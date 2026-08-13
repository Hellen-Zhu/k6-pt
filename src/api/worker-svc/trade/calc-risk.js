/*
 * Risk calculation client — POST /api/v1/trades/{id}/calculate-risk (maker identity).
 *
 * PATH ASSUMED from the API governance list: the 2026-08-10 capture shows the Payload tab only
 * (request name 'calculate-risk' confirms the last path segment) — CONFIRM method + full URL
 * from the Headers tab before the first real-environment round. The two variants on
 * the governance list (partial-novation / for-new) are NOT implemented yet — separate contracts.
 *
 * Request contract (captured 2026-08-10): the body is the FULL trade snapshot the UI holds —
 * { id, basic: {...}, instrument: {...}, trace: [...] }. The platform prices from the payload
 * itself (the UI fires one calculate-risk per lifecycle event, sending its current snapshot),
 * so payload rows must be SAME-SOURCE captures of real trades (data README discipline): a
 * hand-assembled instrument section would measure the platform's error path, not its pricing
 * path. Stateless compute — rows are a REUSABLE rotation pool, nothing is consumed.
 *
 * Response contract UNCALIBRATED (capture had no Response tab): business success is judged as
 * envelope code === 200 only; tighten (status value, data shape) once a real response is on file.
 */
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

// No known rejection-message patterns yet — attribution falls back to the server's code enum
const REJECT_PATTERNS = [];

/** Whitelist rebuild — the loader's bookkeeping key (__row) must never leak into the body. */
export function buildCalcRiskPayload(payloadRow) {
  return {
    id: payloadRow.id,
    basic: payloadRow.basic,
    instrument: payloadRow.instrument,
    trace: payloadRow.trace || [],
  };
}

export function calculateRisk(cfg, payloadRow, user, runPhase) {
  const id = String(payloadRow.id || '');
  const { res, tags } = client.postJson(
    cfg, SVC, `/api/v1/trades/${encodeURIComponent(id)}/calculate-risk`, buildCalcRiskPayload(payloadRow), {
      // Normalized name tag — unique tradeIds must never become tag values
      name: 'POST /api/v1/trades/{id}/calculate-risk', module: MOD, user,
      tags: { runPhase: runPhase || 'main', row: String(payloadRow.__row || 0) },
    },
  );
  return classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
  });
}
