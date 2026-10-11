/**
 * 认证：把「用户身份」换成「客户端令牌」。
 *
 * 提供两条路：
 *  - **配对码**（推荐）：用户在**网页上**（已登录）生成 6 位码，客户端输入换取令牌。
 *    密码从不经过客户端，并且能在网页上看到/撤销已授权设备。
 *  - **账号密码**：客户端直接填账号密码换令牌（方便，但密码要在客户端出现一次）。
 *
 * 两种都返回同一个东西：一个长期令牌字符串。之后所有接口都用它。
 */
import { Handler, PRIV, UserModel } from 'hydrooj';
import { ClientApiHandler } from './base';
import {
    issueToken, issuePairCode, consumePairCode, listTokens, revokeTokens,
} from '../model';
import { hashToken } from '../lib';

// ---------------------------------------------------------------- Hydro 兼容层

/**
 * 按用户名/邮箱找用户。
 *
 * Hydro 各版本这个方法签名不太一致（有的要 domainId、有的不要），这里挨个试一遍 ——
 * 比赌一个签名然后线上 500 强。
 */
async function findUser(key: string) {
    const M: any = UserModel;
    const domainId = 'system';
    const cands: Array<() => any> = [
        () => M.getByUname?.(domainId, key),
        () => M.getByUname?.(key),
        () => M.getByEmail?.(domainId, key),
        () => M.getByEmail?.(key),
    ];
    for (const f of cands) {
        try { const r = await f(); if (r) return r; } catch { /* 试下一个 */ }
    }
    return null;
}

/**
 * 校验密码。多版本兼容。
 *
 * <para>⚠️ 别 `import { User } from 'hydrooj'` —— **hydrooj 并不导出 `User` 这个类**
 * （只导出 `UserModel`）。写 `new User(udoc)` 在 CJS 下会变成 `new undefined(...)`，
 * 异常被 catch 吞掉 → 表现成「密码永远不对」，极难查。正确做法是从 UserModel 拿一个
 * **User 实例**（实例自带 `checkPassword`），这也是 Hydro 官方的用法。</para>
 */
async function checkPassword(udoc: any, password: string): Promise<boolean> {
    const M: any = UserModel;
    const getters: Array<() => any> = [
        () => M.getById?.('system', udoc._id),
        () => M.getById?.(udoc._id),
    ];
    for (const get of getters) {
        try {
            const u: any = await get();
            if (u && typeof u.checkPassword === 'function') return !!(await u.checkPassword(password));
        } catch { /* 试下一个 */ }
    }
    for (const m of ['checkPassword', 'verifyPassword', 'checkPass']) {
        try {
            if (typeof M[m] === 'function') {
                const r = await M[m](udoc, password);
                if (r !== undefined && r !== null) return !!r;
            }
        } catch { /* 试下一个 */ }
    }
    return false;
}

/** priv 位掩码 → 客户端能懂的简单角色名。 */
function roleOf(priv: number): string {
    if (priv & (PRIV.PRIV_EDIT_SYSTEM || 0)) return 'root';
    if (priv & (PRIV.PRIV_CREATE_DOMAIN || 0)) return 'admin';
    if (priv & (PRIV.PRIV_USER_PROFILE || 0)) return 'user';
    return 'guest';
}

// ---------------------------------------------------------------- 登录（公开）

export class AuthLoginHandler extends ClientApiHandler {
    protected requiresAuth = false;

    protected async run() {
        const uname = String(this.param('username', '') || this.param('uname', '')).trim();
        const password = String(this.param('password', ''));
        const device = String(this.param('device', '') || (this.request as any).headers?.['user-agent'] || '客户端');
        if (!uname || !password) { this.fail('请填写账号和密码'); return; }

        const udoc = await findUser(uname);
        // 注意：用户不存在和密码错误返回**同一句话**，别告诉攻击者哪个账号存在
        if (!udoc || !(await checkPassword(udoc, password))) {
            this.fail('账号或密码不正确', 401); return;
        }
        if (udoc.priv === 0 && udoc.banReason) { this.fail('该账号已被封禁', 403); return; }

        const token = await issueToken(udoc._id, device, this.clientIp);
        this.ok({
            token,
            uid: udoc._id,
            uname: udoc.uname,
            role: roleOf(udoc.priv),
            expiresInDays: 365,
        });
    }
}

// ---------------------------------------------------------------- 配对码换令牌（公开）

export class AuthPairHandler extends ClientApiHandler {
    protected requiresAuth = false;

    protected async run() {
        const code = String(this.param('code', '')).trim();
        const device = String(this.param('device', '') || '客户端');
        if (!/^\d{6}$/.test(code)) { this.fail('配对码应为 6 位数字'); return; }

        const r = await consumePairCode(code, device, this.clientIp);
        if (!r) { this.fail('配对码无效、已使用或已过期（15 分钟内有效）', 401); return; }

        const udoc = await findUser(String(r.uid)) || await UserModel.getById?.('system', r.uid);
        this.ok({
            token: r.token,
            uid: r.uid,
            uname: udoc?.uname || '',
            role: udoc ? roleOf(udoc.priv) : 'user',
            expiresInDays: 365,
        });
    }
}

// ---------------------------------------------------------------- 网页端生成配对码（要登录）

/**
 * 这个接口是**网页**调用的（不是客户端）—— 用户已经在浏览器里登录了，
 * 点一下生成配对码，拿去客户端输入。所以它走 Hydro 自己的登录态，不继承 ClientApiHandler。
 */
export class PairCodeGenerateHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const uid = (this.user as any)?._id || (this.user as any)?.uid;
        const code = await issuePairCode(uid);
        this.response.type = 'application/json';
        this.response.body = {
            ok: true,
            code,
            expireInSeconds: 900,
            tip: '在客户端「用配对码登录」里输入这 6 位数字，15 分钟内有效。',
        };
    }
}

// ---------------------------------------------------------------- 以下都要令牌

export class AuthWhoamiHandler extends ClientApiHandler {
    protected async run() {
        const udoc = await UserModel.getById?.('system', this.clientUid);
        this.ok({
            uid: this.clientUid,
            uname: udoc?.uname || '',
            role: udoc ? roleOf(udoc.priv) : 'user',
            device: this.tokenInfo?.name || '',
            tokenExpireAt: this.tokenInfo?.expiresAt || null,
        });
    }
}

export class AuthRefreshHandler extends ClientApiHandler {
    protected async run() {
        const raw = this.readToken();
        // 换一个新的、同时把旧的作废（避免令牌无限堆积，也能发现「令牌泄漏了」）
        await revokeTokens(this.clientUid, undefined, hashToken(raw));
        const token = await issueToken(this.clientUid, this.tokenInfo?.name || '客户端', this.clientIp);
        this.ok({ token, expiresInDays: 365 });
    }
}

export class AuthDevicesHandler extends ClientApiHandler {
    protected async run() {
        const list = await listTokens(this.clientUid);
        for (const d of list) d.current = d.name === this.tokenInfo?.name;
        this.ok({ devices: list, current: this.tokenInfo?.name || '' });
    }
}

export class AuthRevokeHandler extends ClientApiHandler {
    protected async run() {
        const id = String(this.param('id', '')).trim();
        const all = String(this.param('all', '')) === '1';
        let n: number;
        if (all) {
            n = await revokeTokens(this.clientUid, undefined, hashToken(this.readToken()));
        } else if (id) {
            n = await revokeTokens(this.clientUid, id);
        } else {
            this.fail('请指定要撤销的设备 id，或传 all=1 撤销其它全部设备'); return;
        }
        this.ok({ revoked: n });
    }
}

export class AuthLogoutHandler extends ClientApiHandler {
    protected async run() {
        const n = await revokeTokens(this.clientUid, undefined, undefined);
        this.ok({ revoked: n, message: '已退出登录（本机令牌也一并作废）' });
    }
}
