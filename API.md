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
| GET | `/client-api/notifications` | 需要 | 私信/通知列表 |
| POST | `/client-api/notifications/read` | 需要 | 标记已读（`id=xxx` 或 `all=1`） |

**`/client-api/capabilities` 建议客户端启动时第一个调** —— 它告诉客户端该显示什么：

```jsonc
{
  "ok": true,
  "uid": 5,
  "features": {
    "checkin": true, "checkinMakeup": true, "coin": true,
    "problems": true, "records": true, "submit": true,
    "contests": true, "discussions": true, "ranking": true,
    "notifications": true, "pairLogin": true
  },
  "checkin": { "signedToday": false, "streak": 6, "makeupWindow": 3, "makeupCost": 5 },
  "isAdmin": true,
  "apiVersion": 1
}
```

这样以后加功能不用发新版客户端：新功能开关由服务端告诉它。

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
| GET | `/client-api/records` | `page, limit, mine=1, pid, uid` | 提交记录 |
| GET | `/client-api/record` | `rid` | 评测详情（**自己的提交才返回代码**） |
| POST | `/client-api/submit` | `pid, lang, code` | 提交代码 |

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
