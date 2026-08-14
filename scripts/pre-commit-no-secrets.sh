#!/bin/sh
#
# Refuses to commit private-environment identifiers into this PUBLIC repo.
#
# Why this exists: API captures and env configs are exactly the files that tend to carry a real
# hostname, a real user email or a real counterparty value out of a private environment. The repo's
# standing red line (config/environments/dev.json, data/trade/event-cases.json) is that
# SHAPES live here and real VALUES live only in the private copy — this hook enforces it.
#
# The rules below are deliberately GENERIC (allow-list based). Site-specific literals must never
# be written into this file: a deny-list naming the real host would itself publish the host. Put
# those in an untracked local file instead, one extended-regex per line:
#     $(git rev-parse --git-common-dir)/no-secrets.local
#
# Install (once per clone; covers all linked worktrees):
#   printf '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/scripts/pre-commit-no-secrets.sh"\n' \
#     > "$(git rev-parse --git-path hooks)/pre-commit" && chmod +x "$_"
#
# Bypass only when you are certain the match is a false positive:
#   git commit --no-verify
#
set -u

# Both `git diff --name-only` and git grep's pathspec resolve against the CURRENT directory, so a
# commit made from a subdirectory would otherwise scan the wrong paths and silently pass.
cd "$(git rev-parse --show-toplevel)" || exit 0

files=$(git diff --cached --name-only --diff-filter=ACMR | grep -v '^scripts/pre-commit-no-secrets\.sh$')
[ -z "$files" ] && exit 0

# Approved placeholders — everything else of the same shape is treated as a real value.
OK_MAIL='@example\.(com|org|net)'
OK_HOST='://(localhost|127\.0\.0\.1|<[A-Za-z_]+>|github\.com|raw\.githubusercontent\.com|k6\.io|grafana\.com|prometheus\.io)'

# git grep exit codes: 0 = match, 1 = clean, >1 = the scan itself failed. Fail CLOSED on >1 —
# a guard that silently passes when it cannot run is worse than no guard.
scan() { # scan <extended-regex>; prints matches, dies on scanner error
  out=$(git grep --cached -nIoE "$1" -- $files)
  rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "✗ commit blocked — the secret scan could not run (git grep exit $rc)" >&2
    exit 1
  fi
  printf '%s' "$out"
}

hits=$(scan '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | grep -vE "$OK_MAIL")
hits="$hits
$(scan 'https?://[A-Za-z0-9._<>-]+' | grep -vE "$OK_HOST")"

# Optional site-specific literals, kept OUT of the repo on purpose
LOCAL="$(git rev-parse --git-common-dir)/no-secrets.local"
if [ -f "$LOCAL" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    hits="$hits
$(scan "$pat")"
  done < "$LOCAL"
fi

hits=$(printf '%s' "$hits" | grep -v '^$')
[ -z "$hits" ] && exit 0

cat >&2 <<EOF

✗ commit blocked — real values found in staged content:

$hits

This repository is PUBLIC. Use the placeholders the repo already uses:
  hostname     -> <GATEWAY_BASE>   (or localhost, as in config/environments/dev.json)
  user email   -> maker01@example.com / checker1@example.com
  portfolio    -> PERF-PF-A
  counterparty -> 10000001 / "PERF CP A"

Then re-stage and commit. If this is a false positive: git commit --no-verify
EOF
exit 1
