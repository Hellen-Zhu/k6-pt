import exec from 'k6/execution';
import { cfg, buildOptions, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/worker-svc/trade/consumable-pool.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';

// P0 · worker-svc/checker-flow · write path (single-task approve — consumes one pending task per request)
// Checker identity: the checker pool's size is this scenario's rate-limit budget.

const POOL = loadPool('approve-tasks');

export const options = buildOptions('worker-svc/checker-flow', 'approve');
// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED = plannedIterations(options);

export function setup() {
  // Prep planning mode (./prep.sh): report the pool demand and stop before any
  // preflight or request — the pool may legitimately be empty/placeholder at this point
  if (__ENV.PLAN) {
    console.log(`POOLPLAN approve-tasks ${PLANNED}`);
    exec.test.abort('plan only');
  }
  consumablePreflight(POOL, PLANNED, 'approve-tasks');
}

let warnedExhausted = false;

export default function () {
  const taskId = takeUnique(POOL);
  if (taskId === null) {
    // Skip, never recycle — re-approving a consumed task is an http-400 state conflict, not load
    if (!warnedExhausted) {
      console.warn('approve-tasks pool exhausted — remaining iterations are skipped (re-seed a bigger pool)');
      warnedExhausted = true;
    }
    return;
  }
  approveTask(cfg, taskId, pickUser(cfg, 'checker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
