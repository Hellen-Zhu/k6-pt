# k6-pt Console — 设计与实施计划

> 定位一句话:**git 化压测框架的遥控器**——触发、观测、归档索引;不是脚本管理平台。
> 事实来源永远是仓库(脚本/流表)与 profile(形状);portal 负责让"发起一轮正确参数的
> 测试、读懂历史轮次的判定"不需要 SSH。
> UI 原型:`portal/index.html`(mock 数据内联,零依赖,即未来前端骨架)。

## 0. 服务形态

- 单机、无状态:与框架同机同用户,systemd user service(或 nohup)拉起,绑私有网段地址;
- 所有状态在文件系统:`results/` 就是数据库,外加一个 `runs.jsonl` 审计流水;
- 触发的轮次以 `setsid` 脱离 portal 进程树——portal 重启不影响在跑的 soak,
  状态从文件系统恢复;
- 非目标:HA、外部数据库、用户体系(v1 = 共享 token + 每次触发一条审计行)。

## 1. 三条接口契约(宪法,违反即架构腐化)

portal 只允许通过以下三种方式接触框架:

1. **调用** `./run.sh` / `./prep.sh`(子进程,argv 数组,绝不拼 shell 字符串);
2. **读取** `results/` 下的文件(summary.json / report.html / manifest / k6.log);
3. **列举** `src/`、`profiles/`、`config/environments/` 目录(生成下拉目录)。

永不 import 框架内部代码。`PERF_HOME` = portal 所在目录的上一级(同 repo 部署天然成立);
将来若拆分仓库,补一行 `PERF_HOME` 配置即完成迁移——repo 边界跟随接口边界。

## 2. 语言与运行时

- **Node 22 纯标准库**:单文件 `server.js`(node:http / node:fs / node:child_process)
  + 静态 `index.html`,**零 npm 依赖**;
- 选型理由:团队唯一日常语言是 JS(k6 脚本),仓库语言数不增加;stdlib 足够 P0+P1;
- 两个清醒认识:① k6 的 JS ≠ Node 的 JS,零代码复用,文件头注明 runtime;
  ② 发压机上现有的 Node/Python 都借自宿主应用目录——portal 上线前须申请归属明确的
  自有 Node 安装,不站在别人的地基上。

## 3. 负载形状治理(核心决策;2026-08-19 二次修订:"三道护栏换开放")

原则从"按轮次类型锁与不锁"修订为:**修改不被禁止,但每次修改必须同时通过三道护栏**
——可信度靠机制,不靠纪律。

### 3.1 三道护栏

1. **改动前 — 结构化参数 + 校验**:只暴露有类型与边界的参数(标量白名单
   `RATE / DURATION / VUS / MAX_VUS`;测量 profile 另有 `LADDER / RAMP / PLATEAU`),
   逐项正则校验,开跑前拦住手滑——这是自由 JSON 给不了的;
2. **改动后 — 快照 + 展示**:生效配置快照(§3.3)落盘,portal 在每轮结果页直接
   展示生效参数及"与 git 版 profile 的差异";
3. **身份标记 — VARIANT**:任何偏离 git 版 profile 的轮次,summary 与结果列表自动
   携带 `VARIANT` 徽章,**基线对比自动跳过**——改过的轮次不能冒充标准轮,
   可比性由机制而非自觉保证。

### 3.2 参数化范围与锁定清单

**仅两类 profile 保持文件字面量、portal 只读**:基线参考轮(mix-ref)与容量计划的
1x/2x 达标 profile——它们的参数本身就是结论的一部分("在 1x 速率下 PASS",速率改了
PASS 即失义),改它们 = 改度量衡,走 PR。**其余 profile 全部开放结构化参数**。

测量 profile(mix-ladder / stress / spike)的形状参数:

```
LADDER=10,50,100,200    RAMP=1m    PLATEAU=5m
```

- bootstrap 在 init 期由参数展开 stages(profile 文件存默认值与生成规则);
- `plannedIterations` 对展开后的 stages 积分 → **prep 池需求演算自动跟随阶梯,零改动**;
- `preAllocatedVUs / maxVUs` 声明为 `"auto"`,按顶档速率以 0.84R / 2.2R 系数现场推导
  (系数绑定当前 MIX+SLA,推导法见 CAPACITY-TEST-PLAN.md 附录 B)——
  "阶梯扩了、池子忘扩"类事故从机制上灭绝。

### 3.3 所有轮次 —— 生效配置快照(独立于上两层,无条件做)

展开后的最终 scenario 配置(生成的 stages、实际池值、全部覆盖项)写入
`results/<runId>/`(或直接嵌入 summary.json)。回答"这轮到底跑了什么形状"不再依赖
记忆——这同时修复现状:服务器上手改的 untracked profile 副本目前没有任何运行记录。

### 3.4 明确拒绝的反模式

- 浏览器内编辑/上传脚本(git 是唯一来源;文本框编辑 = 无版本无评审的生产脚本漂移);
- STAGES 自由 JSON 输入。参数化 vs 自由 JSON 的差别不是灵活度:
  **可校验**(参数有类型边界,JSON 手滑单位错要跑完才知道)、
  **可命名**("ladder 10-200×4" 能进报告,一坨 JSON 不能)、
  **可继承**(参数只改动那一两个,文本框每次从零粘贴、漂移无声)。

## 4. UI 设计要点(以 portal/index.html 原型为准)

- 图纸遥测风:chart-paper 底、全数据等宽字体、UTC 实时钟;信号紫仅用于载荷曲线与发射钮;
  语义色独立(PASS 绿 / FAIL 红 / MEAS 琥珀);亮暗双主题;
- **签名元素 = 载荷形状图**:判定 profile 只读 + 锁标("shape versioned in git");
  测量 profile 由 LADDER/RAMP/PLATEAU 输入实时重画,auto 池值标注在图上——
  发射前看见并确认你将释放的负载;
- 纪律做进交互:env 互斥锁物理禁用发射钮;MEAS 徽章表达"测量轮无判定";
  **VARIANT 徽章标记偏离 git 版 profile 的轮次**(结果页展示生效参数与差异);
  三分类错误 `T · B · S` 三元组进列表,technical 非零标红;
  prep 是独立虚线按钮,点击要求显式确认(烧共享环境限流预算)。

## 5. API 草案

```
GET  /api/catalog                      场景/环境/profile(含 shape 参数与默认值、判定/测量类型)
GET  /api/rounds?env=                  results/ 索引:verdict、三分类、时间、runId
GET  /api/rounds/{id}/summary|report|manifest|log
GET  /api/health                       垫片可用、K6_IMAGE、podman、磁盘、UTC
POST /api/rounds                       {scenario, env, profile, overrides{}, shape{}}
                                       → 白名单校验 → env 锁 → setsid spawn run.sh → runId
POST /api/prep                         同上,要求 confirm:true(P2)
```

锁:每 env 一个 flock 文件;审计:`runs.jsonl` 追加 `{who, when, args, runId}`。

## 6. 安全

- 绑私有网段地址;`X-Auth-Token` 共享令牌,值只存在于服务器(systemd EnvironmentFile);
- 参数全白名单:scenario/env/profile 必须存在于对应目录;覆盖键限定四个;
  shape 参数逐个正则校验(速率=正整数列表、时长=duration 格式);
- 子进程一律 argv 数组,用户输入永不进 shell 字符串;
- portal 与框架同用户运行,不需要也不获取任何额外权限。

## 7. 分期

| 期 | 内容 | 量级 |
|---|---|---|
| **P0** | 结果浏览器(rounds 索引 + 文件服务)+ /health;前端接真 API | 0.5~1 天 |
| **P1** | 触发器:POST /rounds、env 锁、审计、运行中状态;**框架侧 shape 展开器 + auto 池 + 快照**(§3.2/3.3) | 1~2 天 |
| **P2** | prep 触发(显式确认)、基线晋升按钮(3 稳定 PASS 后 cp 到 baselines/)、soak 排程 | 按需 |

§3 的框架侧改动(展开器 ~40 行 + 三个测量 profile 参数化 + 快照)独立于 portal 存在
价值——没有 portal,命令行 `LADDER=… ./run.sh` 同样受益。

## 8. 决策记录

- 同 repo `portal/` 子目录,不拆仓库(2026-08-19,理由见 §1 末行);
- Node stdlib 而非 Python/FastAPI(2026-08-19,推翻此前默认,理由见 §2);
- 形状治理三层分治(2026-08-19,判定锁死/测量参数化/全量快照);
- **二次修订为"三道护栏换开放"**(2026-08-19,起因:用户提议在结果中展示 manifest
  ——快照展示解决追溯,但不解决可比与事前校验;补上 VARIANT 身份标记后,锁定清单
  缩小到 mix-ref 与 1x/2x 达标 profile,其余全部开放结构化参数)。
