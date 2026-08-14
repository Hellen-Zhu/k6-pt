# POST /api/v1/trades/trigger-event

- **URL**: <GATEWAY_BASE>/api/v1/trades/trigger-event
- **Method**: POST，JSON body
- **Status**: 200
- **Captured**: 2026-08-12（来源：Chrome DevTools Network 截图 IMG_3963_2 / 3966–3972）

**集合端点**，路径里没有 `{id}`——目标交易由 body 的 `tradeIds` 数组寻址（URL 于 2026-08-11 确认）。

## 请求

payload 已在项目中：`data/trade/event-cases.json`（5 种 event 的模板），信封由 `src/api/trade/trigger-event.js` 的 `buildEventPayload()` 组装：

```
{ eventType, data: [ {key, value, type: Text|Numeric|Date} ], reason, comments: "", tradeIds: [tradeId] }
```

本目录只存 response，不重复存 payload。

## 支持的 event 类型（UI Actions 菜单，IMG_3963_2）

共 9 种。下表标注了 payload / response 的覆盖情况：

| eventType | payload 在项目中 | response 已抓 |
|---|:--:|:--:|
| PortfolioReassignment | ✅ | ✅ |
| PartialTermination | ✅ | ✅ |
| Cancellation | ✅ | ✅ |
| EarlyTermination | ✅ | ✅ |
| NovationRemaining | ✅ | ✅ |
| PartialNovationRemaining | ❌ | ✅ |
| Allocation | ❌ | ✅ |
| StepOutFull | ❌ | ❌ |
| StepOutPartial | ❌ | ❌ |

## 响应信封（与其他接口都不同）

```
{ code, status: "SUCCESS", msg: "", data: { eventType, results: [...], status, totalRequested } }
```

注意 **`data.status` 是批量级别的状态**，和外层信封的 `status` 是两回事：

| `data.status` | 含义 | 出现在 |
|---|---|---|
| `ALL_EXECUTED` | 事件已直接生效 | 除 Cancellation 外的 6 种 |
| `ALL_PENDING_APPROVAL` | 进入 checker 审批 | Cancellation |

`ALL_` 前缀强烈暗示存在部分成功的变体（多 tradeId 请求时）。客户端固定只发 1 个 tradeId，所以目前只见过这两个值——**其他取值未知，尤其是"全部失败"长什么样没有样本**。

## 业务断言（压测判定口径）

`src/api/trade/trigger-event.js`：

| 断言 | 分类 | 不符时的 reason |
|---|---|---|
| `code === 200` | business | `reasonFrom()`（`code-N`） |
| `data.status ∈ {ALL_EXECUTED, ALL_PENDING_APPROVAL}` | business | `bulk-status` |
| `data.eventType` 回显等于请求的 eventType | shape | `shape` |

分类依据：
- **`data.status` 判 business** —— 信封 `code: 200` 只说明请求被解析了，`data.status` 才说明事件真的触发了。取值不对＝事件没执行＝**被 block**，这正是压测要抓的，不是功能验证。
- **`eventType` 回显判 shape** —— 服务端回了别的事件类型说明契约漂移，会让按 eventType 切分的指标失真，属于脚本/契约缺陷（与 update.js 的 `data.id` 回显判 shape 同理）。
- `bulk-status` 用固定 slot：这个枚举的失败取值从没观测到，把原值写进 detail 日志而不进 tag，避免基数失控。

## 三个对压测有实际影响的发现

### 1. 是否进审批，取决于 event 类型

`trigger-event.js` 原注释里"events 是否重新进入 checker 审批 unknown"的问题有答案了：**只有 Cancellation 进审批**（返回 `checkerTaskId`），其余 6 种直接执行完毕。

### 2. TaskId 不在 `msg` 里（已修）

`trigger-event.js` 原本用 `extractTaskId(out.body.msg)`（沿用 create/update 的机制），但这个接口的 `msg` 恒为 `""`，taskId 实际在 **`data.results[].checkerTaskId`**，所以 `out.taskId` 永远是 `null`。

已改成从 `data.results[0].checkerTaskId` 取（只有 Cancellation 会返回，其余为 null），并移除了对 `checker-flow/tasks.js` 的 import——顺带减少了一条跨模块依赖。

### 3. 三种 event 会**生成子交易**

`data.results[].childTradeIds`：

| eventType | 子交易 id 形态 | 本次数量 |
|---|---|---|
| NovationRemaining | `<父id>-NOV-<hex>` | 1 |
| PartialNovationRemaining | `<父id>-PNOV-<hex>` | 1 |
| Allocation | `<父id>-ALLOC-<序号>` | 2 |

压测含义：这些 event 每执行一次就往 trade 表里**增加**记录（Allocation 一次加 2 条）。长时间施压会持续放大数据量，进而影响 `GET /api/v1/trades` 这类全量查询的响应体和耗时——跨轮次对比基线时必须把这个增长算进去。

## 其他观察

UI 列表（IMG_3963_2）里出现了抓包中未见的 trade 状态取值：`DEAD`、`PARV`、`LIVE`，以及 eventStatus `Cancelled`。`DEAD` / `Cancelled` 应该是终态事件（Cancellation / EarlyTermination）的结果，`PARV` 含义待确认。
