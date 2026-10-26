# hydrooj-client-gateway — 客户端通道

给 SanhaiOJ 桌面客户端提供一套**带令牌认证的 JSON API**，取代「客户端去爬网页表单」那条路。

配套功能：**签到**（服务端判定、幂等、可发硬币）。

---

## 一、为什么是插件、而不是改客户端

客户端现在办事的方式是「模拟网页请求 + 解析 HTML」。这条路有三个躲不掉的问题：

1. **人机验证**：登录/提交一旦加验证码，客户端直接失效；
2. **抓页面很脆**：网页改一次类名/结构，客户端就得跟着改一版；
3. **拿不到完整数据**：余额这种数字得从 HTML 里抠 —— 而且**真的会抠不到**。
   2026-10-11 实测：客户端硬币页的正则 `"coin_now":(\d+)` 拿到的是 `0`，
   而同一时刻通道接口返回的余额是 `952`。同类问题还有「累计获得」也在同一次请求里一起变 0。

插件给客户端开一套**稳定的 JSON 接口**，上面三个问题一起消掉 —— 顺带把「签到」这种新功能做进去。

---

## 二、安装

```bash
# 1. 拉到服务器（推荐：以后更新只要 git pull）
cd /root/addon
git clone https://github.com/sanhaikeji/sanhai-client-gateway.git

#    （没有 git / 想手动传：把整个目录放到 /root/addon/ 下即可，目录名随意）

# 2. 注册插件（用实际绝对路径）
hydrooj addon add /root/addon/sanhai-client-gateway

# 3. 重启（pm2 方式）
pm2 restart hydrooj
```

以后更新：

```bash
cd /root/addon/sanhai-client-gateway && git pull && pm2 restart hydrooj
```

装完访问 `https://你的域名/client-api/ping`，能看到一段 JSON 就说明通了：

```json
{ "ok": true, "service": "SanhaiOJ 客户端通道", "timezone": "Asia/Shanghai" }
```

> `ping` 是**唯一**不需要令牌的接口 —— 客户端连令牌都还没有的时候也要能测通。

**装完第二步：看自检结果（⭐ 别跳过）**

启动日志里会出现一条 `[clientgw] 自检：…`。

**为什么必须看**：硬币字段名配错时**不会报错**，只会让硬币**静默发不出去**
（MongoDB 的更新匹配不到就当没发生）。所以插件装完会自己查一遍，并且**给出建议值**：

```
[clientgw] 自检：有 2 处配置要确认
[clientgw] 待确认：硬币字段 user.coin 读不到 —— 发币会失败，检查 coinUserField
[clientgw] 建议把 coinUserField 改成 `coin_now`
```

也可以登录后调 `GET /client-api/diagnose`（管理员）看详细结果 —— 它会列出
用户文档上所有数字字段、库里所有含 coin 的集合，帮你对照着改配置。

配置入口：**控制面板 → 系统设置 → hydrooj → 客户端通道**。

---

## 三、认证：两条路

所有接口（除了 `ping`）都要带令牌：

```
Authorization: Bearer <token>
```

令牌怎么来，有两条路：

### 路一：配对码（推荐）

1. 用户在**浏览器**里打开 `/client-api/auth/paircode`（需已登录），拿到 6 位码；
2. 客户端里填这个码 → 调 `POST /client-api/auth/pair?code=123456` → 换到令牌。

好处：**密码从不经过客户端**；用户能在网页上看到「哪些设备登录过」，随时踢掉。

### 路二：账号密码

客户端直接填账号密码 → `POST /client-api/auth/login` → 换令牌。

方便，但密码要在客户端出现一次。适合自己用。

> 令牌默认 365 天有效（可配），落库只存 **SHA-256 哈希** —— 就算数据库被人看到，也拿不到能用的令牌。

---

## 四、签到

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/client-api/checkin/status` | 今天签没签、连续天数、总天数、今天签能得多少 |
| POST | `/client-api/checkin` | 签到 |
| GET | `/client-api/checkin/rules` | 奖励规则（客户端展示用） |
| GET | `/client-api/checkin/calendar?month=2026-10` | 某月日历 |
| GET | `/client-api/checkin/rank?by=streak` | 签到排行 |
| GET | `/client-api/checkin/logs` | 最近签到明细 |
| POST | `/client-api/checkin/makeup?date=2026-10-10` | 补签（花硬币） |

### 为什么这套设计是安全的

「签到」的判定权**完全在服务端**：

- 服务端知道今天是几号（固定 `Asia/Shanghai`，不跟服务器时区走）；
- 服务端知道这个 uid 今天签没签过、昨天签没签（决定连续天数）；
- 客户端**只是触发**，说什么都不算数。

所以哪怕有人伪造请求、拿真令牌狂打，结果也只是「今天已经签过了」，**一分硬币多发不了**。

幂等的保证是数据库层的：`clientgw.checkin_log` 上 `(uid, date)` **唯一索引**。不是代码里的 `if` —— 并发打进来，只有一个能插进去。

> 这就是你上次担心的「刷硬币」问题里唯一能放心发奖励的那一类（服务端自己记状态）。**不要**把奖励挂到「客户端说完成了」上，那类挡不住。

### 奖励规则

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dailyCoins` | 1 | 每天基础硬币 |
| `streakBonus` | 3/7/14/30 天 | 连续奖励，可加多条。**默认是「里程碑」语义**（刚好连续到第 N 天给一次）；想「每 N 天都给」就给那一行开 `repeat` |
| `makeupCost` | 5 | 补签花多少硬币 |
| `makeupWindow` | 3 | 最多补最近几天；设 0 = 关闭补签 |

连续天数算法：**前一天签过 → 今天 +1；否则从 1 开始**。

> ⚠️ `streakBonus` 的语义要留意：**默认只在「刚好第 N 天」给一次**。
> 比如配了「3 天 +2」，那么连续第 6 天**不会**再给（早期版本会因为 6 是 3 的倍数而重复给，
> 已在测试里钉死）。要周期性奖励就显式开 `repeat`。

---

## 五、对接硬币（⚠️ 装完请确认这一节）

发硬币这件事**必须按你服务器上装的那个硬币插件来调**。你这套装的是 **`coin-33oj`**（33OJ 那套）。它的真实结构（2026-10-11 对着 `open33oj/hydro-plugins` 的 `coin-33oj/index.ts` 源码 + 线上自检**逐项核对过**）：

- **余额**：用户文档上的 `coin_now`（当前）/ `coin_all`（累计获得）
- **流水**：账单集合 —— 名字就叫 **`coin`**（`db.collection('coin')`）
- **账单文档形状**：`{ userId, rootId, amount, text }`，**没有时间字段**（时间藏在 ObjectId 前 8 位里）

> ⚠️⚠️ **踩过的坑（2026-10-11 线上事故）**：这套插件最早的默认值把账单写进了
> `coin.bill` 集合、字段写 `{uid, amount, note}` —— 而站点插件读的是 `coin` 集合、
> 字段是 `{userId, rootId, amount, text}`。两边对不上的后果是：
> **签到发的币在站点流水里完全不出现**（余额却是对的，因为 `coin_now` 两边一致），
> 而且 `coin_all`（累计获得）从来没涨过 —— 站点硬币榜是
> `find({coin_all:{$exists:true}})` 筛出来的，所以这些用户在硬币榜上**是隐形的**。
>
> 现在的做法是**优先直接调用站点插件自己的 `inc()`**（coin-33oj 在 `apply()` 里做了
> `global.Hydro.model.coin = coinModel`），账单 + `coin_now` + `coin_all` 一次到位、
> 集合与字段名都不用猜；拿不到那个模型时才退回自己写库。

### 怎么确认（别猜，猜错不会报错）

**装完先看启动日志**，插件自己会查一遍：

```
[clientgw] 自检：配置正常（user.coin_now = 952，账单 coin 1234 条（字段 _id、userId、rootId、amount、text），发币走 站点 coin 插件）
[clientgw] 发币将直接调用站点硬币插件的 inc()（账单与 coin_all 交给它维护）
```

出问题时是这样：

```
[clientgw] 自检：有 1 处配置要确认
[clientgw] 待确认：账单集合 coin.bill 读不出来（要么名字不对、要么没权限）
[clientgw] 建议把 coinBillCollection 改成 `coin`
```

也可以自己查（数据库名一般是 `hydro`）：

```bash
# 1) 用户文档上到底有没有硬币字段、叫什么
mongosh hydro --eval 'printjson(db.user.findOne({_id: 5}))'

# 2) 看账单集合的真实名字和字段（⭐ 这一步就能定死，别靠猜）
mongosh hydro --eval 'printjson(db.coin.findOne({}))'
```

### 对应的配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `coinUserField` | `coin_now` | 用户文档上记**当前**余额的字段名 |
| `coinAllField` | `coin_all` | 记**累计获得**的字段名（站点硬币榜按它筛人） |
| `coinUserCollection` | `user` | 余额存在哪个集合（一般不用改） |
| `coinBillCollection` | `coin` | 账单集合名 |
| `coinWriteBill` | `true` | 关掉 = 只加余额、不写账单表 |

改完不用重启（Hydro 会热重载设置）。

> ⚠️ 字段名配错是**静默失败**：MongoDB 的 `updateOne` 匹配不到就当没这回事，
> 硬币会**无声无息地消失**。所以自检优先盯的就是字段名 —— 它会从用户文档里
> 把「像硬币的字段」列出来提醒你核对。

> 也可以直接调用 coin-33oj 自己的入口对比一下：`/coin/inc`（管理员加币）、`/coin/bill`（账单）。

---

## 六、和网页上已有的「打卡」是什么关系

你服务器上还装了 **`checkin-33oj`**（网页版打卡 + 每日运势）。

⚠️ **它和这个插件各记各的** —— 网页上打一次卡、客户端签一次到，是两条记录。

两种处理方式，按你的想法选：

- **A. 客户端为主**：以后让学生用客户端签到（有硬币奖励），网页那个打卡就当没有；或者后续把 `checkin-33oj` 的打卡逻辑改成调本插件的 `doCheckin()`，两边合并。
- **B. 桥接**：本插件改成**读 `checkin-33oj` 的记录**来判断今天签没签 —— 需要先看一眼它的表结构，改动不大。

现在代码是 A 的做法（自己记）。要走 B 告诉我一声。

---

## 七、目录结构

```
hydrooj-client-gateway/
├── package.json
├── index.ts              # 插件入口：配置 Schema + 路由注册
├── lib.ts                # 时间（固定时区）/ 令牌 / 配对码 / 限流
├── model.ts              # 数据层：令牌、配对码、签到、发硬币
├── handler/
│   ├── base.ts           # ★ 认证中间件（所有接口的入口）
│   ├── auth.ts           # 登录 / 配对码 / 设备管理
│   ├── checkin.ts        # 签到全套
│   ├── user.ts           # 个人信息 / 统计
│   ├── oj.ts             # 题目 / 提交 / 比赛 / 讨论 / 排行
│   ├── coin.ts           # 硬币余额 / 流水 / 排行 / 发放
│   ├── system.ts         # 连通性 / 能力清单 / 通知
│   └── index.ts          # 汇总导出
├── test/                 # 回归测试（见下）
│   ├── prepare.mjs       #   生成 .build/（复制源码、只改 import 路径）
│   └── test.ts           #   68 个断言，覆盖签到 / 令牌 / 配对码 / 发币
└── README.md
```

完整接口清单见 **[`API.md`](./API.md)**（44 个接口 + 客户端典型调用流程）。

---

## 八、测试（改完代码先跑这个）

**不需要装 Hydro、不需要 MongoDB**。两套测试，一条命令跑完：

```bash
npm test
# 等价于下面两条：
#   node test/prepare.mjs && node --experimental-strip-types test/test.ts
#   node --experimental-strip-types test/load-check.mjs
```

### ① `test.ts` —— 逻辑测试（68 个断言）

用内存假存储跑真实的签到逻辑。覆盖：

- 时间：时区边界（UTC 16:30 算作上海的次日）、跨月、跨闰年；
- 签到：首次 / 幂等 / 连续累加 / 断签重置 / 连签 7 天；
- **并发**：两个请求同时签，只有一个真正生效（幂等的物理保证）；
- 补签：重复补签、补签不给基础奖励；
- 发币：金额对不对、**给不存在的 uid 会不会静默丢币**；
- 令牌：校验 / 过期 / 撤销 / **库里只有哈希没有明文**；
- 配对码：一次性；
- 奖励计算：各种边界（含「连续第 6 天不该拿到连续 3 天的奖励」）；
- **自检诊断**：配置正确时无误报 / 字段配错时能发现并给出建议值。

> ⚠️ 这是**逻辑级**验证：唯一索引冲突是在假存储里模拟的，不是真的 MongoDB。
> 它验的是「代码路径对不对」，MongoDB 本身的行为不用它来验。

### ② `load-check.mjs` —— 真加载 + 真注册

`test.ts` 只跑 `model.ts` / `lib.ts`，**碰不到 `index.ts` 和各 handler** —— 而实际踩的坑恰恰在加载阶段。
这个测试把整个插件在 Node 里**真 import 一遍、真调一次 `apply()`**，然后要求注册出 36 条路由。

**为什么必须有它**：Hydro 的三个加载器（service / model / addon）**共用同一个 `fail` 列表**，
任何一个文件加载失败，整个插件的 `index.ts`（36 条路由）都会被跳过 —— 线上表现是
**所有 `/client-api/*` 全部 404**，而且看着完全不像「插件没装成功」。

它已经抓到两个逻辑测试发现不了的问题（都已修）：

1. **`import { ObjectId } from 'mongodb'`** —— 插件装在 `~/.hydro/addons/` 下时，Node 从那里
   往上找不到 `mongodb` 的 `node_modules`，require 直接抛错 → 整个插件废掉。
   现在改从 `hydrooj` 取（Hydro 把 `ObjectId` / `Schema` 都**再导出**了，
   见 `packages/hydrooj/src/libs.ts`）—— **插件现在只依赖 `hydrooj` 这一个包**。
2. **`import { TokenInfo } from '../model'`** —— `TokenInfo` 是 interface，当值导入在 ESM 下是
   硬错误（`does not provide an export named 'TokenInfo'`）。改成 `import type`。

> ⚠️ **写这个插件的铁律：除了 `hydrooj` 和 Node 内置模块，什么都别 import。**
> 裸包名在插件目录下解析不到，而失败方式极隐蔽 —— 不是报错页，是**整片接口 404**。

**逻辑测试这边抓到并修掉的三个问题**（都在源码注释里标了）：

1. 奖励计算写成 `streak === day || streak % day === 0` —— 连续第 6 天会拿到「连续 3 天」的奖励，
   而且 `streak = 0` 时所有取模都命中，一次算出好几倍。现在拆成显式的「里程碑 / 周期」两种语义。
2. `grantCoin` 没检查 `matchedCount` —— MongoDB 匹配不到用户时不报错，**硬币会静默丢失**
   （硬币字段名配错时就是这个表现）。现在会抛错。
3. `doCheckin` 里判断「前一天」用的是 `yesterday()`（跟真实时钟走），
   传入非当天日期时连续天数会算错。改用 `prevDay(date)`。


---

## 九、版本适配说明

Hydro 各版本有些方法签名不一样，代码里已经做了兜底，但有两处**如果你升级 Hydro 后接口报错**，优先看这里：

1. **提交代码**（`handler/oj.ts` 的 `submitCode()`）—— 依次尝试
   `ProblemModel.submit` / `RecordModel.add` 等几种签名，全失败会返回明确的错误信息（含尝试过哪些）。
2. **密码校验**（`handler/auth.ts` 的 `checkPassword()`）—— 依次尝试 `User.checkPassword()`
   和几个模型静态方法。

其余数据接口（题目/记录/比赛）都做了「模型 API 失败 → 直接读 MongoDB 集合」的回退，
`document`（题目 docType=10、比赛 20、讨论 30/31）、`record`、`domain.user` 这几个集合
是 Hydro 一直在用的，比较稳。
