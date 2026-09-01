/*
 * READ-ONLY collector for the trade-ids read pool (detail + risk-metrics scenarios): one
 * blotter query over OUR standing trades, harvest their ids. This is the "GET-based
 * collector over real standing trades" the harvest hook anticipated (seed-harvest.sh,
 * 2026-08-10 note) — it replaces both the manual capture procedure in data/trade/README.md
 * and the write-seed read-pool refresh in prep.sh (create×50 + approve×50 just to obtain
 * ids: burned maker AND checker rate-limit budget, and inherited the create pipeline's
 * survival-rate problems; a harvest is one request and zero writes).
 *
 * Ownership scoping: one blotter definition per distinct portfolioId taken from the create
 * case rows (data/trade/trades-create.json) — the same-source discipline, no second place
 * to maintain portfolio ids, and the harvest can only ever return trades our identities
 * are entitled to read. Raw open() on purpose: importing src/testdata/trade/create.js
 * would drag the dat preload into a read-only collector (init-graph isolation, see the
 * query client header).
 *
 * Run:  ./prep.sh harvest-trade-ids <env> ITERATIONS=1
 *   ITERATIONS=1 is the norm — the single request carries every portfolio blotter and the
 *   response returns all matching rows. Dedupe + freshest-first cap happen here;
 *   scripts/seed-harvest.sh extracts the SEEDID lines and activates the pool.
 *   HARVEST_MAX=<n> caps the harvest (default 500; sort is dealDate desc, so the cap
 *   keeps the freshest ids — stale ids are the read pool's 404 failure mode).
 *
 * Contract note: the portfolio condition is hand-assembled from the blotter vocabulary
 * observed in data/api-captures/post-blotter-trades/ (field names from captured columns,
 * operator '=' from the captured dealDate condition). If the server rejects it, the round
 * harvests 0, prep.sh falls back to the write-seed refresh, and k6.log carries the
 * business/shape detail — align field/operator with a UI capture (DevTools → Copy as
 * cURL on the blotter's portfolio filter) before retrying.
 */
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { queryTrades } from '../api/trade/query.js';
import { ERR } from '../lib/errors.js';

const MAX = Number(__ENV.HARVEST_MAX || 500);

const PORTFOLIOS = (() => {
  const doc = JSON.parse(open(import.meta.resolve('../../data/trade/trades-create.json')));
  const ids = [...new Set((doc.rows || []).map((r) => String(r.portfolioId || '')).filter(Boolean))];
  if (ids.length === 0) throw new Error('trades-create.json yields no portfolioId — nothing to scope the harvest to');
  return ids;
})();

export const options = buildOptions('trade', 'query');

const seen = new Set(); // per-VU dedupe; ITERATIONS=1 (single VU) is the documented norm

export default function () {
  const blotterRow = {
    __row: 0,
    blotterDetails: PORTFOLIOS.map((pf, n) => ({
      id: `BLT-HARVEST-${n + 1}`,
      name: `Harvest ${pf}`,
      columns: ['id'],
      conditions: [{
        id: `c-harvest-${n + 1}`,
        field: 'trade.basic.portfolioId',
        operator: '=',
        value: pf,
        logicOperator: 'AND',
      }],
      sort: { field: 'trade.basic.dealDate', direction: 'desc' },
    })),
  };
  const out = queryTrades(cfg, blotterRow, pickUser(cfg, 'maker', __VU), 'seed');
  if (out.errClass !== ERR.OK) return;
  for (const bl of blotterRow.blotterDetails) {
    for (const row of out.body.data[bl.id].data) {
      const id = (row && row.trade && row.trade.id) || (row && row.id) || '';
      if (!id || seen.has(id) || seen.size >= MAX) continue;
      seen.add(id);
      console.log(`SEEDID ${id}`);
    }
  }
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
