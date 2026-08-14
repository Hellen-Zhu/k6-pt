import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/trade/trade-ids-pool.js';
import { getTrade } from '../api/trade/detail.js';

// P0 · trade · read path (single-trade detail)

export const options = buildOptions('trade', 'detail');

export function setup() {
  tradeIdsPreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  getTrade(cfg, pickTradeId(i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
