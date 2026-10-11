/**
 * 客户端 API 的基类：**认证在这里统一做**。
 *
 * 为什么所有接口都继承它、而不是各自校验令牌 —— 认证漏掉一处就等于没有认证。
 * 放在基类的 `prepare()` 里，是「每个 HTTP 方法执行前都会跑」的钩子，加新接口时
 * 想漏也漏不掉。
 */
import { Handler } from 'hydrooj';
import { verifyToken, TokenInfo } from '../model';
import { rateLimit } from '../lib';

export abstract class ClientApiHandler extends Handler {
    /** 认证通过后的用户 uid；0 表示没通过（prepare 已经写好错误响应）。 */
    protected clientUid = 0;
    protected tokenInfo: TokenInfo | null = null;
    protected clientIp = '';
    /** 令牌原文的短指纹，用来「保留当前设备」这类操作。 */
    protected tokenFingerprint = '';

    /**
     * 是否需要令牌。只有「换取令牌」的接口（登录、配对码）才设 false ——
     * 那时客户端手里还没有令牌，天然不能要求它。这类接口改为**按 IP 限流**，
     * 用来挡撞库。
     */
    protected requiresAuth = true;

    /**
     * 客户端 API 用 Bearer 令牌认证，不使用 session，因此不涉及 CSRF。
     * 覆盖掉 Hydro 的 CSRF 校验（它会去找 `_csrf` 字段，客户端没有这个东西）。
     */
    async checkCsrf() { /* intentionally empty */ }

    /**
     * Hydro 的 _prepare 包装：不抛异常（抛了会渲染成 HTML 错误页，客户端解析不了），
     * 而是写一个 JSON 响应并把 clientUid 留在 0，后续的 run() 会被跳过。
     */
    /**
     * Hydro 各版本调用的生命周期钩子不完全一致（`prepare()` / `_prepare()`），
     * 两个都挂上，并用一个开关防重复执行。认证只跑一次。
     */
    async prepare() { await this.doAuth(); }

    async _prepare() { await this.doAuth(); }

    private _authed = false;

    private async doAuth() {
        if (this._authed) return;
        this._authed = true;

        this.clientIp = String((this.request as any).ip || '');

        if (!this.requiresAuth) {
            // 公开接口（登录 / 配对码）：没有令牌可验，只能按 IP 限流挡撞库
            if (!rateLimit(`pub:${this.clientIp}`, 20, 60_000)) {
                this.authFail('尝试过于频繁，请一分钟后再试');
            }
            return;
        }

        const raw = this.readToken();
        if (!raw) { this.authFail('缺少客户端令牌：请在请求头带上 Authorization: Bearer <token>'); return; }

        // 限流按令牌指纹算（不是按 IP —— 内网/学校出口 IP 都一样，按 IP 会误伤）
        this.tokenFingerprint = raw.slice(0, 12);
        if (!rateLimit(`gw:${this.tokenFingerprint}`, 600, 60_000)) {
            this.authFail('请求过于频繁，请稍后再试'); return;
        }

        const info = await verifyToken(raw, this.clientIp);
        if (!info) { this.authFail('令牌无效、已过期或已被撤销，请重新登录'); return; }
        this.clientUid = info.uid;
        this.tokenInfo = info;
    }

    /** 令牌从哪来：优先 Authorization 头，其次自定义头 / 查询串 / 表单。 */
    protected readToken(): string {
        const h = ((this.request as any).headers || {}) as Record<string, any>;
        const m = /^Bearer\s+(.+)$/i.exec(String(h.authorization || h.Authorization || ''));
        if (m) return m[1].trim();
        if (h['x-client-token']) return String(h['x-client-token']).trim();
        const a = this.param('token', '');
        return a ? String(a) : '';
    }

    private authFail(message: string) {
        this.json(401, { ok: false, error: message });
    }

    // ------------------------------------------------ 统一出入口

    private json(status: number, body: any) {
        // HydroResponse 的属性名各版本略有出入，逐个 try —— 设不上也不该让整个请求挂掉
        try { this.response.status = status; } catch { /* 忽略 */ }
        try { this.response.type = 'application/json'; } catch { /* 忽略 */ }
        try { (this.response as any).set?.('Cache-Control', 'no-store'); } catch { /* 忽略 */ }
        this.response.body = body;
    }

    protected ok(data: any = {}) {
        this.json(200, { ok: true, ...data });
    }

    protected fail(message: string, status = 400, extra: any = {}) {
        this.json(status, { ok: false, error: message, ...extra });
    }

    /**
     * 取参数：路由参数（若有）、请求体、查询串，挨个找。
     * 这套 API 刻意**不使用路径参数**，全部走查询串 / 表单 —— 少一层装饰器，少一处出错。
     */
    protected param(name: string, def?: any): any {
        const a = (this as any).args;
        if (a && a[name] !== undefined && a[name] !== null && a[name] !== '') return a[name];
        const b = ((this.request as any).body || {}) as Record<string, any>;
        if (b[name] !== undefined && b[name] !== null && b[name] !== '') return b[name];
        const q = ((this.request as any).query || {}) as Record<string, any>;
        if (q[name] !== undefined && q[name] !== null && q[name] !== '') return q[name];
        return def;
    }

    protected intParam(name: string, def = 0): number {
        const v = parseInt(String(this.param(name, def)), 10);
        return Number.isFinite(v) ? v : def;
    }

    // ------------------------------------------------ 子类只需实现 run

    /** 请求处理主体。认证失败时不会被调用。 */
    protected abstract run(): Promise<void>;

    async get() { await this.dispatch(); }

    async post() { await this.dispatch(); }

    private async dispatch() {
        if (this.requiresAuth && !this.clientUid) return;   // prepare 已写错误响应
        try {
            await this.run();
        } catch (e) {
            const msg = (e as any)?.message || String(e);
            // 业务异常（用户没登录、找不到题目之类）返回 400；其它当作 500
            this.fail(msg, 400);
        }
    }
}
