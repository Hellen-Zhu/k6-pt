import exec from 'k6/execution';
import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/trade/query.js';

// P0 · trade · read path

const DATA = loadData('trade/trades-query');
const ROWS = DATA.rows.map((r, n) => Object.assign({ __row: n + 1 }, r));

// perf_trades_rows avg>0: empty-DB guard. The default blotter row filters dealDate =
// CURRENT_DATE, so "empty" means "no same-day trades" — book some (seed or UI) before a
// standalone round, or the guard trips by design.
export const options = buildOptions('trade', 'query', {
  perf_trades_rows: ['avg>0'],
});

export default function () {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(ROWS, i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
