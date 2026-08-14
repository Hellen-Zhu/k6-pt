#!/usr/bin/env bash
#
# prep.sh — DATA PREPARATION, the counterpart command to ./run.sh (which only runs tests
# and reports). Everything pool-related lives here: computing a round's demand, running
# the seed producers (its own k6 invocation — seed rounds are logistics, not measurement:
# no Prometheus export, no web dashboard), harvesting + activating the pools, and
# verifying the activated volume.
#
#   ./prep.sh <measurement-scenario> [env] [profile] [KEY=value ...]
#       Size and seed every pool the scenario × profile needs. The demand numbers come
#       from the scenario ITSELF (PLAN=1 dry-run prints POOLPLAN lines and aborts before
#       any request) — ratio rounding and ladder integration included, so no pool math is
#       ever duplicated in bash.
#
#   ./prep.sh <seed-producer> [env] ITERATIONS=<n>
#       Run ONE producer directly (manual re-seed: a poisoned cycle pool, a custom-sized
#       consumable pool, a trade-ids refresh). Harvest + activation included.
#
# prep and the measurement stay two separate commands on purpose: seeding burns
# shared-environment rate-limit budget and must be an explicit decision — everything
# AFTER that decision is automated.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# UTC for the same reason as run.sh: seed run dirs/logs reconcile against server logs
export TZ=UTC

[[ $# -lt 1 ]] && { echo "Usage: ./prep.sh <scenario|seed-producer> [env] [profile] [KEY=value ...]" >&2; exit 2; }
SCENARIO="${1%.js}"; shift
ENV_NAME="local" PROFILE="smoke" POS=0
RAW_OVERRIDES=()
for a in "$@"; do
  if [[ "$a" == *=* ]]; then
    RAW_OVERRIDES+=("$a")
  else
    POS=$((POS + 1))
    if [[ "$POS" == 1 ]]; then ENV_NAME="$a"; else PROFILE="$a"; fi
  fi
done
OVERRIDE_ARGS=()
for o in ${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}; do
  [[ "$o" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || { echo "ERROR: malformed override: '$o' (expected KEY=value)" >&2; exit 1; }
  OVERRIDE_ARGS+=(-e "$o")
done
[[ -f "config/environments/${ENV_NAME}.json" ]] || { echo "ERROR: environment not found: ${ENV_NAME}" >&2; exit 2; }
command -v k6 >/dev/null 2>&1 || { echo "ERROR: k6 not in PATH" >&2; exit 1; }

# ── Seed execution: prep's own k6 invocation (run.sh knows nothing about seeding) ──
# The k6 exit code is deliberately ignored — the activated-volume check below is the real
# gate (a partially failed seed round with enough harvest is still a usable pool).
seed_run() { # <producer> <iterations>
  local producer="$1" iter="$2"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local run_id="${producer}_${ENV_NAME}_seed_${stamp}"
  local dir="results/${stamp%%-*}/${run_id}"
  mkdir -p "$dir"
  echo "▶ seed     $producer ITERATIONS=$iter → $dir"
  set +e
  k6 run --tag "testid=$run_id" \
    -e ENV="$ENV_NAME" -e PROFILE=seed -e TESTID="$run_id" -e RESULT_DIR="$dir" \
    -e ITERATIONS="$iter" \
    "src/seed/${producer}.js" 2>&1 | tee "$dir/k6.log"
  set -e
  scripts/seed-harvest.sh "$dir" "$producer"
}

# ── Producer mode: ./prep.sh <seed-producer> [env] ITERATIONS=<n> ──
if [[ -f "src/seed/${SCENARIO}.js" ]]; then
  ITER=""
  for o in ${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}; do
    [[ "$o" == ITERATIONS=* ]] && ITER="${o#ITERATIONS=}"
  done
  [[ -n "$ITER" ]] || { echo "ERROR: producer mode needs an explicit size: ./prep.sh ${SCENARIO} ${ENV_NAME} ITERATIONS=<n>" >&2; exit 2; }
  seed_run "$SCENARIO" "$ITER"
  exit 0
fi

# ── Scenario mode: PLAN dry-run → demand table → seed each pool → verify ──
[[ -f "profiles/${PROFILE}.json" ]] || { echo "ERROR: profile not found: ${PROFILE}" >&2; exit 2; }

producer_for() {
  case "$1" in
    update-ids)      echo "seed-update-pool" ;;
    approve-tasks)   echo "seed-approve-pool" ;;
    event-ids)       echo "seed-event-pool" ;;
    amend-cycle-ids) echo "seed-amend-cycle-pool" ;;
    *)               echo "" ;;
  esac
}
case "$SCENARIO" in
  trade-mix-book|trade-mix-amend|trade-mix-full|trades-update|checker-approve|trades-trigger-event) ;;
  *) echo "prep: $SCENARIO consumes no seeded pools — nothing to do"; exit 0 ;;
esac
SCENARIO_FILE=""
for dir in src/scenarios src/mixed; do
  [[ -f "$dir/${SCENARIO}.js" ]] && { SCENARIO_FILE="$dir/${SCENARIO}.js"; break; }
done
[[ -n "$SCENARIO_FILE" ]] || { echo "ERROR: scenario not found: ${SCENARIO}" >&2; exit 2; }

PLAN_LOG="$(mktemp "${TMPDIR:-/tmp}/prep-plan.XXXXXX")"
echo "▶ prep     computing pool demand: $SCENARIO × $PROFILE ${RAW_OVERRIDES[*]:-}"
k6 run --quiet --log-output "file=$PLAN_LOG" \
  -e ENV="$ENV_NAME" -e PROFILE="$PROFILE" -e PLAN=1 \
  ${OVERRIDE_ARGS[@]+"${OVERRIDE_ARGS[@]}"} "$SCENARIO_FILE" >/dev/null 2>&1 || true
PLANS="$(sed -n 's/.*POOLPLAN \([a-z-]\{1,\}\) \([0-9]\{1,\}\).*/\1 \2/p' "$PLAN_LOG")"
rm -f "$PLAN_LOG"
[[ -n "$PLANS" ]] || { echo "ERROR: PLAN dry-run produced no POOLPLAN lines (init failure? see the scenario's setup)" >&2; exit 1; }
if grep -q ' 0$' <<< "$PLANS"; then
  echo "ERROR: this profile reports ZERO planned iterations — closed vus-only profiles (baseline/ladder) have unknowable demand, so prep cannot budget them." >&2
  echo "       Size the pool manually instead: iterations ≈ VUs × duration ÷ response time, then ./prep.sh seed-... ITERATIONS=<n>." >&2
  exit 1
fi

echo "── pool demand (preflight floor = planned × 1.2; seed ITERATIONS = planned × 1.6 for harvest loss) ──"
while read -r pool planned; do
  needed=$(( (planned * 12 + 9) / 10 ))
  iter=$(( (planned * 16 + 9) / 10 )); [[ "$iter" -lt $((needed + 3)) ]] && iter=$((needed + 3))
  printf '  %-16s planned %-7s floor %-7s seed ITERATIONS %s\n' "$pool" "$planned" "$needed" "$iter"
done <<< "$PLANS"

# Read-pool refresh: mixed entries also preflight trade-ids. The refresh is UNCONDITIONAL
# (2026-08-13 decision): non-placeholder content proves nothing — ids from another
# environment or a cleaned DB look valid here and only surface as http-404 mid-round.
# Always seed a fresh batch; skip only when this round's demand already runs
# seed-update-pool, whose harvest refreshes trade-ids anyway (seed-harvest.sh side effect).
TRADE_IDS_FILE="data/worker-svc/trade/trade-ids.json"
case "$SCENARIO" in trade-mix-*)
  if ! grep -q '^update-ids ' <<< "$PLANS"; then
    echo "▶ prep     refreshing the trade-ids read pool — seeding a fresh batch via seed-update-pool ITERATIONS=50"
    seed_run seed-update-pool 50
    grep -q 'TBC-' "$TRADE_IDS_FILE" && { echo "ERROR: trade-ids still holds placeholders after refresh — harvest failed (environment reachable? contract drift?); prep aborted" >&2; exit 1; }
  fi ;;
esac

while read -r pool planned; do
  producer="$(producer_for "$pool")"
  [[ -n "$producer" ]] || { echo "ERROR: no seed producer mapped for pool '$pool'" >&2; exit 1; }
  needed=$(( (planned * 12 + 9) / 10 ))
  iter=$(( (planned * 16 + 9) / 10 )); [[ "$iter" -lt $((needed + 3)) ]] && iter=$((needed + 3))
  echo "▶ prep     seeding $pool via $producer ITERATIONS=$iter"
  seed_run "$producer" "$iter"
  POOL_FILE_PATH="data/worker-svc/trade/${pool}.json"
  if grep -q 'TBC-' "$POOL_FILE_PATH" 2>/dev/null; then
    echo "ERROR: $pool still holds placeholders after seeding — harvest failed (environment reachable? contract drift?); prep aborted" >&2
    exit 1
  fi
  got=$(sed -n 's/^[[:space:]]*"[A-Za-z0-9:-]\{1,\}",\{0,1\}[[:space:]]*$/x/p' "$POOL_FILE_PATH" | wc -l | tr -d ' ')
  if [[ "$got" -lt "$needed" ]]; then
    echo "ERROR: $pool holds $got ids but the round needs >= $needed — harvest loss exceeded the margin; re-run prep or seed manually with a larger ITERATIONS" >&2
    exit 1
  fi
  echo "  ok: $pool holds $got ids (>= $needed)"
done <<< "$PLANS"

echo
echo "✔ pools ready — run the measurement:"
echo "  ./run.sh $SCENARIO $ENV_NAME $PROFILE ${RAW_OVERRIDES[*]:-}"
