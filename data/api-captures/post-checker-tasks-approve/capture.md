# POST /api/v1/checker/tasks/{taskId}/approve

- **URL**: <GATEWAY_BASE>/api/v1/checker/tasks/CHK-17865078801556298D6B6/approve
- **Method**: POST，**空 body**（`-d ''`，但仍带 `Content-Type: application/json`）
- **Status**: 200
- **Captured**: 2026-08-12（来源：Swagger UI 截图 IMG_3961 + IMG_3965，两张衔接成完整的 `basic`）
- **Headers**:
  - `accept: */*` ← 注意与 trades 各接口的 `application/json` 不同
  - `Content-Type: application/json`
  - `X-User-Id: checker1@example.com`（必须是 checker 身份，见 README「身份认证」）

审批动作全部由 URL 路径里的 taskId 表达，没有请求体，所以本目录无 payload 文件。

## 与 create 的链路对应（同一笔交易）

本次抓包的 taskId `CHK-17865078801556298D6B6` 就是 `../post-trades-create/` 那次 create 返回的 taskId，响应里的 `data.id` = `TRD-1786507880144423CE167` 也与 create 返回的 trade id 一致。两份抓包串起来是一条完整的 **create → approve** 链，可作为 seed 流水线（create → approve → LIVE 池）的实证。

## 响应

`response-200.json`：

```
{ code: 200, status: "SUCCESS", msg: "", data: { id, basic } }
```

`data` 是 `{id, basic}` 平铺，**与 update 一致，与 create 不同**（create 是 `data.trade.{id,basic}`）。

`__truncated`：`basic` 拍到 `notionalCurrency` 截断。

## 业务断言（现有实现）

`src/api/checker-flow/tasks.js`：
- business：`code === 200 && status === 'SUCCESS'`
- shape：`data.id` 匹配 `/^TRD-[A-Za-z0-9]+$/`

本次抓包与该契约一致。

## 审批后的 trade 状态（四种转移全部确认，2026-08-12）

| 任务来源 | 动作 | `basic.status` | `basic.eventStatus` |
|---|---|---|---|
| create（SUBMIT） | approve | **`Live`** | `New` |
| create（SUBMIT） | reject | **`Draft`** | `New` |
| update（AMEND） | approve | **`Live`** | `Amended` |
| update（AMEND） | reject | **`Live`** | `Amended` |

读法：
- **`eventStatus` 由任务来源决定，不由审批结果决定**——它记录"这笔 trade 经历了什么事件"（New / Amended），审批动作不改它。
- **`status` 只有一个例外是 `Draft`**：驳回一笔从未上线的新单。其余三种都落在 `Live`。
- 因此 **amend 任务的 approve 和 reject 响应完全无法区分**（信封、`status`、`eventStatus` 全同），靠响应无法证明驳回生效，只能回查 trade。
- 本次 approve 后 `version: 2`。

## 断言口径：上面这张表**不进断言**

这是压测不是功能测试，断言只需要回答"请求有没有被服务端挡住"，信封（`code === 200 && status === 'SUCCESS'`）就够了。状态机落到哪一格属于功能覆盖，不在这里做。

`src/api/checker-flow/tasks.js` 的断言保持原样：
- business：`code === 200 && status === 'SUCCESS'`
- shape：`data.id` 匹配 `/^TRD-[A-Za-z0-9]+$/`

状态表留档的价值在于**解释什么会让压测卡住**：approve 一个已审批的任务会返回 http-400（`Task ... is not PENDING`），这才是会中断持续施压的东西，池子的 exactly-once 游标就是为了防它。

## 错误语义（源码既有记录，2026-08-06 实测，本次未复现）

两者的 body 都是 `error/message/timestamp`，**不是标准信封**，所以按 technical 分类：
- `http-403` — 权限不足（`does not have CHECKER permission for product=... event=...`）。权限是**按 productId 划分**的，checker 账号必须覆盖 case pool 里的每个 productId。这是身份池配置问题，不是性能信号。
- `http-400` — 状态冲突（`Task ... is not PENDING (current: APPROVED)`），即池子被消费过/过期，需要重新 seed。
