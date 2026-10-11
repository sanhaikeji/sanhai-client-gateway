/**
 * 「我的」：个人信息、统计、名次。
 *
 * 这些数据 Hydro 有现成的存放位置：
 *  - 账号信息在 `user` 集合；
 *  - 解题统计（AC 数 / 提交数 / rp / 名次）在 `domain.user` 集合（**按域分开**）。
 *    直接读这两个集合，比调 Hydro 的模型层更稳（模型层方法名各版本有出入）。
 */
import { PRIV } from 'hydrooj';
import { ClientApiHandler } from './base';
import { coinBalance, getState } from '../model';

function roleOf(priv: number): string {
    if (priv & (PRIV.PRIV_EDIT_SYSTEM || 0)) return 'root';
    if (priv & (PRIV.PRIV_CREATE_DOMAIN || 0)) return 'admin';
    if (priv & (PRIV.PRIV_USER_PROFILE || 0)) return 'user';
    return 'guest';
}

export class MeHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = String((this as any).domain?._id || 'system');

        const udoc = await ctx.db.collection('user').findOne(
            { _id: this.clientUid },
            { projection: { uname: 1, mail: 1, priv: 1, regat: 1, loginat: 1, avatar: 1 } },
        );
        if (!udoc) { this.fail('账号不存在', 404); return; }

        const dudoc = await ctx.db.collection('domain.user').findOne(
            { domainId, uid: this.clientUid },
            { projection: { rp: 1, rank: 1, nAccept: 1, nSubmit: 1, displayName: 1 } },
        ).catch(() => null);

        const st = await getState(this.clientUid);
        const coin = await coinBalance(this.clientUid).catch(() => 0);

        this.ok({
            uid: this.clientUid,
            uname: udoc.uname,
            displayName: dudoc?.displayName || udoc.uname,
            mail: udoc.mail || '',
            avatar: udoc.avatar || '',
            role: roleOf(udoc.priv || 0),
            priv: udoc.priv || 0,
            regat: udoc.regat || null,
            loginat: udoc.loginat || null,
            domainId,
            coin,
            rp: dudoc?.rp ?? 0,
            rank: dudoc?.rank ?? 0,
            nAccept: dudoc?.nAccept ?? 0,
            nSubmit: dudoc?.nSubmit ?? 0,
            checkin: {
                signed: st.lastDate === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
                streak: st.streak,
                totalDays: st.totalDays,
            },
        });
    }
}

export class MeStatsHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = String((this as any).domain?._id || 'system');

        const dudoc = await ctx.db.collection('domain.user').findOne(
            { domainId, uid: this.clientUid },
            { projection: { nAccept: 1, nSubmit: 1, rp: 1, rank: 1 } },
        ).catch(() => null);

        const nAccept = dudoc?.nAccept ?? 0;
        const nSubmit = dudoc?.nSubmit ?? 0;
        const rate = nSubmit > 0 ? Math.round((nAccept / nSubmit) * 1000) / 10 : 0;

        // 最近 7 天的提交数（客户端画活跃度用）。
        // 记录表的主键是 ObjectId，时间戳就藏在里面 —— 不必再读提交时间字段。
        let recent: Array<{ date: string; count: number }> = [];
        try {
            const docs = await ctx.db.collection('record')
                .find({ uid: this.clientUid }, { projection: { _id: 1 } })
                .sort({ _id: -1 }).limit(500).toArray();
            const since = Date.now() - 7 * 86400_000;
            const buckets: Record<string, number> = {};
            for (const d of docs) {
                const ts: Date | undefined = d._id?.getTimestamp?.();
                if (!ts || ts.getTime() < since) continue;
                const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(ts);
                buckets[key] = (buckets[key] || 0) + 1;
            }
            recent = Object.keys(buckets).sort().map((k) => ({ date: k, count: buckets[k] }));
        } catch { /* 记录表结构不同就算了，不影响主统计 */ }

        const st = await getState(this.clientUid);
        this.ok({
            nAccept,
            nSubmit,
            acceptRate: rate,
            rp: dudoc?.rp ?? 0,
            rank: dudoc?.rank ?? 0,
            checkinDays: st.totalDays,
            maxStreak: st.maxStreak,
            recentSubmits: recent,
        });
    }
}
