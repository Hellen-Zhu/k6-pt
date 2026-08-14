# POST /api/v1/blotter/trades

- **URL**: <GATEWAY_BASE>/api/v1/blotter/trades
- **Method**: POST
- **Status**: 200
- **Captured**: 2026-08-14（来源：Swagger UI 截图 IMG_4003 / IMG_4004）
- **Headers**:
  - `accept: application/json`
  - `Content-Type: application/json`
  - `X-User-Id: maker01@example.com`

## 请求

`payload.json`（IMG_4004 的 Edit Value 全文，完整）。`blotterDetails` 是**数组**——一次请求可携带多个 blotter 定义；每个 blotter：

| 键 | 含义 | 备注 |
|---|---|---|
| `id` / `name` | blotter 标识与显示名 | `BLT-*` / `c-*` 为合成契约标识，保留原值 |
| `columns` | 投影列（`trade.basic.*` 点路径） | 响应实际返回的字段**多于**所请求列（见观察 2） |
| `conditions[]` | 过滤条件 `{id, field, operator, value, logicOperator}` | `value` 支持**服务端 token**：本例 `CURRENT_DATE` |
| `sort` | `{field, direction}` | |

## 响应

`response-200.json`。信封不变（code/status/msg/data），但 **data 按 blotter id 分组**：

```
{ code, status: "SUCCESS", msg: "", data: { "<blotterId>": { data: [ {trade:{id,basic}}, ... ] } } }
```

**截图未拍全**，`__truncated` 标注了缺口：basic 只拍到 `marketers[0].marketerId`；blotter 内 `data` 数组之外是否有分页/计数字段未知——与旧 get-trades 同款疑问，仍待一次完整抓包确认。

## 业务断言（现有实现）

`src/api/trade/query.js`：
- business：`code === 200 && status === 'SUCCESS'`
- shape：请求里的**每一个** blotter id 都必须以 `data[<id>].data` 数组应答
- 全部 blotter 行数合计进 `perf_trades_rows` Trend（场景挂 `avg>0` 防空库；注意默认 blotter 条件为 `dealDate = CURRENT_DATE`，"空库"语义变为"当天无数据"）

## 关键观察

1. **取代 `GET /api/v1/trades`**（2026-08-14）：旧 list 接口退役；旧抓包保留在 `../get-trades/` 作历史证据。
2. **columns 是请求侧投影，但响应字段多于所请求列**：只请求 4 列，响应 basic 却携带 breakClause/ci/cva/fva/hardMargin/marketers 等——投影语义待确认（可能只作用于 UI 网格），断言不依赖它。
3. **`basic.breakClause` 以字符串 `"false"` 返回**——create/update 抓包里同名字段是布尔。类型不一致，任何断言都不要碰这个字段。
4. `CURRENT_DATE` 是**服务端**解析的日期 token，与本仓库 testdata 的客户端 token `{{TODAY}}` 不同源——blotter 行里直接用服务端 token，不要混用。
5. 相比旧 get-trades 的无参全量 GET，blotter 查询天然带条件窗口（默认行=当天）；但混测造出的 trade 全是当天的，**持续轮次内响应仍会增长**，跨轮对比时照旧要计入。
