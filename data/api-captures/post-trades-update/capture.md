# POST /api/v1/trades/{tradeId}/update

- **URL**: <GATEWAY_BASE>/api/v1/trades/TRD-178645853025698777B95/update
- **Method**: POST
- **Status**: 200（amend 成功，进入审批）/ 409（状态不允许 amend）
- **Captured**: 2026-08-12（来源：Swagger UI 截图 IMG_3954~3956，server date: Wed,12 Aug 2026 03:58:15 GMT）
- **Headers**:
  - `Content-Type: application/json`
  - `accept: application/json`
  - `X-User-ID: anonymous`
  - `X-User-Id: maker01@example.com`

## 状态机规则（重要）

- amend 提交成功后 trade 进入 `Pending Approval Live`（basic.status），`eventStatus: Amended`，等待 checker 审批（响应 msg 里带 `TaskId: CHK-...`）。
- **在 approve/reject 之前再次 amend 会报 409**：`Action 'AMEND' is not permitted when trade status is 'Pending Approval Live'`。
- approve 或 reject 之后可以继续 amend。
- 对压测的含义：同一个 trade id 不能连续 update，脚本里每次 amend 后必须先走 checker approve/reject（见 `src/api/checker-flow/tasks.js`），或者每个 VU 用独立的 trade id 池避免撞 409。

## 请求

见 `payload.json`。最小 amend payload 只需 `id` + 要改的字段（这里只改了 `basic.portfolioId`）。

## 响应

- `response-200.json` — 成功：`status: "PENDING APPROVAL"`，data 里返回整个 trade 快照（version 递增到 3）。**注意：截图未拍全，`data.instrument.TRF` 只有 delivery 部分可见，后续字段（notionals 等）缺失；`data.basic` 是完整的（字段按字母序，两张截图正好衔接）。**
- `response-409.json` — 冲突：body 只有 code/status/msg 三个字段。

## 业务断言（压测判定口径）

成功只需同时满足两条：

| 字段 | 期望值 |
|---|---|
| `status` | `"PENDING APPROVAL"` |
| `data.basic.eventStatus` | `"Amended"` |

其余字段（`code`、`msg` 里的 TaskId、`data.basic.version` 递增、`data.basic.status`）只作排查线索，不参与判定。

实现在 `src/api/trade/update.js` 的 `business` 钩子；两条断言各自有独立的 reason tag：
- `status` 不符 → 走 `reasonFrom()`（模式表 / `code-N`）
- `eventStatus` 不符 → 固定 `event-status`

## 其他观察

- 请求同时带了 `X-User-ID: anonymous` 和 `X-User-Id: maker01@example.com`。**以 `X-User-Id: maker01@example.com` 为准**——权限验证走这个 header（见 README「身份认证」）；`X-User-ID: anonymous` 是 Swagger UI 多发的，复现时删掉。
- 409 响应头暴露了限流配置：`x-ratelimit-burst-capacity: 40`、`x-ratelimit-replenish-rate: 20`（每秒补充 20 个 token）——压测超过 ~20 rps 时会先撞网关限流而不是业务瓶颈。
