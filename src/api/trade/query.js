/*
 * Trade blotter-query client — POST /api/v1/blotter/trades (maker identity, JSON body).
 * Replaces the retired GET /api/v1/trades list (contract recalibrated 2026-08-14, captured in
 * data/api-captures/post-blotter-trades/; the old capture stays in ../get-trades/ as history).
 * Kept independent of the create data graph (the row loading + dat preloading in src/testdata) —
 * same init-graph isolation rationale as before: a broken create dataset must not drag down the
 * query scenario, and query VUs must not carry dat memory.
 *
 * The request carries an ARRAY of blotter definitions (columns / conditions / sort; condition
 * values may use SERVER-side tokens such as CURRENT_DATE — not this repo's client-side {{TODAY}}),
 * and the response groups rows BY BLOTTER ID:
 *   { code: 200, status: "SUCCESS", msg: "", data: { "<blotterId>": { data: [ {trade:{id,basic}}, ... ] } } }
 * The envelope makes business rejection assertable (code/status), so this client uses the full
 * classifier; shape asserts that EVERY requested blotter id answers with a rows array.
 * Observed 2026-08-14 (see capture): the response returns more basic fields than the requested
 * columns, and basic.breakClause arrives string-typed ("false") unlike create/update captures —
 * neither is asserted.
 */
import * as client from '../../lib/http.js';
import { classifyResponse, reasonFrom, ERR } from '../../lib/errors.js';
import { Trend } from 'k6/metrics';

const MOD = 'trade';

// Empty-DB guard: total row count across the requested blotters feeds a Trend, and scenarios
// attach an avg>0 threshold. Note the default blotter row filters dealDate = CURRENT_DATE, so
// "empty" now means "no same-day trades" — mixed rounds create them continuously; a standalone
// single-API round needs trades booked today (seed or UI) or the guard trips.
export const tradesRows = new Trend('perf_trades_rows');

// No known rejection-message patterns yet — attribution falls back to the server's code enum (code-N)
const REJECT_PATTERNS = [];

/** blotterRow: one row from testdata (data/trade/trades-query.json) — a complete blotterDetails
 *  payload. Only the blotterDetails key reaches the wire; loader bookkeeping (__row) never does. */
export function queryTrades(cfg, blotterRow, user, runPhase) {
  const blotters = blotterRow.blotterDetails || [];
  const { res, tags } = client.postJson(cfg, '/api/v1/blotter/trades', { blotterDetails: blotters }, {
    name: 'POST /api/v1/blotter/trades', module: MOD, user,
    // row = data row number (__row): bounded tag, lets a bad blotter row be sliced out of metrics
    tags: { row: String(blotterRow.__row || 0), runPhase: runPhase || 'main' },
  });
  const out = classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'SUCCESS'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      if (!b.data || typeof b.data !== 'object') {
        return `data object missing — keys=${Object.keys(b || {}).slice(0, 8).join(',')}`;
      }
      for (const bl of blotters) {
        const got = b.data[bl.id];
        if (!got || !Array.isArray(got.data)) {
          return `blotter '${bl.id}' rows array missing at data['${bl.id}'].data — data.keys=${Object.keys(b.data).slice(0, 8).join(',')}`;
        }
      }
      return null;
    },
  });
  if (out.errClass === ERR.OK) {
    let n = 0;
    for (const bl of blotters) n += out.body.data[bl.id].data.length;
    tradesRows.add(n, tags);
  }
  return out;
}
