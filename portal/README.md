# portal — k6-pt console

P1: rounds browser + health + real launch (`POST /api/rounds` with per-env lock,
whitelisted overrides, runs.jsonl audit). Measurement profiles expose
LADDER/RAMP/PLATEAU shape params; any override marks the round VARIANT
(effective config lands in summary.json; baseline comparison skipped).

```
node portal/server.js          # then open http://127.0.0.1:8090
```

Env: `PORTAL_ADDR` / `PORTAL_PORT` / `PORTAL_TOKEN` (enables X-Auth-Token) / `PERF_HOME`.
Runtime: Node >= 18, standard library only. Design & contracts: DESIGN.md.
Runtime files (gitignored): `.locks/` `logs/` `runs.jsonl`.
