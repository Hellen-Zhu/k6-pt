# ARCHITECTURE — 框架导读

> 读完这份文档，你应该能回答三个问题：一次测量是怎么跑起来的、数据从哪来到哪去、
> 加一个 API 要动哪几处。行为的权威定义永远是代码；本文只负责给出地图和关键位置。

## 三十秒总览

两条命令，职责互斥（分开的原因写在两个脚本头部：**造数烧共享环境的限流预算，必须是显式决策**）：

```
./prep.sh <scenario|seed-producer> [env] [profile|ITERATIONS=n]   # 只铺数据
./run.sh  <scenario> [env] [profile] [KEY=value ...]              # 只跑测量
```

```
./prep.sh trade-mix-full dev mix                ./run.sh trade-mix-full dev mix RATE=10
  │                                               │
  ├ k6 PLAN=1 干跑（0 请求）                       ├ manifest 快照（环境/profile/commit/UTC 时钟）
  │   └ 场景自报 POOLPLAN <池名> <需求量>           ├ k6 run
  ├ producer_for: 池名 → seed 生产者               │   ├ init   bootstrap 组装 options（profile × SLA 四层阈值）
  ├ k6 seed 轮（create→approve，SEEDID 日志）      │   │        mixed 入口再经 splitByRatio 切成 N 个并行 scenario
  ├ seed-harvest.sh: grep SEEDID → 池文件          │   ├ setup  preflight 数据门（占位符/体积，失败 0 请求中止）
  │   └ 自动激活 + 旧池归档（可回滚）               │   ├ VU     flow → api 契约 → lib/http 出口 → 三分类记账
  └ 体积复核 ≥ planned × 1.2                       │   └ end    handleSummary → summary.txt/json + report.html
                                                  └ 提取 verdict → 退出码
```

## 目录地图

| 目录 | 职责一句话 | 关键文件 |
|---|---|---|
| `src/lib/` | 引擎层：options 组装、HTTP 唯一出口、三分类错误引擎、ratio 切分、报告 | bootstrap.js / http.js / errors.js / mix.js / report.js |
| `src/api/<mod>/` | **契约层**：每 API 一个文件 = 请求构造 + 响应成败判定（注入引擎的回调） | create.js 是最完整的样例 |
| `src/testdata/<mod>/` | 请求形状数据集：行加载/轮转/校验 + dat 预载，与 api client 同名配对 | 见「数据供给分类学」 |
| `src/pools/<mod>/` | id 池（服务端状态引用）：三种取用纪律 + preflight 数据门 | 见「数据供给分类学」 |
| `src/scenarios/` | 单 API 测量入口，每个 ~30 行 | trades-update.js 是池场景样例 |
| `src/mixed/` | 混合形态入口，自包含 flow 表（刻意不共享 flow 模块，见「设计决策志」） | trade-mix-full.js |
| `src/seed/` | 造数生产者（独立 k6 入口，仅 prep.sh 调用） | 2 套流水线 + 2 个别名 |
| `data/<mod>/` | 池文件与 case 文件；仓库里只放**形状**（占位符），真实值只在私有副本 | README.md 有红线纪律 |
| `data/api-captures/` | 抓包存档 = 契约的证据链（每个 client 头部注释都引用它） | |
| `config/environments/` | 环境（单网关端点 + 身份池 + 白名单） | |
| `config/slas/` | 每 API 百分位 SLA（挂在 perf_success_duration 上） | |
| `profiles/` | 负载形状（声明式 JSON，scenario 块就是 k6 executor 原文） | |
| `baselines/` | 晋升的 summary.json；存在即自动出对比段（只标红，不改判定） | |
| `scripts/` | 3 个单一用途工具：收获、抓包解码、pre-commit 防泄密 | |
| `results/` | 每轮产物（gitignore；summary.txt 是判定权威） | |

## 造数（seed）与取数（pools）——最容易混的一对

一句话：**seed 是工厂，`data/` 是仓库，pools 是领料窗口。**

| | `src/pools/`（取数） | `src/seed/`（造数） |
|---|---|---|
| 本质 | 测量场景**内部**的 JS 模块 | **独立的 k6 入口**，prep.sh 单独调一次 k6 |
| 何时运行 | 测量轮的 init / setup / VU 阶段 | 测量**之前**的 seed 轮 |
| 发 HTTP 请求吗 | 一个都不发 | 发（create→approve，带 `runPhase=seed` 标签可切片） |
| 读什么 | `data/trade/*.json` | 造数 case 池（trades-create.json）+ dat |
| 产出什么 | 每次迭代交给场景一个 id / 数据行 | k6.log 里的 `SEEDID <id>` 行 |
| 谁落盘 | 不落盘 | `scripts/seed-harvest.sh` grep SEEDID → 写池文件并激活 |
| 失败形态 | `PREFLIGHT FAILED`，0 请求即中止 | 收获量 < 需求×1.2，prep 报错退出 |

连接两者的唯一媒介是 **`data/trade/` 的池文件**：seed 写（经 harvest），pools 读。
仓库里池文件永远是 `TBC-` 占位符，因为真实 id 是**某个环境的服务端状态**——只有对着那个
环境跑一次 prep 才存在；换环境即作废。

4 个生产者 = 2 套流水线 + 2 个别名：

| 生产者 | 流水线 | SEEDID | 收获目标 |
|---|---|---|---|
| `seed-update-pool` | create→approve | LIVE tradeId | update-ids.json；**副作用**：同批刷新 trade-ids.json（seed-harvest.sh 只认这一个名字） |
| `seed-approve-pool` | create（不 approve） | 待审 CHK taskId | approve-tasks.json |
| `seed-event-pool` | ＝seed-update-pool 别名 | LIVE tradeId | event-ids.json |
| `seed-amend-cycle-pool` | ＝seed-update-pool 别名 | LIVE tradeId | amend-cycle-ids.json |

别名文件只有一行 re-export，但**文件名本身是路由键**（prep.sh 靠 `-f src/seed/<名字>.js`
进入生产者模式；seed-harvest.sh 靠名字选收获目标文件）。删掉别名 = 收获落错文件。

## 数据供给分类学：testdata 与三种 id 池

关键区分：**id 池是服务端状态（要 seed），testdata 是请求形状（手工/抓包维护，与 seed 无关）。**

| 种类 | 模块 | 实例 | 纪律 | 何时重铺 |
|---|---|---|---|---|
| 只读轮转 | trade-ids-pool.js | trade-ids | 循环取用，只读 | id 过期（症状 http-404）时重抓 |
| 一次性游标 | consumable-pool.js | update-ids / approve-tasks / event-ids | `iterationInTest` 全局游标每 id 恰用一次；耗尽**跳过不复用** | **每轮之后**（一轮即脏） |
| 永久循环 | cycle-pool.js | amend-cycle-ids | update→reject 把 id 还原回 LIVE；体积门保证轮转回来前跑完一圈 | 仅中毒后（症状 http-409） |
| testdata | testdata/.../create.js / trigger-event.js / calc-risk.js | trades-create + dat / event-cases / calc-risk-payloads | 模板永久轮转，无服务端状态 | 手工维护（抓包校准） |

各自的正确性条件写在模块头注释里：一次性游标为什么能防 http-400 状态冲突
（consumable-pool.js 头部）、循环池的重访周期公式 `max(50, 峰值速率 × 链路p99和 × 3)`
（cycle-pool.js 头部 + trade-mix-full.js `cycleFloor`）。

**池归属规则**：一个消耗型/循环池只能被**一个** scenario 消费——两个 scenario 共用一个游标
会互相踩（各 mixed 入口头注释均有说明）。

## 一次测量轮的生命周期

```
init    bootstrap.buildOptions[Multi]：读 profile + SLA，叠四层阈值——
          1) 底线 perf_err_script count==0（脚本错误 = 本轮作废）
          2) profile 层（判定线 + 熔断线 abortOnFail）
          3) API 层百分位 SLA（探索型 profile 用 "apiSla": false 豁免，key 存在性仍强制）
          4) 场景附加（如 query 的空库门 perf_trades_rows avg>0）
        mixed 入口再经 lib/mix.js splitByRatio 把一个模板 scenario 切成 N 个并行 scenario
setup   __ENV.PLAN=1 → 只打 POOLPLAN 行即 abort（prep 的探针，0 请求）
        否则跑 preflight：占位符门 + 体积门，失败打 PREFLIGHT FAILED 并中止
VU 阶段 flow 函数 → api 客户端（构造请求 + 注入 {business, shape} 契约）
        → lib/http.js 唯一出口（单网关、X-User-Id 身份、低基数 tags）
        → lib/errors.js 三分类记账（见下节）
end     handleSummary 直接写 summary.txt / summary.json / report.html
        run.sh 提取 summary.json 的 verdict：k6 非零退出码优先，否则 verdict!=PASS → exit 1
```

## 三分类错误模型与判定权威

本系统**业务失败也返回 HTTP 200**（成败在 body 的 code/status 里），所以 http_req_failed
和 dashboard.html 的错误率都不可作判定依据。三类必须分开看：

| 类 | 含义 | 处置 |
|---|---|---|
| technical | 连接失败 / 超时 / 非 200 | **这是性能结论** |
| business | HTTP 200 但业务拒绝 | 通常是数据问题（池过期、占位符），不是性能问题 |
| script | 响应非 JSON / shape 不符 | 脚本缺陷，**本轮作废** |

SLA 百分位只看 `perf_success_duration`（业务成功请求的耗时）——快速失败的请求不许拉低分位数。
判定权威链：summary.txt/json（三分类 + 阈值 + 零请求防假绿）→ run.sh 退出码。

## 按名字接线的 6 个约定点

框架的模块间耦合不靠 import，靠**字符串一致**。改名/加池时，以下 6 处必须同步：

| # | 位置 | 约定 |
|---|---|---|
| 1 | `prep.sh` `producer_for()` | 池名 → 生产者名 |
| 2 | `prep.sh` 场景白名单 case | 哪些场景吃池（新池场景要加名字） |
| 3 | `scripts/seed-harvest.sh` case 表 | 生产者名 → 收获目标文件 |
| 4 | `scripts/seed-harvest.sh` 魔法串 `"seed-update-pool"` | 只有它顺手刷新 trade-ids |
| 5 | 各场景 setup 的 `POOLPLAN <池名>` 输出 | 池名必须与 #1 的 key 一致 |
| 6 | `data/trade/<池名>.json` | 文件名必须与池名一致 |

> ⚠ **已知陷阱**（2026-08-13 实测确认，暂未修）：`./prep.sh` 收到拼错的生产者/场景名会落进
> 白名单兜底分支，打印 "consumes no seeded pools — nothing to do" 并 **exit 0**——看起来成功，
> 实际什么都没铺。铺完池请核对输出里有 "ok: <池名> holds N ids" 行。

## Checklist：加一个 API / 加一个 mixed 形态

**只读 API**（无 bash 改动）：
1. `src/api/<mod>/<api>.js` —— 契约（照抄 detail.js 或 query.js 的形状）
2. `config/slas/<mod>.json` 加一个 key
3. `src/scenarios/<场景名>.js` —— 照抄 trades-query.js（~20 行）

**带消耗池的写路径 API**（会碰到全部 6 个约定点）：
1. api 契约 + `data/` payload 文件（如需要）
2. SLA key
3. `data/trade/<池名>.json` 占位文件
4. `src/seed/seed-<池名>.js` —— 若 create→approve 流水线适用，1 行 re-export 即可
5. 场景文件：POOLPLAN 上报 + consumablePreflight + takeUnique 耗尽跳过（照抄 trades-update.js）
6. **bash 三处**：约定点 #1、#2、#3 各加一行

**mixed 形态**：
1. 复制最近的姐妹入口（book/amend/full），改头注释、MIX 表、flow 函数
2. 确认池归属：新入口消费的每个消耗/循环池不得与其他入口共用
3. setup 里为每个池打 `POOLPLAN`；`prep.sh` 白名单（约定点 #2）加名字
4. 改任何共享 flow 逻辑时，检查姐妹入口是否要同步（自包含的代价，头注释有提醒）

## 设计决策志

| 日期 | 决定 | 依据/位置 |
|---|---|---|
| 2026-08-07 | 混合方法论：真实 API 比例、无排序、业务倍数缩放；每 API 挂名判 SLA | 各 mixed 头注释 |
| 2026-08-11 | mixed 入口**自包含**，退役共享 `_trade-flows` 模块（读一个文件看懂全场景） | git 3a23949 |
| 2026-08-11 | 全家跑 fresh trades，退役 blended approve 池（keep it simple） | git a2129ae |
| 2026-08-12 | 单网关端点（2026-08-14 收尾：service 维度连同目录/标签/签名全部退役，module 为唯一归因层） | lib/config.js `baseUrl` |
| 2026-08-12 | chain 表的 RATE 语义 = **HTTP 请求数份额**（RATE=10 即网关 10 req/s） | lib/mix.js 头注释 |
| 2026-08-12 | 抓包红线：仓库只放形状，真实值只在私有副本；pre-commit 守卫 | data/api-captures/README.md |
| 2026-08-12 | run/prep 分家：跑与铺各一条命令 | git 0487140 |
| — | 除 k6 外零依赖（负载机上没有 jq/node/python，bash 侧只做行级 sed） | run.sh `cfg_get` 注释 |
| — | UTC 全链（runId/结果目录/manifest/k6.log 与服务端日志直接对账） | run.sh 头部 |
