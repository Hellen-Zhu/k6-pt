import http from 'k6/http';
import * as client from '../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../lib/errors.js';
import { extractTaskId } from '../checker-flow/tasks.js';
import { getDat, datName } from '../../testdata/trade/create.js';

const MOD = 'trade';

// The read path (queryTrades / perf_trades_rows) lives in ./query.js (init-graph isolation, final review #4):
// this file holds only create + its ./create.js data graph, so load-testing other APIs does not
// transitively load the testdata rows and the dat binaries.

/*
 * ── Response contract for create (calibrated against live trade-performance measurements;
 *    business classification belongs to this file, lib/errors.js is only the engine) ──
 * Success = HTTP 200 + code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-[A-Za-z0-9]+
 * (id relaxed from TRD-\d+ on 2026-08-05: real dev data contains hex-suffixed ids.)
 * msg carries the checker TaskId ("Submitted for checker approval. TaskId: CHK-...") — the
 * classify result is returned with `taskId` attached so the seed pipeline can approve directly.
 * On the first real-environment run, confirm the contract has not changed with the release.
 */
const REJECT_PATTERNS = [
  // The server names uploaded temp files by timestamp; concurrent uploads in the same instant delete
  // each other's temp files → "dat not found"
  // (workaround switch and attribution when this is hit: spec §11-4; the regex matches real server error
  //  text, which may contain Chinese — the escapes below are "does not exist" / "cannot find", keep them)
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|\u4e0d\u5b58\u5728)|\u627e\u4e0d\u5230/i },
];

/** premiumDate defaults to T+2 BUSINESS days (weekends skipped; holiday calendars are NOT
 *  modeled — a run whose T+2 lands on a market holiday may be business-rejected, calibrate
 *  then). Computed per call so long runs crossing midnight stay correct; a row may override
 *  with an explicit premiumDate value. */
function premiumDateTPlus2() {
  const d = new Date();
  let added = 0;
  while (added < 2) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

/** trade fields (the plain form fields of the multipart body). Must JSON.stringify —
 *  real counterparty names contain * and non-ASCII; hand-built strings will sooner or later produce invalid JSON.
 *  Shape recalibrated against a real capture (2026-08-10): basic carries the full field set below.
 *  productId is the single product identifier everywhere (rows, payload, dat same-name convention,
 *  attribution tag) — the former productType name was retired 2026-08-10. */
export function buildTradePayload(caseRow) {
  return JSON.stringify({
    basic: {
      portfolioId: caseRow.portfolioId,
      counterpartyFmId: caseRow.counterpartyFmId,
      counterpartyName: caseRow.counterpartyName,
      productId: caseRow.productId,
      direction: caseRow.direction || 'Buy',
      notionalCurrency: caseRow.notionalCurrency || '',
      premiumAmount: caseRow.premiumAmount !== undefined ? caseRow.premiumAmount : 0,
      premiumCurrency: caseRow.premiumCurrency || 'USD',
      premiumDate: caseRow.premiumDate || premiumDateTPlus2(),
      iaCcy: caseRow.iaCcy || 'USD',
      structuringInvolved: caseRow.structuringInvolved === true,
      esgLinked: caseRow.esgLinked === true,
      excludeFromCsa: caseRow.excludeFromCsa === true,
      breakClause: caseRow.breakClause === true,
    },
  });
}

// Placeholder patterns: deliberately no PERF prefix — the dedicated PERF portfolio is a legitimate
// real value (spec §6). The escape is the Chinese for "TBD", kept so Chinese placeholders still match.
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|\u5f85\u5b9a|placeholder)\s*$/i;

/** Not optional under static data supply: unresolved/placeholder fields would still be sent →
 *  server-side business rejection → the report shows "elevated error rate" instead of
 *  "the script is wrong" — the hardest failure class to debug */
export function validateInputs(caseRow) {
  const problems = [];
  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = caseRow[k];
    if (!v || !String(v).trim()) problems.push(`${k} unresolved (check the data file path and field names, see testdata/trade/create.js)`);
    else if (PLACEHOLDER.test(v)) problems.push(`${k}='${v}' is still a placeholder (see data/trade/README.md)`);
  });
  if (!caseRow.productId || !String(caseRow.productId).trim()) {
    problems.push('productId unresolved (the dat is located by the same-name-as-productId convention, see testdata/trade/create.js)');
  }
  return problems;
}

/** Send one create. The single request outlet — preflight and the main loop share this contract. */
export function createTrade(cfg, caseRow, user, runPhase) {
  const body = {
    trade: buildTradePayload(caseRow),
    datFile: http.file(getDat(caseRow.productId), datName(caseRow.productId), 'application/octet-stream'),
  };
  const { res, tags } = client.postMultipart(cfg, '/api/v1/trades/create', body, {
    name: 'POST /api/v1/trades/create', module: MOD, user,
    // Low-cardinality tags: row = data row number (__row), so a bad row can be sliced straight out
    // of the metrics; unique values like tradeId are strictly forbidden
    tags: {
      runPhase: runPhase || 'main',
      row: String(caseRow.__row || 0),
      productId: caseRow.productId || 'NA',
    },
  });
  const out = classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      const id = b.data && b.data.trade ? String(b.data.trade.id || '') : '';
      return /^TRD-[A-Za-z0-9]+$/.test(id) ? null : `unexpected tradeId format — '${id}'`;
    },
  });
  // Business success without a parsable TaskId is NOT a failure (taskId stays null);
  // the seed pipeline drops such rows and logs a warning — measurement rounds ignore it.
  out.tradeId = out.body && out.body.data && out.body.data.trade ? String(out.body.data.trade.id || '') : '';
  out.taskId = out.body ? extractTaskId(out.body.msg) : null;
  return out;
}
