#!/usr/bin/env bash
# Haalt de live dataset (current release) naar webapp/public, voor lokaal
# ontwikkelen tegen de echte data. Overschrijft de lokale bestanden.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

worker="$(require_container worker)"
ssh "$HOST" docker exec "$worker" sh -c "'cd /srv/inlever/site/current && tar czf - .'" \
  | tar xzf - -C "$REPO_ROOT/webapp/public"
echo "webapp/public bijgewerkt vanaf $worker"
