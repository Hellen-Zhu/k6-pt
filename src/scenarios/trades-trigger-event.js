import exec from 'k6/execution';
import { cfg, buildOptions, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/worker-svc/trade/consumable-pool.js';
import { pickEventCase, eventCasesPreflight } from '../pools/worker-svc/trade/event-case-pool.js';
import { triggerEvent } from '../api/worker-svc/trade/trigger-event.js';

// P0 · worker-svc/trade · write path (lifecycle events — consumes one LIVE id per request).
// Internal tool per methodology: SLA line calibration / mixed-round attribution / regression
// bisection; capacity conclusions come from trade-mix. Event templates (5 captured types)
// rotate independently of the id cursor, so a round spreads evenly across event types; to
// isolate ONE event type (per-type SLA calibration), run with a single-row variant file —
// same mechanism as create's CREATE_DATA_FILE, here via EVENT_CASES_FILE is NOT implemented
// (YAGNI): temporarily trim event-cases.json in the private copy instead.
// Pool: ./prep.sh seed-event-pool <env> ITERATIONS=<n>  (single-use, re-seed per round)

const POOL = loadPool('event-ids');

export const options = buildOptions('worker-svc/trade', 'triggerEvent');
// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED = plannedIterations(options);

export function setup() {
  // Prep planning mode (./prep.sh): report the pool demand and stop before any
  // preflight or request — the pool may legitimately be empty/placeholder at this point
  if (__ENV.PLAN) {
    console.log(`POOLPLAN event-ids ${PLANNED}`);
    exec.test.abort('plan only');
  }
  eventCasesPreflight();
  consumablePreflight(POOL, PLANNED, 'event-ids');
}

let warnedExhausted = false;

export default function () {
  const i = exec.scenario.iterationInTest;
  const id = takeUnique(POOL);
  if (id === null) {
    // Skip, never recycle — a second event on a consumed id measures the state machine, not the system
    if (!warnedExhausted) {
      console.warn('event-ids pool exhausted — remaining iterations are skipped (re-seed a bigger pool)');
      warnedExhausted = true;
    }
    return;
  }
  triggerEvent(cfg, id, pickEventCase(i), pickUser(cfg, 'maker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
