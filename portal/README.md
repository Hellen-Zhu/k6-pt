# portal — k6-pt console

P0 (read-only): rounds browser + health + CLI command composer.

```
node portal/server.js          # then open http://127.0.0.1:8090
```

Env: `PORTAL_ADDR` / `PORTAL_PORT` / `PORTAL_TOKEN` (enables X-Auth-Token) / `PERF_HOME`.
Runtime: Node >= 18, standard library only. Design & contracts: DESIGN.md.
