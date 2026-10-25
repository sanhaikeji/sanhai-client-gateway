/**
 * 客户端积分 / 任务中心的 HTTP 接口。
 *
 * <p>全部继承 <see cref="ClientApiHandler"/>，认证在基类统一做（Bearer 令牌），
 * 所以这里只管业务。</p>
 */
import { ClientApiHandler } from './base';
import { isAdmin } from './coin';
import {
    pointsBalance, pointsHistory, pointsBoard, pointsRank,
    spendPoints, addPoints, taskOverview, claimTask,
} from '../points';
import { getConfig } from '../model';

const uidParam = (h: ClientApiHandler, key = 'uid'): number => {
    const v = Number(h.param(key, 0));
    return Number.isInteger(v) && v > 0 ? v : 0;
};

// ---------------------------------------------------------------- 查询

/** GET /client-api/points —— 我的积分：余额 + 名次 + 最近流水。 */
export class PointsMeHandler extends ClientApiHandler {
    protected async run() {
        const uid = this.clientUid;
        const [balance, rank, recent] = await Promise.all([
            pointsBalance(uid), pointsRank(uid), pointsHistory(uid, 20),
        ]);
        this.ok({ uid, balance, rank, recent });
    }
}

/** GET /client-api/points/board —— 积分榜。 */
export class PointsBoardHandler extends ClientApiHandler {
    protected async run() {
        const limit = Number(this.param('limit', 20));
        this.ok({ board: await pointsBoard(Number.isInteger(limit) ? limit : 20) });
    }
}

// ---------------------------------------------------------------- 变动

/**
 * POST /client-api/points/gift —— 把自己的积分转给别人。
 *
 * <p>管理员（uid=5）可以直接给任意人；普通用户只能转自己的，且转完余额不能是负的。
 * 「扣多少、加多少」在服务端各算一次，扣和加都要成功才算完成 —— 只扣不加是最容易出事的写法。</p>
 */
export class PointsGiftHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        const toUid = uidParam(this, 'toUid');
        const amount = Number(this.param('amount', 0));
        const note = String(this.param('note', '') || '').slice(0, 100);

        if (!toUid) { this.fail('缺少 toUid', 400); return; }
        if (toUid === this.clientUid) { this.fail('不能转给自己', 400); return; }
        if (!Number.isInteger(amount) || amount <= 0) { this.fail('数额不合法', 400); return; }
        if (amount > 100000) { this.fail('单笔数额过大，请分批', 400); return; }

        const admin = isAdmin(cfg, this.clientUid);
        if (admin) {
            // 管理员：直接从自己账上转（所以管理员也得有余额），或者走「发放」
            const r = await spendPoints(this.clientUid, amount, `赠送积分给 uid ${toUid}${note ? `：${note}` : ''}`, this.clientUid);
            if (!r.ok) { this.fail(r.error || '扣分失败', 400); return; }
            const add = await addPoints(toUid, amount, `来自 uid ${this.clientUid} 的赠送${note ? `：${note}` : ''}`, this.clientUid);
            this.ok({ from: this.clientUid, to: toUid, amount, balance: add.balance });
            return;
        }

        const r = await spendPoints(this.clientUid, amount, `赠送积分给 uid ${toUid}${note ? `：${note}` : ''}`, this.clientUid);
        if (!r.ok) { this.fail(r.error || '积分不够', 400); return; }
        const add = await addPoints(toUid, amount, `来自 uid ${this.clientUid} 的赠送${note ? `：${note}` : ''}`, this.clientUid);
        this.ok({ from: this.clientUid, to: toUid, amount, balance: add.balance });
    }
}

/** POST /client-api/points/grant —— 管理员直接发放（不走自己的余额）。 */
export class PointsGrantHandler extends ClientApiHandler {
    protected async run() {
        const cfg: any = getConfig();
        if (!isAdmin(cfg, this.clientUid)) { this.fail('没有发放权限', 403); return; }

        const uid = uidParam(this);
        const amount = Number(this.param('amount', 0));
        const note = String(this.param('note', '') || '管理员发放');
        if (!uid) { this.fail('缺少 uid', 400); return; }
        if (!Number.isInteger(amount) || amount === 0) { this.fail('数额不合法', 400); return; }
        if (Math.abs(amount) > 100000) { this.fail('单次数额过大，请分批', 400); return; }

        const r = await addPoints(uid, amount, `${note}（uid ${this.clientUid} 发放）`, this.clientUid);
        this.ok({ uid, amount, note, balance: r.balance });
    }
}

// ---------------------------------------------------------------- 任务

/** GET /client-api/tasks —— 任务列表 + 我的状态（完成与否服务端判）。 */
export class TaskListHandler extends ClientApiHandler {
    protected async run() {
        const ctx = (this as any).ctx;   // 和 checkin.ts 同一个取法
        const tasks = await taskOverview(ctx, this.clientUid);
        this.ok({ tasks, balance: await pointsBalance(this.clientUid) });
    }
}

/** POST /client-api/tasks/claim —— 领奖。先服务端判定完成，再幂等发分。 */
export class TaskClaimHandler extends ClientApiHandler {
    protected async run() {
        const taskId = String(this.param('taskId', '') || '');
        if (!taskId) { this.fail('缺少 taskId', 400); return; }
        const ctx = (this as any).ctx;   // 和 checkin.ts 同一个取法
        const r = await claimTask(ctx, this.clientUid, taskId);
        if (!r.ok) { this.fail(r.error || '领取失败', 400); return; }
        this.ok(r);
    }
}