/**
 * SanhaiOJ 客户端通道（hydrooj-client-gateway）
 * ============================================
 *
 * 给桌面客户端提供一套**带令牌认证的 JSON API**，替代「客户端爬网页表单」那条路。
 * 附带一套完整的签到（服务端判定、幂等、可发硬币）。
 *
 * 安装：
 *   hydrooj addon add /path/to/hydrooj-client-gateway
 *   pm2 restart hydrooj
 *
 * 安装后到「控制面板 → 系统设置 → hydrooj → 客户端通道」里配置奖励规则。
 */
// ⚠️ 只从 'hydrooj' 取东西。别 import 'schemastery' / 'mongodb' 这类裸包名 ——
//    插件被装到 ~/.hydro/addons/ 下时，Node 从那里往上找不到它们的 node_modules，
//    require 直接抛错。而 hydrooj 把这两个都**再导出**了（packages/hydrooj/src/libs.ts：
//    `export { _, ObjectID, Schema }` / `export { Filter, ObjectId } from 'mongodb'`），
//    所以从 'hydrooj' 拿是同一个东西，且一定解析得到。
import { Context, PRIV, Schema } from 'hydrooj';
import * as H from './handler';
import { init as initModel, diagnose } from './model';
import { initPoints } from './points';

/** 配置默认值。与下面的 Schema 保持一致（Hydro 传进来的 config 可能缺字段，这里兜底）。 */
const DEFAULTS = {
    tokenTtlDays: 365,
    checkinEnabled: true,
    dailyCoins: 1,
    streakBonus: [
        { day: 3, coins: 2, label: '连续 3 天' },
        { day: 7, coins: 5, label: '连续 7 天' },
        { day: 14, coins: 10, label: '连续 14 天' },
        { day: 30, coins: 30, label: '满月啦' },
    ],
    makeupCost: 5,
    makeupWindow: 3,
    // 补签也给「当天基础硬币」。默认 1 = 和 dailyCoins 同值 ——
    // 原来是 0，等于「扣 5 币换来 0 币」，补签纯亏，功能是废的。
    makeupReward: 1,
    // 打卡发的客户端积分（站点硬币之外的另一套）
    checkinPoints: 100,          // 第 1 天
    checkinPointsPerDay: 10,     // 之后每天加这个数
    checkinPointsCap: 200,       // 连续加成封顶（基础分照给 → 最高 300）
    coinEnabled: true,
    coinUserCollection: 'user',
    coinUserField: 'coin_now',      // SanhaiOJ 上 coin-33oj 用的字段（自检实测）
    coinAllField: 'coin_all',       // 累计获得；站点硬币榜按它筛人，必须一起涨
    // ⚠️ 账单集合是 `coin`，不是 `coin.bill` —— coin-33oj 的源码里就是
    //    `db.collection('coin')`，字段 {userId, rootId, amount, text}。
    //    2026-10-11 事故复盘：原来默认 `coin.bill` + 字段 {uid,amount,note}，
    //    结果是**签到发的币在站点流水里根本不出现**（余额倒是对的）。
    coinBillCollection: 'coin',
    coinWriteBill: true,            // 发币时是否同时写一张账单表
    adminUids: [5],
    checkinCollection: 'clientgw.checkin',
    checkinLogCollection: 'clientgw.checkin_log',
    checkinRepairCollection: 'clientgw.checkin_repair',
    tokenCollection: 'clientgw.token',
    pairCollection: 'clientgw.pair',
    // ---- 题面直传（见 handler/oj.ts 的 StatementHandler）----
    // 本站（SanhaiOJ）的题面不在 pdoc.content 里，而是 /sanhai-ui/statement/<token>，
    // 那条路由有防盗刷（UA 必须含 OjClient）。服务端代取一层，客户端就不用碰它。
    statementProxy: true,
    statementSelfBase: '',        // 空 = 按当前请求的 Host 反推
    statementCacheSeconds: 60,    // 0 = 不缓存
    statementTimeoutMs: 8000,
};

export const Config = Schema.object({
    tokenTtlDays: Schema.number().default(365).description('客户端令牌有效期（天）'),

    checkinEnabled: Schema.boolean().default(true).description('启用签到'),
    dailyCoins: Schema.number().default(1).description('每天签到的基础硬币'),
    streakBonus: Schema.array(Schema.object({
        day: Schema.number().description('连续到第几天'),
        coins: Schema.number().description('额外奖励硬币'),
        label: Schema.string().description('客户端上显示的说明'),
        repeat: Schema.boolean().default(false)
            .description('是否「每 N 天都给」；不勾 = 只在刚好第 N 天给一次'),
    })).default(DEFAULTS.streakBonus).description('连续签到奖励（可加多条）'),
    makeupCost: Schema.number().default(5).description('补签消耗的硬币'),
    makeupWindow: Schema.number().default(3).description('最多可补最近几天（0 = 关闭补签）'),
    makeupReward: Schema.number().default(1)
        .description('补签本身给多少硬币（默认 1 = 和每日基础硬币同值；补签同样计入连续天数）'),

    checkinPoints: Schema.number().default(100).description('打卡发多少客户端积分（连续第 1 天）'),
    checkinPointsPerDay: Schema.number().default(10).description('之后每多连 1 天多给多少积分'),
    checkinPointsCap: Schema.number().default(200).description('连续加成封顶（基础分照给，所以最高 = 基础 + 封顶）'),

    coinEnabled: Schema.boolean().default(true).description('启用硬币发放与读取'),
    coinUserCollection: Schema.string().default('user').description('存硬币数量的集合'),
    coinUserField: Schema.string().default('coin_now')
        .description('用户文档上记硬币数量的字段名（SanhaiOJ 是 coin_now）'),
    coinAllField: Schema.string().default('coin_all')
        .description('用户文档上记「累计获得」的字段名（coin-33oj 是 coin_all；站点硬币榜按它筛人）'),
    coinBillCollection: Schema.string().default('coin')
        .description('硬币账单集合（coin-33oj 是 coin；写错的话流水在站点上看不到）'),
    coinWriteBill: Schema.boolean().default(true)
        .description('发币时是否同时往账单集合写一条流水（关掉 = 只加余额）'),
    adminUids: Schema.array(Schema.number()).default([5]).description('能发硬币 / 看全部账单的 uid'),

    checkinCollection: Schema.string().default('clientgw.checkin').description('签到状态集合'),
    checkinLogCollection: Schema.string().default('clientgw.checkin_log').description('签到流水集合'),
    checkinRepairCollection: Schema.string().default('clientgw.checkin_repair')
        .description('补发记录集合（_id = uid；保证同一个人的历史差额只补一次）'),
    tokenCollection: Schema.string().default('clientgw.token').description('客户端令牌集合'),
    pairCollection: Schema.string().default('clientgw.pair').description('配对码集合'),

    statementProxy: Schema.boolean().default(true)
        .description('启用题面直传（GET /client-api/statement；关掉后该接口返回 404）'),
    statementSelfBase: Schema.string().default('')
        .description('服务端自取题面时用的站点地址（留空 = 按当前请求的 Host 反推，通常不用填）'),
    statementCacheSeconds: Schema.number().default(60)
        .description('题面缓存秒数（只缓存成功结果；0 = 关闭缓存）'),
    statementTimeoutMs: Schema.number().default(8000)
        .description('自取题面的超时（毫秒），超时按 site_unreachable 处理'),
});

export async function apply(ctx: Context, config: any = {}) {
    const cfg = { ...DEFAULTS, ...config };
    initModel(ctx, cfg);
    initPoints(ctx, cfg);

    /** 注册一个路由。参数不传 = 不检查权限（认证在 ClientApiHandler 里自己做）。 */
    const R = (name: string, path: string, Handler: any, priv?: number) => {
        if (priv === undefined) ctx.Route(name, path, Handler);
        else ctx.Route(name, path, Handler, priv);
    };

    // ---------------- 系统
    R('client_api_ping', '/client-api/ping', H.PingHandler);
    R('client_api_capabilities', '/client-api/capabilities', H.CapabilitiesHandler);
    R('client_api_diagnose', '/client-api/diagnose', H.DiagnoseHandler);
    R('client_api_notifications', '/client-api/notifications', H.NotificationsHandler);
    R('client_api_notification_read', '/client-api/notifications/read', H.NotificationReadHandler);

    // ---------------- 认证
    R('client_api_login', '/client-api/auth/login', H.AuthLoginHandler);
    R('client_api_pair', '/client-api/auth/pair', H.AuthPairHandler);
    // 这个走网页登录态（用户在浏览器里点「生成配对码」），所以要 PRIV_USER_PROFILE
    R('client_api_paircode', '/client-api/auth/paircode', H.PairCodeGenerateHandler, PRIV.PRIV_USER_PROFILE);
    R('client_api_whoami', '/client-api/auth/whoami', H.AuthWhoamiHandler);
    R('client_api_refresh', '/client-api/auth/refresh', H.AuthRefreshHandler);
    R('client_api_devices', '/client-api/auth/devices', H.AuthDevicesHandler);
    R('client_api_revoke', '/client-api/auth/revoke', H.AuthRevokeHandler);
    R('client_api_logout', '/client-api/auth/logout', H.AuthLogoutHandler);

    // ---------------- 我的
    R('client_api_me', '/client-api/me', H.MeHandler);
    R('client_api_me_stats', '/client-api/me/stats', H.MeStatsHandler);
    // 当前域内的权限（建题 / 看他人提交 / 看代码 …）。
    // ⚠️ 权限是**按域**算的，切域必须重新拉一次 —— 客户端原来只在登录时探一次，这是
    //    「有的域里建题入口不见了」的根因。
    R('client_api_perms', '/client-api/perms', H.PermsHandler);

    // ---------------- 签到
    R('client_api_checkin_status', '/client-api/checkin/status', H.CheckinStatusHandler);
    R('client_api_checkin', '/client-api/checkin', H.CheckinDoHandler);
    R('client_api_checkin_rules', '/client-api/checkin/rules', H.CheckinRulesHandler);
    R('client_api_checkin_calendar', '/client-api/checkin/calendar', H.CheckinCalendarHandler);
    R('client_api_checkin_rank', '/client-api/checkin/rank', H.CheckinRankHandler);
    R('client_api_checkin_logs', '/client-api/checkin/logs', H.CheckinLogsHandler);
    R('client_api_checkin_makeup', '/client-api/checkin/makeup', H.CheckinMakeupHandler);
    // 历史补发（管理员，默认 dry-run）—— 修的是「连续天数算错」遗留的少发
    R('client_api_checkin_repair', '/client-api/checkin/repair', H.CheckinRepairHandler);

    // ---------------- 题目
    R('client_api_problems', '/client-api/problems', H.ProblemsHandler);
    R('client_api_problem', '/client-api/problem', H.ProblemDetailHandler);
    R('client_api_problem_random', '/client-api/problem/random', H.RandomProblemHandler);
    // 题面直传：客户端不必自己去拉站点那个受防盗刷保护的 /sanhai-ui/statement/<token>。
    // 先在服务端取（带 OjClient UA + 缓存 + 并发去重），再把正文交给客户端。
    R('client_api_statement', '/client-api/statement', H.StatementHandler);

    // ---------------- 提交
    R('client_api_records', '/client-api/records', H.RecordsHandler);
    R('client_api_record', '/client-api/record', H.RecordDetailHandler);
    R('client_api_submit', '/client-api/submit', H.SubmitHandler);

    // ---------------- 比赛 / 讨论 / 排行
    R('client_api_contests', '/client-api/contests', H.ContestsHandler);
    R('client_api_discussions', '/client-api/discussions', H.DiscussionsHandler);
    R('client_api_ranking', '/client-api/ranking', H.RankingHandler);

    // ---------------- 硬币
    R('client_api_coin_balance', '/client-api/coin/balance', H.CoinBalanceHandler);
    R('client_api_coin_bill', '/client-api/coin/bill', H.CoinBillHandler);
    R('client_api_coin_rank', '/client-api/coin/rank', H.CoinRankHandler);
    R('client_api_coin_inc', '/client-api/coin/inc', H.CoinIncHandler);

    // 客户端积分（和站点硬币是两套货币，互不换算）
    R('client_api_points', '/client-api/points', H.PointsMeHandler);
    R('client_api_points_board', '/client-api/points/board', H.PointsBoardHandler);
    R('client_api_points_gift', '/client-api/points/gift', H.PointsGiftHandler);
    R('client_api_points_grant', '/client-api/points/grant', H.PointsGrantHandler);
    // 任务中心
    R('client_api_tasks', '/client-api/tasks', H.TaskListHandler);
    R('client_api_tasks_claim', '/client-api/tasks/claim', H.TaskClaimHandler);

    ctx.logger?.info?.('[clientgw] 客户端通道已就绪：/client-api/*');

    // 启动自检：延迟跑一次，把「硬币 / 签到配置对不对」写进日志。
    // ⚠️ 为什么必须主动做：硬币字段名配错时**不会报错**，只会让硬币静默发不出去
    //    （MongoDB 的 updateOne 匹配不到就当没这回事）。所以装完就把它说出来，
    //    别等人发现「签到不给币」。
    setTimeout(() => {
        diagnose()
            .then((r) => {
                ctx.logger?.info?.(`[clientgw] 自检：${r.summary}`);
                if (r.coin.siteCoinModel) {
                    ctx.logger?.info?.('[clientgw] 发币将直接调用站点硬币插件的 inc()（账单与 coin_all 交给它维护）');
                }
                if (r.coin.billFields.length) {
                    ctx.logger?.info?.(`[clientgw] 账单集合 ${r.coin.billCollection} 的字段：${r.coin.billFields.join('、')}`);
                }
                for (const issue of r.issues) ctx.logger?.warn?.(`[clientgw] 待确认：${issue}`);
                if (r.coin.suggestedField && r.coin.suggestedField !== r.coin.userField) {
                    ctx.logger?.warn?.(`[clientgw] 建议把 coinUserField 改成 \`${r.coin.suggestedField}\``);
                }
                if (r.coin.suggestedBillCollection) {
                    ctx.logger?.warn?.(
                        `[clientgw] 建议把 coinBillCollection 改成 \`${r.coin.suggestedBillCollection}\``,
                    );
                }
            })
            .catch((e) => ctx.logger?.warn?.(`[clientgw] 自检没跑成：${(e as Error).message}`));
    }, 8000);
}
