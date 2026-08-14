import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../testdata/trade/create.js';
import { createTrade } from '../api/trade/create.js';
import { createTradePreflight } from '../testdata/trade/create-preflight.js';

// P0 · trade · write path

export const options = buildOptions('trade', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const user = pickUser(cfg, 'maker', __VU);
  createTrade(cfg, pickCase(i), user, 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
