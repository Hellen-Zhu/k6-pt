#!/usr/bin/env bash
# k6 -> podman shim: makes a pinned k6 container image behave like a local k6
# binary, so run.sh / prep.sh stay container-agnostic (they only require "a k6
# executable on PATH"). Not dispatched by run.sh/prep.sh — this file is DEPLOYED
# to the load generator, it is never executed from the repo checkout:
#
#   cp scripts/k6-podman-shim.sh ~/bin/k6 && chmod +x ~/bin/k6
#   echo 'export K6_IMAGE=docker.io/grafana/k6:<validated-version>' >> ~/.bashrc
#   # ~/bin must precede any other k6 on PATH; verify with: which k6 && k6 version
#
# K6_IMAGE is required on purpose (no default): an implicit :latest would let
# the k6 version drift between rounds and silently break baseline comparability.
#
# Flag rationale (RHEL / rootless podman / load-generator specifics):
#   --network host        rootless user-mode networking adds generator-side
#                         throughput loss and latency jitter; host networking
#                         also keeps target/Prometheus reachability identical
#                         to a bare binary
#   -v "$PWD:$PWD" -w …   same-path mount: relative and absolute paths resolve
#                         identically on both sides, results land where run.sh
#                         expects; :Z relabels for SELinux enforcing
#   --userns=keep-id
#   --user uid:gid        the official image defaults to its own "k6" user,
#                         which rootless podman would map to a subuid — output
#                         files would not be owned by the invoking user
#   --ulimit nofile       hundreds of VUs hold hundreds of sockets; the
#                         container default (like the host default) is too low
#   -e TZ -e 'K6_*'       run.sh exports TZ=UTC and k6 honors K6_* env config
#                         (web dashboard, Prometheus RW, TLS-verify toggle…);
#                         wildcard env passthrough is podman-only
IMAGE="${K6_IMAGE:?set K6_IMAGE to the pinned k6 image tag, e.g. docker.io/grafana/k6:<version>}"

exec podman run --rm -i \
  --network host \
  --userns=keep-id --user "$(id -u):$(id -g)" \
  --ulimit nofile=65536:65536 \
  -e TZ -e 'K6_*' \
  -v "$PWD:$PWD:Z" -w "$PWD" \
  "$IMAGE" "$@"
