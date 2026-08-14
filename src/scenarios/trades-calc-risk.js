import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCalcRiskPayload, calcRiskPayloadsPreflight } from '../testdata/trade/calc-risk.js';
import { calculateRisk } from '../api/trade/calc-risk.js';

// P0 · trade · compute path (risk calculation — stateless, nothing consumed).
// Internal tool per methodology: SLA line calibration / mixed-round attribution / regression
// bisection; capacity conclusions come from trade-mix. Payload rows rotate forever (reusable
// pool, zero seeding) — pool size buys pricing-path DIVERSITY, so a single-row pool measures
// one product's pricing hot in cache; add captured rows per product before reading cross-
// product conclusions. Likely the most CPU-bound endpoint in the set: watch the server U/S
// panels — this is the flow most able to move jvm CPU, unlike the wait-dominated read paths.

export const options = buildOptions('trade', 'calcRisk');

export function setup() {
  calcRiskPayloadsPreflight();
}

export default function () {
  calculateRisk(cfg, pickCalcRiskPayload(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
