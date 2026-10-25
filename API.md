# SanhaiOJ 客户端通道 · API 清单

> 由 Hydro 插件 **`hydrooj-client-gateway`** 提供。
> 基地址 = 你的 OJ 域名，例如 `https://www.myijk.com`。
> 所有接口返回 JSON；除 `ping` 外都需要请求头 `Authorization: Bearer <令牌>`。

---

## 0. 通用约定

**认证**

```
Authorization: Bearer <token>
```
（也支持 `?token=` 和 `X-Client-Token` 头，给调试用；正式请用 Authorization 头）

**成功 / 失败**

```jsonc
// 成功
{ "ok": true, ... }
// 失败（HTTP 状态码同时会给出 400/401/403/404）
{ "ok": false, "error": "人类可读的说明" }
```

| 状态码 | 含义 |
|---|---|
| 401 | 没带令牌 / 令牌无效 / 过期 / 已撤销 |
| 403 | 令牌有效但没权限（比如非管理员要发硬币） |
| 400 | 参数不对，或业务拒绝（如「今天已经签过了」不算错误，见返回值） |
| 404 | 对象不存在（题目、记录…） |

**分页**：统一 `?page=1&limit=20`。
**时间**：所有「日期」按 **Asia/Shanghai** 算。响应里的时间戳是 ISO 字符串或毫秒数，会标注。

**限流**：单令牌 600 次/分钟；登录类接口按 IP 20 次/分钟。

---

## 1. 系统

| 方法 | 路径 | 令牌 | 说明 |
|---|---|---|---|
| GET | `/client-api/ping` | 不需要 | 连通性 + 服务端时间（客户端猜时钟差用） |
| GET | `/client-api/capabilities` | 需要 | **能力清单**：这台 OJ 有哪些功能可用、我是不是管理员 |
| GET | `/client-api/diagnose` | 需要（管理员） | **自检**：硬币字段 / 账单集合配得对不对（含建议值） |
| GET | `/client-api/notifications` | 需要 | 私信/通知列表（`unread` 为精确全量，`byConv` 为分会话未读） |
| POST | `/client-api/notifications/read` | 需要 | 标记已读（`all=1` / `conv=` / `ids=` / `id=`，按账号记） |

**`/client-api/capabilities` 建议客户端启动时第一个调** —— 它告诉客户端该显示什么：

```jsonc
{
  "ok": true,
  "uid": 5,
  "features": {
    "checkin": true, "checkinMakeup": true, "coin": true,
    "problems": true, "records": true, "submit": true,
    "contests": true, "discussions": true, "ranking": true,
    "notifications": true, "notificationsReadBy": true, "pairLogin": true
  },
  "checkin": { "signedToday": false, "streak": 6, "makeupWindow": 3, "makeupCost": 5 },
  "isAdmin": true,
  "apiVersion": 1
}
```

这样以后加功能不用发新版客户端：新功能开关由服务端告诉它。

### 私信

**`GET /client-api/notifications`** —— 私信列表（`limit` 默认 20，最大 100）

```jsonc
{
  "ok": true,
  "unread": 37,               // ★ 精确的全量未读数，与 limit / 分页无关
  "byConv": {                 // ★ 分会话未读：key 是对方 uid（字符串），value 是未读条数
    "5": 12,
    "7": 3
  },
  "messages": [
    {
      "id": "670f1c...",
      "from": 5,
      "content": "……（最多 500 字）",
      "read": false,          // ★ 当前用户视角：我读过没有
      "readAt": null,         // 我读到的时间（ISO 字符串）；没读 / 老数据为 null
      "at": 1697000000000
    }
  ]
}
```

> **`read` 是「我」的视角，不是消息的全局状态。** 一条消息可以同时发给多个人（`to` 是数组），
> A 读过之后 B 仍是未读 —— 已读按 **uid** 记在消息文档上，所以**跨设备一致**：
> 换台电脑登录同一个账号，已读还是已读。
> 升级前就标记过已读的老消息仍算已读，不会突然全变未读。
> `unread` 用 `countDocuments` 全量数，**不受 `limit` 限制**（老版本只数当前页，未读超过 20 时角标会卡住）。
>
> **`byConv`** —— 按对方（`from`）分组的未读聚合，口径和 `unread` **完全一致**
> （同一个查询条件 `$match`），所以 `sum(byConv) === unread`。
> `from` 在库里可能存成数字或字符串，统一数字化后当 key（同一会话不会因为存储类型不同被算成两个）。
> 一条发给多人的消息（`to` 是数组）对**每个**收件人各算 1。
> 聚合失败（老库 / 账号没有聚合权限）时返回 `{}` —— `unread` / `messages` 照常给，**不会报错**。

**`POST /client-api/notifications/read`** —— 标记已读

| 参数 | 说明 |
|---|---|
| `all=1` | 把我收到的全部标记为已读（顺手清网页端 `unreadMsg` 角标） |
| `conv=<uid>` | 只清**这个会话**：`from` 为该 uid、且我是收件人的未读全部已读 |
| `ids=<id1,id2,...>` | 批量按消息 id 清，逗号分隔；**最多 200 个**（超出截断），非法 id 跳过不报错 |
| `id=xxx` | 标记单条 |

**优先级：`all=1` > `conv` > `ids` > `id`** —— 同时传多个时只按最左边那个走，**不叠加**。
一个参数都不给会报错（`请给出消息 id，或传 all=1 全部已读`）。

> ⚠️ 客户端 POST 的 body 恒为 `{}`，**参数请放在 query 上**（如
> `POST /client-api/notifications/read?conv=5`）。

```jsonc
{
  "ok": true,
  "updated": 3,               // 实际改动的条数
  "scope": "conv"             // "all" | "conv" | "ids" | "one"，告诉客户端这次按哪条规则走的
}
```

> `scope` 用来让客户端确认服务端**真的**按新语义执行了（老版本服务端不会返回这个字段，
> 也会忽略 `conv` / `ids`）—— 客户端可先看 `features.notificationsReadBy`。
> `conv` 同时用 `from: { $in: [Number(conv), String(conv)] }` 匹配，**`from` 存成字符串也能清掉**。
> 只会改动**「我」那一份**已读状态：同一份消息文档里其他收件人的状态原样不动。
> 只能标记自己是收件人的消息 —— 拿别人的消息 id 来标记会得到 `updated: 0`，不会改动任何数据。
> `all=1` 还会顺手把 Hydro 网页端的未读角标（用户文档上的 `unreadMsg`）清零，让网页端角标同步消失；
> 这一步失败不影响已读本身。

---

## 2. 认证

| 方法 | 路径 | 令牌 | 参数 | 说明 |
|---|---|---|---|---|
| POST | `/client-api/auth/login` | 不需要 | `username, password, device?` | 账号密码换令牌 |
| POST | `/client-api/auth/pair` | 不需要 | `code, device?` | 6 位配对码换令牌 |
| GET | `/client-api/auth/paircode` | **网页登录态** | — | 生成配对码（**给网页用**，需已登录） |
| GET | `/client-api/auth/whoami` | 需要 | — | 当前身份 + 令牌到期时间 |
| POST | `/client-api/auth/refresh` | 需要 | — | 换新令牌（旧的作废） |
| GET | `/client-api/auth/devices` | 需要 | — | 已授权设备列表 |
| POST | `/client-api/auth/revoke` | 需要 | `id=xxx` 或 `all=1` | 撤销设备 |
| POST | `/client-api/auth/logout` | 需要 | — | 退出（撤销全部令牌） |

**登录成功返回**

```jsonc
{ "ok": true, "token": "xxxxx", "uid": 5, "uname": "sanhai", "role": "admin", "expiresInDays": 365 }
```

**配对码流程**（推荐给客户端用）

```
用户浏览器:  GET /client-api/auth/paircode        → { code: "482913", expireInSeconds: 900 }
客户端:      POST /client-api/auth/pair { code, device:"小明-笔记本" }
             → { token, uid, uname, role }
```

---

## 3. 签到 ★

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/client-api/checkin/status` | — | 今天签没签 + 连续/总计 + **今天签能得多少** |
| POST | `/client-api/checkin` | — | 签到 |
| GET | `/client-api/checkin/rules` | — | 奖励规则（渲染「连签 7 天得 5 币」这种提示） |
| GET | `/client-api/checkin/calendar` | `month=2026-10` | 月历（每天签没签） |
| GET | `/client-api/checkin/rank` | `by=streak\|total`, `limit` | 排行 |
| GET | `/client-api/checkin/logs` | `limit` | 最近签到明细 |
| POST | `/client-api/checkin/makeup` | `date=2026-10-10` | 补签（花硬币） |

**`rules` 返回**（客户端用它渲染「连签 7 天得 5 币」这类提示）

```jsonc
{
  "ok": true,
  "dailyCoins": 1,
  "streakBonus": [
    { "day": 3,  "coins": 2, "label": "连续 3 天",  "repeat": false },
    { "day": 7,  "coins": 5, "label": "连续 7 天",  "repeat": false }
  ],
  "makeupCost": 5, "makeupWindow": 3, "makeupReward": 0,
  "timezone": "Asia/Shanghai"
}
```

> `repeat: false`（默认）= **只在刚好第 N 天给一次**；`true` = 每 N 天都给。
> 客户端按这个区分「里程碑」和「周期性」奖励。
> ⚠️ 里程碑语义下，连续第 6 天**不会**因为「6 是 3 的倍数」而再拿一次连签 3 的奖励。

**`status` 返回**

```jsonc
{
  "ok": true,
  "date": "2026-10-11",
  "signed": false,               // 今天签没签
  "streak": 6,                   // 当前连续
  "maxStreak": 12,
  "totalDays": 48,
  "totalReward": 96,
  "todayStreakIfSign": 7,        // 今天签了会是多少
  "todayRewardIfSign": 6,        // 今天签了能得多少（基础 1 + 连签 5）
  "todayBonusLabel": "连续 7 天",
  "coinBalance": 275
}
```

**`POST /checkin` 返回**

```jsonc
{
  "ok": true,
  "date": "2026-10-11", "streak": 7, "reward": 6,
  "base": 1, "bonus": 5, "bonusLabel": "连续 7 天",
  "totalDays": 49, "totalReward": 102,
  "already": false,
  "message": "签到成功！连续 7 天，获得 6 硬币（连续 7 天）",
  "status": { /* 同 status 接口 */ }
}
```

> 重复签到**不是错误**：返回 `already: true`、`reward: 0`，HTTP 仍是 200。客户端好写。
>
> 上面的数字只是示例，**以 `/client-api/checkin/rules` 为准**。

---

## 4. 「我的」

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/client-api/me` | 账号信息：uid / uname / role / 硬币 / rp / 名次 / 签到概况 |
| GET | `/client-api/me/stats` | 统计：AC 数 / 提交数 / 通过率 / 最近 7 天提交趋势 |
| GET | `/client-api/perms` | **当前域内权限**：建题 / 改题 / 看他人提交 / 看代码 / 发讨论… |

> ⚠️ **权限是按域算的**，切换域之后要**重新拉一次** `/client-api/perms`。
> 客户端原来判「能不能建题」是去抓 `/d/{domain}/problem/create` 的返回文本找关键字，
> 那个做法不跟着域走 —— 这就是「有的域里建题功能没工作」的原因。

---

## 5. 题目

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/client-api/problems` | `page, limit, q` | 题目列表（`q` 支持标题模糊 / 题号） |
| GET | `/client-api/problem` | `pid` | 题目详情 |
| GET | `/client-api/problem/random` | — | 随机一题 |

---

## 6. 提交

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/client-api/records` | `page, limit, mine=1, pid, uid, status` | 提交记录 |
| GET | `/client-api/record` | `rid` | 评测详情（`canSeeCode` 告诉你代码给没给） |
| POST | `/client-api/submit` | `pid, lang, code` | 提交代码 |

**`/client-api/records` 的权限规则（和 Hydro 网页端完全一致）**：

- 不带 `uid`（= 查全部）或 `uid` 是别人 → 需要 `PERM_VIEW_RECORD`；
- 没权限时不带 `uid` → **自动收敛成只看自己**（返回 `uidScope` = 你自己）；
- 没权限且**明确指名别人** → `403`，不做静默降级（否则调用方会以为拿到了别人的数据）；
- 返回值带 `canViewAll`，客户端据此决定「本题全部提交 / 只看 AC」那些入口显不显示。

`status=1` 即「只看 AC」。配合 `pid` 就能实现网页端的「按题目查看所有提交」。

**`/client-api/record` 的代码可见性**：自己的记录永远给代码；
看别人的需要 `PERM_READ_RECORD_CODE`，只看 AC 代码则 `PERM_READ_RECORD_CODE_ACCEPT`。
返回里的 `isSelf` / `canSeeCode` 让客户端能区分「没代码」和「没权限看代码」。

**提交**

```
POST /client-api/submit
{ "pid": 1000, "lang": "cc.cc14o2", "code": "#include <bits/stdc++.h>..." }
→ { "ok": true, "rid": "6712ab...", "message": "已提交，正在等待评测" }
```

> `lang` 用 Hydro 的语言码（和网页提交框里的 value 一致）。
> 提交后拿 `rid` 轮询 `/client-api/record?rid=` 看结果。

---

## 7. 比赛 / 讨论 / 排行

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/client-api/contests` | — | 比赛列表（含 `phase`: upcoming/running/ended） |
| GET | `/client-api/discussions` | — | 讨论/题解列表 |
| GET | `/client-api/ranking` | `limit` | 用户排行榜（按 rp） |

---

## 8. 硬币

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/client-api/coin/balance` | — | 我的余额。返回 `{uid, coin, coinAll, now, all}`（`coin`/`now` = 当前，`coinAll`/`all` = 累计获得） |
| GET | `/client-api/coin/bill` | `page, limit, all=1` | 账单（`all=1` 仅管理员）。`bills[]` 每项 `{id, uid, userId, rootId, amount, note, text, at}`；`at` 常为 `null` —— coin-33oj 的账单没有时间字段，时间在 ObjectId 前 8 位里 |
| GET | `/client-api/coin/rank` | `limit` | 硬币排行 |
| POST | `/client-api/coin/inc` | `uid, amount, note` | **管理员**发硬币 |

> ⚠️ 余额读的是站点硬币插件的字段（默认 `user.coin_now` / `user.coin_all`），
> 账单读的是它那张集合（默认 `coin`）。**别用网页抓取取这几个数** ——
> 2026-10-11 实测客户端的 HTML 正则拿到的是 0，而这里返回的是 952。

---

## 9. 客户端的典型调用流程

**第一次启动**

```
1. GET  /client-api/ping                       测通
2. （没令牌）→ 引导用户配对码或账号密码登录
3. GET  /client-api/capabilities               拿到功能清单，决定显示哪些入口
4. GET  /client-api/me                         显示头像/名字/硬币
```

**每次打开**

```
1. GET  /client-api/capabilities               顺手确认令牌还有效（401 就重新登录）
2. GET  /client-api/checkin/status             未签到 → 首页弹签到按钮
3. GET  /client-api/coin/balance               显示硬币
```

**签到**

```
1. GET  /client-api/checkin/status             看 signed
2. POST /client-api/checkin                    签
3. 拿着返回的 reward 播个动画
4. GET  /client-api/checkin/rank?by=streak     顺便看看名次
```

**做题**

```
1. GET  /client-api/problems?page=1
2. GET  /client-api/problem?pid=1000
3. POST /client-api/submit
4. GET  /client-api/record?rid=xxx             轮询到 status 不是 Waiting
```

---

## 10. 全部接口速查（35 个）

```
系统     GET  /client-api/ping
        GET  /client-api/capabilities
        GET  /client-api/diagnose                 (管理员)
        GET  /client-api/notifications
        POST /client-api/notifications/read

认证    POST /client-api/auth/login
        POST /client-api/auth/pair
        GET  /client-api/auth/paircode        (网页)
        GET  /client-api/auth/whoami
        POST /client-api/auth/refresh
        GET  /client-api/auth/devices
        POST /client-api/auth/revoke
        POST /client-api/auth/logout

签到    GET  /client-api/checkin/status
        POST /client-api/checkin
        GET  /client-api/checkin/rules
        GET  /client-api/checkin/calendar
        GET  /client-api/checkin/rank
        GET  /client-api/checkin/logs
        POST /client-api/checkin/makeup

我的    GET  /client-api/me
        GET  /client-api/me/stats

题目    GET  /client-api/problems
        GET  /client-api/problem
        GET  /client-api/problem/random

提交    GET  /client-api/records
        GET  /client-api/record
        POST /client-api/submit

比赛    GET  /client-api/contests
讨论    GET  /client-api/discussions
排行    GET  /client-api/ranking

硬币    GET  /client-api/coin/balance
        GET  /client-api/coin/bill
        GET  /client-api/coin/rank
        POST /client-api/coin/inc             (管理员)
```
