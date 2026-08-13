#!/usr/bin/env bash
#
# seed-harvest.sh <run_dir> <scenario> — post-run hook for seed producers (prep.sh calls
# this after every seed round it executes): collect the SEEDID lines from k6.log into a
# pool file and auto-activate it over the producer's target under data/.
#
# Auto-activation is safe by construction: the target is derived from the producer name, a
# zero harvest never activates, the replaced pool is a consumed (dirty) one per the
# single-use discipline, and the consuming side's preflight still gates volume. The replaced
# file is archived beside the run for rollback. Opt out with SEED_AUTO_ACTIVATE=false.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUN_DIR="${1:?usage: seed-harvest.sh <run_dir> <scenario>}"
SCENARIO="${2:?usage: seed-harvest.sh <run_dir> <scenario>}"
[[ -f "$RUN_DIR/k6.log" ]] || exit 0

POOL_FILE="$RUN_DIR/seed-pool.json"
# Producer → pool-file mapping keeps the activation hint copy-pasteable;
# an unmapped future producer falls back to the generic hint
case "$SCENARIO" in
  seed-update-pool)      POOL_TARGET="data/worker-svc/trade/update-ids.json" ;;
  seed-approve-pool)     POOL_TARGET="data/worker-svc/trade/approve-tasks.json" ;;
  seed-event-pool)       POOL_TARGET="data/worker-svc/trade/event-ids.json" ;;
  seed-amend-cycle-pool) POOL_TARGET="data/worker-svc/trade/amend-cycle-ids.json" ;;
  *)                     POOL_TARGET="" ;;
esac
{
  echo '{'
  echo "  \"_comment\": \"Harvested by seed-harvest.sh (${SCENARIO}) from SEEDID lines. Activate: cp this file over ${POOL_TARGET:-the matching pool file under data/worker-svc/trade/}. Consumable pools are single-use (re-seed per round); the amend-cycle pool is permanent (reject restores every id).\","
  echo '  "ids": ['
  sed -n 's/.*SEEDID \([A-Za-z0-9-]\{1,\}\).*/    "\1",/p' "$RUN_DIR/k6.log" | sed '$ s/,$//'
  echo '  ]'
  echo '}'
} > "$POOL_FILE"
SEED_N=$(sed -n 's/.*SEEDID .*/x/p' "$RUN_DIR/k6.log" | wc -l | tr -d ' ')
echo "seed pool: $POOL_FILE   ← $SEED_N ids harvested"
if [[ "$SEED_N" == 0 ]]; then
  echo "  ⚠ 0 ids harvested — nothing activated; check k6.log for why the pipeline produced nothing"
elif [[ -n "$POOL_TARGET" && "${SEED_AUTO_ACTIVATE:-true}" != "false" ]]; then
  [[ -f "$POOL_TARGET" ]] && cp "$POOL_TARGET" "$RUN_DIR/replaced-pool.json"
  cp "$POOL_FILE" "$POOL_TARGET"
  echo "  activated: $SEED_N ids → $POOL_TARGET"
  [[ -f "$RUN_DIR/replaced-pool.json" ]] && echo "  rollback:  cp $RUN_DIR/replaced-pool.json $POOL_TARGET   (previous pool, archived)"
  # Refresh the reusable read pool alongside: seed-update-pool's harvest is LIVE trades —
  # legitimate detail targets. Deliberately unconditional (team decision 2026-08-10): one seed
  # session refreshes everything together. When the standing-data waterline matures, a
  # GET-based collector over real standing trades becomes the formal source and this retires.
  TRADE_IDS_FILE="data/worker-svc/trade/trade-ids.json"
  if [[ "$SCENARIO" == "seed-update-pool" ]]; then
    [[ -f "$TRADE_IDS_FILE" ]] && cp "$TRADE_IDS_FILE" "$RUN_DIR/replaced-trade-ids.json"
    cp "$POOL_FILE" "$TRADE_IDS_FILE"
    echo "  refreshed:  $TRADE_IDS_FILE (reusable read pool, same harvest; previous archived: $RUN_DIR/replaced-trade-ids.json)"
  fi
elif [[ -n "$POOL_TARGET" ]]; then
  echo "  activate: cp $POOL_FILE $POOL_TARGET   (auto-activation disabled by SEED_AUTO_ACTIVATE=false)"
else
  echo "  activate: cp $POOL_FILE data/worker-svc/trade/<matching-pool>.json"
fi
