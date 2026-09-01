/*
 * READ-ONLY collector for the trade-ids read pool (detail + risk-metrics scenarios): one
 * GET /api/v1/trades list read, harvest the ids. This is the "GET-based collector over
 * real standing trades" the harvest hook anticipated (seed-harvest.sh, 2026-08-10 note) —
 * it replaces both the manual capture procedure in data/trade/README.md and the
 * write-seed read-pool refresh in prep.sh (create×50 + approve×50 just to obtain ids:
 * burned maker AND checker rate-limit budget, and inherited the create pipeline's
 * survival-rate problems; a harvest is one request and zero writes).
 *
 * Source decision (2026-09-01, replacing the first blotter-based cut): the plain list
 * endpoint over hand-assembled blotter conditions — no invented condition vocabulary to
 * be rejected. Scoping shifts accordingly, because the list projection has NO portfolioId
 * (see the client header):
 *  - identity visibility — the harvest runs as a maker, the same identity class the
 *    detail/risk-metrics scenarios read with, so every harvested id is readable by them;
 *  - same-source productId filter — only products our create rows actually trade, which
 *    keeps the pool's cost profile comparable to the write-seeded pools it replaces.
 * Rows are NOT status-filtered (detail reads any visible trade); if risk-metrics turns
 * out to choke on non-Live standing trades, add a basic.status === 'Live' filter here.
 *
 * Run:  ./prep.sh harvest-trade-ids <env> ITERATIONS=1
 *   ITERATIONS=1 is the norm — one request returns the full list. Dedupe + freshest-first
 *   (dealDate desc, client-side) cap happen here; scripts/seed-harvest.sh extracts the
 *   SEEDID lines and activates data/trade/trade-ids.json.
 *   HARVEST_MAX=<n> caps the harvest (default 500; the cap keeps the freshest ids —
 *   stale ids are the read pool's 404 failure mode).
 *
 * Failure mode is safe by construction: contract drift or an empty environment harvests
 * 0, prep.sh falls back to the write-seed refresh, and k6.log carries the business/shape
 * detail.
 */
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { listTrades } from '../api/trade/list.js';
import { ERR } from '../lib/errors.js';

const MAX = Number(__ENV.HARVEST_MAX || 500);

const PRODUCTS = (() => {
  // Raw open() on purpose — importing src/testdata/trade/create.js would drag the dat
  // preload into a read-only collector (init-graph isolation, see the query client header).
  const doc = JSON.parse(open(import.meta.resolve('../../data/trade/trades-create.json')));
  const ids = [...new Set((doc.rows || []).map((r) => String(r.productId || '')).filter(Boolean))];
  if (ids.length === 0) throw new Error('trades-create.json yields no productId — nothing to scope the harvest to');
  return new Set(ids);
})();

export const options = buildOptions('trade', 'query');

const seen = new Set(); // per-VU dedupe; ITERATIONS=1 (single VU) is the documented norm

export default function () {
  const out = listTrades(cfg, pickUser(cfg, 'maker', __VU), 'seed');
  if (out.errClass !== ERR.OK) return;
  const rows = out.body.data.data
    // trade presence is guarded per the capture note (heterogeneous rows, unconfirmed)
    .filter((r) => r && r.trade && r.trade.id && r.trade.basic
      && PRODUCTS.has(String(r.trade.basic.productId)))
    .sort((a, b) => String(b.trade.basic.dealDate).localeCompare(String(a.trade.basic.dealDate)));
  for (const r of rows) {
    const id = String(r.trade.id);
    if (seen.has(id) || seen.size >= MAX) continue;
    seen.add(id);
    console.log(`SEEDID ${id}`);
  }
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
