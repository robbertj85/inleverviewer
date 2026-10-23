#!/usr/bin/env bash
# Eenmalig: zet de analyse-inputs die geen script in deze repo ophaalt op het
# data-volume van de worker. Zonder deze bestanden slaat de wekelijkse run de
# analyselagen over (melding "analysis skipped, inputs missing").
#
#   data/cbs/cbs_vk100_2024_inhabited.gpkg   CBS Vierkantstatistieken 100 m 2024,
#                                            alleen bewoonde cellen (~85 MB)
#
# Bestaande bestanden worden overschreven (atomair: eerst .tmp, dan mv).
#
#   ./deploy/push-analysis-inputs.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"

worker="$(require_container worker)"
for rel in cbs/cbs_vk100_2024_inhabited.gpkg; do
  src="$REPO_ROOT/data/$rel"
  if [[ ! -f "$src" ]]; then
    echo "ontbreekt lokaal: $src" >&2
    exit 1
  fi
  dst="/srv/inlever/data/$rel"
  echo "→ $rel ($(du -h "$src" | cut -f1))"
  ssh "$HOST" "docker exec -i $worker sh -c 'mkdir -p \"\$(dirname $dst)\" && cat > $dst.tmp && mv $dst.tmp $dst'" < "$src"
done

echo "klaar. Draai de analyse nu met:"
echo "  ssh $HOST docker exec $worker python deploy/scheduler.py analyse --all"
