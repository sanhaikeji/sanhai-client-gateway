/**
 * 心跳中转的**服务端侧**：代发请求
 * ============================================
 *
 * 场景（2026-11-07）：学校禁止内网穿透（frp / cloudflared），
 * OJ 源站在内网、外网访问不到。于是链路变成：
 *
 *   外网客户端 ──①──▶ WorkBuddy 云服务 ──②──▶ 内网 agent ──③──▶ 本插件
 *
 * agent 拿到请求后打到这里（`POST /client-api/relay/forward`），
 * 由**本插件**验用户令牌并代发到对应业务接口。
 *
 * ⚠️⚠️ **为什么用户令牌不能经过 agent**：
 *   如果 agent 拿着用户令牌去调业务接口，那 agent 就**持有用户凭据** ——
 *   agent 一旦被攻破（它跑在学生自己的机器上？不一定，也可能是服务器），
 *   攻击者就能用任意用户身份操作 OJ（看别人提交、发币、签到…）。
 *   所以本方案让**令牌一步都不出插件**：
 *     · agent 只带一个独立的「通道密钥」（X-Channel-Key）来认证自己；
 *     · 用户令牌由**客户端**交给云、云转给 agent、agent **原样带过来**；
 *     · 插件用现成的 {@link verifyToken} 验它 → 得到 uid → 代发。
 *   agent 全程拿不到 uid 之外的东西（连 uid 都只是它自己问出来的）。
 *
 * 顺带解决限流问题：见 {@link RelayForwardHandler} 里对 `rateLimit` 的处理。
 */
import { ClientApiHandler } from './base';
import { verifyToken } from '../model';
import { safeEqual, rateLimit } from '../lib';
// ⚠️ 用 `import` 而不是 `require()` —— 本插件跑在 ESM 下（Hydro 的构建产物是 ESM），
//    `require` 在 ESM 里不存在。
//    同样注意：这两个是**Node 内置模块**，不是裸包名，从插件目录解析得到。
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------- 配置

/**
 * 通道密钥（agent 用）。
 * <para>⛔ **这个密钥的持有者只能「代发」，不能以任何用户身份操作** ——
 * 它不是管理员密钥，不进 `adminUids` 那套。</para>
 * <para>配置方式：环境变量 {@code RELAY_CHANNEL_KEY}，或同目录的 {@code relay-channel.key}。</para>
 */
function getChannelKey(): string {
    const env = String(process.env.RELAY_CHANNEL_KEY || '').trim();
    if (env) return env;
    try {
        const f = join(__dirname, '..', 'relay-channel.key');
        return readFileSync(f, 'utf8').trim();
    } catch {
        return '';
    }
}

/** agent 每一分钟最多能代发多少次（一个 agent 替全校学生转发，量不小）。 */
const AGENT_RATE_LIMIT = 3000;
const AGENT_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------- 转发

/**
 * 代发请求。
 *
 * <para>请求体：<c>{ userToken, method, path, query, body }</c>。</para>
 * <para>返回：<c>{ ok, status, body }</c> —— 状态码和正文都是**被代发那个接口**的，
 * 云和 agent 原样带回客户端。</para>
 */
export class RelayForwardHandler extends ClientApiHandler {
    /** ⛔ 这一条**不要**用户令牌来认证 —— 认证靠通道密钥。 */
    protected requiresAuth = false;

    protected async run() {
        // 1) 先验通道密钥（恒定时间比较，防时序侧信道）
        const expected = getChannelKey();
        if (!expected) {
            this.fail('服务端未配置通道密钥（RELAY_CHANNEL_KEY），转发通道关闭', 503);
            return;
        }
        const provided = String((this.request as any).headers?.['x-channel-key'] || '');
        if (!safeEqual(provided, expected)) {
            this.fail('通道密钥不对', 401);
            return;
        }

        // 2) 限流按**通道**算（不是按用户 —— 一个 agent 替全校转发，
        //    按用户算的话一个用户请求多就全站被限）
        const ip = String((this.request as any).ip || '');
        if (!rateLimit(`relay:${provided.slice(0, 12)}:${ip}`, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS)) {
            this.fail('转发过于频繁，请稍后再试', 429);
            return;
        }

        // 3) 取出要代发的内容
        const body = this.param('body', {}) as any;
        const userToken = String(this.param('userToken', '') || '').trim();
        if (!userToken) {
            this.fail('缺少 userToken', 400);
            return;
        }

        // 4) ⚠️ 路径白名单：只允许转发到 /client-api/* 下的接口。
        //    绝不能让它变成「任意 URL 代理」——那就是 SSRF。
        //    ⚠️ 正则里**不能**放 '.' 和 '/' 的自由组合：`/client-api/../../etc/passwd`
        //    会被「以 /client-api/ 开头」骗过去。所以每段只允许字母数字下划线连字符。
        const path = String(this.param('path', '') || '');
        if (!/^\/client-api\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*$/.test(path)) {
            this.fail(`路径不合法：${path}`, 400);
            return;
        }

        // 5) 验用户令牌 → 得到 uid
        //    ⚠️ 这里用 verifyToken 而不是直接信任 agent 传来的 uid ——
        //    agent 说「这是 uid 5」不算数，得令牌本身能验出 uid 5 才行。
        const info = await verifyToken(userToken, ip);
        if (!info) {
            this.fail('用户令牌无效、已过期或已被撤销', 401);
            return;
        }
        const uid = info.uid;

        // 6) 代发：调对应的业务 handler
        const method = String(this.param('method', 'GET') || 'GET').toUpperCase();
        const query = (this.param('query', {}) || {}) as Record<string, any>;

        const r = await this.forwardTo(method, path, query, info, userToken, body);
        // ⚠️ **状态码透传**：被代发接口返回 404 / 401 / 400 时，这里也必须是那个码 ——
        //    包成 200 的话，客户端分不清「成功」和「失败」，
        //    云和 agent 也没法按状态码决定要不要重试。
        //    （用 okWithStatus 而不是「先设 response.status 再调 ok()」——
        //    ok() 里的 200 会把前面设的覆盖掉。）
        this.okWithStatus(r.status, { status: r.status, body: r.body });
    }

    /**
     * 把请求转给对应的业务 handler。
     *
     * <para>做法：找到已注册的同名 handler，用**假的请求上下文**调它，
     * 把 {@link ClientApiHandler.clientUid} 设成被代发用户的 uid。</para>
     *
     * <para>⚠️ 为什么不自己实现每个接口：那是 35 个路由的复制粘贴，
     * 以后加接口必然漏 —— 而漏掉的那个就是**绕过鉴权**的那个。</para>
     */
    private async forwardTo(
        method: string, path: string, query: Record<string, any>,
        info: { uid: number; name?: string; expiresAt?: any }, userToken: string, body: any,
    ): Promise<{ status: number; body: any }> {
        // 路由名 → handler 类。
        // '/client-api/checkin/status' → 'client_api_checkin_status'
        // ⚠️ **斜杠要换成下划线** —— 直接拼会得到 'client_apiping'，
        //    而注册时的名字是 'client_api_ping'（中间有下划线），对不上 → 全部 404。
        const routeName = 'client_api_' + path.slice('/client-api/'.length).replace(/\//g, '_');

        // ⚠️ 只认 HANDLER_MAP（由 registerRelayRoute 维护）。
        //    **不查 ctx.Route.__handlers** —— 那是 Hydro 的内部字段，各版本不一定有，
        //    拿它当「也认」会导致「本机有、线上没有」这种只在生产复现的怪错。
        const HandlerCtor = HANDLER_MAP[routeName];
        if (!HandlerCtor) {
            return { status: 404, body: { ok: false, error: `没有这个接口：${path}` } };
        }

        // 造一个和真实请求一样的上下文，但把参数换成代发的那份
        const fakeRequest: any = {
            ...(this.request as any),
            method: method === 'GET' ? 'GET' : 'POST',
            query,
            body,
            ip: String((this.request as any).ip || ''),
            headers: { ...((this.request as any).headers || {}), 'x-client-token': userToken },
        };
        const ctx: any = (this as any).ctx;
        const fakeCtx: any = Object.create(Object.getPrototypeOf(ctx) || Object.prototype);
        Object.assign(fakeCtx, ctx);
        fakeCtx.request = fakeRequest;
        const fakeResponse: any = { status: 200, body: null, type: 'application/json' };
        fakeCtx.response = fakeResponse;

        // ⚠️⚠️ 装配方式必须是 `Object.create(prototype)` + 手工塞字段，
        //    **不能 `new HandlerCtor(ctx)`** ——
        //    Hydro 的 Handler 构造函数签名各版本不一致（实测不是 (ctx)），
        //    用 new 会得到一个 request/response 全是 undefined 的半成品，
        //    代发时静默返回空响应（表现为「所有接口都返回 200 但没有数据」）。
        //    这跟 test/test.ts 里 callHandler 的做法一致。
        const h: any = Object.create(HandlerCtor.prototype);
        h.ctx = fakeCtx;
        h.request = fakeRequest;
        h.response = fakeResponse;
        h.args = {};
        h.clientUid = info.uid;
        // ⚠️ tokenInfo / tokenFingerprint 也要装上（auth.ts 的设备列表用 `tokenInfo?.name`
        //    标「当前设备」，缺了会显示成空名）。跟 doAuth 的口径完全一致。
        h.tokenInfo = info;
        h.tokenFingerprint = String(userToken).slice(0, 12);
        // ⚠️ 关键：把认证标记为「已完成」，否则 base 类的 doAuth 会拿通道密钥去当用户令牌验
        h._authed = true;
        h._relayForward = true;      // 供业务 handler 判断「这是代发」

        try {
            await (h as any).dispatch();
        } catch (e) {
            return { status: 500, body: { ok: false, error: (e as Error).message } };
        }
        return { status: fakeResponse.status || 200, body: fakeResponse.body };
    }
}

/**
 * 路由名 → handler 类的映射。
 * <para>⛔ **为什么不用 `ctx.Route` 反查**：Hydro 的 `ctx.Route(name, path, Handler)` 只管注册，
 * 各个版本**不保证**运行时能按名字取回 handler 类（`ctx.Route.__handlers` 这种内部字段
 * 不是公开 API，跨版本随时可能没有）。猜它存在 → 线上 404 → 整个中转链路哑掉。</para>
 * <para>✅ 所以由**本插件自己**在 {@link registerRelayRoutes} 里维护这张表 ——
 * 我们本来就是在这里注册全部 35 条路由的，顺手记一张表，零依赖、跨版本稳定。</para>
 */
const HANDLER_MAP: Record<string, any> = {};

/**
 * 注册路由（并把 handler 记进 {@link HANDLER_MAP}）。
 * <para>⚠️ 转发表必须和真实注册**同步**：这里记了、但没注册 → 转发表里的接口 404；
 * 反之（注册了但没记）→ 该接口不能被代发（安全上是安全的，只是功能不可用）。</para>
 */
export function registerRelayRoute(
    ctx: any, name: string, path: string, Handler: any, priv?: number,
) {
    HANDLER_MAP[name] = Handler;
    if (priv === undefined) ctx.Route(name, path, Handler);
    else ctx.Route(name, path, Handler, priv);
}

