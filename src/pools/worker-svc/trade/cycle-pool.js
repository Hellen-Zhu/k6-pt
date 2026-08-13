/*
 * Cycle pool — PERMANENT rotation for closed write loops (the amend→reject chain):
 * a pool of LIVE trade ids where every iteration returns its id to the starting state
 * before the rotation comes back around (reject discards the amendment, so the trade
 * ends byte-identical — zero drift, the pool never wears out and is seeded ONCE).
 *
 * Third pool discipline, beside the existing two:
 *   trade-ids-pool.js   reusable READ rotation (ids only read, order free)
 *   consumable-pool.js  exactly-once WRITE cursor (ids spent, re-seed per round)
 *   cycle-pool.js       reusable WRITE rotation (ids mutated and restored in-iteration)
 *
 * Correctness condition: an id must complete its cycle (update → reject → LIVE) before the
 * rotation revisits it, or the revisit self-inflicts the 409 state conflict ("Action 'AMEND'
 * is not permitted when trade status is 'Pending Approval Live'"). The volume preflight
 * enforces revisit period >> cycle time via the caller-computed floor:
 *   needed = max(50, ceil(peak iteration rate × cycle SLA seconds × 3))
 * with the cycle time taken at the SLA BOUNDARY (sum of the chain steps' p99), not at
 * baseline latency — degraded rounds are exactly when the margin is needed.
 *
 * Poisoning: if the return leg fails (update landed, reject did not), that id is stuck
 * pending and every revisit reads as http-409 technical. Rare in healthy runs (tracks the
 * error rate); recovery = re-run the seed producer. Deliberately NOT special-cased in the
 * classification engine — the http-409 reason tag is already sliceable.
 *
 * The pool is consumed by exactly ONE scenario (same ownership rule as consumable pools):
 * two scenarios rotating one cycle pool would interleave cursors and self-collide.
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const PLACEHOLDER = /tbc|todo|placeholder|xxx/i;

/** name: pool file basename under data/worker-svc/trade/, e.g. 'amend-cycle-ids' */
export function loadCyclePool(name) {
  return new SharedArray(`cycle-${name}`, () => {
    const doc = JSON.parse(open(import.meta.resolve(`../../../../data/worker-svc/trade/${name}.json`)));
    return (doc.ids || []).map(String);
  });
}

/** Setup-phase gate (the PREFLIGHT FAILED keyword is wired to the hint in run.sh).
 *  needed: revisit-safety floor computed by the entry from ITS chain shape and profile peak. */
export function cyclePreflight(pool, needed, name) {
  if (pool.length === 0 || pool.every((v) => PLACEHOLDER.test(v))) {
    console.error(
      `PREFLIGHT FAILED — ${name}.json is empty or placeholders only. ` +
      `Seed it once with its producer (./prep.sh <scenario> ... or ./prep.sh seed-amend-cycle-pool ...); ` +
      `it is permanent afterwards — reject restores every id.`
    );
    exec.test.abort(`${name} pool failed local validation`);
  }
  if (pool.length < needed) {
    console.error(
      `PREFLIGHT FAILED — ${name}.json holds ${pool.length} ids but this profile needs >= ${needed} ` +
      `(revisit period must clear the cycle's SLA-boundary duration with 3x margin). ` +
      `Seed a bigger pool or lower RATE.`
    );
    exec.test.abort(`${name} pool too small for the planned load`);
  }
}

/** Endless rotation — ids are restored by the chain, so wrapping around is the design. */
export function pickCycleId(pool, i) {
  return pool[Math.abs(i) % pool.length];
}
