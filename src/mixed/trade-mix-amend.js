/*
 * Mixed-API workload, AMEND-HEAVY shape: both create and update present, with update
 * OUTWEIGHING create (2:1 — management calls amend the future high-frequency operation).
 * query/detail/create/update/approve, all five contracts environment-calibrated, runnable today.
 * Methodology unchanged (agreed 2026-08-07): realistic API RATIOS, no ordering, scaled in
 * business-volume MULTIPLES; per-API SLA thresholds are name-tagged.
 *
 * Everything runs on FRESH trades (management decision 2026-08-11, keep it simple): the
 * update pool is fresh LIVE trades (seed-update-pool) and the approve pool is new-trade
 * tasks (seed-approve-pool) — approve here means approve-NEW-trade, same as the book shape.
 * The blended/typed approve pool (create:amend interleave, taskType slicing) was implemented
 * and retired the same day; recover from git history if the per-type question ever reopens.
 *
 * Sister shapes: trade-mix-book (new-business day) and trade-mix-full (+ lifecycle path).
 * Entries are deliberately SELF-CONTAINED (2026-08-11 direction, no shared flow module):
 * read one file, see the whole scenario — when changing a flow here, check whether the
 * sister entries need the same change.
 *
 * PLACEHOLDER ratios (must sum to 1) pending the traffic profile; two are
 * STRUCTURAL: update = 2 × create (the shape's defining trait) and approve = create + update.
 * A round dirties update-ids AND approve-tasks — re-seed before rerun.
 *
 * Cursor correctness: exec.scenario.iterationInTest counts PER SCENARIO (verified against
 * k6 v2.1.0), so each consumable pool keeps its exactly-once guarantee as long as it is
 * consumed by exactly ONE scenario — update-mix owns update-ids, approve-mix owns
 * approve-tasks.
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { splitByRatio } from '../lib/mix.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { pickCase } from '../testdata/trade/create.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/trade/trade-ids-pool.js';
import { createTrade } from '../api/trade/create.js';
import { updateTrade } from '../api/trade/update.js';
import { approveTask } from '../api/checker-flow/tasks.js';
import { queryTrades } from '../api/trade/query.js';
import { getTrade } from '../api/trade/detail.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/trade/consumable-pool.js';
import { createTradePreflight } from '../testdata/trade/create-preflight.js';

// PLACEHOLDER ratios (must sum to 1) — update = 2 × create and approve = create + update are structural
const MIX = { query: 0.25, detail: 0.15, create: 0.1, update: 0.2, approve: 0.3 };

const QUERY_DATA = loadData('trade/trades-query');
const UPDATE_DATA = loadData('trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const UPDATE_POOL = loadPool('update-ids');
const APPROVE_POOL = loadPool('approve-tasks');

const base = buildOptionsMulti(
  [
    ['trade', 'query'],
    ['trade', 'detail'],
    ['trade', 'create'],
    ['trade', 'update'],
    ['checker-flow', 'approve'],
  ],
  // Same empty-DB guard as the single-API query scenario
  { perf_trades_rows: ['avg>0'] },
);

base.scenarios = splitByRatio(base.scenarios.main, [
  { name: 'query-mix', exec: 'queryMix', ratio: MIX.query },
  { name: 'detail-mix', exec: 'detailMix', ratio: MIX.detail },
  { name: 'create-mix', exec: 'createMix', ratio: MIX.create },
  { name: 'update-mix', exec: 'updateMix', ratio: MIX.update },
  { name: 'approve-mix', exec: 'approveMix', ratio: MIX.approve },
]);
export const options = base;

// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED_UPDATE = plannedIterations({ scenarios: { main: base.scenarios['update-mix'] } });
const PLANNED_APPROVE = plannedIterations({ scenarios: { main: base.scenarios['approve-mix'] } });

export function setup() {
  // Prep planning mode (./prep.sh): report each consumable pool's demand and stop before
  // any preflight or request — pools may legitimately be empty/placeholder at this point
  if (__ENV.PLAN) {
    console.log(`POOLPLAN update-ids ${PLANNED_UPDATE}`);
    console.log(`POOLPLAN approve-tasks ${PLANNED_APPROVE}`);
    exec.test.abort('plan only');
  }
  const seeded = createTradePreflight();
  tradeIdsPreflight();
  consumablePreflight(UPDATE_POOL, PLANNED_UPDATE, 'update-ids');
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

let warnedUpdateExhausted = false;

export function updateMix() {
  const i = exec.scenario.iterationInTest;
  const id = takeUnique(UPDATE_POOL);
  if (id === null) {
    // Skip, never recycle — a second update on the same id measures the state machine, not the system
    if (!warnedUpdateExhausted) {
      console.warn('update-ids pool exhausted — remaining update-mix iterations are skipped (re-seed a bigger pool)');
      warnedUpdateExhausted = true;
    }
    return;
  }
  updateTrade(cfg, id, pickAt(UPDATE_CASES, i), pickUser(cfg, 'maker', __VU), 'main');
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
