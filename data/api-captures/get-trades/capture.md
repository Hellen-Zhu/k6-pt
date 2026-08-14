# GET /api/v1/trades

> ⚠ **已退役（2026-08-14）**：本接口由 `POST /api/v1/blotter/trades` 取代（见 [../post-blotter-trades/](../post-blotter-trades/)）。本记录保留作历史证据。

- **URL**: <GATEWAY_BASE>/api/v1/trades
- **Method**: GET（本次抓包无 query 参数，全量列表）
- **Status**: 200
- **Captured**: 2026-08-12（来源：Swagger UI 截图 IMG_3957，server date: Wed,12 Aug 2026 04:06:01 GMT）
- **Headers**:
  - `accept: application/json`
  - `X-User-Id: checker1@example.com`

## 响应

`response-200.json`。信封 + 嵌套行数组：

```
{ code, status: "SUCCESS", msg: "", data: { data: [ {trade|checkerContext}, ... ] } }
```

**截图未拍全**，`__truncated` 标记了缺口：
- 第 2 个元素只看到 `checkerContext.taskId`，其余字段被截断；
- `data` 下 `data` 数组之外是否还有分页字段（total / page / pageSize）**未知**——列表接口的分页行为需要另抓一次确认，这直接影响压测时单次响应的体积。

## 业务断言（现有实现）

`src/api/trade/query.js`：
- business：`code === 200 && status === 'SUCCESS'`
- shape：`Array.isArray(data.data)`
- 行数进 `perf_trades_rows` Trend，场景挂 `avg>0` 阈值防空库

本次抓包与该契约一致。

## 关键观察

1. **列表返回的是投影，不是完整 trade。** 本响应 `basic` 只有 12 个字段（currencyPair, dealDate, eventStatus, notionalAmount, notionalCurrency, productId, rate, source, status, tradeType, valueDate, version），而 create/update 的 `basic` 有 28 个（多出 ci、counterpartyFmId、cva、direction、marketers、portfolioId、premium*、bookingEntity、trader、vmc 等）。字段按字母序排列，可确认是服务端裁剪而非截图漏拍。
2. **数组元素结构不统一。** 元素 1 只有 `trade`；元素 2 以 `checkerContext` 开头（字母序 checkerContext < trade，所以元素 1 是真的没有 checkerContext）。推测：`checkerContext` 只在该 trade 有待审批任务时出现，`trade` 恒在——**此推测未经确认**，遍历时若要取 `row.trade.id` 建议加守卫。
3. 无分页参数的全量 GET，随着造数增长响应体会持续膨胀，压测时要么固定数据量基线，要么补 query 参数限制返回集。
