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
} from './.build/model.ts';
import { dateKey, today, prevDay } from './.build/lib.ts';

// ---------------------------------------------------------------- 假存储

function match(doc: any, q: any): boolean {
    for (const [k, v] of Object.entries(q)) {
        const dv = doc[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const o: any = v;
            if ('$in' in o) { if (!o.$in.map(String).includes(String(dv))) return false; continue; }
            if ('$ne' in o) { if (String(dv) === String(o.$ne)) return false; continue; }
            if ('$gte' in o) { if (!(dv >= o.$gte)) return false; continue; }
            if ('$lte' in o) { if (!(dv <= o.$lte)) return false; continue; }
            if ('$gt' in o) { if (!(dv > o.$gt)) return false; continue; }
            if ('$lt' in o) { if (!(dv < o.$lt)) return false; continue; }
            throw new Error('假存储不支持这个查询子句: ' + k + ' ' + JSON.stringify(o));
        }
        if (String(dv) !== String(v)) return false;
    }
    return true;
}

function applyUpdate(doc: any, upd: any) {
    if (upd.$set) for (const [k, v] of Object.entries(upd.$set)) doc[k] = v;
    if (upd.$inc) for (const [k, v] of Object.entries(upd.$inc)) doc[k] = (Number(doc[k]) || 0) + Number(v);
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

    console.log(`\n${'='.repeat(46)}`);
    console.log(`结果：通过 ${pass}　失败 ${fail}`);
    if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
    console.log('='.repeat(46));
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n测试自身抛异常：', e); process.exit(2); });
