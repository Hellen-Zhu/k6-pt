# API Captures

从截图 / 抓包记录下来的真实 API 请求，作为编写 k6 场景（`src/api/`）和造数 payload（`data/worker-svc/`）的一手参考。

## 目录约定

每个 API 一个文件夹，命名为 `<method>-<url路径 slug>`，例如 `post-trades-trigger-event/`：

```
data/api-captures/
  post-trades-trigger-event/
    capture.md       # URL、method、headers、状态码、抓取时间、截图来源、备注
    payload.json     # 请求体（裸 JSON，可被 k6 open() 直接加载）
    response.json    # 响应体（裸 JSON）
```

- GET 等无请求体的 API 省略 `payload.json`，query 参数写进 `capture.md`。
- multipart 接口：每个文本 part 存成 `payload-<part名>.json`（如 `payload-trade-field.json`），文件 part 只在 `capture.md` 里记文件名和来源，不拷贝二进制。
- 同一个 API 有多种响应就按状态码分文件：`response-200.json`、`response-409.json`。
- 一个端点带多种业务变体（如 trigger-event 的 9 种 eventType）时，用 `response-200-<变体名>.json` 平铺在同一个目录里，不拆成多个目录。
- payload/response 里的 token、cookie 等敏感字段替换为 `<REDACTED>`。
- 同一个 API 的不同变体（不同参数组合）用后缀区分：`post-trades-query-by-date/`。

### `__truncated` 标记

截图拍不全是常态。**凡是不完整的响应，必须在缺失所在的那一层加 `__truncated` 键说明缺了什么**——双下划线前缀沿用仓库既有的 bookkeeping 约定（如 loader 的 `__row`），不会和服务端字段混淆。宁可标注，也不要留下一个看起来完整的残缺样本。

## capture.md 模板

```markdown
# POST /api/v1/xxx

- **URL**: <WORKER_SVC_BASE>/api/v1/xxx
- **Method**: POST
- **Status**: 200
- **Captured**: 2026-08-12（来源：截图 / Chrome DevTools）
- **Headers**（仅记录非默认的）: Content-Type: application/json

## 备注

（鉴权方式、前置条件、字段含义等）
```

## 红线：真实值不进仓库

**本仓库是 PUBLIC 的。** 抓包记录的是**结构**，不是**数据**——所有真实值一律替换为占位符，真实副本只保存在私有副本中：

| 类别 | 占位符 |
|---|---|
| 主机 / base URL | `<WORKER_SVC_BASE>`（或 `localhost`，同 `config/environments/dev.json`） |
| 用户邮箱 | `maker01@example.com` / `checker1@example.com` |
| portfolio | `PERF-PF-A` |
| counterparty | `10000001` / `PERF CP A` |

trade id / task id（`TRD-…` / `CHK-…`）是 dev 环境生成的合成标识，保留原值——id 格式本身就是要记录的契约。

`scripts/pre-commit-no-secrets.sh` 是配套的 pre-commit 守卫，会拦下含真实值的提交（安装方式见脚本头部）。站点专有的字面量放在未跟踪的 `$(git rev-parse --git-common-dir)/no-secrets.local`，**不要写进脚本**——deny-list 里写出真实主机名等于又发布了一次。

## 身份认证

系统**没有 token 认证**，所有 API 统一通过 **`X-User-Id`** 这一个 header 做权限验证，值是用户邮箱（如 `maker01@example.com` / `checker1@example.com`）。抓包时以它为准。

Swagger UI 会额外发一个 `X-User-ID`（大小写不同但协议层同名，会被合并成逗号拼接值）——那是 UI 的产物，不是接口设计，复现 curl 时删掉。

k6 侧对应实现：`src/lib/users.js` 的 `pickUser(cfg, role, vu)` 按角色池取身份，`src/lib/http.js:72` 注入单个 `X-User-Id`。

## 索引

| API | Method | 说明 |
|---|---|---|
| [get-trades](get-trades/) | GET | trade 列表；返回字段是投影（12 字段），无分页参数 |
| [post-checker-tasks-approve](post-checker-tasks-approve/) | POST | 审批通过；空 body，checker 身份，`data.{id,basic}` |
| [post-checker-tasks-reject](post-checker-tasks-reject/) | POST | 驳回；与 approve 同构，**无需 reason payload** |
| [post-trades-create](post-trades-create/) | POST | 建 trade；**multipart**（trade JSON + datFile），响应 `data.trade.{id,basic}` |
| [post-trades-update](post-trades-update/) | POST | trade amend；提交后进 Pending Approval Live，approve/reject 前再 amend 报 409 |
| [post-trades-trigger-event](post-trades-trigger-event/) | POST | 生命周期事件（9 种）；批量信封 `data.{results,status,totalRequested}`，部分事件生成子交易 |
