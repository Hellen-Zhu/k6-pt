/*
 * Trade update client — POST /api/v1/trades/{id}/update (maker identity, partial-field body).
 *
 * Contract calibrated against a real dev response (re-confirmed 2026-08-12, captured in
 * data/api-captures/post-trades-update/):
 *   → { code: 200, status: "PENDING APPROVAL",
 *       msg: "Submitted for checker approval. TaskId: CHK-...", data: { id, basic: {...} } }
 * The update re-enters the approval state machine (eventStatus=Amended), so every update
 * CONSUMES one LIVE trade id — the scenario feeds ids through the consumable pool's unique
 * cursor, never a reusable one. A second update before the checker acts is not load, it is a
 * hard state conflict: HTTP 409 "Action 'AMEND' is not permitted when trade status is
 * 'Pending Approval Live'" — and because that is a non-200, it lands in the TECHNICAL bucket,
 * i.e. an id-pool defect will read as a system failure in the verdict. Keep the pool unique.
 *
 * Kept isolated from create's data graph (same init-graph discipline as query.js): this file
 * carries no testdata rows and no dat binaries.
 */
import * as client from '../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../lib/errors.js';
import { extractTaskId } from '../checker-flow/tasks.js';

const MOD = 'trade';

// No known rejection-message patterns yet — attribution falls back to the server's code enum (code-N)
const REJECT_PATTERNS = [];

/**
 * payloadRow comes from data/trade/update-payload.json. Only whitelisted keys are
 * sent — the server rejects unknown fields, and the loader's bookkeeping key (__row) must
 * never leak into the request body.
 */
export function buildUpdatePayload(payloadRow) {
  return { basic: payloadRow.basic };
}

export function updateTrade(cfg, tradeId, payloadRow, user, runPhase) {
  const { res, tags } = client.postJson(cfg, `/api/v1/trades/${tradeId}/update`, buildUpdatePayload(payloadRow), {
    // Normalized name tag — unique tradeIds must never become tag values
    name: 'POST /api/v1/trades/{id}/update', module: MOD, user,
    tags: { runPhase: runPhase || 'main', row: String(payloadRow.__row || 0) },
  });
  const out = classifyResponse(res, tags, {
    // Two-part business contract (see data/api-captures/post-trades-update/): the envelope must
    // report PENDING APPROVAL *and* the returned snapshot must show the trade has re-entered the
    // approval state machine as eventStatus=Amended. The envelope alone is not enough — it only
    // says the request was taken, not that the amendment landed on the trade.
    business: (b) => {
      if (b.status !== 'PENDING APPROVAL') {
        return {
          reason: reasonFrom(b, REJECT_PATTERNS),
          detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
        };
      }
      const basic = b.data && b.data.basic ? b.data.basic : null;
      const eventStatus = basic ? String(basic.eventStatus || '') : '';
      if (eventStatus !== 'Amended') {
        // Own bounded slot: reasonFrom would tag this 'code-200', which says nothing about the failure
        return {
          reason: 'event-status',
          detail: `business: accepted but data.basic.eventStatus='${eventStatus}' (expected 'Amended')`,
        };
      }
      return null;
    },
    shape: (b) => {
      const id = b.data ? String(b.data.id || '') : '';
      return id === String(tradeId) ? null : `data.id echo mismatch — sent '${tradeId}', got '${id}'`;
    },
  });
  // The new approval task for this amendment — future consume-and-regenerate loops approve it
  // to bring the id back to LIVE (soak-scenario material, not used by the single-API measurement)
  out.taskId = out.body ? extractTaskId(out.body.msg) : null;
  return out;
}
