#!/usr/bin/env bash
#
# http-capture.sh <run_dir> — post-run hook (run.sh calls this when HTTP_CAPTURE is set):
# decode the HTTPCAP lines (lib/http.js emits one base64-encoded JSON entry per request)
# from k6.log into a readable JSON-lines file. base64 transport is what keeps the JSON
# intact — k6's logfmt would otherwise escape every quote in msg="...".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUN_DIR="${1:?usage: http-capture.sh <run_dir>}"
[[ -f "$RUN_DIR/k6.log" ]] || exit 0

CAP_FILE="$RUN_DIR/http-capture.jsonl"
: > "$CAP_FILE"
sed -n 's/.*HTTPCAP \([A-Za-z0-9+/=]\{1,\}\).*/\1/p' "$RUN_DIR/k6.log" | while IFS= read -r b64; do
  printf '%s' "$b64" | base64 -d 2>/dev/null && echo
done >> "$CAP_FILE"
CAP_N=$(grep -c . "$CAP_FILE" 2>/dev/null || echo 0)
echo "capture:   $CAP_FILE ← $CAP_N requests as JSON lines (one per line; smoke-caliber tool — carries REAL payloads/responses, delete after use, same discipline as K6_HTTP_DEBUG's k6.log)"
