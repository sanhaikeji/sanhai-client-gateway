/**
 * 硬币接口。
 *
 * ⚠️ 这里读的是 **coin-33oj 那套结构**（你服务器上装的那个）：
 *   - 余额：用户文档上一个数字字段（默认 `user.coin`）
 *   - 流水：一张账单集合（默认 `coin.bill`）
 * 字段名不对的话，改 `index.ts` 里的 `coinUserField` / `coinBillCollection` 即可 ——
 * README 的「对接硬币」一节有一条 mongosh 命令，能一眼看出真实的字段名。
 *
 * 「加币」接口只给管理员用（默认 uid 5，可在配置里改），普通用户只有只读的余额/流水/排行。
 */
import { ClientApiHandler } from './base';
import { coinBalance, grantCoin, getConfig } from '../model';

export class CoinBalanceHandler extends ClientApiHandler {
    protected async run() {
        const bal = await coinBalance(this.clientUid);
        this.ok({ uid: this.clientUid, coin: bal });
    }
}

export class CoinBillHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const cfg: any = getConfig();
        const page = Math.max(1, this.intParam('page', 1));
        const limit = Math.min(100, Math.max(1, this.intParam('limit', 20)));
        // 管理员（或配置里的人）可以看全部人的账单
        const all = String(this.param('all', '0')) === '1' && isAdmin(cfg, this.clientUid);

        let docs: any[] = [];
        try {
            const q = all ? {} : { uid: this.clientUid };
            docs = await ctx.db.collection(cfg.coinBillCollection || 'coin.bill')
                .find(q).sort({ ts: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        } catch { /* 集合不存在就当空 */ }

        this.ok({
            page, limit, scope: all ? 'all' : 'mine',
            bills: docs.map((d: any) => ({
                id: String(d._id),
                uid: d.uid,
                amount: d.amount,
                note: d.note || '',
                at: d.ts || null,
            })),
        });
    }
}

export class CoinRankHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const cfg: any = getConfig();
        const limit = Math.min(200, Math.max(1, this.intParam('limit', 50)));
        const field = cfg.coinUserField || 'coin';
        let rows: any[] = [];
        try {
            rows = await ctx.db.collection(cfg.coinUserCollection || 'user')
                .find({ [field]: { $gt: 0 } }, { projection: { uname: 1, [field]: 1 } })
                .sort({ [field]: -1 }).limit(limit).toArray();
        } catch { /* 忽略 */ }
        this.ok({
            ranking: rows.map((r: any, i: number) => ({
                rank: i + 1, uid: r._id, uname: r.uname, coin: Number(r[field]) || 0,
            })),
            me: rows.findIndex((r: any) => r._id === this.clientUid) + 1 || 0,
        });
    }
}

/** 管理员加币（把 coin-33oj 的 /coin/inc 变成一个 API）。 */
export class CoinIncHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        if (!isAdmin(cfg, this.clientUid)) { this.fail('没有权限发放硬币', 403); return; }

        const uid = this.intParam('uid', 0);
        const amount = this.intParam('amount', 0);
        const note = String(this.param('note', '') || '人工发放');
        if (!uid || !amount) { this.fail('需要 uid 和 amount'); return; }
        if (Math.abs(amount) > 100000) { this.fail('单次金额过大，请分批'); return; }

        await grantCoin(uid, amount, note);
        this.ok({ uid, amount, note, balance: await coinBalance(uid) });
    }
}

function isAdmin(cfg: any, uid: number): boolean {
    const list: number[] = Array.isArray(cfg.adminUids) ? cfg.adminUids : [5];
    return list.includes(uid);
}

/** 供外部（比如 capabilities）判断是否需要展示管理入口。 */
export { isAdmin };
