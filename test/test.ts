/**
 * 插件逻辑的真实运行测试（不依赖 Hydro / MongoDB）。
 *
 * 做法：把 model.ts 原样搬过来（只改两处 import 的解析路径），
 * 用一个「够用的假 collection」当存储，然后跑完整流程。
 *
 * ⚠️ 这是**逻辑级**验证，不是 MongoDB 集成测试 —— 唯一索引冲突是我在假 collection 里
 * 模拟出来的。它验的是「代码路径对不对」（连续天数、幂等、补签、并发），
 * 而 MongoDB 本身的行为不需要我来验。
 */
import {
    init, doCheckin, getState, getCalendar, getRank, calcReward,
    issueToken, verifyToken, revokeTokens, listTokens,
    issuePairCode, consumePairCode, coinBalance, grantCoin, diagnose,
    computeStreak, countBack, longestRun, loadCheckinDays, repairCheckin,
} from './.build/model.ts';
import { dateKey, today, prevDay, resolveRecordScope } from './.build/lib.ts';
// 通知的两个 handler：这里跑的是**真实 handler 代码**（只把 import 路径改写成本机能跑的）
import {
    NotificationsHandler, NotificationReadHandler,
} from './.build/handler/system.ts';
// 签到的三个 handler：RepairHandler 的权限门、补签文案、打卡联动能量都在这里跑真代码
import {
    CheckinDoHandler, CheckinStatusHandler, CheckinMakeupHandler, CheckinRepairHandler,
} from './.build/handler/checkin.ts';
import {
    initPoints, grantCheckinPoints, pointsBalance, TASKS,
} from './.build/points.ts';
import {
    unreadFilter, readMark, isReadBy,
} from './.build/notify.ts';
// prepare.mjs 生成的 hydrooj 替身（只提供 ObjectId / Handler）—— 批量已读要用真 ObjectId
import { ObjectId } from './.build/_hydro.ts';

// ---------------------------------------------------------------- 假存储

/** 点号路径取值：Mongo 的 `readBy.5` 指「readBy 字段下面的 5 字段」，不是字面字段名。 */
function getPath(doc: any, path: string): any {
    if (!path.includes('.')) return doc[path];
    let cur = doc;
    for (const k of path.split('.')) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[k];
    }
    return cur;
}

/** 点号路径写值：Mongo 的 `$set: { 'readBy.5': x }` 会把中间层自动建成对象。 */
function setPath(doc: any, path: string, val: any) {
    if (!path.includes('.')) { doc[path] = val; return; }
    const ks = path.split('.');
    let cur = doc;
    for (const k of ks.slice(0, -1)) {
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
        cur = cur[k];
    }
    cur[ks[ks.length - 1]] = val;
}

function match(doc: any, q: any): boolean {
    for (const [k, v] of Object.entries(q)) {
        const dv = getPath(doc, k);
        if (v && typeof v === 'object' && !Array.isArray(v)
            && Object.keys(v).some((x) => x.startsWith('$'))) {
            const o: any = v;
            if ('$exists' in o) { if (!!o.$exists !== (dv !== undefined)) return false; continue; }
            if ('$in' in o) { if (!o.$in.map(String).includes(String(dv))) return false; continue; }
            if ('$ne' in o) { if (String(dv) === String(o.$ne)) return false; continue; }
            if ('$gte' in o) { if (!(dv >= o.$gte)) return false; continue; }
            if ('$lte' in o) { if (!(dv <= o.$lte)) return false; continue; }
            if ('$gt' in o) { if (!(dv > o.$gt)) return false; continue; }
            if ('$lt' in o) { if (!(dv < o.$lt)) return false; continue; }
            throw new Error('假存储不支持这个查询子句: ' + k + ' ' + JSON.stringify(o));
        }
        // Mongo 的隐式数组匹配：`{to: 5}` 能匹配 `to: [5, 7]`（私信群发就是这种文档）
        if (Array.isArray(dv)) {
            if (!dv.some((x) => String(x) === String(v))) return false;
            continue;
        }
        if (String(dv) !== String(v)) return false;
    }
    return true;
}

function applyUpdate(doc: any, upd: any) {
    if (upd.$set) for (const [k, v] of Object.entries(upd.$set)) setPath(doc, k, v);
    if (upd.$inc) for (const [k, v] of Object.entries(upd.$inc)) {
        setPath(doc, k, (Number(getPath(doc, k)) || 0) + Number(v));
    }
}

function makeDB() {
    const store = new Map<string, { docs: any[]; uniq: string[][] }>();
    return {
        collection(name: string) {
            if (!store.has(name)) store.set(name, { docs: [], uniq: [] });
            const c = store.get(name)!;
            return {
                async createIndex(keys: any, opts?: any) {
                    if (opts && opts.unique) c.uniq.push(Object.keys(keys));
                    return 'ok';
                },
                async insertOne(doc: any) {
                    // 模拟唯一索引（签到幂等的物理保证）
                    for (const ks of c.uniq) {
                        if (c.docs.some((d) => ks.every((k) => String(d[k]) === String(doc[k])))) {
                            const e: any = new Error('E11000 duplicate key error');
                            e.code = 11000;
                            throw e;
                        }
                    }
                    c.docs.push({ ...doc });
                    return { acknowledged: true, insertedId: doc._id };
                },
                async findOne(q: any) { return c.docs.find((d) => match(d, q)) ?? null; },
                find(q: any) {
                    let arr = c.docs.filter((d) => match(d, q));
                    const cur: any = {
                        sort(spec: any) {
                            arr = arr.slice().sort((a, b) => {
                                for (const [k, dir] of Object.entries(spec)) {
                                    const av = a[k]; const bv = b[k];
                                    if (av === bv) continue;
                                    return (av > bv ? 1 : -1) * (Number(dir) < 0 ? -1 : 1);
                                }
                                return 0;
                            });
                            return cur;
                        },
                        skip(n: number) { arr = arr.slice(n); return cur; },
                        limit(n: number) { arr = arr.slice(0, n); return cur; },
                        async toArray() { return arr.map((d) => ({ ...d })); },
                    };
                    return cur;
                },
                async updateOne(q: any, upd: any, opts?: any) {
                    let d = c.docs.find((x) => match(x, q));
                    if (!d && opts && opts.upsert) {
                        d = {};
                        for (const [k, v] of Object.entries(q)) if (typeof v !== 'object') d[k] = v;
                        c.docs.push(d);
                    }
                    if (!d) return { matchedCount: 0, modifiedCount: 0 };
                    applyUpdate(d, upd);
                    return { matchedCount: 1, modifiedCount: 1 };
                },
                async updateMany(q: any, upd: any) {
                    let n = 0;
                    for (const d of c.docs) if (match(d, q)) { applyUpdate(d, upd); n += 1; }
                    return { matchedCount: n, modifiedCount: n };
                },
                async countDocuments(q: any) {
                    return c.docs.filter((d) => match(d, q || {})).length;
                },
                // byConv 用它做「按 from 分组计数」。只支持插件真正用到的那两个阶段，
                // 遇到别的阶段直接抛 —— 别让假存储悄悄把错管道的测试变成「永远是 {}」。
                aggregate(pipeline: any[]) {
                    let arr = c.docs.slice();
                    for (const stage of pipeline) {
                        if (stage && stage.$match) {
                            const q = stage.$match;
                            arr = arr.filter((d) => match(d, q));
                        } else if (stage && stage.$group) {
                            const g = stage.$group;
                            const key = String(g._id).replace(/^\$/, '');   // '$from' → 'from'
                            const sumField = Object.keys(g).find((k) => k !== '_id');
                            if (!sumField || g[sumField].$sum !== 1) {
                                throw new Error('假存储只支持 { $sum: 1 }');
                            }
                            const acc = new Map<any, any>();
                            for (const d of arr) {
                                const k = getPath(d, key);
                                const cur = acc.get(k) ?? { _id: k, [sumField]: 0 };
                                cur[sumField] += 1;
                                acc.set(k, cur);
                            }
                            arr = [...acc.values()];
                        } else {
                            throw new Error('假存储不支持这个聚合阶段: ' + JSON.stringify(stage));
                        }
                    }
                    return { toArray: async () => arr.map((d) => ({ ...d })) };
                },
                // diagnose 用它试探「这个集合在不在、有多少条」
                async estimatedDocumentCount() { return c.docs.length; },
            };
        },
        // diagnose 靠它列集合清单
        listCollections() {
            return {
                async toArray() { return [...store.keys()].map((name) => ({ name })); },
            };
        },
    };
}

// ---------------------------------------------------------------- 断言

let pass = 0; let fail = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, extra = '') {
    if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
    else { fail += 1; fails.push(name); console.log(`  [FAIL] ${name}${extra ? '   ' + extra : ''}`); }
}
function eq(name: string, got: any, want: any) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    check(ok ? name : `${name}`, ok, ok ? '' : `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------- 开跑

const db: any = makeDB();
const CFG = {
    dailyCoins: 1,
    streakBonus: [
        { day: 3, coins: 2, label: '连续 3 天' },
        { day: 7, coins: 5, label: '连续 7 天' },
    ],
    makeupCost: 5, makeupWindow: 3, makeupReward: 0,
    coinEnabled: true,
    // ⚠️ 这几个默认值 = 站点上 coin-33oj 的**真实结构**（2026-10-11 对着它源码核过）：
    //    账单集合叫 `coin`（不是 `coin.bill`），文档形如 {userId, rootId, amount, text}。
    coinUserCollection: 'user', coinUserField: 'coin_now', coinAllField: 'coin_all',
    coinBillCollection: 'coin',
    checkinCollection: 'clientgw.checkin', checkinLogCollection: 'clientgw.checkin_log',
    tokenCollection: 'clientgw.token', pairCollection: 'clientgw.pair',
    tokenTtlDays: 365,
};
init({ db } as any, CFG);

async function main() {
    // 预置用户：真实环境下 uid 一定存在（他得先登录才能签到），
    // 而且硬币就写在用户文档的这个字段上。
    for (const uid of [5, 7, 100, 101, 102, 103, 104]) {
        await db.collection('user').insertOne({ _id: uid, uname: `u${uid}`, coin_now: 0, coin_all: 0 });
    }

    section('1. 时间（固定 Asia/Shanghai）');
    check('today() 格式', /^\d{4}-\d{2}-\d{2}$/.test(today()), today());
    eq('prevDay(2026-10-01)', prevDay('2026-10-01'), '2026-09-30');
    eq('prevDay(2026-10-01) 跨月', prevDay('2026-01-01'), '2025-12-31');
    eq('prevDay 跨月（3/1）', prevDay('2026-03-01'), '2026-02-28');
    eq('prevDay 跨闰年（2028/3/1）', prevDay('2028-03-01'), '2028-02-29');
    // ⭐ 时区边界：UTC 16:30 已经是上海的第二天 00:30
    eq('UTC 16:30 → 上海次日', dateKey(new Date('2026-10-05T16:30:00Z')), '2026-10-06');
    eq('UTC 15:30 → 上海当天', dateKey(new Date('2026-10-05T15:30:00Z')), '2026-10-05');

    section('2. 签到：首次 / 幂等');
    const U = 100;
    let r = await doCheckin(U, { date: '2026-10-01' });
    eq('首次 streak', r.streak, 1);
    eq('首次 reward = 基础 1', r.reward, 1);
    check('首次不是 already', !r.already);
    r = await doCheckin(U, { date: '2026-10-01' });
    eq('同日再签 already=true', r.already, true);
    eq('同日再签 reward=0', r.reward, 0);

    section('3. 连续天数 + 连签奖励');
    r = await doCheckin(U, { date: '2026-10-02' });
    eq('第 2 天 streak', r.streak, 2);
    r = await doCheckin(U, { date: '2026-10-03' });
    eq('第 3 天 streak', r.streak, 3);
    eq('第 3 天 bonus', r.bonus, 2);
    eq('第 3 天总奖励', r.reward, 3);

    section('4. 断一天 → 重置');
    r = await doCheckin(U, { date: '2026-10-06' });   // 10-05 没签
    eq('断签后 streak 重置为 1', r.streak, 1);
    eq('断签后 reward 回到 1', r.reward, 1);

    section('5. 连签 7 天 / 累计');
    const U2 = 101;
    let r7: any = null;
    for (let i = 1; i <= 7; i += 1) {
        const d = `2026-09-${String(i).padStart(2, '0')}`;
        r7 = await doCheckin(U2, { date: d });
    }
    eq('第 7 天 streak', r7.streak, 7);
    eq('第 7 天 bonus', r7.bonus, 5);
    const st2 = await getState(U2);
    eq('总天数', st2.totalDays, 7);
    eq('最大连续', st2.maxStreak, 7);

    section('6. 发硬币（对接 coin-33oj 的字段）');
    const u2 = await db.collection('user').findOne({ _id: U2 });
    eq('U2 硬币 = 7 基础 + 2 + 5', u2.coin_now, 14);
    // 累计获得也要跟着涨 —— 站点硬币榜是 find({coin_all:{$exists:true}}) 筛出来的
    eq('U2 累计获得', u2.coin_all, 14);
    // ⭐ 账单必须落在**站点插件读的那个集合**里，字段也要对得上，
    //    否则签到发的币在站点流水里根本不出现（2026-10-11 的线上事故）。
    const bills = (await db.collection('coin').find({}).toArray()).filter((b: any) => b.userId === U2);
    eq('U2 账单条数', bills.length, 7);
    eq('账单金额合计', bills.reduce((s: number, b: any) => s + b.amount, 0), 14);
    check('账单字段是站点形状 {userId,rootId,amount,text}',
        bills.every((b: any) => 'userId' in b && 'rootId' in b && 'amount' in b && 'text' in b),
        JSON.stringify(bills[0]));
    eq('coinBalance 读到同一个数', await coinBalance(U2), 14);

    section('7. 并发签到（幂等的物理保证）★');
    const U3 = 102;
    const [a, b] = await Promise.all([
        doCheckin(U3, { date: '2026-10-09' }),
        doCheckin(U3, { date: '2026-10-09' }),
    ]);
    eq('两个并发只有 1 个真签到', [a, b].filter((x) => !x.already).length, 1);
    const u3 = await db.collection('user').findOne({ _id: U3 });
    eq('并发下只发了一次硬币', u3 ? u3.coin_now : 0, 1);
    eq('并发下流水只有 1 条', (await db.collection('clientgw.checkin_log').find({ uid: U3 }).toArray()).length, 1);

    section('8. 补签');
    const U4 = 103;
    await doCheckin(U4, { date: '2026-10-07' });
    const mk = await doCheckin(U4, { date: '2026-10-05', makeup: true });
    check('补签成功', !mk.already);
    eq('补签不给基础奖励', mk.reward, 0);
    eq('补签后总天数', (await getState(U4)).totalDays, 2);
    const mk2 = await doCheckin(U4, { date: '2026-10-05', makeup: true });
    eq('重复补签 already=true', mk2.already, true);

    section('9. 日历 / 排行');
    const cal = await getCalendar(U, '2026-10');
    eq('U 在 10 月签过的日子', cal.days.filter((d) => d.signed).map((d) => d.date),
        ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06']);
    eq('10 月天数', cal.days.length, 31);
    const rank = await getRank('total', 10);
    check('排行按总天数降序', rank.length >= 3 && rank[0].totalDays >= rank[rank.length - 1].totalDays,
        JSON.stringify(rank.map((x) => x.totalDays)));

    section('10. 客户端令牌');
    const tk = await issueToken(5, '测试设备', '127.0.0.1');
    check('签发返回长字符串', typeof tk === 'string' && tk.length > 20, String(tk).slice(0, 12));
    const info = await verifyToken(tk, '127.0.0.1');
    eq('校验拿回 uid', info ? info.uid : null, 5);
    eq('拿回设备名', info ? info.name : null, '测试设备');
    eq('乱填令牌 → null', await verifyToken('not-a-real-token'), null);
    eq('空令牌 → null', await verifyToken(''), null);
    const devs = await listTokens(5);
    check('设备列表能列出刚签发的设备', devs.some((d: any) => d.name === '测试设备'), JSON.stringify(devs));
    await revokeTokens(5, undefined, undefined);
    eq('撤销后 → null', await verifyToken(tk), null);
    eq('撤销后设备列表清空', (await listTokens(5)).length, 0);

    section('11. 令牌只存哈希（不存明文）');
    const raw = await issueToken(7, 'dev', 'ip');
    const rows = await db.collection('clientgw.token').find({}).toArray();
    check('库里没有明文令牌', rows.every((d: any) => d.tokenHash !== raw));
    check('tokenHash 是 64 位 hex', rows.some((d: any) => typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash)));

    section('12. 配对码（网页 → 客户端）');
    const code = await issuePairCode(5);
    check('6 位数字', /^\d{6}$/.test(code), code);
    const pr = await consumePairCode(code, '设备A', '10.0.0.1');
    eq('换取令牌成功', pr ? pr.uid : null, 5);
    check('配对码一次性', (await consumePairCode(code, '设备B', '10.0.0.2')) === null);

    section('13. 奖励计算（边界）');
    eq('streak=0 只给基础', calcReward(0).total, 1);
    eq('streak=3 有 bonus', calcReward(3).bonus, 2);
    eq('streak=7 有 bonus', calcReward(7).bonus, 5);
    eq('streak=6 不命中「连续 3 天」（里程碑语义）', calcReward(6).bonus, 0);
    eq('streak=10 无 bonus', calcReward(10).bonus, 0);
    eq('streak=14 无 bonus（未开 repeat）', calcReward(14).bonus, 0);
    eq('补签默认不再给基础', calcReward(5, true).total, 0);

    section('14. 发硬币的健壮性（不能静默丢币）');
    try {
        await grantCoin(999999, 5, '不存在的用户');
        check('给不存在的 uid 发币会抛错', false, '居然没抛');
    } catch (e) {
        check('给不存在的 uid 发币抛错', /发硬币失败/.test((e as Error).message), (e as Error).message.slice(0, 40));
    }
    // 正常发币仍然要成功
    const before = await coinBalance(104);
    await grantCoin(104, 30, '测试发放');
    eq('正常发币生效', await coinBalance(104), before + 30);
    eq('发币后账单多一条', (await db.collection('coin').find({ userId: 104 }).toArray()).length, 1);

    section('15. 自检诊断（硬币字段配错能不能发现）★');
    const dg = await diagnose(101);
    check('诊断跑通', !!dg.summary, dg.summary);
    eq('认出了硬币字段', dg.coin.fieldExists, true);
    eq('读到余额', dg.coin.sampleValue, 14);
    check('列出了数字字段', dg.coin.numericFields.includes('coin_now'), JSON.stringify(dg.coin.numericFields));
    check('配置正确时无误报', dg.issues.length === 0, JSON.stringify(dg.issues));
    eq('账单集合也在库里', dg.coin.billCollectionExists, true);
    check('自检报出账单真实字段名', dg.coin.billFields.includes('userId') && dg.coin.billFields.includes('text'),
        JSON.stringify(dg.coin.billFields));

    // ⭐ 把字段配错，诊断必须发现并给出建议（否则装上后会静默丢币）
    init({ db } as any, { ...CFG, coinUserField: 'totally_wrong_field' });
    const dg2 = await diagnose(101);
    check('字段配错会被发现', dg2.issues.some((i) => /读不到/.test(i)), JSON.stringify(dg2.issues));
    eq('给出建议字段名', dg2.coin.suggestedField, 'coin_now');
    check('summary 点出有问题', /要确认/.test(dg2.summary), dg2.summary);

    // 恢复正确配置
    init({ db } as any, CFG);

    section('16. 优先走站点硬币插件的 inc()（避免写错集合/字段）★');
    {
        const calls: any[] = [];
        // 模拟 coin-33oj：4 参 inc(userId, rootId, amount, text)，内部写账单 + 涨两个字段
        (globalThis as any).Hydro = {
            model: {
                coin: {
                    async inc(userId: number, rootId: number, amount: number, text: string) {
                        calls.push([userId, rootId, amount, text]);
                        await db.collection('coin').insertOne({ userId, rootId, amount, text });
                        await db.collection('user').updateOne(
                            { _id: userId }, { $inc: { coin_now: amount, coin_all: amount } },
                        );
                    },
                },
            },
        };
        const U9 = 106;
        await db.collection('user').insertOne({ _id: U9, uname: 'u106', coin_now: 0, coin_all: 0 });
        await grantCoin(U9, 7, '走站点 inc');
        eq('调用了站点 inc 一次', calls.length, 1);
        eq('参数是 (uid, rootId=0, amount, text)', calls[0], [U9, 0, 7, '走站点 inc']);
        const u9 = await db.collection('user').findOne({ _id: U9 });
        eq('余额由站点 inc 维护', u9.coin_now, 7);
        eq('账单没被重复记一条', (await db.collection('coin').find({ userId: U9 }).toArray()).length, 1);

        // ⭐ 参数个数不是 4 → 不敢调（照 4 参传会把金额塞到 rootId 上，比不调还糟）
        (globalThis as any).Hydro = {
            model: { coin: { async inc(a: any, b: any, c: any) { calls.push(['WRONG', a, b, c]); } } },
        };
        const U10 = 107;
        await db.collection('user').insertOne({ _id: U10, uname: 'u107', coin_now: 0, coin_all: 0 });
        await grantCoin(U10, 3, '三参不敢调');
        eq('参不上时退回自己写库', (await db.collection('user').findOne({ _id: U10 })).coin_now, 3);
        check('没有误调三参 inc', !calls.some((c) => c[0] === 'WRONG'), JSON.stringify(calls));
        (globalThis as any).Hydro = undefined;
    }

    section('17. 提交列表的权限门（与网页端同规则）★');
    {
        // 规则来源：Hydro handler/record.ts —— `if (q.uid !== this.user._id) checkPerm(PERM_VIEW_RECORD)`
        // 也就是「不带 uid 查全部」和「查别人」都要权限。
        const ME = 5;
        const OTHER = 9;

        // ---- 有权限的人 ----
        let s = resolveRecordScope({ mine: false, uid: 0, clientUid: ME, canViewAll: true });
        check('有权限·不带 uid → 不拒', !s.deny);
        eq('有权限·不带 uid → 全部用户(0)', s.uid, 0);

        s = resolveRecordScope({ mine: false, uid: OTHER, clientUid: ME, canViewAll: true });
        check('有权限·查别人 → 不拒', !s.deny);
        eq('有权限·查别人 → 保留该 uid', s.uid, OTHER);

        // ---- 没权限的人 ----
        s = resolveRecordScope({ mine: false, uid: 0, clientUid: ME, canViewAll: false });
        check('无权限·不带 uid → 不拒（这是默认视图）', !s.deny);
        eq('无权限·不带 uid → 收敛成自己', s.uid, ME);

        s = resolveRecordScope({ mine: false, uid: OTHER, clientUid: ME, canViewAll: false });
        check('无权限·指名别人 → 必须拒（越权）★', s.deny);

        s = resolveRecordScope({ mine: false, uid: ME, clientUid: ME, canViewAll: false });
        check('无权限·查自己 → 不拒', !s.deny);
        eq('无权限·查自己 → uid 是自己', s.uid, ME);

        // mine=1 是「我的提交」，任何权限下都只能是自己的 —— 防的是
        // 「同时传 mine=1 和 uid=别人」这种绕过（mine 优先）。
        s = resolveRecordScope({ mine: true, uid: OTHER, clientUid: ME, canViewAll: false });
        eq('mine=1 时忽略 uid（无权限）', s.uid, ME);
        s = resolveRecordScope({ mine: true, uid: OTHER, clientUid: ME, canViewAll: true });
        eq('mine=1 时忽略 uid（有权限）', s.uid, ME);
    }

    section('18. 私信已读：跟着账号走 + 多收件人互不干扰 ★');
    {
        const A = 201; const B = 202;
        await db.collection('user').insertOne({ _id: A, uname: 'ua', unreadMsg: 99 });
        await db.collection('user').insertOne({ _id: B, uname: 'ub', unreadMsg: 99 });
        const msg = db.collection('message');

        // 一条消息发给两个人（to 是数组）—— 老写法「一人读 = 所有人已读」就炸在这种文档上
        await msg.insertOne({ _id: 'm-shared', from: 1, to: [A, B], content: '群发' });
        // 老数据：老插件只写了 read: true，没有 readBy
        await msg.insertOne({
            _id: 'm-legacy', from: 1, to: A, content: '老消息', read: true,
        });
        await msg.insertOne({ _id: 'm-a', from: 1, to: A, content: '只发给 A' });
        // 25 条，用来把「未读被 limit 截断」暴露出来
        for (let i = 0; i < 25; i += 1) {
            await msg.insertOne({
                _id: `m-bulk-${String(i).padStart(2, '0')}`, from: 1, to: A, content: `批量 ${i}`,
            });
        }

        // 直接调 ran()：绕过认证（认证另有测试），跑真实的 handler 代码
        const hctx = { db };
        const callHandler = async (Ctor: any, uid: number, params: any = {}) => {
            const h: any = Object.create(Ctor.prototype);
            h.clientUid = uid;
            h.args = {};
            h.request = { body: { ...params }, query: {}, headers: {}, ip: '127.0.0.1' };
            h.response = {};
            (h as any).ctx = hctx;
            await h.run();
            return h.response.body;
        };
        const get = (uid: number, limit = 20) => callHandler(NotificationsHandler, uid, { limit });
        const read = (uid: number, params: any) => callHandler(NotificationReadHandler, uid, params);

        // ---- (a) 未读数不受 limit 限制 ----
        let g = await get(A, 20);
        eq('A 未读 = 25 批量 + 群发 + 单独 = 27（limit 只有 20）', g.unread, 27);
        eq('A 只返回一页 20 条', g.messages.length, 20);
        check('旧写法会数成 ≤20，这里必须 > limit', g.unread > g.messages.length, `unread=${g.unread}`);
        eq('B 未读 = 1（只有群发那条）', (await get(B)).unread, 1);

        // ---- (b) A 读了，B 仍未读 ----
        const r1 = await read(A, { id: 'm-shared' });
        eq('A 单条已读成功', r1.updated, 1);
        const shared1 = await msg.findOne({ _id: 'm-shared' });
        check('只写了 A 的 readBy 格子', !!shared1.readBy?.[String(A)], JSON.stringify(shared1.readBy));
        check('没写 B 的 readBy 格子', shared1.readBy?.[String(B)] === undefined, JSON.stringify(shared1.readBy));
        check('没再写全局 read:true（那是老写法的坑）', shared1.read === undefined, String(shared1.read));

        g = await get(A);
        eq('A 读后未读 26', g.unread, 26);
        const mine = g.messages.find((m: any) => m.id === 'm-shared');
        eq('A 视角 read=true', mine.read, true);
        check('A 视角给了 readAt', typeof mine.readAt === 'string' && !Number.isNaN(Date.parse(mine.readAt)), String(mine.readAt));

        g = await get(B);
        eq('B 未读仍是 1（没被 A 带走）★', g.unread, 1);
        eq('B 视角 read 仍是 false ★', g.messages.find((m: any) => m.id === 'm-shared').read, false);

        // ---- 单条已读必须限定「我是收件人」----
        const r2 = await read(B, { id: 'm-a' });
        eq('B 读一条不属于自己的消息 → updated 0', r2.updated, 0);
        const ma = await msg.findOne({ _id: 'm-a' });
        check('B 的越权请求没写进 readBy', ma.readBy?.[String(B)] === undefined, JSON.stringify(ma.readBy));
        eq('A 的 m-a 仍未读', (await get(A, 100)).messages.find((m: any) => m.id === 'm-a').read, false);

        // ---- (c) 老数据 read:true 仍算已读 ----
        g = await get(A, 100);
        const legacy = g.messages.find((m: any) => m.id === 'm-legacy');
        eq('老数据 A 视角 read=true', legacy.read, true);
        eq('老数据没有 readAt', legacy.readAt, null);
        eq('老数据不计入未读', g.unread, 26);

        // ---- (d) all=1 只影响自己 ----
        const r3 = await read(A, { all: '1' });
        eq('A 全部已读 = 26 条（老数据那条不重复算）', r3.updated, 26);
        g = await get(A);
        eq('A 未读清零', g.unread, 0);
        check('A 这一页全部 read=true', g.messages.every((m: any) => m.read === true));

        g = await get(B);
        eq('B 未读不受影响 ★', g.unread, 1);
        eq('B 视角仍然未读 ★', g.messages.find((m: any) => m.id === 'm-shared').read, false);
        const shared2 = await msg.findOne({ _id: 'm-shared' });
        check('A 全读后仍没写全局 read', shared2.read === undefined, String(shared2.read));
        check('B 的格子仍然不存在', shared2.readBy?.[String(B)] === undefined, JSON.stringify(shared2.readBy));

        // ---- 顺手清 Hydro 网页端角标 ----
        eq('A 的 unreadMsg 被清零', (await db.collection('user').findOne({ _id: A })).unreadMsg, 0);
        eq('B 的 unreadMsg 没动', (await db.collection('user').findOne({ _id: B })).unreadMsg, 99);

        // 清角标失败不能影响已读本身（这步只是附赠）
        const realCollection = db.collection.bind(db);
        db.collection = (name: string) => {
            const c: any = realCollection(name);
            if (name === 'user') return { ...c, updateOne: async () => { throw new Error('模拟清角标失败'); } };
            return c;
        };
        const r4 = await read(A, { all: '1' });
        db.collection = realCollection;
        eq('清角标抛错时接口仍 ok', r4.ok, true);

        section('19. 已读查询本身（防手拼路径）★');
        eq('unreadFilter 用对象形式的点号路径', JSON.stringify(unreadFilter(A)),
            JSON.stringify({ to: A, [`readBy.${A}`]: { $exists: false }, read: { $ne: true } }));
        eq('readMark 只写自己那一格', Object.keys(readMark(A).$set), [`readBy.${A}`]);
        eq('isReadBy 认老数据', isReadBy({ read: true }, A), true);
        eq('isReadBy 不认别人的 readBy', isReadBy({ readBy: { [String(B)]: new Date() } }, A), false);
        eq('isReadBy 认自己的 readBy', isReadBy({ readBy: { [String(A)]: new Date() } }, A), true);
    }

    // =============================================================================================
    section('20. byConv 聚合 / conv= / ids= / 优先级 ★');
    {
        const hctx = { db };
        const callHandler = async (Ctor: any, uid: number, params: any = {}) => {
            const h: any = Object.create(Ctor.prototype);
            h.clientUid = uid;
            h.args = {};
            h.request = { body: { ...params }, query: {}, headers: {}, ip: '127.0.0.1' };
            h.response = {};
            (h as any).ctx = hctx;
            await h.run();
            return h.response.body;
        };
        const get = (uid: number, limit = 20) => callHandler(NotificationsHandler, uid, { limit });
        const read = (uid: number, params: any) => callHandler(NotificationReadHandler, uid, params);
        const msg = db.collection('message');
        const sum = (o: any) => Object.values(o || {}).reduce((s: any, x: any) => s + Number(x), 0);

        // ---------------------------------------------------------------- (a) byConv
        const A = 301; const B = 302;
        await db.collection('user').insertOne({ _id: A, uname: 'u301', unreadMsg: 0 });
        await db.collection('user').insertOne({ _id: B, uname: 'u302', unreadMsg: 0 });

        // 一条消息发给两个人：对 A、对 B **各算 1**（不是各算 0.5、也不是只算一个人）
        await msg.insertOne({ _id: 'c-shared', from: 11, to: [A, B], content: '群发' });
        await msg.insertOne({ _id: 'c-a1', from: 11, to: A, content: '11 的第二条' });
        await msg.insertOne({ _id: 'c-str', from: '12', to: A, content: 'from 存成字符串' });
        await msg.insertOne({ _id: 'c-num', from: 12, to: A, content: 'from 存成数字' });
        await msg.insertOne({ _id: 'c-legacy', from: 13, to: A, content: '老数据已读', read: true });
        await msg.insertOne({ _id: 'c-only-str', from: '14', to: A, content: '只有字符串 from' });

        let g = await get(A, 100);
        eq('byConv 按 from 分组计数', g.byConv, { 11: 2, 12: 2, 14: 1 });
        check('byConv 的 key 一律是字符串', Object.keys(g.byConv).every((k) => typeof k === 'string'),
            JSON.stringify(Object.keys(g.byConv)));
        eq('byConv 的数字/字符串 from 归到同一个会话', g.byConv['12'], 2);
        eq('byConv 老数据 read:true 不算未读', g.byConv['13'], undefined);
        eq('byConv 合计 == unread（同口径）', sum(g.byConv), g.unread);
        eq('A 未读 5', g.unread, 5);

        const gb = await get(B);
        eq('群发那条对 B 也算 1 ★', gb.byConv, { 11: 1 });
        eq('B 未读 1', gb.unread, 1);

        // 聚合失败（老库 / 缺权限）→ byConv 只能是 {}，unread / messages 照常，绝不能 500
        const realCollection = db.collection.bind(db);
        db.collection = (name: string) => {
            const c: any = realCollection(name);
            if (name === 'message') {
                return { ...c, aggregate: () => { throw new Error('模拟聚合失败（老库 / 缺权限）'); } };
            }
            return c;
        };
        const gFail = await get(A, 100);
        db.collection = realCollection;
        eq('聚合失败 → 不 500（ok 仍为 true）', gFail.ok, true);
        eq('聚合失败 → byConv = {}', gFail.byConv, {});
        eq('聚合失败 → unread 照常', gFail.unread, 5);
        eq('聚合失败 → messages 照常', gFail.messages.length, 6);

        // ---------------------------------------------------------------- (b) conv=
        const rb = await read(A, { conv: '12' });
        eq('conv=12 清掉 2 条', rb.updated, 2);
        eq('conv= 返回 scope="conv"', rb.scope, 'conv');
        g = await get(A, 100);
        eq('conv= 清完只剩 11 / 14', g.byConv, { 11: 2, 14: 1 });
        eq('A 未读 3（其他会话没被动）', g.unread, 3);
        eq('B 完全不受 A 的 conv= 影响 ★', (await get(B)).unread, 1);

        // from 存成字符串时也必须清得掉（只按 `$in: [Number, String]` 兜才走得通）
        const rb2 = await read(A, { conv: '14' });
        eq('conv=14 清掉 from 存成字符串的那条 ★', rb2.updated, 1);
        eq('清完只剩会话 11', (await get(A, 100)).byConv, { 11: 2 });

        // ---------------------------------------------------------------- (c) ids=
        const C = 303;
        await db.collection('user').insertOne({ _id: C, uname: 'u303', unreadMsg: 0 });
        const hexes = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)];
        for (let i = 0; i < hexes.length; i += 1) {
            await msg.insertOne({ _id: new ObjectId(hexes[i]), from: 21, to: C, content: `批量 ${i}` });
        }
        // 中间夹一个非法 id：跳过它，另外三个照常生效
        const rc = await read(C, { ids: `${hexes[0]}, ${hexes[1]} ,not-an-id, ${hexes[2]}` });
        eq('ids= 批量清 3 条（非法 id 跳过不报错）', rc.updated, 3);
        eq('ids= 返回 scope="ids"', rc.scope, 'ids');
        eq('C 未读清零', (await get(C)).unread, 0);

        // 截断：一次给 205 个，只认前 200 个
        const D = 304;
        await db.collection('user').insertOne({ _id: D, uname: 'u304', unreadMsg: 0 });
        const many: string[] = [];
        for (let i = 0; i < 205; i += 1) {
            const h = i.toString(16).padStart(24, '0');
            many.push(h);
            await msg.insertOne({ _id: new ObjectId(h), from: 22, to: D, content: `海量 ${i}` });
        }
        const rd = await read(D, { ids: many.join(',') });
        eq('ids= 超过 200 个时截断成 200', rd.updated, 200);
        eq('剩下 5 条仍未读 ★', (await get(D)).unread, 5);

        // ---------------------------------------------------------------- (d) 优先级
        const E = 305;
        await db.collection('user').insertOne({ _id: E, uname: 'u305', unreadMsg: 0 });
        for (let i = 0; i < 3; i += 1) {
            await msg.insertOne({ _id: `e-21-${i}`, from: 21, to: E, content: '会话 21' });
        }
        for (let i = 0; i < 2; i += 1) {
            await msg.insertOne({ _id: `e-22-${i}`, from: 22, to: E, content: '会话 22' });
        }
        const re = await read(E, { all: '1', conv: '21', ids: hexes[0] });
        eq('all + conv + ids 同时传 → 只按 all 走', re.scope, 'all');
        eq('按 all 清了全部 5 条', re.updated, 5);
        eq('all 之后未读清零', (await get(E)).unread, 0);

        const F = 306;
        await db.collection('user').insertOne({ _id: F, uname: 'u306', unreadMsg: 0 });
        const hex22 = 'd'.repeat(24);
        for (let i = 0; i < 3; i += 1) {
            await msg.insertOne({ _id: `f-21-${i}`, from: 21, to: F, content: '会话 21' });
        }
        await msg.insertOne({ _id: new ObjectId(hex22), from: 22, to: F, content: '会话 22 的可批量 id' });
        await msg.insertOne({ _id: 'f-22-1', from: 22, to: F, content: '会话 22' });

        const rf = await read(F, { conv: '21', ids: hex22 });
        eq('conv + ids 同时传 → 只按 conv 走', rf.scope, 'conv');
        eq('conv 只清 21 那 3 条（ids 被忽略）★', rf.updated, 3);
        eq('会话 22 那 2 条原封不动 ★', (await get(F)).unread, 2);

        // 都不给 → 保留原来的报错；单个 id → scope="one"
        const rEmpty = await read(F, {});
        eq('都不给参数 → ok=false（保留原提示）', rEmpty.ok, false);
        check('报错提示没变', /请给出消息 id，或传 all=1 全部已读/.test(String(rEmpty.error)), String(rEmpty.error));
        const rOne = await read(F, { id: hex22 });
        eq('单个 id → scope="one"', rOne.scope, 'one');
        eq('单个 id 只清 1 条', rOne.updated, 1);
        eq('清完剩 1 条未读', (await get(F)).unread, 1);
    }

    // =============================================================================================
    // 从这里起换成「线上配置」：makeupReward 1（补签不再纯亏）+ 打卡能量 100/10/200
    //
    // ⚠️ 上面那些段用的 CFG 是 makeupReward: 0 的老口径，**故意不动**它（历史断言原样保留）；
    //    新语义只在生产默认值下说得通，所以单独 re-init 一次。
    const CFG2 = {
        ...CFG,
        makeupReward: 1,
        checkinPoints: 100, checkinPointsPerDay: 10, checkinPointsCap: 200,
        checkinRepairCollection: 'clientgw.checkin_repair',
        adminUids: [5],
    };
    init({ db } as any, CFG2);
    initPoints({ db } as any, CFG2);

    /** 相对今天往前数 k 天（k = 0 就是今天）。连签这类测试必须用真实「今天」才验得出来。 */
    const D = (k: number) => dateKey(new Date(), -k);

    /** 跑真 handler（绕过认证，认证另有测试）。 */
    const callApi = async (Ctor: any, uid: number, params: any = {}) => {
        const h: any = Object.create(Ctor.prototype);
        h.clientUid = uid;
        h.args = {};
        h.request = { body: { ...params }, query: {}, headers: {}, ip: '127.0.0.1' };
        h.response = {};
        (h as any).ctx = { db };
        await h.run();
        return { ...(h.response.body || {}), _status: h.response.status };
    };
    const newUser = async (uid: number, coin = 0) => {
        await db.collection('user').insertOne({
            _id: uid, uname: `u${uid}`, coin_now: coin, coin_all: coin,
        });
    };

    section('21. 补签把断掉的链接回来（用户原话的复现）★');
    {
        const U20 = 400;
        await newUser(U20);
        // 连 5 天：D-6 … D-2
        for (let k = 6; k >= 2; k -= 1) await doCheckin(U20, { date: D(k) });
        eq('连 5 天后第 5 天的 streak', (await getState(U20)).maxStreak, 5);

        // 断 1 天（D-1）→ 今天签：必须从 1 重新算
        const r1 = await doCheckin(U20, { date: D(0) });
        eq('断 1 天后今天签 → streak 归 1', r1.streak, 1);
        eq('断链后 state.streak 也诚实为 1（不是旧值 5）★', (await getState(U20)).streak, 1);

        // 补签断的那一天
        const mk = await doCheckin(U20, { date: D(1), makeup: true });
        eq('补签日自己的连续数 = 6（不是「抄当前值」）', mk.streak, 6);
        const st = await getState(U20);
        eq('补签后立刻变 7 ★★', st.streak, 7);
        eq('补签后 lastDate = 今天', st.lastDate, D(0));
        eq('补签后 maxStreak = 7', st.maxStreak, 7);
        eq('总天数 = 5 + 今天 + 补签', st.totalDays, 7);

        // 用户看到的那个数字（/checkin/status）必须是 7 —— 原话「连续签到还是会重新计算」
        const stApi = await callApi(CheckinStatusHandler, U20, {});
        eq('接口 status.streak = 7 ★★', stApi.streak, 7);
        eq('接口 status.signed = true', stApi.signed, true);
        eq('接口 todayStreakIfSign = 7（今天已签）', stApi.todayStreakIfSign, 7);
    }

    section('22. 反向顺序：先补昨天、再签今天 ★');
    {
        const U21 = 401;
        await newUser(U21);
        for (let k = 5; k >= 2; k -= 1) await doCheckin(U21, { date: D(k) });   // D-5 … D-2（4 天）

        const mk = await doCheckin(U21, { date: D(1), makeup: true });          // 先补昨天
        eq('先补昨天：那天的连续数 = 5', mk.streak, 5);
        eq('补完昨天：当前连续 5（昨天 = 链还活着）', (await getState(U21)).streak, 5);

        const r = await doCheckin(U21, { date: D(0) });                         // 再签今天
        eq('再签今天 → 6', r.streak, 6);
        eq('state 同步到 6', (await getState(U21)).streak, 6);
        eq('累计 6 天', (await getState(U21)).totalDays, 6);
    }

    section('23. 补签日按「该日连续数」拿奖励（含里程碑）★');
    {
        const U22 = 402;
        await newUser(U22);
        for (let k = 7; k >= 2; k -= 1) await doCheckin(U22, { date: D(k) });   // D-7 … D-2（6 天）

        const mk = await doCheckin(U22, { date: D(1), makeup: true });          // 补第 7 天
        eq('补签日的连续数 = 7', mk.streak, 7);
        eq('补签日吃到「连续 7 天」里程碑 ★', mk.bonus, 5);
        eq('补签日实发 = 基础 1 + 里程碑 5', mk.reward, 6);
        eq('补签日的基础币不再是 0 ★', mk.base, 1);
        eq('里程碑文案', mk.bonusLabel, '连续 7 天');

        const row = await db.collection('clientgw.checkin_log').findOne({ uid: U22, date: D(1) });
        eq('流水里记的 streak/reward 是终值（不是占位 0）',
            [row.streak, row.reward, !!row.makeup], [7, 6, true]);
    }

    section('24. computeStreak：中间有洞 / 全是洞 / 只有今天 ★');
    {
        eq('countBack 纯函数（连 2 天）', countBack(new Set(['2026-01-01', '2026-01-02']), '2026-01-02'), 2);
        eq('countBack 纯函数（upto 当天没签 → 0）', countBack(new Set(['2026-01-01']), '2026-01-02'), 0);
        eq('longestRun 认最长的一段', longestRun(new Set(['2026-01-01', '2026-01-03', '2026-01-04'])), 2);

        const ONLY_TODAY = 403;
        await newUser(ONLY_TODAY);
        await doCheckin(ONLY_TODAY, { date: D(0) });
        eq('只有今天 → 1', await computeStreak(ONLY_TODAY, D(0)), 1);
        eq('只有今天 → 问昨天是 0', await computeStreak(ONLY_TODAY, D(1)), 0);
        eq('只有今天 → 问 D-3 是 0', await computeStreak(ONLY_TODAY, D(3)), 0);

        const HOLE = 404;
        await newUser(HOLE);
        await doCheckin(HOLE, { date: D(0) });
        await doCheckin(HOLE, { date: D(2) });                                  // D-1 留个洞
        eq('中间有洞：今天数 1 天就停 ★', await computeStreak(HOLE, D(0)), 1);
        eq('中间有洞：D-2 那天也是 1', await computeStreak(HOLE, D(2)), 1);
        eq('中间有洞：D-3 没签 → 0', await computeStreak(HOLE, D(3)), 0);
        eq('中间有洞：历史最长仍是 1', longestRun(await loadCheckinDays(HOLE)), 1);

        const EMPTY = 405;
        await newUser(EMPTY);
        eq('全是洞（从没签过）→ 0', await computeStreak(EMPTY, D(0)), 0);
        eq('全是洞 → 最多 0 天', longestRun(await loadCheckinDays(EMPTY)), 0);
    }

    section('25. 补发接口：dry / 真补 / 幂等 / force ★');
    {
        const U26 = 406;
        await newUser(U26);
        // 手工造一份「老 bug 留下的」流水：7 天连签全是 reward 0（线上就是这样少发的）
        for (let k = 7; k >= 1; k -= 1) {
            await db.collection('clientgw.checkin_log').insertOne({
                uid: U26, date: D(k), ts: new Date(), streak: 1, reward: 0, makeup: k === 3,
            });
        }
        // 应得：连 1..7 天 → 1+1+3+1+1+1+6 = 14（第 3 天 +2、第 7 天 +5）

        // ---- 非管理员：403，且不能写任何东西
        const deny = await callApi(CheckinRepairHandler, 7, { dry: '0', uid: U26 });
        eq('非管理员 → 403 ★', deny._status, 403);
        check('403 的提示是「只有管理员」', /只有管理员/.test(String(deny.error)), String(deny.error));
        eq('403 之后余额没动', (await db.collection('user').findOne({ _id: U26 })).coin_now, 0);

        // ---- 管理员：dry 默认 1
        const adm = await callApi(CheckinRepairHandler, 5, { uid: U26 });
        eq('管理员不传 dry → 默认 dry=1 ★', adm.dry, true);
        eq('体检报出 1 个人', adm.scanned, 1);
        eq('体检报出 1 个有差额', adm.affected, 1);
        eq('体检报出应补 14', adm.totalCoins, 14);
        eq('体检的明细路径对', [adm.users[0].uid, adm.users[0].days, adm.users[0].endStreak],
            [U26, 7, 7]);
        eq('体检时 paid=0', adm.users[0].paid, 0);

        // ---- dry=1（模型层，再确认一遍真的不写库）
        const rep1 = await repairCheckin({ dry: true, uid: U26 });
        eq('dry：expected 14', rep1.users[0].expected, 14);
        eq('dry：actual 0', rep1.users[0].actual, 0);
        eq('dry：diff 14', rep1.users[0].diff, 14);
        eq('dry：totalPaid 0', rep1.totalPaid, 0);
        eq('dry 不写库：余额还是 0 ★', (await db.collection('user').findOne({ _id: U26 })).coin_now, 0);
        eq('dry 不写库：没建 state 文档 ★',
            await db.collection('clientgw.checkin').findOne({ _id: U26 }), null);
        eq('dry 不写库：没建补发记录 ★',
            await db.collection('clientgw.checkin_repair').countDocuments({ _id: U26 }), 0);
        eq('dry 不写库：没写账单 ★',
            (await db.collection('coin').find({ userId: U26 }).toArray()).length, 0);

        // ---- dry=0：真补
        const rep2 = await repairCheckin({ dry: false, uid: U26 });
        eq('真补：paid = 14', rep2.users[0].paid, 14);
        eq('真补：totalPaid = 14', rep2.totalPaid, 14);
        const u26 = await db.collection('user').findOne({ _id: U26 });
        eq('真补：余额 +14 ★', u26.coin_now, 14);
        eq('真补：coin_all 也涨（硬币榜靠它筛人）★', u26.coin_all, 14);
        const bills26 = await db.collection('coin').find({ userId: U26 }).toArray();
        eq('真补：只写 1 张账单', bills26.length, 1);
        eq('真补：账单文案', bills26[0].text, '补签连续天数修正补发');

        const st26 = await db.collection('clientgw.checkin').findOne({ _id: U26 });
        eq('state.totalDays = 流水条数 ★', st26.totalDays, 7);
        eq('state.totalReward 按流水重算 = 14 ★', st26.totalReward, 14);
        eq('state.maxStreak = 最长一段 = 7', st26.maxStreak, 7);
        eq('state.streak = 7（最后签到日是昨天，链还活着）', st26.streak, 7);
        eq('state.lastDate = 昨天', st26.lastDate, D(1));

        // ---- 再跑一次：不二次补
        const rep3 = await repairCheckin({ dry: false, uid: U26 });
        eq('重复跑：paid = 0 ★★', rep3.users[0].paid, 0);
        eq('重复跑：totalPaid = 0', rep3.totalPaid, 0);
        eq('重复跑：余额不变 ★', (await db.collection('user').findOne({ _id: U26 })).coin_now, 14);
        eq('重复跑：账单没多', (await db.collection('coin').find({ userId: U26 }).toArray()).length, 1);
        eq('重复跑：仍报出同一处差额（诊断信息不丢）', rep3.users[0].diff, 14);

        // ---- force=1 才再补
        const rep4 = await repairCheckin({ dry: false, uid: U26, force: true });
        eq('force=1 才再补一次 ★', rep4.users[0].paid, 14);
        eq('force 后余额 28', (await db.collection('user').findOne({ _id: U26 })).coin_now, 28);
        const rep5 = await db.collection('clientgw.checkin_repair').findOne({ _id: U26 });
        eq('补发记录记着累计 28', rep5.paid, 28);
    }

    section('26. 打卡能量：100 / 140 / 300 + 一天只发一次 ★');
    {
        const P1 = 410; const P5 = 411; const P30 = 412; const P50 = 413; const P0 = 414;
        for (const u of [P1, P5, P30, P50, P0]) await newUser(u);

        eq('连签 1 天 → 100 ★', (await grantCheckinPoints(P1, 1)).points, 100);
        eq('连签 5 天 → 140 ★', (await grantCheckinPoints(P5, 5)).points, 140);
        eq('连签 30 天 → 300（封顶）★', (await grantCheckinPoints(P30, 30)).points, 300);
        eq('连签 50 天也还是 300（封顶只压加成）', (await grantCheckinPoints(P50, 50)).points, 300);
        eq('streak=0 只给基础 100', (await grantCheckinPoints(P0, 0)).points, 100);

        // 同一天重复发：幂等键 checkin:<uid>:<日期> 挡住
        const dup = await grantCheckinPoints(P1, 1);
        eq('同一天再发 → 0 分 ★★', dup.points, 0);
        eq('同日重复后余额仍是 100', await pointsBalance(P1), 100);
        eq('积分流水只 1 条',
            await db.collection('clientgw.points_log').countDocuments({ uid: P1 }), 1);
    }

    section('27. 打卡接口联动：能量 + 补签文案 ★');
    {
        const C1 = 420;
        await newUser(C1);
        const d1 = await callApi(CheckinDoHandler, C1, {});
        eq('打卡顺手发能量 100 ★', d1.points, 100);
        eq('打卡返回 streak = 1', d1.streak, 1);
        eq('status.streak = 1', d1.status.streak, 1);
        eq('status.signed = true', d1.status.signed, true);

        const d2 = await callApi(CheckinDoHandler, C1, {});
        eq('重复打卡 already', d2.already, true);
        eq('重复打卡不再给能量 ★', d2.points, 0);
        eq('重复打卡 streak 仍是 1（不是 0）', d2.streak, 1);

        // 补签文案要把实发硬币数说出来，否则「花 5 币」看着像纯亏
        const C2 = 421;
        await newUser(C2, 10);
        await doCheckin(C2, { date: D(2) });
        const mk = await callApi(CheckinMakeupHandler, C2, { date: D(1) });
        eq('补签成功', mk.ok, true);
        eq('补签成本 5', mk.cost, 5);
        eq('补签也发基础币（不再纯亏）★', mk.reward, 1);
        check('补签文案带实发硬币数 ★', /获得 1 硬币/.test(String(mk.message)), String(mk.message));

        // 任务表里的「完成今日打卡」是另一笔，改成 20
        eq('任务表 daily.checkin = 20 分 ★', TASKS.find((t) => t.id === 'daily.checkin')?.points, 20);
    }

    console.log(`\n${'='.repeat(46)}`);
    console.log(`结果：通过 ${pass}　失败 ${fail}`);
    if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
    console.log('='.repeat(46));
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n测试自身抛异常：', e); process.exit(2); });
