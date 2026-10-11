/**
 * 数据层：客户端令牌、配对码、签到状态、签到流水，以及「发硬币」的适配。
 *
 * 设计上只依赖 `ctx.db`（MongoDB），不碰 Hydro 的核心模型 —— 这样跨 Hydro 版本
 * 的兼容面最大（升级 Hydro 不用跟着改这里）。
 */
import { ObjectId } from 'hydrooj';   // 见 index.ts 顶部注释：别直接 import 'mongodb'
import type { Context } from 'hydrooj';
import {
    today, prevDay, newToken, hashToken, newPairCode,
} from './lib';

// ---------------------------------------------------------------- 集合

let _ctx: Context;
let checkinColl: any;
let checkinLogColl: any;
let tokenColl: any;
let pairColl: any;

/** 插件配置（由 index.ts 在 apply 时灌进来）。 */
let cfg: any = {};

export function init(ctx: Context, config: any) {
    _ctx = ctx;
    cfg = config || {};
    checkinColl = ctx.db.collection(cfg.checkinCollection || 'clientgw.checkin');
    checkinLogColl = ctx.db.collection(cfg.checkinLogCollection || 'clientgw.checkin_log');
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
 * 执行签到。
 *
 * ⚠️ 顺序很重要：**先插流水（靠唯一索引兜底），再更新状态、再发硬币**。
 * 反过来会有窗口期让并发请求重复发币。检查过 `already` 之后再发币也一样不行 ——
 * 两个请求可能同时通过检查。
 */
export async function doCheckin(uid: number, opts: { makeup?: boolean; date?: string } = {}): Promise<CheckinResult> {
    const date = opts.date || today();
    const makeup = !!opts.makeup;

    // 快速路径：今天签过就直接返回
    const exist = await checkinLogColl.findOne({ uid, date });
    const state = await getState(uid);
    if (exist) {
        return {
            date, streak: state.streak, reward: 0, base: 0, bonus: 0, bonusLabel: '',
            totalDays: state.totalDays, totalReward: state.totalReward, already: true,
        };
    }

    // 计算连续天数：只有「前一天签过」才累加，否则从 1 重新开始。
    // ⚠️ 用 prevDay(date) 而不是 yesterday()：这样传入任意日期（补签、测试）
    //    都能算对，也不会被服务器时钟带偏。
    let streak = 1;
    if (!makeup) {
        if (state.lastDate === prevDay(date)) streak = state.streak + 1;
        else if (state.lastDate === date) streak = state.streak;
    } else {
        streak = state.streak;   // 补签不改变当前连续
    }

    const { base, bonus, total, bonusLabel } = calcReward(streak, makeup);

    // 1) 流水（唯一索引 = 幂等的物理保证）
    try {
        await checkinLogColl.insertOne({
            uid, date, ts: new Date(), streak, reward: total, makeup,
        });
    } catch (e) {
        if (isDup(e)) {
            const s2 = await getState(uid);
            return {
                date, streak: s2.streak, reward: 0, base: 0, bonus: 0, bonusLabel: '',
                totalDays: s2.totalDays, totalReward: s2.totalReward, already: true,
            };
        }
        throw e;
    }

    // 2) 更新状态
    const nextStreak = makeup ? state.streak : streak;
    await checkinColl.updateOne({ _id: uid }, {
        $set: {
            lastDate: state.lastDate && state.lastDate > date ? state.lastDate : date,
            streak: nextStreak,
            maxStreak: Math.max(state.maxStreak, nextStreak),
            updatedAt: new Date(),
        },
        $inc: { totalDays: 1, totalReward: total },
    }, { upsert: true });

    // 3) 发硬币（失败不回滚签到 —— 宁可少发一次，也不要「扣了流水又发不出币」）
    if (total > 0 && cfg.coinEnabled !== false) {
        try {
            await grantCoin(uid, total, makeup ? `补签 ${date}` : `签到（连续 ${nextStreak} 天）`);
        } catch (e) {
            ctx().logger?.error?.(`[clientgw] 发硬币失败 uid=${uid} amount=${total}: ${(e as Error).message}`);
        }
    }

    return {
        date, streak: nextStreak, reward: total, base, bonus, bonusLabel,
        totalDays: state.totalDays + 1, totalReward: state.totalReward + total,
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
 * 发硬币。
 *
 * ⚠️ **这一处必须按你服务器上装的那个硬币插件来调**。33OJ 那套 `coin-33oj` 的做法是
 * 「用户文档上一个记数量的字段 + 一张账单表」，所以这里默认直接写库；
 * 换成别的硬币插件时，改 index.ts 的配置即可（或在这里加一个分支）。
 *
 * 怎么确认字段名：见 README「对接硬币」一节（一条 mongosh 命令就能看出来）。
 */
export async function grantCoin(uid: number, amount: number, note: string) {
    const c = ctx();
    const userColl = c.db.collection(cfg.coinUserCollection || 'user');
    const field = cfg.coinUserField || 'coin';
    const r = await userColl.updateOne({ _id: uid }, { $inc: { [field]: amount } });

    // ⚠️ 匹配不到用户时 updateOne **不报错**，只是 matchedCount = 0 —— 硬币会**静默消失**。
    //    最常见的触发原因就是硬币字段名配错了（拿不到就查不到，见 README 第五节）。
    //    所以这里必须显式检查并抛错，让调用方知道「这次没发出去」。
    if (!r || !r.matchedCount) {
        throw new Error(
            `发硬币失败：${cfg.coinUserCollection || 'user'} 里没有 uid=${uid}，`
            + `或字段 ${field} 配错了（检查插件配置）`,
        );
    }

    await c.db.collection(cfg.coinBillCollection || 'coin.bill').insertOne({
        uid, amount, note, ts: new Date(),
    });
}

/** 读余额（同样按上面的假设）。 */
export async function coinBalance(uid: number): Promise<number> {
    const c = ctx();
    const field = cfg.coinUserField || 'coin';
    const d = await c.db.collection(cfg.coinUserCollection || 'user').findOne(
        { _id: uid }, { projection: { [field]: 1 } },
    );
    return (d && Number(d[field])) || 0;
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
    const field = cfg.coinUserField || 'coin';
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

    // ---- 集合清单（顺便找出像账单的那个）----
    let collections: string[] = [];
    try {
        const all = await c.db.listCollections().toArray();
        collections = all.map((x: any) => x.name);
    } catch { /* 有些权限读不到清单，不影响主判断 */ }

    const billColl = cfg.coinBillCollection || 'coin.bill';
    const billCollectionExists = collections.includes(billColl);
    let billCount = 0;
    if (billCollectionExists) {
        try { billCount = await c.db.collection(billColl).countDocuments({}); } catch { /* 忽略 */ }
    }

    // ⭐ 给出建议：名字里带 coin/money/score 的字段、含 coin 的集合
    const guessWords = ['coin', 'coins', 'money', 'score', 'point', 'points'];
    const suggestedField = numericFields.find((k) => guessWords.some((w) => k.toLowerCase().includes(w))) || null;
    const suggestedBillCollection = collections.find((n) => /coin/i.test(n) && n !== uColl) || null;

    if (!fieldExists) issues.push(`硬币字段 ${uColl}.${field} 读不到 —— 发币会失败，检查 coinUserField`);
    if (!billCollectionExists) issues.push(`账单集合 ${billColl} 不在库里 —— 检查 coinBillCollection`);
    if (fieldExists && suggestedField && suggestedField !== field) {
        issues.push(`${uColl} 上还有个像硬币的字段 \`${suggestedField}\`，确认哪个才是余额`);
    }
    if (!billCollectionExists && suggestedBillCollection) {
        issues.push(`发现一个更像账单的集合 \`${suggestedBillCollection}\``);
    }
    if (collections.length) {
        const coinish = collections.filter((n) => /coin/i.test(n));
        if (coinish.length && !coinish.includes(billColl)) {
            issues.push(`库里含 coin 的集合有：${coinish.join('、')}`);
        }
    }

    // ---- 签到自己的表 ----
    let logCount = 0;
    try {
        logCount = await c.db.collection(cfg.checkinLogCollection || 'clientgw.checkin_log').countDocuments({});
    } catch { /* 第一次装还没有这张表，正常 */ }

    const summary = issues.length
        ? `有 ${issues.length} 处配置要确认`
        : `配置正常（${uColl}.${field}${sampleValue === null ? '' : ` = ${sampleValue}`}，账单 ${billColl} ${billCount} 条）`;

    return {
        summary, issues,
        coin: {
            userCollection: uColl, userField: field, fieldExists, sampleValue, numericFields,
            billCollection: billColl, billCollectionExists, billCount,
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
