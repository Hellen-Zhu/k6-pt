#!/usr/bin/env node
/*
 * k6-pt console backend — P0 (read-only).
 * Runtime: Node >= 18, STANDARD LIBRARY ONLY. This is Node-JS, not k6-JS — never
 * import framework code (contract, DESIGN.md §1): spawn run.sh/prep.sh (from P1),
 * read results/, list catalog directories. Nothing else.
 *
 * Run:   node portal/server.js            then open http://127.0.0.1:8090
 * Env:   PORTAL_ADDR  bind address        (default 127.0.0.1)
 *        PORTAL_PORT  port                (default 8090)
 *        PORTAL_TOKEN when set, /api/* requires header X-Auth-Token
 *        PERF_HOME    framework root      (default: parent of this file)
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PERF_HOME = path.resolve(process.env.PERF_HOME || path.join(__dirname, '..'));
const ADDR = process.env.PORTAL_ADDR || '127.0.0.1';
const PORT = Number(process.env.PORTAL_PORT || 8090);
const TOKEN = process.env.PORTAL_TOKEN || '';

// Profile tiers (DESIGN.md §3.2). LOCKED profiles are read-only in the portal.
const MEASUREMENT = new Set(['mix-ladder', 'stress', 'spike']);
const LOCKED = new Set(['mix-ref']); // + future 1x/2x acceptance profiles

// runId file map: API name -> [filename, content-type]
const RUN_FILES = {
  summary:  ['summary.json',  'application/json'],
  text:     ['summary.txt',   'text/plain; charset=utf-8'],
  report:   ['report.html',   'text/html; charset=utf-8'],
  manifest: ['manifest.txt',  'text/plain; charset=utf-8'],
  log:      ['k6.log',        'text/plain; charset=utf-8'],
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // runId: no slashes, no leading dot

/* ── helpers ─────────────────────────────────────────────── */
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/* ── /api/catalog ────────────────────────────────────────── */
function catalog() {
  const js = (dir) => listDir(path.join(PERF_HOME, dir))
    .filter((f) => f.endsWith('.js') && !f.startsWith('_')).map((f) => f.slice(0, -3));
  const scenarios = [...js('src/mixed'), ...js('src/scenarios')];
  const envs = listDir(path.join(PERF_HOME, 'config/environments'))
    .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const profiles = listDir(path.join(PERF_HOME, 'profiles'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = readJson(path.join(PERF_HOME, 'profiles', f));
      if (!p) return null;
      const name = f.slice(0, -5);
      const scenario = {};
      for (const [k, v] of Object.entries(p.scenario || {})) if (!k.startsWith('_')) scenario[k] = v;
      return {
        name,
        description: p.description || '',
        apiSla: p.apiSla !== false,
        kind: MEASUREMENT.has(name) ? 'measurement' : 'judgment',
        locked: LOCKED.has(name),
        scenario,
      };
    })
    .filter(Boolean);
  return { scenarios, envs, profiles };
}

/* ── /api/rounds ─────────────────────────────────────────── */
function grafanaLink(runDir) {
  try {
    const fd = fs.openSync(path.join(runDir, 'manifest.txt'), 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/^grafana:\s*(\S+)/m);
    return m && m[1] !== '<none>' ? m[1] : null;
  } catch { return null; }
}

function rounds(envFilter, limit) {
  const resultsDir = path.join(PERF_HOME, 'results');
  const days = listDir(resultsDir).filter((d) => /^\d{8}$/.test(d)).sort().reverse();
  const out = [];
  for (const day of days) {
    const dayDir = path.join(resultsDir, day);
    const ids = listDir(dayDir).filter((d) => ID_RE.test(d)).sort().reverse();
    for (const id of ids) {
      // runId = scenario_env_profile_YYYYMMDD-HHMMSS (fields themselves never contain '_')
      const parts = id.split('_');
      const [scenario, env, profile, ts] = parts.length === 4 ? parts : [id, '', '', ''];
      if (envFilter && env !== envFilter) continue;
      const runDir = path.join(dayDir, id);
      const s = readJson(path.join(runDir, 'summary.json'));
      const started = /^\d{8}-\d{6}$/.test(ts)
        ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`
        : '';
      out.push({
        id, scenario, env, profile, started,
        running: !s,
        verdict: s ? s.verdict : 'RUN',
        err: s ? [s.errTechnical || 0, s.errBusiness || 0, s.errScript || 0] : null,
        requests: s ? s.requests : null,
        rps: s ? s.rps : null,
        grafana: grafanaLink(runDir),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function findRunDir(id) {
  if (!ID_RE.test(id)) return null;
  const resultsDir = path.join(PERF_HOME, 'results');
  const ts = id.split('_')[3] || '';
  const guess = path.join(resultsDir, ts.slice(0, 8), id);
  if (fs.existsSync(guess)) return guess;
  for (const day of listDir(resultsDir)) {           // fallback: scan day dirs
    const p = path.join(resultsDir, day, id);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ── /api/health ─────────────────────────────────────────── */
function health() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('framework', fs.existsSync(path.join(PERF_HOME, 'run.sh')), PERF_HOME);

  const k6OnPath = (process.env.PATH || '').split(path.delimiter)
    .some((d) => { try { fs.accessSync(path.join(d, 'k6'), fs.constants.X_OK); return true; } catch { return false; } });
  add('k6 shim', k6OnPath, k6OnPath ? 'k6 found on PATH' : 'no k6 on PATH — install the podman shim');

  const img = process.env.K6_IMAGE || '';
  add('K6_IMAGE', !!img, img ? img.split('/').pop() : 'not set');

  let podman = false, pv = 'not found';
  try { pv = execFileSync('podman', ['--version'], { timeout: 2500 }).toString().trim(); podman = true; } catch {}
  add('podman', podman, pv);

  let disk = 'n/a', diskOk = true;
  try {
    const st = fs.statfsSync(PERF_HOME);
    const freePct = Math.round((st.bavail / st.blocks) * 100);
    disk = `${freePct}% free`; diskOk = freePct > 10;
  } catch {}
  add('disk', diskOk, disk);

  return { ok: checks.every((c) => c.ok), checks, utc: new Date().toISOString() };
}

/* ── router ──────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/') && TOKEN && req.headers['x-auth-token'] !== TOKEN)
    return json(res, 401, { error: 'X-Auth-Token required' });
  if (req.method !== 'GET') return json(res, 405, { error: 'P0 is read-only' });

  try {
    if (p === '/' ) return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    if (p === '/api/catalog') return json(res, 200, catalog());
    if (p === '/api/health')  return json(res, 200, health());
    if (p === '/api/rounds')
      return json(res, 200, rounds(url.searchParams.get('env') || '', Number(url.searchParams.get('limit') || 100)));

    const m = p.match(/^\/api\/rounds\/([^/]+)\/([a-z]+)$/);
    if (m && RUN_FILES[m[2]]) {
      const dir = findRunDir(m[1]);
      const [file, type] = RUN_FILES[m[2]];
      if (!dir || !fs.existsSync(path.join(dir, file))) return json(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(path.join(dir, file)), type);
    }
    return json(res, 404, { error: 'unknown route' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, ADDR, () =>
  console.log(`k6-pt console (P0 read-only) on http://${ADDR}:${PORT}  PERF_HOME=${PERF_HOME}${TOKEN ? '  [token auth on]' : ''}`));
