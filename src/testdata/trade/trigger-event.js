/*
 * Lifecycle-event testdata rows — REUSABLE rotation (request-shape dataset):
 * one row = one event template ({ eventType, data[], reason }); the tradeId it fires against
 * comes separately from the event-ids CONSUMABLE pool, so templates rotate forever while ids
 * are spent exactly once. Row values in the repo are placeholders; real captured values live
 * only in the private copy (data README discipline). Date-typed values may carry the tokens
 * {{TODAY}} / {{T_PLUS_2}} — resolved per request by the trigger-event client.
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const eventCases = new SharedArray('event-cases', () => {
  const doc = JSON.parse(open(import.meta.resolve('../../../data/trade/event-cases.json')));
  return (doc.rows || []).map((r, n) => Object.assign({ __row: n + 1 }, r));
});

export function pickEventCase(i) {
  return eventCases[i % eventCases.length];
}

/** Setup-phase gate (the PREFLIGHT FAILED keyword is wired to the hint in run.sh). */
export function eventCasesPreflight() {
  const problems = [];
  if (eventCases.length === 0) problems.push('event-cases.json has no rows');
  eventCases.forEach((r) => {
    if (!r.eventType || !String(r.eventType).trim()) problems.push(`row ${r.__row}: eventType missing`);
    if (!Array.isArray(r.data)) problems.push(`row ${r.__row}: data is not an array`);
    if (!r.reason || !String(r.reason).trim()) problems.push(`row ${r.__row}: reason missing`);
  });
  if (problems.length) {
    console.error(`PREFLIGHT FAILED — event-cases.json invalid: ${problems.join('; ')} (see data/trade/README.md)`);
    exec.test.abort('event testdata rows failed local validation');
  }
}
