# Shared helpers for the deploy/ scripts. Source, don't run.
HOST="${DEPLOY_HOST:-hetzner}"   # from ~/.ssh/config
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Name of the running Coolify container for compose service $1 of this app
# (Coolify names them <service>-<resource-uuid>; find it by labels instead).
# The resource name derives from the repo (inleverviewer), so match both.
inlever_container() {
  ssh "$HOST" "docker ps --filter label=com.docker.compose.service=$1 --format '{{.Names}} {{.Label \"coolify.resourceName\"}}'" \
    | awk '$2 ~ /inlever(punten)?viewer/ {print $1; exit}'
}

require_container() {
  local name
  name="$(inlever_container "$1")"
  if [[ -z "$name" ]]; then
    echo "geen draaiende '$1'-container van inleverpuntenviewer gevonden op $HOST (Coolify-resource al gedeployed?)" >&2
    exit 1
  fi
  echo "$name"
}
