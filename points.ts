/**
 * 客户端积分与任务中心。
 *
 * <p>⚠️ **为什么积分账本放这里（而不是中转站）**：任务中心必须**服务端判定完成**。
 * 「今天打卡了没有」「今天提交过代码没有」这些事实只有站点的 MongoDB 知道；
 * 中转站查不到，只能靠客户端上报 —— 那等于发个脚本就能刷积分。
 * 所以积分、流水、任务完成记录全部落在站点这边。</p>
 *
 * <p>和「硬币」的关系是**两套货币**：硬币是站点 coin 插件的，积分是客户端自己的。
 * 打卡时两边同时发放，但互不换算、互不影响。</p>
 *
 * <p>安全等级（对应之前定的 A/B/C）：
 *   - A 类（服务端本来就有记录）：打卡、提交评测 —— 判定完全在服务端；
 *   - B 类（服务端记状态 + 唯一索引）：任务领取靠 <code>(uid, taskId, period)</code>
 *     唯一索引保证同一天同一个任务只能领一次，不靠代码里的 if。
 *   凡是「只有客户端知道」的（比如"我打开了某个页面"），**不做任务** —— 那是 C 类，
 *   发了必然被刷。</p>
 */
import { ObjectId } from 'hydrooj';
import { getState, getConfig } from './model';
import { today } from './lib';

let _ctx: any;
let pointsColl: any;
let pointsLogColl: any;
let taskLogColl: any;

export function initPoints(c: any, config: any) {
    _ctx = c;
    pointsColl = c.db.collection(config.pointsCollection || 'clientgw.points');
    pointsLogColl = c.db.collection(config.pointsLogCollection || 'clientgw.points_log');
    taskLogColl = c.db.collection(config.taskLogCollection || 'clientgw.task_log');

    // 流水按人查；任务领取靠这个唯一索引幂等 —— 并发点两次也只会发一次
    void pointsLogColl.createIndex({ uid: 1, ts: -1 });
    void taskLogColl.createIndex({ uid: 1, taskId: 1, period: 1 }, { unique: true });
    void taskLogColl.createIndex({ ts: -1 });
}

// ---------------------------------------------------------------- 余额与流水

export async function pointsBalance(uid: number): Promise<number> {
    const d = await pointsColl.findOne({ _id: uid });
    return d && Number.isFinite(d.balance) ? d.balance : 0;
}

/**
 * 记一笔流水并改余额。
 *
 * @param key 幂等键。**同一秒内的同一个 key 只入账一次**（打卡发分、任务领奖都靠它）。
 */
export async function addPoints(
    uid: number, amount: number, reason: string, byUid: number, key?: string,
): Promise<{ ok: boolean; balance: number; duplicated?: boolean }> {
    const c = pointsColl;
    const ts = Date.now();

    if (key) {
        const dup = await pointsLogColl.findOne({ uid, key });
        if (dup) return { ok: false, balance: await pointsBalance(uid), duplicated: true };
    }

    // 先写流水再改余额：并发下以「流水」为准，宁可少发也不多发
    try {
        await pointsLogColl.insertOne({
            uid, amount, reason, by: byUid, ts,
            at: new Date(ts).toISOString(),
            ...(key ? { key } : {}),
        });
    } catch (e: any) {
        if (e && e.code === 11000) return { ok: false, balance: await pointsBalance(uid), duplicated: true };
        throw e;
    }

    await c.updateOne({ _id: uid }, { $inc: { balance: amount } }, { upsert: true });
    return { ok: true, balance: await pointsBalance(uid) };
}

/** 扣分。余额不足返回 false（不扣、不写流水）。 */
export async function spendPoints(
    uid: number, amount: number, reason: string, byUid: number,
): Promise<{ ok: boolean; balance: number; error?: string }> {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, balance: await pointsBalance(uid), error: '数额不合法' };
    const cur = await pointsBalance(uid);
    if (cur < amount) return { ok: false, balance: cur, error: `积分不够（现有 ${cur}，需要 ${amount}）` };

    await pointsLogColl.insertOne({
        uid, amount: -amount, reason, by: byUid,
        ts: Date.now(), at: new Date().toISOString(),
    });
    await pointsColl.updateOne({ _id: uid }, { $inc: { balance: -amount } });
    return { ok: true, balance: cur - amount };
}

export async function pointsHistory(uid: number, limit = 30) {
    const rows = await pointsLogColl.find({ uid }).sort({ ts: -1 }).limit(Math.min(limit, 100)).toArray();
    return rows.map((r: any) => ({
        amount: r.amount, reason: r.reason, by: r.by,
        at: r.at, ts: r.ts,
    }));
}

export async function pointsBoard(limit = 20) {
    const rows = await pointsColl.find({ balance: { $gt: 0 } })
        .sort({ balance: -1 }).limit(Math.min(limit, 100)).toArray();
    const uids = rows.map((r: any) => r._id);
    const names: Record<number, string> = {};
    try {
        // ⚠️ 用 init 时存的 ctx，不要写 pointsColl.db —— Hydro 的 db 包装不保证有这个属性
        const docs = await _ctx.db.collection('user')
            .find({ _id: { $in: uids } }, { projection: { uname: 1 } }).toArray();
        for (const d of docs) names[d._id] = d.uname;
    } catch { /* 用户集合查不到就只显示 uid */ }
    return rows.map((r: any, i: number) => ({
        rank: i + 1, uid: r._id, name: names[r._id] || `uid ${r._id}`, balance: r.balance,
    }));
}

/** 我的排名（没上榜就返回 null，客户端显示"未上榜"）。 */
export async function pointsRank(uid: number): Promise<number | null> {
    const me = await pointsBalance(uid);
    if (me <= 0) return null;
    const higher = await pointsColl.countDocuments({ balance: { $gt: me } });
    return higher + 1;
}

// ---------------------------------------------------------------- 任务定义
//
// 每条任务都必须**服务端可判定**。判定函数返回 true/false，客户端说什么都不算数。

export interface TaskDef {
    id: string;
    title: string;
    desc: string;
    points: number;
    /** daily = 每天可领一次；once = 终身一次 */
    period: 'daily' | 'once';
    /** 服务端判定：这件事到底完成没有 */
    check: (ctx: any, uid: number) => Promise<boolean>;
    /** 进度上限（给客户端画进度条用），0 表示只有完成/未完成两态 */
    goal?: number;
    /** 当前进度 */
    progress?: (ctx: any, uid: number) => Promise<number>;
}

export const TASKS: TaskDef[] = [
    {
        id: 'daily.checkin',
        title: '完成今日打卡',
        desc: '打卡时同时拿站点硬币和客户端积分',
        points: 20,
        period: 'daily',
        check: async (_ctx, uid) => (await getState(uid)).lastDate === today(),
    },
    {
        id: 'daily.submit',
        title: '提交一次代码',
        desc: '今天在题库里提交任意一道题（评测记录为准）',
        points: 10,
        period: 'daily',
        check: async (ctx, uid) => {
            const day = today();
            const from = new Date(`${day}T00:00:00`).getTime();
            const n = await ctx.db.collection('record')
                .countDocuments({ uid, ts: { $gte: from } });
            return n > 0;
        },
    },
    {
        id: 'streak.3',
        title: '连续签到 3 天',
        desc: '连续三天不断签',
        points: 30,
        period: 'once',
        check: async (_ctx, uid) => (await getState(uid)).maxStreak >= 3,
    },
    {
        id: 'streak.7',
        title: '连续签到 7 天',
        desc: '连续一周不断签',
        points: 80,
        period: 'once',
        check: async (_ctx, uid) => (await getState(uid)).maxStreak >= 7,
    },
    {
        id: 'total.10',
        title: '累计签到 10 天',
        desc: '加起来签满 10 天就行，不要求连续',
        points: 60,
        period: 'once',
        check: async (_ctx, uid) => (await getState(uid)).totalDays >= 10,
    },
];

export function taskById(id: string) {
    return TASKS.find((t) => t.id === id) || null;
}

function periodOf(t: TaskDef) {
    return t.period === 'daily' ? today() : 'once';
}

export async function taskClaimed(uid: number, t: TaskDef) {
    const d = await taskLogColl.findOne({ uid, taskId: t.id, period: periodOf(t) });
    return !!d;
}

/** 任务列表 + 我的状态。 */
export async function taskOverview(ctx: any, uid: number) {
    const out = [];
    for (const t of TASKS) {
        const done = await t.check(ctx, uid);
        const claimed = await taskClaimed(uid, t);
        out.push({
            id: t.id, title: t.title, desc: t.desc, points: t.points, period: t.period,
            done, claimed,
            goal: t.goal || 0,
            progress: t.progress ? await t.progress(ctx, uid) : (done ? 1 : 0),
            // 已经领过就别再让人点「领取」了，界面上直接标成已完成
            state: claimed ? 'claimed' : (done ? 'ready' : 'doing'),
        });
    }
    return out;
}

/**
 * 领奖。**先判定、再幂等、后发分** —— 顺序不能反，
 * 反了就会出现「没完成也能领」或者「完成两次发两份」。
 */
export async function claimTask(ctx: any, uid: number, taskId: string) {
    const t = taskById(taskId);
    if (!t) return { ok: false, error: '没有这个任务' };

    const done = await t.check(ctx, uid);
    if (!done) return { ok: false, error: '任务还没完成' };

    const r = await addPoints(uid, t.points, `任务奖励：${t.title}`, 0, `task:${t.id}:${periodOf(t)}`);
    if (r.duplicated) return { ok: false, error: '这个任务的奖励已经领过了' };

    try {
        await taskLogColl.insertOne({ uid, taskId: t.id, period: periodOf(t), ts: Date.now(), at: new Date().toISOString() });
    } catch { /* 唯一索引兜底，重复了也不影响 */ }

    return { ok: true, points: t.points, balance: r.balance, title: t.title };
}

/**
 * 打卡时同步发积分（和硬币同时）。
 * 幂等键用 `checkin:<uid>:<日期>`，所以**一天只发一次**，并发也安全。
 *
 * <p>数值全部可配：第 1 天 `checkinPoints`（默认 100），之后每天加
 * `checkinPointsPerDay`（默认 10），加成封顶 `checkinPointsCap`（默认 200）——
 * 即第 5 天 140、第 30 天封顶 300。原来的 `5 + min((streak-1)*2, 20)` 太小，
 * 打卡在界面上几乎没有存在感。</p>
 *
 * <p>⚠️ `streak` 是**那一天真实的连续天数**（来自流水推导，见 model.ts 的
 * `computeStreak`），不是 state 里可能过期的缓存值。</p>
 */
export async function grantCheckinPoints(uid: number, streak: number): Promise<{ points: number; balance: number }> {
    const cfg: any = getConfig();
    const base = Number(cfg.checkinPoints ?? 100);
    const perDay = Number(cfg.checkinPointsPerDay ?? 10);
    const cap = Number(cfg.checkinPointsCap ?? 200);
    // 封顶只压在「连续加成」上，基础分照给 —— 否则连签 30 天和 20 天就没区别了
    const bonus = Math.min(Math.max(0, streak - 1) * perDay, cap);
    const pts = base + bonus;
    // 幂等键保持不变（checkin:<uid>:<日期>）—— 一天只发一次，重复打卡拿不到第二份
    const r = await addPoints(uid, pts, `每日打卡（连续 ${streak} 天${bonus ? `，加成 +${bonus}` : ''}）`, 0, `checkin:${uid}:${today()}`);
    return { points: r.duplicated ? 0 : pts, balance: r.balance };
}