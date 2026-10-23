#!/usr/bin/env bash
# Eenmalig: vult de volumes van de worker met de data uit git (webapp/public +
# data/), inclusief de analyselagen die de wekelijkse run niet zelf maakt.
# Overschrijft niets wat er al staat, dus veilig om opnieuw te draaien.
#
#   ./deploy/seed-data.sh            laatste commit op origin/main mét data
#   ./deploy/seed-data.sh <rev>      een specifieke commit
set -euo pipefail
source "$(dirname "$0")/lib.sh"

git -C "$REPO_ROOT" fetch -q origin
# Na de merge van vps-migration staat de data niet meer in main; neem dan de
# laatste commit waarin summary.json nog bestond (toegevoegd of gewijzigd).
REV="${1:-$(git -C "$REPO_ROOT" log -1 --format=%H --diff-filter=AM origin/main -- webapp/public/data/summary.json)}"
echo "seed uit $(git -C "$REPO_ROOT" log -1 --format='%h %cs %s' "$REV")"

worker="$(require_container worker)"
git -C "$REPO_ROOT" archive --format=tar "$REV" webapp/public data \
  | gzip -1 \
  | ssh "$HOST" docker exec -i "$worker" python deploy/scheduler.py seed

echo "klaar. De worker start de eerste wekelijkse run binnen 10 minuten vanzelf;"
echo "volg hem met: ssh $HOST docker logs -f $worker"
