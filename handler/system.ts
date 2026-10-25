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
import {
    unreadFilter, readMark, isReadBy, readAtOf,
} from '../notify';
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
                // 服务端支持「按会话清未读 / 批量按 id 清」（`conv=` / `ids=` / `scope`）
                notificationsReadBy: true,
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
        const uid = this.clientUid;
        const limit = Math.min(100, Math.max(1, this.intParam('limit', 20)));
        let rows: any[] = [];
        let unread = 0;
        let counted = false;
        let coll: any = null;
        // 按会话（`from`）聚合的未读数：客户端拿它画「每个会话几个红点」，不用自己翻页统计
        let byConv: Record<string, number> = {};
        try {
            // Hydro 的私信存在 `message` 集合；`to` 可能是数组，Mongo 的等值匹配天然按「数组里有它」算
            coll = ctx.db.collection('message');
            rows = await coll.find({ to: uid })
                .sort({ _id: -1 }).limit(limit).toArray();
            // ⚠️ unread 必须**全量**数：以前是 rows.filter，只数了当前这一页（默认 20 条），
            //    未读 30 条时客户端角标永远卡在 20。countDocuments 不受 limit 影响。
            unread = await coll.countDocuments(unreadFilter(uid));
            counted = true;
        } catch { /* 没有消息系统就当空 */ }
        // 数不出来（老驱动 / 集合异常）时，退化成这一页的估计值，至少别给个 0
        if (!counted) unread = rows.filter((m) => !isReadBy(m, uid)).length;

        // 聚合**复用** unreadFilter：口径必须和上面的 unread 完全一致，否则角标和分会话数对不上。
        // 这一步是附赠信息：老库 / 只读账号 / 不支持聚合时退化成 {}，绝不能因此把整个列表打成 500。
        if (coll) {
            try {
                const groups = await coll.aggregate([
                    { $match: unreadFilter(uid) },
                    { $group: { _id: '$from', n: { $sum: 1 } } },
                ]).toArray();
                for (const g of groups) {
                    if (g?._id === null || g?._id === undefined) continue;
                    // `from` 可能存成数字，也可能存成字符串 —— 先数字化再当 key，两种存储归到同一个会话。
                    // 非数字的脏数据退回原值，至少不丢计数。
                    const n = Number(g._id);
                    const key = Number.isFinite(n) ? String(n) : String(g._id);
                    if (!key) continue;
                    byConv[key] = (byConv[key] || 0) + Number(g.n || 0);
                }
            } catch { byConv = {}; }
        }

        this.ok({
            unread,
            byConv,
            messages: rows.map((m) => {
                const at = readAtOf(m, uid);
                return {
                    id: String(m._id),
                    from: m.from,
                    content: typeof m.content === 'string' ? m.content.slice(0, 500) : '',
                    // read 是**当前用户视角**的布尔（老客户端在吃这个字段，不能改语义）
                    read: isReadBy(m, uid),
                    // 额外给的：我这条读到的时间，没读 / 老数据为 null
                    readAt: at ? at.toISOString() : null,
                    at: m._id?.getTimestamp?.() || null,
                };
            }),
        });
    }
}

/** `ids=` 一次最多认多少个 —— 客户端一次勾选几千条时不该把一条 updateMany 撑爆。 */
const MAX_BATCH_IDS = 200;

export class NotificationReadHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const uid = this.clientUid;
        // ⚠️ 客户端 POST 的 body 恒为 `{}`，参数只会出现在 query 上（base.ts 的 param() 会兜住）
        const id = String(this.param('id', '')).trim();
        const all = String(this.param('all', '')) === '1';
        const convRaw = String(this.param('conv', '')).trim();
        const idsRaw = String(this.param('ids', '')).trim();
        const conv = Number(convRaw);
        const hasConv = convRaw !== '' && Number.isFinite(conv) && conv > 0;
        try {
            const coll = ctx.db.collection('message');
            // 优先级：all=1 > conv > ids > 单条 id（同时传多个时只按最左边那个走，不叠加）
            if (all) {
                // 只写「我」那一格：同一份文档里别的收件人的 readBy 原样不动
                const r = await coll.updateMany(unreadFilter(uid), readMark(uid));
                // 顺手清 Hydro 网页端的未读角标（网页版 handler/home.ts 也是这么做的）。
                // 这一步是附赠：清不掉不该让已读失败，所以单独 try。
                try {
                    await ctx.db.collection('user').updateOne({ _id: uid }, { $set: { unreadMsg: 0 } });
                } catch { /* 角标清不掉无所谓，已读本身已经写成功 */ }
                this.ok({ updated: r?.modifiedCount ?? 0, scope: 'all' });
                return;
            }
            if (hasConv) {
                // `from` 在库里可能是数字、也可能是字符串 —— 两种都兜住，否则「按会话已读」会漏掉一半
                const r = await coll.updateMany(
                    { ...unreadFilter(uid), from: { $in: [conv, String(conv)] } },
                    readMark(uid),
                );
                this.ok({ updated: r?.modifiedCount ?? 0, scope: 'conv' });
                return;
            }
            if (idsRaw) {
                // 最多 200 个，超出截断；非法 id **跳过不报错**（一个坏 id 不该让整批失败）
                const tokens = idsRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_BATCH_IDS);
                const oids: any[] = [];
                for (const t of tokens) {
                    // 先按 24 位 hex 粗筛，再交给 ObjectId —— 直接 new 会抛，抛在循环里就整批挂了
                    if (!/^[0-9a-fA-F]{24}$/.test(t)) continue;
                    try { oids.push(new ObjectId(t)); } catch { /* 非法 id 跳过 */ }
                }
                // 一个合法 id 都没有时就别查了（`$in: []` 在部分驱动上语义不一致）
                const r = oids.length
                    ? await coll.updateMany({ ...unreadFilter(uid), _id: { $in: oids } }, readMark(uid))
                    : null;
                this.ok({ updated: r?.modifiedCount ?? 0, scope: 'ids' });
                return;
            }
            if (!id) { this.fail('请给出消息 id，或传 all=1 全部已读'); return; }
            // ⚠️ `to: uid` 不能省 —— 少了它，谁知道消息 id 谁就能改别人的已读状态
            const r = await coll.updateOne({ _id: new ObjectId(id), to: uid }, readMark(uid));
            this.ok({ updated: r?.matchedCount ? 1 : 0, scope: 'one' });
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
