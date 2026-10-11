/**
 * 硬币接口。
 *
 * ⚠️ 这里读的是 **coin-33oj 那套结构**（你服务器上装的那个）：
 *   - 余额：用户文档上的数字字段 `coin_now`（当前）/ `coin_all`（累计获得）
 *   - 流水：账单集合 **`coin`**（不是 `coin.bill`！），字段 `{userId, rootId, amount, text}`
 * 字段名不对的话，改 `index.ts` 里的配置即可 —— 启动日志 / `/client-api/diagnose`
 * 会直接把库里真实的集合名和字段名打出来。
 *
 * 「加币」接口只给管理员用（默认 uid 5，可在配置里改），普通用户只有只读的余额/流水/排行。
 */
import { ClientApiHandler } from './base';
import { coinBalance, coinBalances, grantCoin, getConfig } from '../model';

export class CoinBalanceHandler extends ClientApiHandler {
    protected async run() {
        // 2026-10-11：把「累计获得」也一起返回 —— 客户端硬币页要显示两个数，
        // 以前它只能去抓网页 HTML，那条路已经拿不到数了（见 README 的排查记录）。
        const b = await coinBalances(this.clientUid);
        this.ok({ uid: this.clientUid, coin: b.now, coinAll: b.all, now: b.now, all: b.all });
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

        // ⚠️ 站点插件写的是 `userId`，我们早期版本写的是 `uid`。两个都认，
        //    否则历史流水会突然「消失」。
        const q = all ? {} : { $or: [{ userId: this.clientUid }, { uid: this.clientUid }] };

        let docs: any[] = [];
        try {
            docs = await ctx.db.collection(cfg.coinBillCollection || 'coin')
                .find(q).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        } catch { /* 集合不存在就当空 */ }

        this.ok({
            page, limit, scope: all ? 'all' : 'mine',
            bills: docs.map((d: any) => ({
                id: String(d._id),
                uid: d.userId ?? d.uid ?? 0,
                userId: d.userId ?? d.uid ?? 0,
                rootId: d.rootId ?? 0,
                amount: d.amount,
                // 站点插件叫 text，我们早期版本叫 note
                note: d.text || d.note || '',
                text: d.text || d.note || '',
                // 站点插件的账单**没有时间字段**，时间藏在 ObjectId 前 8 位里（客户端自己反推）
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
        const field = cfg.coinUserField || 'coin_now';
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
