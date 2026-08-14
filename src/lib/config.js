// Pure config parsing and whitelist validation. File reading happens in the scenario script's
// init phase (k6 open()); this module handles text only — so it can be loaded by both k6 and Node.
// Note: the k6 runtime has no WHATWG URL, so hostnames are parsed with string operations.
function hostOf(url) {
  return url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
}

export function assertWhitelisted(url, whitelist, label = url) {
  const host = hostOf(url);
  const ok = whitelist.some((w) => host === w || host.endsWith(`.${w}`));
  if (!ok) throw new Error(`target not whitelisted: ${label} -> ${host}`);
}

export function parseEnvConfig(rawText) {
  const cfg = JSON.parse(rawText);
  for (const key of ['name', 'whitelist', 'promRwUrl', 'gatewayUrl', 'users']) {
    if (!(key in cfg)) throw new Error(`config missing field: ${key}`);
  }
  assertWhitelisted(cfg.gatewayUrl, cfg.whitelist, 'gatewayUrl');
  return cfg;
}

/*
 * Every API goes through the ONE gateway endpoint (2026-08-12 decision — the per-service URL
 * map is gone; 2026-08-14: the service dimension is retired everywhere — directories, tags,
 * client signatures. module is the sole attribution layer below the endpoint name.
 */
export function baseUrl(cfg) {
  return cfg.gatewayUrl;
}
