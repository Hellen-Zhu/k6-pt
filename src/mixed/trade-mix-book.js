/*
 * Mixed-API workload, BOOKING-DAY shape: the new-business profile — reads + create +
 * approve-new, NO amend path. query/detail/create/approve, all four contracts
 * environment-calibrated, runnable today. Methodology unchanged (agreed 2026-08-07): realistic
 * API RATIOS, no ordering, scaled in business-volume MULTIPLES; per-API SLA thresholds are
 * name-tagged so each endpoint is judged under mixed load against its own SLA.
 *
 * The whole family runs on FRESH trades (management decision 2026-08-11, keep it simple):
 * approve always means approve-NEW-trade, seeded by seed-approve-pool (create → harvest
 * TaskId). Sister shapes: trade-mix-amend (amend-heavy) and trade-mix-full (+ lifecycle
 * path). Entries are deliberately SELF-CONTAINED (2026-08-11 direction, no shared flow
 * module): read one file, see the whole scenario — when changing a flow here, check whether
 * the sister entries need the same change.
 *
 * PLACEHOLDER ratios (must sum to 1) pending the traffic profile; one is
 * STRUCTURAL: approve = create (in this shape every task comes from a booking). Pool demand
 * per round = ratio × total rate × duration × 1.2 (preflight enforces); a round dirties
 * approve-tasks only — the lightest re-seed of the family.
 *
 * Cursor correctness: exec.scenario.iterationInTest counts PER SCENARIO (verified against
 * k6 v2.1.0), so the consumable pool keeps its exactly-once guarantee as long as it is
 * consumed by exactly ONE scenario — approve-mix owns approve-tasks.
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { splitByRatio } from '../lib/mix.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { pickCase } from '../testdata/trade/create.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/trade/trade-ids-pool.js';
import { createTrade } from '../api/trade/create.js';
import { approveTask } from '../api/checker-flow/tasks.js';
import { queryTrades } from '../api/trade/query.js';
import { getTrade } from '../api/trade/detail.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/trade/consumable-pool.js';
import { createTradePreflight } from '../testdata/trade/create-preflight.js';

// PLACEHOLDER ratios (must sum to 1) — approve = create is structural
const MIX = { query: 0.4, detail: 0.2, create: 0.2, approve: 0.2 };

const QUERY_DATA = loadData('trade/trades-query');
const APPROVE_POOL = loadPool('approve-tasks');

const base = buildOptionsMulti(
  [
    ['trade', 'query'],
    ['trade', 'detail'],
    ['trade', 'create'],
    ['checker-flow', 'approve'],
  ],
  // Same empty-DB guard as the single-API query scenario
  { perf_trades_rows: ['avg>0'] },
);

base.scenarios = splitByRatio(base.scenarios.main, [
  { name: 'query-mix', exec: 'queryMix', ratio: MIX.query },
  { name: 'detail-mix', exec: 'detailMix', ratio: MIX.detail },
  { name: 'create-mix', exec: 'createMix', ratio: MIX.create },
  { name: 'approve-mix', exec: 'approveMix', ratio: MIX.approve },
]);
export const options = base;

// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED_APPROVE = plannedIterations({ scenarios: { main: base.scenarios['approve-mix'] } });

export function setup() {
  // Prep planning mode (./prep.sh): report each consumable pool's demand and stop before
  // any preflight or request — pools may legitimately be empty/placeholder at this point
  if (__ENV.PLAN) {
    console.log(`POOLPLAN approve-tasks ${PLANNED_APPROVE}`);
    exec.test.abort('plan only');
  }
  const seeded = createTradePreflight();
  tradeIdsPreflight();
  consumablePreflight(APPROVE_POOL, PLANNED_APPROVE, 'approve-tasks');
  return seeded;
}

export function queryMix() {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(QUERY_DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export function detailMix() {
  getTrade(cfg, pickTradeId(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU));
}

export function createMix() {
  createTrade(cfg, pickCase(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU), 'main');
}

let warnedApproveExhausted = false;

export function approveMix() {
  const taskId = takeUnique(APPROVE_POOL);
  if (taskId === null) {
    // Skip, never recycle — re-approving a consumed task is an http-400 state conflict, not load
    if (!warnedApproveExhausted) {
      console.warn('approve-tasks pool exhausted — remaining approve-mix iterations are skipped (re-seed a bigger pool)');
      warnedApproveExhausted = true;
    }
    return;
  }
  approveTask(cfg, taskId, pickUser(cfg, 'checker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
