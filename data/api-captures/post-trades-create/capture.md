# POST /api/v1/trades/create

- **URL**: <GATEWAY_BASE>/api/v1/trades/create
- **Method**: POST，**`multipart/form-data`**（不是 JSON body）
- **Status**: 200
- **Captured**: 2026-08-12（来源：Swagger UI 截图 IMG_3958）
- **Headers**:
  - `accept: application/json`
  - `Content-Type: multipart/form-data`
  - `X-User-ID: maker01@example.com` + `X-User-Id: checker1@example.com` ← 见下方「身份 header」

## 请求（multipart 两个 part）

| part | 类型 | 内容 |
|---|---|---|
| `trade` | 文本（JSON 字符串） | 见 `payload-trade-field.json` |
| `datFile` | 文件 | `0_instrument.dat`（按 productId 同名约定取，见 `pools/trade/create-case-pool.js`） |

本次抓包的 `trade` 字段只带了 5 个 basic 字段（portfolioId / counterpartyFmId / counterpartyName / productId / direction），比脚本 `buildTradePayload()` 发的字段少——服务端会补默认值（响应里 currencyPair、dealDate、premium* 等都是服务端填的）。

## 响应

`response-200.json`。**`data` 结构与 update 不同**，写断言时别混：

| | create | update |
|---|---|---|
| trade 位置 | `data.trade.{id, basic}` | `data.{id, basic}`（无 trade 包装） |
| checkerContext | `data.checkerContext` 有 | 无（TaskId 只在 `msg` 里） |

`__truncated` 标记了缺口：`data.trade.basic` 拍到 `marketers` 就截断了，后续字段（notionalAmount 之后按字母序的部分）缺失。

## 业务断言（现有实现）

`src/api/trade/create.js`：
- business：`code === 200 && status === 'PENDING APPROVAL'`
- shape：`data.trade.id` 匹配 `/^TRD-[A-Za-z0-9]+$/`
- `REJECT_PATTERNS` 有 `dat-missing`（并发上传同一时间戳临时文件互删）

本次抓包与该契约一致。新建 trade 的 `eventStatus` 是 `"New"`（不是 update 的 `"Amended"`）。

## 身份 header（重要）

**以 `X-User-Id` 为准 —— 每个 API 都靠它做权限验证**（系统无 token 认证，见 `src/lib/users.js`）。本次抓包该取 `X-User-Id: checker1@example.com`。

curl 里那个 `X-User-ID: maker01@example.com` 是 Swagger UI 多发的一次（全局参数 + 手填参数各发一次），**复现时删掉**。

需要留意的副作用：HTTP header 名大小写不敏感，所以这两行在协议层是同一个 header 发了两次，服务端收到的是逗号拼接值——`checkerContext.submittedBy` 回显的 `"maker01@example.com, checker1@example.com"` 证实了合并确实发生了。因此**本次抓包无法判断权限校验拿到的是拼接串还是只取了第一个值**；如果要拿这份抓包论证 maker/checker 的权限边界，需要只发一个 header 重抓一次。

k6 侧不受影响：`src/lib/http.js:72` 每次只发一个 `X-User-Id`，取值来自 `pickUser(cfg, role, vu)` 的角色池。
