/*
 * Mixed-API workload, FULL variant — the whole trade lifecycle as CHAIN-FED flows:
 * five parallel k6 scenarios, three of them chains that manufacture their own data, so the
 * entry runs with ZERO consumable pools (prep per round is retired for this entry).
 *
 *   flow          share  req/iter  iteration body (strictly serial inside — business causality)
 *   query          .20      1      GET /trades
 *   detail         .10      1      GET /trades/{id}            (trade-ids reusable read pool)
 *   create-chain   .10      2      create → approve            (fresh trade, then abandoned LIVE)
 *   event-chain    .20      4      create → approve → trigger-event → calculate-risk
 *                                  (fresh DISPOSABLE trade, so terminal event types are fine;
 *                                   5 captured types rotate; calc fires 1:1 after the event)
 *   amend-cycle    .40      2      update → reject             (PERMANENT pool: reject discards
 *                                   the amendment, the id returns to LIVE unchanged — seed once)
 *
 * RATE semantics (2026-08-12 decision): ratio = share of HTTP REQUESTS, so RATE=10 puts
 * exactly 10 HTTP req/s on the gateway. Per-endpoint at RATE=10: query 2 / detail 1 /
 * create 1 / approve 1 / update 2 / reject 2 / event 0.5 / calc 0.5. Chains run at
 * rate × share ÷ reqPerIter iterations/s (lib/mix.js emits ×10 rates with timeUnit 10s to
 * express the fractional ones).
 *
 * Ratio provenance — the business population picture (2026-08-12): of the active users,
 * create : amend : event ≈ 20 : 40 : 10 (amend-dominant per management). Checker load is NOT
 * a knob: conservation fixes it — every create spawns one approve, every amend one verdict —
 * and the chains enforce that structurally. Read-flow share (30%) is a placeholder pending
 * the traffic profile.
 *
 * Honesty notes (report-caliber, keep in the wording of conclusions):
 *  - approve/reject split: the checker's .30 share lands as approve .10 + reject .20 (the
 *    cycle rejects 100% of amendments to stay permanent; production mostly approves). Same
 *    state-machine write path, capacity-equivalent.
 *  - Timeline compression: approve follows create by ~ms (production: minutes), events fire
 *    on second-old trades (production: days). Arrival rates — the thing the server actually
 *    experiences — are exact; per-trade chronology is not modeled.
 *  - The event chain's Cancellation rows leave PENDING checker tasks behind on purpose
 *    (nobody processes them): free padding for the otherwise near-empty checker queue.
 *  - Novation/Allocation events spawn child trades and GET /trades has no pagination —
 *    sustained rounds grow the query response; account for it in cross-round comparisons.
 *
 * Entries are deliberately SELF-CONTAINED (no shared flow module): read one file, see the
 * whole scenario. Sister entries (trade-mix-book / trade-mix-amend) still run the pool-fed
 * shape — when changing a flow here, check whether they need the same change.
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti } from '../lib/bootstrap.js';
import { splitByRatio } from '../lib/mix.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { ERR } from '../lib/errors.js';
import { pickCase } from '../testdata/trade/create.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/trade/trade-ids-pool.js';
import { createTradePreflight } from '../testdata/trade/create-preflight.js';
import { pickEventCase, eventCasesPreflight } from '../testdata/trade/trigger-event.js';
import { pickCalcRiskPayload, calcRiskPayloadsPreflight } from '../testdata/trade/calc-risk.js';
import { loadCyclePool, cyclePreflight, pickCycleId } from '../pools/trade/cycle-pool.js';
import { createTrade } from '../api/trade/create.js';
import { updateTrade } from '../api/trade/update.js';
import { approveTask, rejectTask } from '../api/checker-flow/tasks.js';
import { queryTrades } from '../api/trade/query.js';
import { getTrade } from '../api/trade/detail.js';
import { triggerEvent } from '../api/trade/trigger-event.js';
import { calculateRisk } from '../api/trade/calc-risk.js';

// Request shares (sum 1.0). create:amend:event = 2:4:1 is the business picture; the
// chain shapes (reqPerIter) are structural, not tunable — see header.
const MIX = { query: 0.2, detail: 0.1, createChain: 0.1, eventChain: 0.2, amendCycle: 0.4 };

const QUERY_DATA = loadData('trade/trades-query');
const UPDATE_DATA = loadData('trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const CYCLE_POOL = loadCyclePool('amend-cycle-ids');

const base = buildOptionsMulti(
  [
    ['trade', 'query'],
    ['trade', 'detail'],
    ['trade', 'create'],
    ['checker-flow', 'approve'],
    ['trade', 'update'],
    ['checker-flow', 'reject'],
    ['trade', 'triggerEvent'],
    ['trade', 'calcRisk'],
  ],
  // Same empty-DB guard as the single-API query scenario
  { perf_trades_rows: ['avg>0'] },
);

base.scenarios = splitByRatio(base.scenarios.main, [
  { name: 'query-mix', exec: 'queryMix', ratio: MIX.query },
  { name: 'detail-mix', exec: 'detailMix', ratio: MIX.detail },
  { name: 'create-chain', exec: 'createChain', ratio: MIX.createChain, reqPerIter: 2 },
  { name: 'event-chain', exec: 'eventChain', ratio: MIX.eventChain, reqPerIter: 4 },
  { name: 'amend-cycle', exec: 'amendCycle', ratio: MIX.amendCycle, reqPerIter: 2 },
]);
export const options = base;

// ── Cycle-pool floor, captured at init (k6 replaces the exported options binding after init,
// so the split scenario must be read here, not in setup) ─────────────────────────────────
// Revisit safety: an id must finish update→reject before the rotation returns to it. The
// cycle time is taken at the SLA BOUNDARY (update p99 2.0s + reject p99 1.5s = 3.5s) — the
// margin must hold in degraded rounds, which is when it matters. ×3 safety, floor 50.
const CYCLE_SLA_SECONDS = 3.5;

function secondsOf(d) {
  let total = 0;
  const re = /(\d+)(h|m|s)/g;
  let m;
  while ((m = re.exec(String(d))) !== null) {
    total += parseInt(m[1], 10) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  }
  return total;
}

function cycleFloor(sc) {
  if (sc.iterations !== undefined) return Math.ceil(sc.iterations * 1.2);
  const tu = secondsOf(sc.timeUnit || '1s') || 1;
  let peak = sc.rate !== undefined ? sc.rate : 0;
  if (Array.isArray(sc.stages)) {
    peak = sc.startRate || 0;
    for (const st of sc.stages) peak = Math.max(peak, st.target);
  }
  return Math.max(50, Math.ceil((peak / tu) * CYCLE_SLA_SECONDS * 3));
}

const CYCLE_NEEDED = cycleFloor(base.scenarios['amend-cycle']);

export function setup() {
  // Prep planning mode (./prep.sh): report the permanent pool's floor and stop before any
  // preflight or request. This is the entry's ONLY seeded pool — and it is seeded ONCE, not
  // per round (reject restores every id; re-seed only after poisoning).
  if (__ENV.PLAN) {
    console.log(`POOLPLAN amend-cycle-ids ${CYCLE_NEEDED}`);
    exec.test.abort('plan only');
  }
  const seeded = createTradePreflight();
  tradeIdsPreflight();
  eventCasesPreflight();
  calcRiskPayloadsPreflight();
  cyclePreflight(CYCLE_POOL, CYCLE_NEEDED, 'amend-cycle-ids');
  return seeded;
}

export function queryMix() {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(QUERY_DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export function detailMix() {
  getTrade(cfg, pickTradeId(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU));
}

/** create → approve. A fresh trade per iteration, left LIVE and abandoned. Head failure
 *  (create rejected / no TaskId) abandons the iteration — no shared state to corrupt. */
export function createChain() {
  const i = exec.scenario.iterationInTest;
  const created = createTrade(cfg, pickCase(i), pickUser(cfg, 'maker', __VU), 'main');
  if (created.errClass !== ERR.OK || !created.taskId) return;
  approveTask(cfg, created.taskId, pickUser(cfg, 'checker', __VU), 'main');
}

/** create → approve → trigger-event → calculate-risk. The trade is DISPOSABLE, which is what
 *  lets every captured event type fire here, terminal ones included. The event template
 *  rotates on the iteration cursor; calc is the structural 1:1 follow-up (skipped when the
 *  event itself was blocked — the UI would not recalc a failed event either). */
export function eventChain() {
  const i = exec.scenario.iterationInTest;
  const maker = pickUser(cfg, 'maker', __VU);
  const created = createTrade(cfg, pickCase(i), maker, 'main');
  if (created.errClass !== ERR.OK || !created.taskId) return;
  const approved = approveTask(cfg, created.taskId, pickUser(cfg, 'checker', __VU), 'main');
  if (approved.errClass !== ERR.OK) return;
  const evented = triggerEvent(cfg, created.tradeId, pickEventCase(i), maker, 'main');
  if (evented.errClass !== ERR.OK) return;
  calculateRisk(cfg, pickCalcRiskPayload(i), maker, 'main');
}

/** update → reject on the permanent pool. reject discards the amendment, so the id is LIVE
 *  again before the rotation revisits it (volume preflight guarantees the margin). A failed
 *  return leg leaves the id stuck pending — poisoned slots surface as http-409 on revisit;
 *  re-seed the pool to recover. */
export function amendCycle() {
  const i = exec.scenario.iterationInTest;
  const id = pickCycleId(CYCLE_POOL, i);
  const updated = updateTrade(cfg, id, pickAt(UPDATE_CASES, i), pickUser(cfg, 'maker', __VU), 'main');
  if (updated.errClass !== ERR.OK) return;
  if (!updated.taskId) {
    console.warn(`amend-cycle: updated ${id} but no TaskId in msg — cannot reject, slot left pending (poisoned)`);
    return;
  }
  rejectTask(cfg, updated.taskId, pickUser(cfg, 'checker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
