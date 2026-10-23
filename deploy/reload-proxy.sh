#!/usr/bin/env bash
# Nginx Proxy Manager zoekt de alias (inleverpuntenviewer) maar één keer op,
# bij het laden van de config. Een redeploy in Coolify maakt de web-container
# opnieuw aan met een nieuw IP, en dan geeft NPM 502 tot hij herlaadt.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ssh "$HOST" 'docker exec nginx-proxy-manager-app-1 nginx -t && docker exec nginx-proxy-manager-app-1 nginx -s reload'
echo "NPM herladen"
