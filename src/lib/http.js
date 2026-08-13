import k6http from 'k6/http';
import { b64encode } from 'k6/encoding';
import { baseUrl } from './config.js';

// Unified HTTP pipeline: the single exit point for all API calls, responsible only for
// "getting the request out the door" — baseUrl resolution, default request headers,
// low-cardinality metric tags. Response classification is the api layer's contract duty
// (lib/errors.js), so this returns {res, tags} for the caller to feed into the classification
// engine.
// opts: { name (required, metric tag), module, user, params (query object), headers,
//         tags (additional low-cardinality tags) }

/*
 * ── HTTP_CAPTURE=1: readable per-request JSON capture (contract-work tool) ──────────────
 * k6's native --http-debug prints Go wire dumps — escaped one-line JSON, raw multipart with
 * dat binaries — unusable for contract calibration. This mode emits one structured entry per
 * request (method/url/status/duration/headers/bodies, JSON bodies parsed back into objects,
 * binary file parts replaced with a placeholder) as an 'HTTPCAP <base64>' console line;
 * run.sh decodes them into <run dir>/http-capture.jsonl. base64 is the transport because
 * k6's logfmt would escape every quote inside msg="..." and corrupt naive extraction.
 * SMOKE-CALIBER ONLY: per-request logging at load volume distorts the measurement and the
 * captured file carries REAL business payloads — delete after use (K6_HTTP_DEBUG discipline).
 */
const CAPTURE = !!__ENV.HTTP_CAPTURE;

function jsonish(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return '<empty>';
  try { return JSON.parse(v); } catch (e) { /* not JSON — fall through */ }
  return v.length > 2000 ? v.slice(0, 2000) + '...<truncated>' : v;
}

function captureBody(body) {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return jsonish(body);
  // Multipart form object: http.file() parts carry {data, filename, content_type} — keep the
  // field structure, never the binary
  const out = {};
  for (const k of Object.keys(body)) {
    const v = body[k];
    out[k] = v && typeof v === 'object' && v.data !== undefined
      ? `<binary file: ${v.filename || k}>`
      : jsonish(v);
  }
  return out;
}

function capture(method, url, params, body, res) {
  const entry = {
    name: params.tags.name,
    method,
    url,
    status: res.status,
    durationMs: res.timings ? res.timings.duration : undefined,
    requestHeaders: params.headers,
    requestBody: captureBody(body),
    responseBody: jsonish(res.body),
  };
  console.log('HTTPCAP ' + b64encode(JSON.stringify(entry), 'std'));
}

function request(method, cfg, service, path, body, opts) {
  if (!opts || !opts.name) throw new Error('http: opts.name tag is required');
  const entries = opts.params ? Object.entries(opts.params) : [];
  const qs = entries.length
    ? '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  // Single gateway endpoint for every service; `service` is attribution-only from here on
  const url = baseUrl(cfg) + path + qs;
  const params = {
    headers: Object.assign(
      { Accept: 'application/json' },
      opts.user ? { 'X-User-Id': opts.user } : {},
      opts.headers || {},
    ),
    tags: Object.assign(
      { name: opts.name, service, module: opts.module || 'default' },
      opts.tags || {},
    ),
  };
  const res = method === 'GET' ? k6http.get(url, params) : k6http.post(url, body, params);
  if (CAPTURE) capture(method, url, params, body, res);
  return { res, tags: params.tags };
}

export function get(cfg, service, path, opts) {
  return request('GET', cfg, service, path, null, opts);
}

export function postJson(cfg, service, path, body, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, JSON.stringify(body), o);
}

export function postEmpty(cfg, service, path, opts) {
  // Empty-body POST (checker task actions take no payload — calibrated curl sends -d '').
  // Content-Type still json to mirror the captured request exactly.
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, '', o);
}

export function postMultipart(cfg, service, path, formData, opts) {
  // An object body containing http.file() is multipart-encoded by k6 automatically, boundary
  // included; never hand-write Content-Type — a hand-written value has no boundary and would
  // override the generated one, leaving the server unable to split the parts
  return request('POST', cfg, service, path, formData, opts);
}
