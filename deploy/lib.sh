# Shared helpers for the deploy/ scripts. Source, don't run.
HOST="${DEPLOY_HOST:-hetzner}"   # from ~/.ssh/config
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Coolify names containers <service>-<custom_internal_name>: the resource has
# "consistent container names" on with internal name "inleverpuntenviewer", so
# these are static: web-, app- and worker-inleverpuntenviewer.
inlever_container() {
  echo "$1-inleverpuntenviewer"
}

require_container() {
  local name
  name="$(inlever_container "$1")"
  if [[ "$(ssh "$HOST" "docker inspect -f '{{.State.Running}}' '$name' 2>/dev/null")" != "true" ]]; then
    echo "container '$name' draait niet op $HOST (Coolify-resource al gedeployed, consistent container names aan?)" >&2
    exit 1
  fi
  echo "$name"
}
