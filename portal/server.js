#!/usr/bin/env node
/*
 * k6-pt console backend — P1: read APIs + the launch trigger.
 * Runtime: Node >= 18, STANDARD LIBRARY ONLY. This is Node-JS, not k6-JS — never
 * import framework code (contract, DESIGN.md §1): spawn run.sh/prep.sh,
 * read results/, list catalog directories. Nothing else.
 *
 * Run:   node portal/server.js            then open http://127.0.0.1:8090
 * Env:   PORTAL_ADDR  bind address        (default 127.0.0.1)
 *        PORTAL_PORT  port                (default 8090)
 *        PORTAL_TOKEN when set, /api/* requires header X-Auth-Token
 *        PERF_HOME    framework root      (default: parent of this file)
 *
 * Launch semantics: POST /api/rounds validates against the whitelists, takes the
 * per-env lock (shared-env discipline: one round per env), then spawns run.sh
 * detached — a portal restart never kills a running round; the lock self-heals
 * via a pid liveness check. Every trigger appends a runs.jsonl audit line.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

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

// Override whitelists (DESIGN.md §3.1 guardrail #1). Scalars are always allowed on
// non-locked profiles; shape keys only on measurement profiles that carry a shape block.
const SCALAR_OVR = { RATE: /^\d{1,6}$/, DURATION: /^\d{1,4}(h|m|s)$/, VUS: /^\d{1,5}$/, MAX_VUS: /^\d{1,5}$/ };
const SHAPE_OVR = { LADDER: /^\d{1,6}(,\d{1,6}){0,19}$/, RAMP: /^\d{1,4}(h|m|s)$/, PLATEAU: /^\d{1,4}(h|m|s)$/ };

const LOCK_DIR = path.join(__dirname, '.locks');
const LOG_DIR = path.join(__dirname, 'logs');
const AUDIT_FILE = path.join(__dirname, 'runs.jsonl');

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
      const shape = {};
      for (const [k, v] of Object.entries(p.shape || {})) if (!k.startsWith('_')) shape[k] = v;
      return {
        name,
        description: p.description || '',
        apiSla: p.apiSla !== false,
        kind: MEASUREMENT.has(name) ? 'measurement' : 'judgment',
        locked: LOCKED.has(name),
        scenario,
        shape: p.shape ? shape : null,
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

// Two-phase listing: first a cheap name-only scan of every run dir (filter + global
// time sort need the full set), then summary/manifest reads for the requested page only.
function listRounds(envFilter, q) {
  const resultsDir = path.join(PERF_HOME, 'results');
  const all = [];
  for (const day of listDir(resultsDir).filter((d) => /^\d{8}$/.test(d))) {
    for (const id of listDir(path.join(resultsDir, day))) {
      if (!ID_RE.test(id)) continue;
      // runId = scenario_env_profile_YYYYMMDD-HHMMSS (fields themselves never contain '_')
      const parts = id.split('_');
      const [scenario, env, profile, ts] = parts.length === 4 ? parts : [id, '', '', ''];
      if (envFilter && env !== envFilter) continue;
      if (q && !id.toLowerCase().includes(q)) continue;
      all.push({ id, day, scenario, env, profile, ts });
    }
  }
  all.sort((a, b) => (b.ts || b.id).localeCompare(a.ts || a.id)); // newest first
  return all;
}

function rounds(envFilter, q, offset, limit) {
  const all = listRounds(envFilter, (q || '').toLowerCase());
  const page = all.slice(offset, offset + limit).map((r) => {
    const runDir = path.join(PERF_HOME, 'results', r.day, r.id);
    const s = readJson(path.join(runDir, 'summary.json'));
    const started = /^\d{8}-\d{6}$/.test(r.ts)
      ? `${r.ts.slice(0, 4)}-${r.ts.slice(4, 6)}-${r.ts.slice(6, 8)} ${r.ts.slice(9, 11)}:${r.ts.slice(11, 13)}:${r.ts.slice(13, 15)}`
      : '';
    return {
      id: r.id, scenario: r.scenario, env: r.env, profile: r.profile, started,
      running: !s,
      verdict: s ? s.verdict : 'RUN',
      variant: s ? !!s.variant : false,
      err: s ? [s.errTechnical || 0, s.errBusiness || 0, s.errScript || 0] : null,
      requests: s ? s.requests : null,
      rps: s ? s.rps : null,
      grafana: grafanaLink(runDir),
    };
  });
  return { total: all.length, offset, limit, rounds: page };
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
// Executor capability = framework + a k6 on PATH (bare binary or podman shim).
// Boxes without it (e.g. the Windows dev loop) still serve everything read-only —
// the frontend renders "viewer mode" and launch() refuses with a clear error
// instead of a 202 that dies silently.
function hasK6() {
  const names = process.platform === 'win32' ? ['k6.exe', 'k6.cmd', 'k6'] : ['k6'];
  return (process.env.PATH || '').split(path.delimiter).some((d) =>
    names.some((n) => { try { fs.accessSync(path.join(d, n), fs.constants.X_OK); return true; } catch { return false; } }));
}

function health() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('framework', fs.existsSync(path.join(PERF_HOME, 'run.sh')), PERF_HOME);

  const k6OnPath = hasK6();
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

  return {
    ok: checks.every((c) => c.ok),
    capable: fs.existsSync(path.join(PERF_HOME, 'run.sh')) && k6OnPath,
    checks,
    utc: new Date().toISOString(),
  };
}

/* ── env lock (one round per env — shared-environment discipline) ── */
function lockInfo(env) {
  try { return JSON.parse(fs.readFileSync(path.join(LOCK_DIR, env + '.lock'), 'utf8')); } catch { return null; }
}
function lockAlive(info) {
  if (!info || !info.pid) return false;
  try { process.kill(info.pid, 0); return true; } catch { return false; }
}
function acquireLock(env, meta) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const f = path.join(LOCK_DIR, env + '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(f, 'wx');           // atomic create — the mutex
      fs.writeSync(fd, JSON.stringify(meta)); fs.closeSync(fd);
      return true;
    } catch {
      if (lockAlive(lockInfo(env))) return false; // held by a live run
      try { fs.unlinkSync(f); } catch {}          // stale (dead pid) — break and retry
    }
  }
  return false;
}
function releaseLock(env) { try { fs.unlinkSync(path.join(LOCK_DIR, env + '.lock')); } catch {} }
function audit(entry) { try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n'); } catch {} }

/* ── POST /api/rounds — validate, lock, spawn run.sh detached ── */
function launch(req, res, body) {
  const { scenario, env, profile } = body;
  const overrides = body.overrides || {};
  const cat = catalog();
  if (!cat.scenarios.includes(scenario)) return json(res, 400, { error: `unknown scenario: ${scenario}` });
  if (!cat.envs.includes(env)) return json(res, 400, { error: `unknown env: ${env}` });
  const prof = cat.profiles.find((x) => x.name === profile);
  if (!prof) return json(res, 400, { error: `unknown profile: ${profile}` });
  if (!hasK6())
    return json(res, 400, { error: 'this host cannot execute rounds — no k6 on PATH (viewer mode); launch on the injector' });
  if (prof.locked && Object.keys(overrides).length)
    return json(res, 400, { error: 'locked profile accepts no overrides — its parameters are part of the conclusion' });

  const args = [];
  for (const [k, v] of Object.entries(overrides)) {
    const rule = SCALAR_OVR[k] || (prof.kind === 'measurement' && prof.shape ? SHAPE_OVR[k] : undefined);
    if (!rule) return json(res, 400, { error: `override not allowed here: ${k}` });
    if (!rule.test(String(v))) return json(res, 400, { error: `bad value for ${k}: ${v}` });
    args.push(`${k}=${v}`);
  }

  const who = String(req.headers['x-user'] || req.socket.remoteAddress || 'unknown');
  const meta = { env, scenario, profile, overrides, who, startedUtc: new Date().toISOString() };
  if (!acquireLock(env, meta))
    return json(res, 409, { error: `${env} is locked — round in progress`, lock: lockInfo(env) });

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = meta.startedUtc.replace(/[-:T]/g, '').slice(0, 14);
  const logFile = path.join(LOG_DIR, `${ts}_${scenario}_${env}_${profile}.log`);
  let child;
  try {
    const out = fs.openSync(logFile, 'a');
    // Invoke run.sh through bash explicitly rather than via its shebang: identical on
    // Linux/macOS, and it is what makes the Windows dev loop work (Git Bash provides
    // bash.exe; Windows cannot exec .sh files directly — spawn EFTYPE). Same doctrine
    // as the framework README: "Windows runs the same scripts via Git Bash".
    child = spawn('bash', ['run.sh', scenario, env, profile, ...args],
      { cwd: PERF_HOME, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
  } catch (e) {
    releaseLock(env);
    return json(res, 500, { error: String(e.message || e) });
  }
  meta.pid = child.pid;
  try { fs.writeFileSync(path.join(LOCK_DIR, env + '.lock'), JSON.stringify(meta)); } catch {}
  child.unref();
  child.on('exit', (code) => {
    releaseLock(env);
    audit({ ...meta, event: 'finished', exitCode: code, endedUtc: new Date().toISOString() });
  });
  child.on('error', () => releaseLock(env));
  audit({ ...meta, event: 'started' });
  return json(res, 202, { started: true, pid: child.pid, log: path.basename(logFile) });
}

function readBody(req, cb) {
  let buf = '';
  req.on('data', (c) => { buf += c; if (buf.length > 16384) { req.destroy(); } });
  req.on('end', () => { try { cb(null, JSON.parse(buf || '{}')); } catch { cb(new Error('bad JSON')); } });
}

/* ── router ──────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/') && TOKEN && req.headers['x-auth-token'] !== TOKEN)
    return json(res, 401, { error: 'X-Auth-Token required' });
  if (req.method === 'POST') {
    if (p !== '/api/rounds') return json(res, 405, { error: 'unknown POST route' });
    return readBody(req, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try { launch(req, res, body); } catch (e) { json(res, 500, { error: String(e.message || e) }); }
    });
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  try {
    if (p === '/' ) return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    if (p === '/api/catalog') return json(res, 200, catalog());
    if (p === '/api/health')  return json(res, 200, health());
    if (p === '/api/locks') {
      const out = {};
      for (const e of catalog().envs) { const i = lockInfo(e); out[e] = lockAlive(i) ? i : null; }
      return json(res, 200, out);
    }
    if (p === '/api/rounds')
      return json(res, 200, rounds(
        url.searchParams.get('env') || '',
        url.searchParams.get('q') || '',
        Math.max(0, Number(url.searchParams.get('offset') || 0) || 0),
        Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20) || 20)),
      ));

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
  console.log(`k6-pt console (P1) on http://${ADDR}:${PORT}  PERF_HOME=${PERF_HOME}${TOKEN ? '  [token auth on]' : ''}`));
