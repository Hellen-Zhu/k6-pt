# POST /api/v1/checker/tasks/{taskId}/reject

- **URL**: <GATEWAY_BASE>/api/v1/checker/tasks/CHK-1786510336288FF779744/reject
- **Method**: POST，**空 body**（`-d ''`，带 `Content-Type: application/json`）
- **Status**: 200
- **Captured**: 2026-08-12（来源：Swagger UI 截图 IMG_3962）
- **Headers**: 与 approve 完全相同（`accept: */*`、`Content-Type: application/json`、`X-User-Id: checker1@example.com`）

与 approve 是对称的一对，共用契约细节见 `../post-checker-tasks-approve/capture.md`（含错误语义 403/400）。本次抓的是另一笔交易（task/trade id 都与 approve 那次不同）。

## 本次抓包解决的问题：reject 不需要 reason payload

`src/api/checker-flow/tasks.js` 原注释写着 reject "尚未校准，可能需要 reason payload"。本次抓包证实**不需要**：

- 请求体同样是空的 `-d ''`，与 approve 完全一致；
- 响应是同一个标准信封 `{ code: 200, status: "SUCCESS", msg: "", data: { id, basic } }`。

源码注释已同步更新。

## 响应

`response-200.json`。`__truncated`：`basic` 拍到 `premiumAmount` 截断。

## 驳回后的 trade 状态（已确认）

**取决于驳回的是什么任务：**

| 任务来源 | `basic.status` | `basic.eventStatus` |
|---|---|---|
| create（SUBMIT）——新单 | **`Draft`** | `New` |
| update（AMEND）——改单 | **`Live`** | `Amended` |

驳回新单 → `Draft`（这单从未上线）；驳回改单 → 交易保持 `Live`，改动被丢弃。四种转移的完整对照表见 `../post-checker-tasks-approve/capture.md`。

`response-200.json` 里的 `status: "Draft"` 是 QA 确认后补入的，不是 IMG_3962 拍到的（那张在 `premiumAmount` 就截断了），本目录抓的是**新单**驳回。

### 对 reject 断言的影响：无

上表**不进断言**——压测只判"请求有没有被挡住"，信封就够了，理由见 `../post-checker-tasks-approve/capture.md`。`rejectTask()` 维持 `code === 200 && status === 'SUCCESS'` + `data.id` 格式校验（目前尚无调用方）。

顺带一提，即便想断言也断言不了：**驳回改单时，响应与批准改单完全同构**（`SUCCESS` + `Live` + `Amended`，一字不差），没有任何响应字段能区分两者。

## 与 update 的 409 规则对上了

`../post-trades-update/capture.md` 记录的 409 守卫是 `Action 'AMEND' is not permitted when trade status is 'Pending Approval Live'`——它拦的是 **`Pending Approval Live`** 这一个状态。现在两个终态都清楚了：approve → `Live`、reject → `Draft`，都不是 `Pending Approval Live`，所以"approve/reject 之后可以继续 amend"这条行为观察，与 409 的报错文本是自洽的。
