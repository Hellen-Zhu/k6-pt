/*
 * Trade list client — GET /api/v1/trades (full-list projection, no params observed).
 * Contract: data/api-captures/get-trades/ (2026-08-12 capture). The endpoint was retired
 * from the MEASUREMENT query scenario on 2026-08-14 in favour of the blotter contract;
 * the read-pool collector readopted it on 2026-09-01 as its harvest source (team call:
 * prep logistics prefer the simplest list read over hand-assembled blotter conditions).
 *
 * Projection caveats straight from the capture:
 *  - basic carries a 12-field projection: dealDate / productId / status ARE there,
 *    portfolioId is NOT — scoping by portfolio is impossible on this endpoint; the
 *    collector scopes by identity visibility + same-source productId filter instead;
 *  - rows are heterogeneous: checkerContext appears only when a task is pending and
 *    trade is presumed constant (unconfirmed) — consumers must guard row.trade;
 *  - pagination fields: none observed, growth-unbounded full list — fine for a one-shot
 *    prep read, do NOT put this on a measurement path without re-capturing pagination.
 */
import * as client from '../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../lib/errors.js';

const MOD = 'trade';

// No known rejection-message patterns yet — attribution falls back to the server's code enum
const REJECT_PATTERNS = [];

export function listTrades(cfg, user, runPhase) {
  const { res, tags } = client.get(cfg, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user,
    tags: { runPhase: runPhase || 'main' },
  });
  return classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'SUCCESS'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) =>
      b.data && Array.isArray(b.data.data)
        ? null
        : `data.data rows array missing — keys=${Object.keys(b || {}).slice(0, 8).join(',')}`,
  });
}
