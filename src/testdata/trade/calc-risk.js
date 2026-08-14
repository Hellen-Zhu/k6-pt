/*
 * calculate-risk payload pool — REUSABLE rotation (parameter pool):
 * one row = one FULL trade snapshot ({ id, basic, instrument, trace }) exactly as the UI sends
 * it. Risk calculation is stateless compute, so rows rotate forever — pool size buys input
 * DIVERSITY (different products/schedules stress different pricing paths), not sufficiency.
 *
 * Capture discipline (STRICTER here than anywhere else): the instrument section (notionals,
 * payoffDict, schedule) is deeply product-specific — every row must be a verbatim DevTools
 * capture of a real calculate-risk request (trigger any event in the UI, Network tab →
 * calculate-risk → copy payload). Assembling instrument fields by hand produces payloads the
 * pricing engine rejects or short-circuits — measuring the error path, not the pricing path.
 * Repo rows are well-formed placeholder fakes (pass this structural preflight, will be
 * business-rejected by a real server); real captures live only in the private copy.
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const calcRiskPayloads = new SharedArray('calc-risk-payloads', () => {
  const doc = JSON.parse(open(import.meta.resolve('../../../data/trade/calc-risk-payloads.json')));
  return (doc.rows || []).map((r, n) => Object.assign({ __row: n + 1 }, r));
});

export function pickCalcRiskPayload(i) {
  return calcRiskPayloads[i % calcRiskPayloads.length];
}

/** Setup-phase gate (the PREFLIGHT FAILED keyword is wired to the hint in run.sh). */
export function calcRiskPayloadsPreflight() {
  const problems = [];
  if (calcRiskPayloads.length === 0) problems.push('calc-risk-payloads.json has no rows');
  calcRiskPayloads.forEach((r) => {
    if (!r.id || !String(r.id).trim()) problems.push(`row ${r.__row}: id missing`);
    if (!r.basic || typeof r.basic !== 'object') problems.push(`row ${r.__row}: basic section missing`);
    if (!r.instrument || typeof r.instrument !== 'object') problems.push(`row ${r.__row}: instrument section missing`);
  });
  if (problems.length) {
    console.error(`PREFLIGHT FAILED — calc-risk-payloads.json invalid: ${problems.join('; ')} (see data/trade/README.md)`);
    exec.test.abort('calc-risk payload pool failed local validation');
  }
}
