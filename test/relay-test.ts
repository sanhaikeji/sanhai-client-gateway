/**
 * 心跳中转（relay）的安全测试。
 *
 * <para>验的是**能不能被绕过** —— 这条链路一旦破，等于任意人能用任意用户身份操作 OJ
 * （看别人提交、发币、签到）。所以测的全是「应该被拒」的路径。</para>
 *
 * <para>跑法：node --experimental-strip-types test/relay-test.ts</para>
 */
import {
    RelayForwardHandler, registerRelayRoute,
} from './.build/handler/relay.ts';
import { ClientApiHandler } from './.build/handler/base.ts';
import { init, issueToken, verifyToken } from './.build/model.ts';

// ---------------------------------------------------------------- 假存储

/**
 * 够用的假 collection。
 * <para>⚠️ `findOne` **必须支持 `$ne`** —— 撤销检查靠的是
 * <c>{ tokenHash, revoked: { $ne: true } }</c>；不支持的话，
 * 「撤销的令牌还能用」这个漏洞在测试里就测不出来。</para>
 */
function fakeColl(docs: any[] = []) {
    const match = (d: any, q: any): boolean => Object.keys(q).every((k) => {
        const want = q[k];
        const got = d[k];
        if (want && typeof want === 'object' && !Array.isArray(want)) {
            if ('$ne' in want) return got !== want.$ne;
            if ('$exists' in want) return (got !== undefined) === !!want.$exists;
            return true;
        }
        return got === want;
    });
    return {
        async findOne(q: any) { return docs.find((d) => match(d, q)) || null; },
        async find(q: any) {
            const arr = docs.filter((d) => match(d, q));
            return {
                sort: () => ({ limit: () => ({ toArray: async () => arr.map((d) => ({ ...d })) }) }),
            };
        },
        async updateOne(q: any, u: any) {
            const d = docs.find((x) => match(x, q));
            if (d && u?.$set) Object.assign(d, u.$set);
            return { modifiedCount: d ? 1 : 0 };
        },
        async updateMany(q: any, u: any) {
            const hit = docs.filter((d) => match(d, q));
            for (const d of hit) if (u?.$set) Object.assign(d, u.$set);
            return { modifiedCount: hit.length };
        },
        async insertOne(d: any) { docs.push(d); return { insertedId: d._id }; },
        async countDocuments() { return docs.length; },
        async estimatedDocumentCount() { return docs.length; },
        createIndex: async () => {},
    };
}

/** 假 db：每个集合名对应一个数组。 */
function makeDB() {
    const store = new Map<string, any[]>();
    return {
        collection(name: string) {
            if (!store.has(name)) store.set(name, []);
            const docs = store.get(name);
            const c = fakeColl(docs);
            (c as any)._docs = docs;
            return c;
        },
        listCollections() {
            return { async toArray() { return [...store.keys()].map((name) => ({ name })); } };
        },
    };
}

// ---------------------------------------------------------------- 测试脚手架

const db: any = makeDB();

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

/**
 * 造一个能跑 handler 的假 ctx。
 * <para>⚠️ 装配方式照抄 test.ts 里既有的 callHandler：<c>Object.create(Ctor.prototype)</c>
 * + 手工塞字段 —— 因为 Hydro 的 Handler 基类构造函数会做一堆我们不需要的事，
 * 而 run() 真正用到的只有 request / response / ctx 这三样。</para>
 */
function fakeCtx(headers: Record<string, string> = {}, body: any = {}, query: any = {}) {
    const response: any = { status: 200, body: null, type: 'application/json' };
    const ctx: any = {
        request: { headers, body, query, ip: '10.0.0.5', method: 'POST' },
        response,
        db,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        Route: (name: string, _p: string, H: any) => { routes[name] = H; },
    };
    return ctx;
}

const routes: Record<string, any> = {};

/**
 * 造一个 handler 实例并直接调 run()（跳过框架生命周期）。
 */
async function runForward(ctx: any, params: any) {
    const h: any = Object.create((RelayForwardHandler as any).prototype);
    h.clientUid = 0;
    h.args = {};
    h.request = ctx.request;
    h.response = ctx.response;
    h.ctx = ctx;
    h.request.body = params;
    await h.run();
    return { status: ctx.response.status, body: ctx.response.body };
}

// ---------------------------------------------------------------- 开跑

console.log('\n=== 心跳中转：安全测试 ===\n');

// 1) 环境准备：给 model 一个假存储，让令牌能签发/校验
init({ db } as any, {
    tokenCollection: 'clientgw.token',
    checkinCollection: 'clientgw.checkin',
    checkinLogCollection: 'clientgw.checkin_log',
    checkinRepairCollection: 'clientgw.checkin_repair',
    pairCollection: 'clientgw.pair',
    tokenTtlDays: 365,
} as any);

// 2) 通道密钥
process.env.RELAY_CHANNEL_KEY = 'test-channel-key-0123456789';
const CHANNEL = 'test-channel-key-0123456789';

console.log('① 通道密钥校验');
{
    const r = await runForward(fakeCtx(), {
        userToken: 'x', path: '/client-api/ping', method: 'GET',
    });
    ok('没有通道密钥 → 拒绝', r.status === 401, `实际 ${r.status}`);
}
{
    const r = await runForward(fakeCtx({ 'x-channel-key': 'wrong-key' }), {
        userToken: 'x', path: '/client-api/ping', method: 'GET',
    });
    ok('通道密钥不对 → 拒绝', r.status === 401, `实际 ${r.status}`);
}
{
    // 正确的通道密钥 + 无效用户令牌 → 应该过通道校验、卡在用户令牌
    const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
        userToken: 'definitely-not-a-valid-token', path: '/client-api/ping', method: 'GET',
    });
    ok('通道密钥对但用户令牌无效 → 拒绝', r.status === 401, `实际 ${r.status} ${JSON.stringify(r.body)}`);
}

console.log('\n② 路径白名单（防 SSRF / 越权到别的路由）');
{
    // ⚠️ 这些用例必须配一个**有效的用户令牌**，否则会先在「验令牌」那步被拒（401），
    //    根本走不到路径检查 —— 那样测的就不是路径白名单了。
    const tok: string = await issueToken(99, 'path-test', '10.0.0.5');
    for (const bad of [
        '/admin/user',
        '/client-api/../../etc/passwd',
        'http://evil.com/x',
        '/client-api/ping?x=1',
        '/',
    ]) {
        const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
            userToken: tok, path: bad, method: 'GET',
        });
        // 路径非法 → 400
        ok(`拒绝非法路径 ${bad}`, r.status === 400, `实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
}

console.log('\n③ 缺参数');
{
    const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
        path: '/client-api/ping', method: 'GET',
    });
    ok('缺 userToken → 拒绝', r.status === 400, `实际 ${r.status}`);
}

console.log('\n④ 正常路径：令牌对 → 找到 handler 并代发');
{
    // 签一个真令牌
    const tok: string = await issueToken(5, 'test-device', '10.0.0.5');
    ok('令牌能签发', !!tok && tok.length > 20);

    // 注册一个假的 ping handler 到转发表
    // ⚠️ 它必须继承 ClientApiHandler（有 dispatch / clientUid / response），
    //    这样测的才是真实的代发路径 —— 继承自 RelayForwardHandler 会多一层 relay 逻辑。
    class FakePingHandler extends ClientApiHandler {
        protected async run() {
            // ⚠️ 这里把「我看到的」原样回传，测试才能看出代发时上下文对不对
            (this as any).response.body = {
                ok: true, pong: true,
                uid: (this as any).clientUid,
                sawUid: (this as any).clientUid,
                hasResponse: !!(this as any).response,
            };
        }
    }
    registerRelayRoute(fakeCtx() as any, 'client_api_ping', '/client-api/ping', FakePingHandler);

    const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
        userToken: tok, path: '/client-api/ping', method: 'GET',
    });
    ok('代发成功', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body));
    ok('代发时 uid 是令牌的主人（5）', r.body?.body?.uid === 5,
        `实际 uid=${r.body?.body?.uid}，完整=${JSON.stringify(r.body)}`);
}

console.log('\n⑤ 未知接口 → 404（不能静默通过）');
{
    const tok: string = await issueToken(6, 'test-device-2', '10.0.0.5');
    const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
        userToken: tok, path: '/client-api/no_such_endpoint', method: 'GET',
    });
    ok('未知接口 → 404', r.status === 404, `实际 ${r.status}`);
}

console.log('\n⑥ 撤销的令牌不能代发');
{
    const tok: string = await issueToken(7, 'to-be-revoked', '10.0.0.5');
    const before = await verifyToken(tok, '10.0.0.5');
    ok('撤销前令牌有效', !!before);
    // 直接改库模拟撤销
    const ctx: any = fakeCtx();
    const { revokeTokens } = await import('./.build/model.ts');
    await revokeTokens(7);
    const after = await verifyToken(tok, '10.0.0.5');
    ok('撤销后令牌无效', !after);
    const r = await runForward(fakeCtx({ 'x-channel-key': CHANNEL }), {
        userToken: tok, path: '/client-api/ping', method: 'GET',
    });
    ok('撤销的令牌不能代发', r.status === 401, `实际 ${r.status}`);
}

// ---------------------------------------------------------------- 收尾

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
