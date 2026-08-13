/*
 * Lifecycle event client — POST /api/v1/trades/trigger-event (maker identity).
 *
 * URL CONFIRMED 2026-08-11 (user-provided): a COLLECTION endpoint, no {id} in the path — the
 * body's tradeIds array is the addressing mechanism.
 *
 * Request contract (5 event types captured 2026-08-10, one envelope):
 *   { eventType, data: [ { key, value, type: Text|Numeric|Date } ... ], reason, comments: "",
 *     tradeIds: [ tradeId ] }
 * Captured types → reasons: PortfolioReassignment→NON_ECON_CHANGE, PartialTermination→ECON_CHANGE,
 * Cancellation→ECON_CHANGE (empty data), EarlyTermination→FULL_TERM (direction/amount/ccy/
 * settleDate/ci), NovationRemaining→REMAINING_PARTY_FULL (newCptyName/newCptyFmId/novationDate/
 * newTargetAmount). tradeIds is an array (bulk-capable) — this client always sends exactly one:
 * bulk would batch server work per request and break the request≈business-action equivalence
 * the mixed ratios rely on.
 *
 * Every event CONSUMES one LIVE tradeId (terminal or state-changing either way — a second event
 * on a consumed id measures the state machine, not the system), so the scenario feeds ids from
 * a consumable pool, exactly-once.
 *
 * Response contract CALIBRATED 2026-08-12 (7 of the 9 UI event types captured in
 * data/api-captures/post-trades-trigger-event/) — a BULK envelope unlike every other endpoint:
 *   { code, status: "SUCCESS", msg: "",
 *     data: { eventType, results: [ { tradeId, checkerTaskId?, childTradeIds?[] } ],
 *             status: ALL_EXECUTED | ALL_PENDING_APPROVAL, totalRequested } }
 * Assertions: data.status must be a known success value (business — see BULK_OK) and
 * data.eventType must echo what was sent (shape).
 *
 * Two contract facts the earlier guesses got wrong:
 *   1. Only Cancellation re-enters checker approval (ALL_PENDING_APPROVAL); the other six execute
 *      immediately. It is NOT "every write spawns a checker task".
 *   2. The TaskId is in data.results[].checkerTaskId, never in msg (always "") — create/update's
 *      extractTaskId(msg) mechanism does not transfer here.
 * NovationRemaining / PartialNovationRemaining / Allocation additionally SPAWN child trades
 * (data.results[].childTradeIds, suffixed -NOV- / -PNOV- / -ALLOC-n), so a long event run keeps
 * growing the trade table and with it the cost of every full-table read in the same run.
 */
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

const REJECT_PATTERNS = [];

/*
 * data.status is a BULK-level verdict, separate from the envelope's status. Values seen in dev
 * (captures in data/api-captures/post-trades-trigger-event/): ALL_EXECUTED for 6 of the 7 captured
 * event types, ALL_PENDING_APPROVAL for Cancellation (the only type that re-enters checker
 * approval). The ALL_ prefix implies partial/none variants exist for multi-id requests; this
 * client always sends exactly one tradeId, so anything outside this pair means the event did not
 * go through — the envelope alone would report that as a success and inflate the throughput.
 */
const BULK_OK = ['ALL_EXECUTED', 'ALL_PENDING_APPROVAL'];

/* Date tokens keep the repo/private case rows evergreen — captured literal dates go stale and
 * turn into business rejections weeks later. Same T+2 BUSINESS-day rules as create.js's
 * premiumDate helper (weekends skipped, holiday calendars not modeled); duplicated here rather
 * than imported because create.js carries the case-pool + dat init graph (isolation discipline). */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function tPlus2BusinessIso() {
  const d = new Date();
  let added = 0;
  while (added < 2) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}
function resolveValue(v) {
  if (v === '{{TODAY}}') return todayIso();
  if (v === '{{T_PLUS_2}}') return tPlus2BusinessIso();
  return v;
}

/** Whitelist rebuild (no __row leak); comments always sent as "" per capture. */
export function buildEventPayload(eventCase, tradeId) {
  return {
    eventType: eventCase.eventType,
    data: (eventCase.data || []).map((d) => ({ key: d.key, value: resolveValue(d.value), type: d.type })),
    reason: eventCase.reason,
    comments: '',
    tradeIds: [String(tradeId)],
  };
}

export function triggerEvent(cfg, tradeId, eventCase, user, runPhase) {
  const { res, tags } = client.postJson(
    cfg, SVC, '/api/v1/trades/trigger-event',
    buildEventPayload(eventCase, tradeId), {
      // Collection endpoint — the tradeId travels in the body only, so the raw URL is already
      // low-cardinality; eventType is a deliberate LOW-cardinality tag (5 values) so any
      // metric view can be sliced per event type
      name: 'POST /api/v1/trades/trigger-event', module: MOD, user,
      tags: { runPhase: runPhase || 'main', row: String(eventCase.__row || 0), eventType: String(eventCase.eventType || 'NA') },
    },
  );
  const out = classifyResponse(res, tags, {
    business: (b) => {
      if (b.code !== 200) {
        return {
          reason: reasonFrom(b, REJECT_PATTERNS),
          detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
        };
      }
      // The envelope only says the request parsed; data.status says the event actually fired
      const bulk = b.data ? String(b.data.status || '') : '';
      if (BULK_OK.indexOf(bulk) < 0) {
        // Fixed slot: the failure values of this enum have never been observed, so the raw value
        // stays in the detail text and never reaches a tag
        return {
          reason: 'bulk-status',
          detail: `business: envelope OK but data.status='${bulk}' (expected ${BULK_OK.join(' | ')}), totalRequested=${b.data ? b.data.totalRequested : 'NA'}`,
        };
      }
      return null;
    },
    // The response must belong to the event we asked for; a mismatch voids the per-eventType
    // metric slicing, which is a script-class problem rather than a business rejection
    shape: (b) => {
      const echoed = b.data ? String(b.data.eventType || '') : '';
      return echoed === String(eventCase.eventType)
        ? null
        : `data.eventType echo mismatch — sent '${eventCase.eventType}', got '${echoed}'`;
    },
  });
  // TaskId lives in data.results[].checkerTaskId here, NOT in msg (which is always "") — the
  // create/update mechanism does not transfer. Only Cancellation returns one; null for the rest.
  const first = out.body && out.body.data && Array.isArray(out.body.data.results) ? out.body.data.results[0] : null;
  out.taskId = first && first.checkerTaskId ? String(first.checkerTaskId) : null;
  return out;
}
