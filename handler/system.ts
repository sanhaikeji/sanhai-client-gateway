/**
 * 系统类：连通性探测、能力清单、通知。
 *
 * `capabilities` 是给客户端做「渐进增强」用的：客户端启动时问一次，服务端告诉它
 * 这台 OJ 上有哪些功能可用（比如硬币插件装了没、签到开了没、我是不是管理员）。
 * 这样客户端不用为新功能发版，也不会对着一个不存在的接口反复重试。
 */
import { ObjectId } from 'hydrooj';   // 别直接 import 'mongodb'，见 index.ts 顶部注释
import { ClientApiHandler } from './base';
import { getConfig, getState, diagnose } from '../model';
import { isAdmin } from './coin';

export class PingHandler extends ClientApiHandler {
    /** 连通性探测：这是**唯一**不需要令牌的接口 —— 客户端连「令牌对不对」都不知道的时候也要能测通。 */
    protected requiresAuth = false;

    protected async run() {
        this.ok({
            service: 'SanhaiOJ 客户端通道',
            plugin: 'hydrooj-client-gateway',
            time: new Date().toISOString(),
            serverTime: Date.now(),
            // 客户端可以用它判断服务端时钟差（签到按服务端时区算，客户端时区不准也没关系）
            timezone: 'Asia/Shanghai',
        });
    }
}

export class CapabilitiesHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        const ctx: any = (this as any).ctx;
        const st = await getState(this.clientUid);

        // 探测几个可选依赖是否就位
        let hasCoin = false;
        try {
            const c = await ctx.db.collection(cfg.coinUserCollection || 'user')
                .findOne({ _id: this.clientUid }, { projection: { [cfg.coinUserField || 'coin_now']: 1 } });
            hasCoin = !!(c && c[cfg.coinUserField || 'coin_now'] !== undefined);
        } catch { /* 没有就没有 */ }

        this.ok({
            uid: this.clientUid,
            features: {
                checkin: cfg.checkinEnabled !== false,
                checkinMakeup: cfg.checkinEnabled !== false && Number(cfg.makeupWindow ?? 3) > 0,
                coin: hasCoin && cfg.coinEnabled !== false,
                problems: true,
                records: true,
                submit: true,
                contests: true,
                discussions: true,
                ranking: true,
                notifications: true,
                pairLogin: true,
            },
            checkin: {
                signedToday: st.lastDate === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
                streak: st.streak,
                makeupWindow: Number(cfg.makeupWindow ?? 3),
                makeupCost: Number(cfg.makeupCost ?? 5),
            },
            isAdmin: isAdmin(cfg, this.clientUid),
            apiVersion: 1,
        });
    }
}

export class NotificationsHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const limit = Math.min(100, Math.max(1, this.intParam('limit', 20)));
        let rows: any[] = [];
        try {
            // Hydro 的私信存在 `message` 集合
            rows = await ctx.db.collection('message')
                .find({ to: this.clientUid })
                .sort({ _id: -1 }).limit(limit).toArray();
        } catch { /* 没有消息系统就当空 */ }

        const unread = rows.filter((m) => !m.read).length;
        this.ok({
            unread,
            messages: rows.map((m) => ({
                id: String(m._id),
                from: m.from,
                content: typeof m.content === 'string' ? m.content.slice(0, 500) : '',
                read: !!m.read,
                at: m._id?.getTimestamp?.() || null,
            })),
        });
    }
}

export class NotificationReadHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const id = String(this.param('id', '')).trim();
        const all = String(this.param('all', '')) === '1';
        try {
            if (all) {
                const r = await ctx.db.collection('message')
                    .updateMany({ to: this.clientUid, read: { $ne: true } }, { $set: { read: true } });
                this.ok({ updated: r.modifiedCount });
                return;
            }
            if (!id) { this.fail('请给出消息 id，或传 all=1 全部已读'); return; }
            await ctx.db.collection('message')
                .updateOne({ _id: new ObjectId(id), to: this.clientUid }, { $set: { read: true } });
            this.ok({ updated: 1 });
        } catch (e) {
            this.fail(`标记已读失败：${(e as Error).message}`);
        }
    }
}

/**
 * 自检：把「硬币/签到配置对不对」查出来。
 *
 * ⭐ 装完**第一件事就是调这个** —— 硬币字段名猜不得，配错了不会报错、只会让硬币发不出去。
 * 这个接口会顺手给出建议值（`suggestedField` / `suggestedBillCollection`）。
 */
export class DiagnoseHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        if (!isAdmin(cfg, this.clientUid)) { this.fail('只有管理员能看自检结果', 403); return; }
        const r = await diagnose(this.clientUid);
        this.ok(r);
    }
}
