#!/bin/bash
# EXT-OIDC local stack (real Zitadel Cloud). Usage: stack.sh up|down|status|outage-on|outage-off|sessions|expire-sessions|log-check|purge|probes
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WT="$(cd -- "$HERE/../.." && pwd -P)"
export PATH="$HOME/.local/share/fnm/node-versions/v24.12.0/installation/bin:$PATH"
cd "$WT"
if [ "${1:-}" = "probes" ]; then
  out="$WT/verification-logs/ext-oidc/probes-$(date -u +%Y%m%dT%H%M%SZ).log"
  mkdir -p "$(dirname "$out")"
  {
    date -u
    node "$HERE/probe-provider.mjs"
    node "$HERE/probe-login.mjs"
    node "$HERE/probe-negative.mjs"
    node "$HERE/probe-client.mjs"
    node --import tsx "$HERE/stack.mts" log-check
  } > "$out" 2>&1
  echo "probe log: $out"
  exit 0
fi
exec node --import tsx "$HERE/stack.mts" "$@"
