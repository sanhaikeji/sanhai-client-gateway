/**
 * 数据层：客户端令牌、配对码、签到状态、签到流水，以及「发硬币」的适配。
 *
 * 设计上只依赖 `ctx.db`（MongoDB），不碰 Hydro 的核心模型 —— 这样跨 Hydro 版本
 * 的兼容面最大（升级 Hydro 不用跟着改这里）。
 */
import { ObjectId } from 'hydrooj';   // 见 index.ts 顶部注释：别直接 import 'mongodb'
import type { Context } from 'hydrooj';
import {
    today, yesterday, dateKey, prevDay, newToken, hashToken, newPairCode,
} from './lib';

// ---------------------------------------------------------------- 集合

let _ctx: Context;
let checkinColl: any;
let checkinLogColl: any;
let repairColl: any;
let tokenColl: any;
let pairColl: any;

/** 插件配置（由 index.ts 在 apply 时灌进来）。 */
let cfg: any = {};

export function init(ctx: Context, config: any) {
    _ctx = ctx;
    cfg = config || {};
    checkinColl = ctx.db.collection(cfg.checkinCollection || 'clientgw.checkin');
    checkinLogColl = ctx.db.collection(cfg.checkinLogCollection || 'clientgw.checkin_log');
    // 补发记录：`_id = uid`，用来保证「同一个人的历史差额只补一次」
    repairColl = ctx.db.collection(cfg.checkinRepairCollection || 'clientgw.checkin_repair');
    tokenColl = ctx.db.collection(cfg.tokenCollection || 'clientgw.token');
    pairColl = ctx.db.collection(cfg.pairCollection || 'clientgw.pair');

    // 索引：两项关键约束
    //  1) 签到流水 (uid, date) 唯一 —— **幂等的物理保证**，并发重复签到会被它挡下来；
    //  2) 令牌哈希唯一 —— 方便按哈希反查。
    // createIndex 是幂等的，重复调用无害。
    void checkinLogColl.createIndex({ uid: 1, date: 1 }, { unique: true });
    void checkinLogColl.createIndex({ ts: -1 });
    void tokenColl.createIndex({ tokenHash: 1 }, { unique: true });
    void tokenColl.createIndex({ uid: 1 });
    void pairColl.createIndex({ createdAt: 1 }, { expireAfterSeconds: 900 }); // 配对码 15 分钟自动清
}

const isDup = (e: any) => e && (e.code === 11000 || String(e.message || '').includes('E11000'));

/** 读插件配置（handler 里展示规则、算费用都要用）。 */
export const getConfig = () => cfg;

// ---------------------------------------------------------------- 令牌

export interface TokenInfo {
    uid: number;
    name: string;
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt: Date;
    lastIp?: string;
}

/** 发一个新令牌给客户端。返回的 raw 只在这一刻存在，之后库里只有哈希。 */
export async function issueToken(uid: number, name: string, ip: string): Promise<string> {
    const raw = newToken();
    const days = Number(cfg.tokenTtlDays ?? 365);
    await tokenColl.insertOne({
        tokenHash: hashToken(raw),
        uid,
        name: (name || '未命名设备').slice(0, 40),
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + days * 86400_000),
        lastIp: ip || '',
        revoked: false,
    });
    return raw;
}

/** 校验令牌；有效则返回身份并顺带更新 lastUsedAt / lastIp。 */
export async function verifyToken(raw: string, ip?: string): Promise<TokenInfo | null> {
    if (!raw) return null;
    const doc = await tokenColl.findOne({ tokenHash: hashToken(raw), revoked: { $ne: true } });
    if (!doc) return null;
    if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) return null;
    // 顺手更新使用痕迹（失败不影响本次请求）
    tokenColl.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date(), lastIp: ip || '' } })
        .catch(() => {});
    return {
        uid: doc.uid,
        name: doc.name,
        createdAt: doc.createdAt,
        lastUsedAt: doc.lastUsedAt,
        expiresAt: doc.expiresAt,
        lastIp: doc.lastIp,
    };
}

/** 列出某个账号已授权的设备（客户端里「我的设备」用）。 */
export async function listTokens(uid: number) {
    const arr = await tokenColl.find({ uid, revoked: { $ne: true } })
        .sort({ lastUsedAt: -1 }).limit(50).toArray();
    return arr.map((d: any) => ({
        id: String(d._id),
        name: d.name,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        lastIp: d.lastIp || '',
        current: false,
    }));
}

/** 撤销一个令牌。传 id 撤销指定设备，不传则撤销**除当前之外**的全部。 */
export async function revokeTokens(uid: number, id?: string, keepHash?: string) {
    if (id) {
        const r = await tokenColl.updateOne(
            { _id: new ObjectId(id), uid }, { $set: { revoked: true } },
        );
        return r.modifiedCount;
    }
    const q: any = { uid, revoked: { $ne: true } };
    if (keepHash) q.tokenHash = { $ne: keepHash };
    const r = await tokenColl.updateMany(q, { $set: { revoked: true } });
    return r.modifiedCount;
}

// ---------------------------------------------------------------- 配对码（网页授权登录）

/**
 * 网页端（已登录）生成一个配对码，客户端输入后换令牌。
 *
 * 比「客户端直接存账号密码」安全一档：密码从不离开网页，且用户能在网页上看
 * 有哪些设备、随时撤销。
 */
export async function issuePairCode(uid: number): Promise<string> {
    const code = newPairCode();
    await pairColl.updateOne(
        { _id: code },
        { $set: { uid, createdAt: new Date(), used: false } },
        { upsert: true },
    );
    return code;
}

/** 客户端拿配对码换令牌。一次性，用完即焚。 */
export async function consumePairCode(code: string, name: string, ip: string) {
    const doc = await pairColl.findOne({ _id: code });
    if (!doc || doc.used) return null;
    if (new Date(doc.createdAt).getTime() < Date.now() - 15 * 60_000) return null;
    // 先标已用（并发下只会有一个成功）
    const r = await pairColl.updateOne({ _id: code, used: false }, { $set: { used: true } });
    if (!r.modifiedCount) return null;
    const token = await issueToken(doc.uid, name, ip);
    return { uid: doc.uid, token };
}

// ---------------------------------------------------------------- 签到

export interface CheckinState {
    uid: number;
    lastDate: string;
    streak: number;
    maxStreak: number;
    totalDays: number;
    totalReward: number;
}

export async function getState(uid: number): Promise<CheckinState> {
    const d = await checkinColl.findOne({ _id: uid });
    return d ? {
        uid,
        lastDate: d.lastDate || '',
        streak: d.streak || 0,
        maxStreak: d.maxStreak || 0,
        totalDays: d.totalDays || 0,
        totalReward: d.totalReward || 0,
    } : { uid, lastDate: '', streak: 0, maxStreak: 0, totalDays: 0, totalReward: 0 };
}

// ---------------------------------------------------------------- 连续天数（流水是唯一真值源）
//
// ⚠️ 为什么不再信 `state.streak`：老实现只拿 `state.lastDate` 一个字段比对，
//    于是「断一天 → 今天签 → 再补签断的那天」这条链**永远接不回来**
//    （补签那支直接 `streak = state.streak` 抄当前值），`lastDate` 还是
//    `max(state.lastDate, date)` 那种凑合写法，补签根本挪不动它。
//    用户原话：「签到补签连续签到还是会重新计算」。
//
//    现在**只有 `checkin_log` 算数**：一个人签过哪些天是不会骗人的，
//    state 里的 `streak` / `lastDate` 只是它的缓存（可以随时重算出来）。

/** 回看多少天的流水来数连续。400 天足够覆盖任何真实连签，也不必全表扫。 */
const STREAK_SPAN_DAYS = 400;

/** 读某 uid 的签到日期集合（可限定区间），给「往回数连续」用。 */
export async function loadCheckinDays(
    uid: number, opts: { from?: string; to?: string } = {},
): Promise<Set<string>> {
    const q: any = { uid };
    if (opts.from || opts.to) {
        q.date = {};
        if (opts.from) q.date.$gte = opts.from;
        if (opts.to) q.date.$lte = opts.to;
    }
    const rows = await checkinLogColl.find(q).sort({ date: 1 }).toArray();
    return new Set(rows.map((r: any) => r.date));
}

/**
 * 从日期集合往回数连续天数：`upto` 当天没签就是 0。
 *
 * <para>纯函数（不碰库）—— 所以 repair 那种「要算历史上每一天的连续数」的场合
 * 可以用**一份 Set 算完全部**，不必一天发一次查询。</para>
 */
export function countBack(days: Set<string>, upto: string): number {
    let n = 0;
    let d = upto;
    while (days.has(d)) { n += 1; d = prevDay(d); }
    return n;
}

/** 日期集合里最长的一段连续 —— 也就是「历史最大连签」。 */
export function longestRun(days: Set<string>): number {
    const sorted = [...days].sort();   // YYYY-MM-DD 的字典序 = 时间序
    let best = 0;
    let run = 0;
    let prev = '';
    for (const d of sorted) {
        run = (prev && prevDay(d) === prev) ? run + 1 : 1;
        if (run > best) best = run;
        prev = d;
    }
    return best;
}

/** 从签到流水算出「截至 upto 这一天」的连续天数（补签日一样计入）。 */
export async function computeStreak(uid: number, upto: string): Promise<number> {
    const days = await loadCheckinDays(uid, {
        from: dateKey(new Date(), -STREAK_SPAN_DAYS), to: upto,
    });
    return countBack(days, upto);
}

/**
 * 当前的连续天数（相对「今天」）。
 *
 * <para>三种情况要分清楚，别糊成一种：</para>
 * <list>
 *   <item>最晚签到日 = 今天 → 数到今天的连续；</item>
 *   <item>最晚签到日 = 昨天 → 链**还活着**（今天签就能续上），数到昨天；</item>
 *   <item>更早 → 链**已断**，诚实给 0。</item>
 * </list>
 *
 * <para>⚠️ `streak = 0` 是「断了」的诚实表示，别为了界面好看保留旧值 ——
 * 留着旧值正是「补签后连续天数还是勾不回来」的根源。签到后它自然变 1。</para>
 */
export async function resolveCurrentStreak(
    uid: number, days?: Set<string>,
): Promise<{ lastDate: string; streak: number }> {
    const set = days || await loadCheckinDays(uid, {
        from: dateKey(new Date(), -STREAK_SPAN_DAYS),
    });
    const t = today();
    let lastDate = '';
    for (const d of set) if (d <= t && d > lastDate) lastDate = d;
    if (!lastDate) return { lastDate: '', streak: 0 };
    if (lastDate === t || lastDate === yesterday()) {
        return { lastDate, streak: countBack(set, lastDate) };
    }
    return { lastDate, streak: 0 };
}

/** 计算某一次签到（含补签）该发多少硬币。规则由配置决定。 */
export function calcReward(streak: number, makeup = false): { base: number; bonus: number; total: number; bonusLabel: string } {
    const base = makeup ? Number(cfg.makeupReward ?? 0) : Number(cfg.dailyCoins ?? 1);
    let bonus = 0;
    let bonusLabel = '';
    const table: Array<{ day: number; coins: number; label?: string; repeat?: boolean }> =
        Array.isArray(cfg.streakBonus) ? cfg.streakBonus : [];

    for (const row of table) {
        if (!(row.day > 0)) continue;
        // 默认是「里程碑」语义：**刚好**连续到第 N 天，给一次。
        // 想「每 N 天都给」的，把这一行的 repeat 设成 true。
        //
        // ⚠️ 之前写成 `streak === day || streak % day === 0` 是错的，有两个副作用：
        //    1) 连续第 6 天会拿到「连续 3 天」的奖励（6 是 3 的倍数）；
        //    2) streak = 0 时所有取模都命中，一次算出好几倍的币。
        //    这两种行为在配置里完全看不出来，所以拆成显式开关。
        const hit = row.repeat
            ? (streak > 0 && streak % row.day === 0)
            : (streak === row.day);
        if (hit) {
            bonus += Number(row.coins || 0);
            bonusLabel = row.label || `连续 ${streak} 天`;
        }
    }
    return { base, bonus, total: base + bonus, bonusLabel };
}

export interface CheckinResult {
    date: string;
    streak: number;
    reward: number;
    base: number;
    bonus: number;
    bonusLabel: string;
    totalDays: number;
    totalReward: number;
    already?: boolean;
}

/**
 * 重复签到（含并发输了的那一方）的返回：顺手把 state 里的连续字段修成流水真值。
 *
 * <para>⚠️ 这里**只修 `lastDate` / `streak` / `maxStreak`**，不动 `totalDays` /
 * `totalReward`。理由：那两个走 `$inc` 维护，本来就没错；若在这里按流水重写，
 * 会和「并发成功的那个请求」的 `$inc` 抢写，把总天数少算 1。
 * 历史累计值真要修，那是 {@link repairCheckin} 的活（管理员、默认 dry-run）。</para>
 */
async function alreadyCheckin(uid: number, date: string): Promise<CheckinResult> {
    const days = await loadCheckinDays(uid, { from: dateKey(new Date(), -STREAK_SPAN_DAYS) });
    const cur = await resolveCurrentStreak(uid, days);
    const state = await getState(uid);
    await checkinColl.updateOne({ _id: uid }, {
        $set: {
            lastDate: cur.lastDate,
            streak: cur.streak,
            maxStreak: Math.max(state.maxStreak || 0, longestRun(days), cur.streak),
            updatedAt: new Date(),
        },
    }, { upsert: true });
    return {
        date, streak: cur.streak, reward: 0, base: 0, bonus: 0, bonusLabel: '',
        totalDays: state.totalDays, totalReward: state.totalReward, already: true,
    };
}

/**
 * 执行签到。
 *
 * <para>⚠️ 顺序很重要：**先插流水（靠唯一索引兜底），再算连续天数、再更新状态、再发硬币**。
 * 反过来会有窗口期让并发请求重复发币。检查过 `already` 之后再发币也一样不行 ——
 * 两个请求可能同时通过检查。</para>
 *
 * <para>连续天数一律从流水推（{@link computeStreak}），奖励也按**那一天**的连续数算 ——
 * 所以补签同样能吃到那天的连签里程碑奖励，链子接得回来。</para>
 */
export async function doCheckin(uid: number, opts: { makeup?: boolean; date?: string } = {}): Promise<CheckinResult> {
    const date = opts.date || today();
    const makeup = !!opts.makeup;

    // 快速路径：这天签过就直接返回（顺带把状态修成真值，幂等、不多发币）
    if (await checkinLogColl.findOne({ uid, date })) return alreadyCheckin(uid, date);

    // 1) 流水（唯一索引 = 幂等的物理保证）。
    //    先插一条占位的：下面的连续天数要**包含这一天**才算得对
    //    （否则得自己拼「前一天数 + 1」，两套算法迟早算岔）。
    try {
        await checkinLogColl.insertOne({
            uid, date, ts: new Date(), streak: 1, reward: 0, makeup,
        });
    } catch (e) {
        if (isDup(e)) return alreadyCheckin(uid, date);
        throw e;
    }

    // 2) 连续天数从流水推 → 这一天的奖励按这一天的连续数算
    //    （补签日一样享受里程碑奖励，这是有意的：补签就是为了把链接回来）
    const dayStreak = await computeStreak(uid, date);
    const { base, bonus, total, bonusLabel } = calcReward(dayStreak, makeup);
    await checkinLogColl.updateOne({ uid, date }, { $set: { streak: dayStreak, reward: total } });

    // 3) 状态：lastDate = 该 uid 最晚签到日（不是 `max(state.lastDate, date)` 那种凑合写法），
    //    streak / maxStreak 全按流水推。maxStreak 和旧值取大 —— 历史上更长的链不能被窗口截断。
    const days = await loadCheckinDays(uid, {
        from: dateKey(new Date(), -STREAK_SPAN_DAYS),
        to: date > today() ? date : today(),
    });
    const cur = await resolveCurrentStreak(uid, days);
    const state = await getState(uid);
    const maxStreak = Math.max(state.maxStreak || 0, longestRun(days), cur.streak);
    await checkinColl.updateOne({ _id: uid }, {
        $set: {
            lastDate: cur.lastDate || date,
            streak: cur.streak,
            maxStreak,
            updatedAt: new Date(),
        },
        $inc: { totalDays: 1, totalReward: total },
    }, { upsert: true });

    // 4) 发硬币（失败不回滚签到 —— 宁可少发一次，也不要「扣了流水又发不出币」）
    if (total > 0 && cfg.coinEnabled !== false) {
        try {
            await grantCoin(uid, total, makeup ? `补签 ${date}` : `签到（连续 ${dayStreak} 天）`);
        } catch (e) {
            ctx().logger?.error?.(`[clientgw] 发硬币失败 uid=${uid} amount=${total}: ${(e as Error).message}`);
        }
    }

    return {
        date, streak: dayStreak, reward: total, base, bonus, bonusLabel,
        totalDays: state.totalDays + 1, totalReward: state.totalReward + total,
    };
}

// ---------------------------------------------------------------- 历史补发（管理员，默认 dry-run）

export interface RepairUser {
    uid: number;
    /** 流水条数 */
    days: number;
    /** 截至最后一个签到日的连续天数 */
    endStreak: number;
    /** 按流水重算的应得总额 */
    expected: number;
    /** 流水里记着的实发总额 */
    actual: number;
    diff: number;
    /** 本次真正补发的硬币（dry / 已补过 / 差额 ≤ 0 时都是 0） */
    paid: number;
}

export interface RepairResult {
    dry: boolean;
    /** 体检了多少个 uid */
    scanned: number;
    /** 有差额、需要处理的 uid 数 */
    affected: number;
    /** 应补总额（dry=1 时就是「如果真发会发多少」） */
    totalCoins: number;
    /** 本次实际补发总额 */
    totalPaid: number;
    users: RepairUser[];
    usersTruncated: boolean;
}

/**
 * 把「连续天数算错」造成的历史少发补上。
 *
 * <para>默认 **dry = true（只体检、不发钱）**。这是个会真发硬币的运维接口，
 * 不该因为少打一个参数就把钱发出去。</para>
 *
 * <para>⚠️ 补发必须走 {@link grantCoin}：它同时涨 `coin_now` 和 `coin_all` 并写账单。
 * 自己 `$inc` 一个字段看起来更省事，但那样硬币榜（按 `coin_all` 筛人）和账单页都会对不上。</para>
 *
 * <para>幂等：`clientgw.checkin_repair` 里 `_id = uid` 记一笔，已经补过就跳过；
 * 要重来必须显式 `force = 1`。</para>
 */
export async function repairCheckin(
    opts: { dry?: boolean; force?: boolean; uid?: number } = {},
): Promise<RepairResult> {
    const dry = opts.dry !== false;
    const force = !!opts.force;
    const only = Number(opts.uid || 0);

    // 一次把流水全捞回来：管理员手动触发的运维接口，不常跑；
    // 比「每人查一次 + 每天再查一次」快几个数量级。
    const rows = await checkinLogColl.find(only ? { uid: only } : {}).sort({ date: 1 }).toArray();
    const byUid = new Map<number, any[]>();
    for (const r of rows) {
        const arr = byUid.get(r.uid);
        if (arr) arr.push(r);
        else byUid.set(r.uid, [r]);
    }

    const users: RepairUser[] = [];
    let scanned = 0;
    let affected = 0;
    let totalCoins = 0;
    let totalPaid = 0;

    for (const [uid, list] of byUid) {
        scanned += 1;
        // 一份 Set 算完这个人的每一天，不再查库
        const days = new Set(list.map((r: any) => r.date));
        let expected = 0;
        let actual = 0;
        for (const r of list) {
            expected += calcReward(countBack(days, r.date), !!r.makeup).total;
            actual += Number(r.reward || 0);
        }

        // ⚠️ 已经补过的金额必须扣掉，否则「补完了再体检」还是报同样的差额 ——
        //    2026-10-31 线上真踩到：补完 29 币后再跑 dry=1，照样显示 4 人 29 币，
        //    管理员会以为没生效；这时候手滑加个 force=1 就变成二次发钱。
        //    force 的语义是「无视已补记录、再发一次」，所以它才回到「只和实发比」。
        const done = await repairColl.findOne({ _id: uid }).catch(() => null);
        const paidBefore = Number(done && done.paid) || 0;
        const diff = force ? (expected - actual) : (expected - actual - paidBefore);
        if (diff <= 0) continue;   // 没有还欠的 = 不用动

        affected += 1;
        totalCoins += diff;
        const row: RepairUser = {
            uid,
            days: list.length,
            endStreak: countBack(days, list[list.length - 1].date),
            expected, actual, diff, paid: 0,
        };

        if (!dry) {
            // (a) state 修成流水真值 —— 幂等，重复跑结果一样，所以放在「发钱」之前
            const cur = await resolveCurrentStreak(uid, days);
            await checkinColl.updateOne({ _id: uid }, {
                $set: {
                    lastDate: cur.lastDate,
                    streak: cur.streak,
                    maxStreak: longestRun(days),
                    totalDays: list.length,
                    totalReward: expected,
                    updatedAt: new Date(),
                },
            }, { upsert: true });

            // (b) 发钱：一个 uid 只补一次，force=1 才允许重来
            if (!done || force) {
                await grantCoin(uid, diff, '补签连续天数修正补发');
                row.paid = diff;
                totalPaid += diff;
                await repairColl.updateOne({ _id: uid }, {
                    $set: {
                        uid,
                        paid: paidBefore + diff,
                        at: new Date(),
                        reason: '补签连续天数修正补发',
                    },
                }, { upsert: true });
            }
        }
        users.push(row);
    }

    return {
        dry, scanned, affected, totalCoins, totalPaid,
        users: users.slice(0, 50),
        usersTruncated: users.length > 50,
    };
}

const ctx = () => _ctx;

/** 某个月的签到日历（1 号到月末，签到日为 true）。 */
export async function getCalendar(uid: number, month: string) {
    const mm = /^\d{4}-\d{2}$/.test(month) ? month : today().slice(0, 7);
    const start = `${mm}-01`;
    const rows = await checkinLogColl.find({ uid, date: { $gte: start, $lte: `${mm}-31` } })
        .sort({ date: 1 }).toArray();
    const signed = new Set(rows.map((r: any) => r.date));
    const [y, m] = mm.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const list = [];
    for (let i = 1; i <= days; i += 1) {
        const d = `${mm}-${String(i).padStart(2, '0')}`;
        list.push({ date: d, signed: signed.has(d), makeup: !!rows.find((r: any) => r.date === d)?.makeup });
    }
    return { month: mm, days: list, signed: signed.size };
}

/** 签到排行榜。by = 'streak' | 'total' | 'month'。 */
export async function getRank(by: string, limit = 50) {
    const sort = by === 'total' ? { totalDays: -1 } : { streak: -1 };
    const arr = await checkinColl.find({}).sort(sort as any).limit(Math.min(limit, 200)).toArray();
    return arr.map((d: any, i: number) => ({
        rank: i + 1,
        uid: d._id,
        streak: d.streak || 0,
        maxStreak: d.maxStreak || 0,
        totalDays: d.totalDays || 0,
        totalReward: d.totalReward || 0,
    }));
}

/** 最近 N 天的签到明细（客户端画「最近动态」用）。 */
export async function recentLogs(uid: number, limit = 30) {
    const arr = await checkinLogColl.find({ uid }).sort({ date: -1 }).limit(Math.min(limit, 100)).toArray();
    return arr.map((d: any) => ({ date: d.date, streak: d.streak, reward: d.reward, makeup: !!d.makeup }));
}

// ---------------------------------------------------------------- 硬币发放（对接 coin-33oj）

/**
 * 站点硬币插件自己注册的「发币」入口。
 *
 * <para>⭐ 为什么优先走它、而不是自己写库：<b>我们自己写库会写错地方</b>。
 * coin-33oj（以及它的各个改版）在 <c>apply()</c> 里做了
 * <c>global.Hydro.model.coin = coinModel</c>，把 <c>inc(userId, rootId, amount, text)</c>
 * 暴露出来 —— 它内部干三件事：写账单、<c>$inc coin_now</c>、正数时再 <c>$inc coin_all</c>。</para>
 *
 * <para>⚠️ 2026-10-11 的线上事故就是这么来的：我们自己 <c>insertOne</c> 到 <c>coin.bill</c>、
 * 字段写 <c>{uid, amount, note}</c>，而站点插件读的是 <c>coin</c> 集合、字段是
 * <c>{userId, rootId, amount, text}</c> —— <b>两边对不上，于是签到发的币在流水里根本不出现</b>
 * （余额倒是对的，因为 coin_now 两边一致），而且 <c>coin_all</c>（累计获得）从来没涨过。</para>
 *
 * <para>拿到它就等于「和站点插件用同一套账」，集合名/字段名/连带字段全都不用猜。</para>
 */
function siteCoinModel(): any {
    const g: any = (globalThis as any).Hydro;
    return g?.model?.coin;
}

/**
 * 站点那个 `inc` 能不能按 `inc(uid, rootId, amount, text)` 调。
 *
 * <para>⚠️ **必须看参数个数**：coin-33oj 原版是 4 参（uid / rootId / amount / text）。
 * 万一某个改版砍成 3 参，照 4 参传就会**把金额塞到 rootId 的位置上** ——
 * 那比不调还糟（发出去 0 个币，还记了一笔错账）。对不上就老实走下面自己写库那一支，
 * 效果一样（coin-33oj 的 `inc` 内部也就是 insertOne + 两个 $inc）。</para>
 */
function canCallSiteInc(coin: any): boolean {
    return !!coin && typeof coin.inc === 'function' && coin.inc.length >= 4;
}

/**
 * 发硬币。优先调站点硬币插件自己的 {@link siteCoinModel}；拿不到再自己写库兜底。
 *
 * ⚠️ 兜底那一支必须按服务器上装的那个硬币插件来调（集合名 + 字段名）。
 * 怎么确认：看启动日志/`/client-api/diagnose` 的「账单」一节 —— 它会把库里
 * 真实存在的账单集合和它的字段名打出来，别猜。
 */
export async function grantCoin(uid: number, amount: number, note: string) {
    const c = ctx();
    const userColl = c.db.collection(cfg.coinUserCollection || 'user');
    const field = cfg.coinUserField || 'coin_now';
    const allField = cfg.coinAllField || 'coin_all';

    // 先确认这个 uid 真的存在。⚠️ 理由和下面 updateOne 的检查一样：
    // 匹配不到用户时一切写库都**不报错**，硬币会**静默消失**（coin.inc 内部也是 updateOne）。
    const udoc = await userColl.findOne({ _id: uid }, { projection: { _id: 1 } });
    if (!udoc) {
        throw new Error(
            `发硬币失败：${cfg.coinUserCollection || 'user'} 里没有 uid=${uid}`,
        );
    }

    // ① 首选：站点硬币插件自己的发币函数（账单 + coin_now + coin_all 一次到位）。
    const coin = siteCoinModel();
    if (canCallSiteInc(coin)) {
        try {
            // rootId = 0 表示「系统发放」；站点插件的账单页会把它显示成发放人 uid。
            await coin.inc(uid, 0, amount, note);
            return;
        } catch (e) {
            // 兜底写库有重复记账的风险（账单可能已经写进去了），所以这条日志要看。
            ctx().logger?.warn?.(
                `[clientgw] 调站点 coin.inc 失败，改用直接写库（可能重复记一笔账单）：${(e as Error).message}`,
            );
        }
    } else if (coin && typeof coin.inc === 'function') {
        ctx().logger?.warn?.(
            `[clientgw] 站点 coin.inc 的参数个数是 ${coin.inc.length}（不是 4），不敢按 `
            + 'inc(uid, rootId, amount, text) 调，改用直接写库',
        );
    }

    // ② 兜底：自己写。字段名/集合名以 cfg 为准。
    const r = await userColl.updateOne({ _id: uid }, { $inc: { [field]: amount } });
    if (!r || !r.matchedCount) {
        throw new Error(
            `发硬币失败：${cfg.coinUserCollection || 'user'} 里没有 uid=${uid}，`
            + `或字段 ${field} 配错了（检查插件配置）`,
        );
    }

    // ⚠️ 累计获得要一起涨。站点硬币榜单是 `find({ coin_all: { $exists: true } })` 筛出来的
    //    —— 只涨 coin_now 不涨 coin_all 的用户，**在硬币榜上是看不见的**。
    if (amount > 0) {
        try {
            await userColl.updateOne({ _id: uid }, { $inc: { [allField]: amount } });
        } catch (e) {
            ctx().logger?.warn?.(`[clientgw] 累加 ${allField} 失败（不影响本次发币）：${(e as Error).message}`);
        }
    }

    // 账单（流水）—— **尽力而为**：余额上面已经加上了，这里失败不该让调用方以为「没发出去」。
    // 字段名按站点插件（coin-33oj）的形状写，这样站点账单页也能正常渲染。
    if (cfg.coinWriteBill !== false) {
        try {
            await c.db.collection(cfg.coinBillCollection || 'coin').insertOne({
                userId: uid, rootId: 0, amount, text: note, ts: new Date(),
            });
        } catch (e) {
            ctx().logger?.warn?.(`[clientgw] 写硬币账单失败（余额已加，不影响发币）：${(e as Error).message}`);
        }
    }
}

/** 读余额：`coin_now`（当前）+ `coin_all`（累计获得）。 */
export async function coinBalance(uid: number): Promise<number> {
    const b = await coinBalances(uid);
    return b.now;
}

/** 当前 / 累计两个数（客户端硬币页要一起显示）。 */
export async function coinBalances(uid: number): Promise<{ now: number; all: number }> {
    const c = ctx();
    const nowField = cfg.coinUserField || 'coin_now';
    const allField = cfg.coinAllField || 'coin_all';
    const d = await c.db.collection(cfg.coinUserCollection || 'user').findOne(
        { _id: uid }, { projection: { [nowField]: 1, [allField]: 1 } },
    );
    return {
        now: (d && Number(d[nowField])) || 0,
        all: (d && Number(d[allField])) || 0,
    };
}

// ---------------------------------------------------------------- 自检

export interface DiagnoseResult {
    summary: string;
    issues: string[];
    coin: {
        userCollection: string;
        userField: string;
        fieldExists: boolean;
        sampleValue: number | null;
        numericFields: string[];
        billCollection: string;
        billCollectionExists: boolean;
        billCount: number;
        /** 账单文档里真实出现的字段名（拿它对齐读写，别猜）。 */
        billFields: string[];
        /** 站点硬币插件有没有把 `inc` 挂到 global.Hydro.model.coin 上（挂了就优先用它发币）。 */
        siteCoinModel: boolean;
        suggestedField: string | null;
        suggestedBillCollection: string | null;
    };
    checkin: { stateCollection: string; logCollection: string; logCount: number };
    collections: string[];
}

/**
 * 自检：把「配置对不对」直接查出来，而不是让人去猜。
 *
 * <para>⭐ 存在的理由很实在：硬币字段名**没法猜** —— 配错了不会报错，只会让硬币发不出去
 * （见 {@link grantCoin} 的注释）。与其让用户 SSH 上去跑 mongosh，不如让插件自己查一遍，
 * 顺便**给出建议值**：装上后看一眼 `/client-api/diagnose`，或者直接看启动日志。</para>
 */
export async function diagnose(uid?: number): Promise<DiagnoseResult> {
    const c = ctx();
    const issues: string[] = [];
    const targetUid = uid && uid > 0 ? uid : Number((cfg.adminUids && cfg.adminUids[0]) || 5);

    // ---- 硬币 ----
    const uColl = cfg.coinUserCollection || 'user';
    const field = cfg.coinUserField || 'coin_now';
    let numericFields: string[] = [];
    let fieldExists = false;
    let sampleValue: number | null = null;
    try {
        const udoc = await c.db.collection(uColl).findOne({ _id: targetUid });
        if (udoc) {
            numericFields = Object.keys(udoc).filter((k) => typeof udoc[k] === 'number');
            fieldExists = udoc[field] !== undefined;
            sampleValue = fieldExists ? Number(udoc[field]) : null;
        } else {
            issues.push(`${uColl} 里找不到 uid=${targetUid}，没法确认硬币字段`);
        }
    } catch (e) {
        issues.push(`读 ${uColl} 失败：${(e as Error).message}`);
    }

    // ---- 集合清单 ----
    // ⚠️ `listCollections()` 在受限的 Mongo 账号下会**直接抛错**（缺 listCollections 权限），
    //    不是一个可以信赖的依据 —— 2026-10-11 就是这么误报「账单集合 coin.bill 不在库里」的：
    //    实际上表在、还有数据，只是清单读不出来。
    //    所以这里改成：清单只当参考，真正的判断靠「按名字去试探」。
    let collections: string[] = [];
    try {
        const all = await c.db.listCollections().toArray();
        collections = all.map((x: any) => x.name);
    } catch { /* 权限不够读不到清单，正常 —— 下面的试探才是主路径 */ }

    const billColl = cfg.coinBillCollection || 'coin';
    let billCollectionExists = false;
    let billCount = 0;
    try {
        billCount = await c.db.collection(billColl).estimatedDocumentCount();
        billCollectionExists = true;
    } catch { /* 集合不存在 / 读不到 */ }

    // 「像账单的集合」——按候选名逐个试探（Mongo 里 collection 不存在时 count 会返回 0 而不是报错，
    // 所以判断依据取「有文档」）。命中就把**真实字段名**读出来，这是唯一能确定 schema 的办法。
    const candidates = [
        billColl, 'coin', 'coin.bill', 'coin_bill', 'coinbill', 'coin.log', 'coin.logs',
    ].filter((n, i, a) => n && a.indexOf(n) === i);
    let suggestedBillCollection: string | null = null;
    let billFields: string[] = [];
    let billSampleCount = 0;
    for (const name of candidates) {
        try {
            const n = await c.db.collection(name).estimatedDocumentCount();
            if (n <= 0) continue;
            if (!billFields.length) {
                const one = await c.db.collection(name).findOne({});
                if (one) {
                    billFields = Object.keys(one);
                    billSampleCount = n;
                    if (name !== billColl) suggestedBillCollection = name;
                }
            }
        } catch { /* 忽略 */ }
    }
    // ⭐ 给出建议：名字里带 coin/money/score 的字段。
    // ⚠️ 优先挑「当前余额」味道的（`coin_now` 这种）—— 用户文档上同时有 coin_now / coin_all，
    //    按「第一个像硬币的」挑可能挑到 coin_all（累计获得），那会把配置**改错**。
    const guessWords = ['coin', 'coins', 'money', 'score', 'point', 'points'];
    const coinish = numericFields.filter((k) => guessWords.some((w) => k.toLowerCase().includes(w)));
    const suggestedField = coinish.find((k) => /(^|_)now$/i.test(k))
        || coinish.find((k) => !/(^|_)all$/i.test(k))
        || coinish[0]
        || null;

    if (!fieldExists) {
        issues.push(`硬币字段 ${uColl}.${field} 读不到 —— 发币会失败，检查 coinUserField`);
    }
    if (!billCollectionExists) {
        // 这里要说清「表不存在」和「权限读不到」是两回事，否则会像 2026-10-11 那样白排查一轮。
        issues.push(
            `账单集合 ${billColl} 读不出来（要么名字不对、要么没权限）`
            + (collections.length ? '' : '；注意集合清单也读不到，本机的 Mongo 账号可能缺 listCollections 权限'),
        );
    }
    if (fieldExists && suggestedField && suggestedField !== field) {
        issues.push(`${uColl} 上还有个像硬币的字段 \`${suggestedField}\`，确认哪个才是余额`);
    }
    if (suggestedBillCollection) {
        issues.push(
            `发现一个更像账单的集合 \`${suggestedBillCollection}\``
            + `（${billSampleCount} 条，字段：${billFields.join('、')}）`,
        );
    }

    // ---- 签到自己的表 ----
    let logCount = 0;
    try {
        logCount = await c.db.collection(cfg.checkinLogCollection || 'clientgw.checkin_log').countDocuments({});
    } catch { /* 第一次装还没有这张表，正常 */ }

    const siteCoin = canCallSiteInc(siteCoinModel());

    const summary = issues.length
        ? `有 ${issues.length} 处配置要确认`
        : `配置正常（${uColl}.${field}${sampleValue === null ? '' : ` = ${sampleValue}`}`
          + `，账单 ${billColl} ${billCount} 条${billFields.length ? `（字段 ${billFields.join('、')}）` : ''}`
          + `，发币走 ${siteCoin ? '站点 coin 插件' : '自写库兜底'}）`;

    return {
        summary, issues,
        coin: {
            userCollection: uColl, userField: field, fieldExists, sampleValue, numericFields,
            billCollection: billColl, billCollectionExists, billCount,
            billFields, siteCoinModel: siteCoin,
            suggestedField, suggestedBillCollection,
        },
        checkin: {
            stateCollection: cfg.checkinCollection || 'clientgw.checkin',
            logCollection: cfg.checkinLogCollection || 'clientgw.checkin_log',
            logCount,
        },
        collections,
    };
}
