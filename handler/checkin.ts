/**
 * 签到。
 *
 * ⚠️ 为什么这套签到是**安全的**（跟你上一轮担心的「刷硬币」有关）：
 *   「签到」这件事的判定权完全在**服务端** —— 服务端知道今天几号、这个 uid 今天
 *   有没有签过、他昨天签没签（决定连续天数）。客户端只是**触发**，说什么都不算数。
 *   所以哪怕有人伪造请求、拿真令牌狂打，结果也只是「今天已经签过了」，一分硬币多发不了。
 *   这就是上一轮说的 **B 类（服务端可记状态）**，属于可以放心发奖励的那一类。
 *
 * 幂等的物理保证是 `checkin_log` 上 `(uid, date)` 的唯一索引 —— 不是靠代码里的 if。
 */
import { ClientApiHandler } from './base';
import {
    getState, doCheckin, getCalendar, getRank, recentLogs, calcReward,
    coinBalance, grantCoin, getConfig,
} from '../model';
import { today, yesterday } from '../lib';
import { grantCheckinPoints } from '../points';

/** 批量取用户名（排行榜要显示名字，光有 uid 没法看）。 */
async function names(ctx: any, uids: number[]): Promise<Record<number, string>> {
    const uniq = [...new Set(uids)].filter((x) => x);
    if (!uniq.length) return {};
    try {
        const docs = await ctx.db.collection('user')
            .find({ _id: { $in: uniq } }, { projection: { uname: 1 } }).toArray();
        const m: Record<number, string> = {};
        for (const d of docs) m[d._id] = d.uname;
        return m;
    } catch { return {}; }
}

/** 状态计算（status 和签到后的返回共用）。 */
async function buildStatus(ctx: any, uid: number) {
    const st = await getState(uid);
    const t = today();
    const signed = st.lastDate === t;
    // 今天签到能拿多少（预览）；如果连续断了，按重新开始算
    const willStreak = signed
        ? st.streak
        : (st.lastDate === yesterday() ? st.streak + 1 : 1);
    const preview = calcReward(willStreak);
    const coins = await coinBalance(uid).catch(() => 0);
    return {
        date: t,
        signed,
        streak: st.streak,
        maxStreak: st.maxStreak,
        totalDays: st.totalDays,
        totalReward: st.totalReward,
        todayStreakIfSign: willStreak,
        todayRewardIfSign: preview.total,
        todayBonusLabel: preview.bonusLabel,
        coinBalance: coins,
    };
}

// ---------------------------------------------------------------- 状态

export class CheckinStatusHandler extends ClientApiHandler {
    protected async run() {
        this.ok(await buildStatus((this as any).ctx, this.clientUid));
    }
}

// ---------------------------------------------------------------- 签到

export class CheckinDoHandler extends ClientApiHandler {
    protected async run() {
        const r = await doCheckin(this.clientUid);
        const st = await buildStatus((this as any).ctx, this.clientUid);

        // ⭐ 打卡时**同时发客户端积分**（站点硬币之外的那一套）。
        // 幂等键是 checkin:<uid>:<日期>，所以一天只发一次；重复签到拿不到第二份。
        // 积分发放失败**不能影响打卡** —— 打卡是主功能，积分是附加的。
        let points = 0;
        let pointsBalanceAfter = 0;
        try {
            const p = await grantCheckinPoints(this.clientUid, r.already ? 0 : r.streak);
            points = p.points;
            pointsBalanceAfter = p.balance;
        } catch (e: any) {
            (this as any).ctx?.logger?.warn?.(`[clientgw] 打卡发积分失败（不影响打卡）：${e?.message || e}`);
        }

        this.ok({
            ...r,
            already: !!r.already,
            points,
            pointsBalance: pointsBalanceAfter,
            message: r.already
                ? '今天已经签过啦，明天再来～'
                : `签到成功！连续 ${r.streak} 天，获得 ${r.reward} 硬币${r.bonusLabel ? `（${r.bonusLabel}）` : ''}`
                  + (points ? `，另有 ${points} 客户端积分` : ''),
            status: st,
        });
    }
}

// ---------------------------------------------------------------- 规则（客户端展示用）

export class CheckinRulesHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        const table = Array.isArray(cfg.streakBonus) ? cfg.streakBonus : [];
        this.ok({
            dailyCoins: Number(cfg.dailyCoins ?? 1),
            streakBonus: table.map((r: any) => ({
                day: r.day,
                coins: r.coins,
                label: r.label || `连续 ${r.day} 天`,
                // false = 只在刚好第 N 天给一次；true = 每 N 天都给
                repeat: !!r.repeat,
            })),
            makeupCost: Number(cfg.makeupCost ?? 5),
            makeupWindow: Number(cfg.makeupWindow ?? 3),
            makeupReward: Number(cfg.makeupReward ?? 0),
            timezone: 'Asia/Shanghai',
        });
    }
}

// ---------------------------------------------------------------- 日历

export class CheckinCalendarHandler extends ClientApiHandler {
    protected async run() {
        const month = String(this.param('month', ''));
        const r = await getCalendar(this.clientUid, month);
        this.ok(r);
    }
}

// ---------------------------------------------------------------- 排行

export class CheckinRankHandler extends ClientApiHandler {
    protected async run() {
        const by = String(this.param('by', 'streak'));
        const limit = this.intParam('limit', 50);
        const rows = await getRank(by, limit);
        const nm = await names((this as any).ctx, rows.map((r) => r.uid));
        this.ok({
            by,
            list: rows.map((r) => ({ ...r, uname: nm[r.uid] || `uid:${r.uid}` })),
            me: rows.find((r) => r.uid === this.clientUid)?.rank || 0,
        });
    }
}

// ---------------------------------------------------------------- 明细

export class CheckinLogsHandler extends ClientApiHandler {
    protected async run() {
        const limit = this.intParam('limit', 30);
        this.ok({ logs: await recentLogs(this.clientUid, limit) });
    }
}

// ---------------------------------------------------------------- 补签

export class CheckinMakeupHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        const cost = Number(cfg.makeupCost ?? 5);
        const window = Number(cfg.makeupWindow ?? 3);
        const date = String(this.param('date', ''));

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { this.fail('请给出要补签的日期（YYYY-MM-DD）'); return; }
        if (date >= today()) { this.fail('只能补过去的日子'); return; }

        // 只能补最近 window 天
        const dayMs = 86400_000;
        const diff = Math.floor((Date.now() - new Date(`${date}T00:00:00+08:00`).getTime()) / dayMs);
        if (diff > window) { this.fail(`只能补最近 ${window} 天内的签到`); return; }

        const bal = await coinBalance(this.clientUid).catch(() => 0);
        if (bal < cost) { this.fail(`补签需要 ${cost} 硬币，当前只有 ${bal}`); return; }

        // 先扣费再补 —— 补签失败（比如那天其实签过）要把费用退回去
        await grantCoin(this.clientUid, -cost, `补签 ${date}`).catch(() => {});
        const r = await doCheckin(this.clientUid, { makeup: true, date });
        if (r.already) {
            await grantCoin(this.clientUid, cost, `补签失败退还 ${date}`).catch(() => {});
            this.fail('那天已经签过了，费用已退回'); return;
        }
        this.ok({ ...r, cost, message: `补签 ${date} 成功，花费 ${cost} 硬币` });
    }
}
