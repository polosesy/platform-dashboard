#!/usr/bin/env bash
# Workstation side of the on-prem Docker deployment: push the source, build the image on the server, write the
# runtime settings, start / stop, and open the web through an SSH tunnel. Guide: docs/deployment/container.md §5.
#
#   scripts/onprem.sh deploy            push + build + up (sample settings unless env was run before)
#   scripts/onprem.sh env [--test]      api.env / web.env (+ connections.json) from the local .env → server
#   scripts/onprem.sh tunnel            http://localhost:3000 → the server's 127.0.0.1:3000 (Ctrl-C to close)
#   scripts/onprem.sh push | build | up | status | logs [service] [lines] | down
#
# Connection settings (environment, or the gitignored .secrets/onprem.env):
#   AUD_ONPREM_HOST, AUD_ONPREM_PORT (22), AUD_ONPREM_USER, AUD_ONPREM_KEY (private key path),
#   AUD_LOCAL_PORT (3000), AUD_ONPREM_SUDO_PASSWORD_FILE (optional: a file with the sudo password, raw or "pw:<value>"
#   — without it, sudo asks on the terminal)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .secrets/onprem.env ] && . .secrets/onprem.env

HOST="${AUD_ONPREM_HOST:?set AUD_ONPREM_HOST (or .secrets/onprem.env)}"
SSH_PORT="${AUD_ONPREM_PORT:-22}"
USER_="${AUD_ONPREM_USER:?set AUD_ONPREM_USER}"
KEY="${AUD_ONPREM_KEY:-}"
LOCAL_PORT="${AUD_LOCAL_PORT:-3000}"
SSH_OPTS=(-p "$SSH_PORT" -o ServerAliveInterval=30 ${KEY:+-i "$KEY" -o IdentitiesOnly=yes})
SCP_OPTS=(-P "$SSH_PORT" -q ${KEY:+-i "$KEY" -o IdentitiesOnly=yes})
REMOTE="$USER_@$HOST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Run onprem-remote.sh as root: the sudo password from a file (piped, never on a command line), else the terminal
remote_sudo() {
  local cmd="bash ~/aud-dashboard/deploy/docker/onprem-remote.sh $*"
  if [ -n "${AUD_ONPREM_SUDO_PASSWORD_FILE:-}" ]; then
    { grep -m1 '^pw:' "$AUD_ONPREM_SUDO_PASSWORD_FILE" | sed 's/^pw://' || head -1 "$AUD_ONPREM_SUDO_PASSWORD_FILE"; } \
      | tr -d '\r' | ssh "${SSH_OPTS[@]}" "$REMOTE" "sudo -S -p '' $cmd"
  else
    ssh -t "${SSH_OPTS[@]}" "$REMOTE" "sudo $cmd"
  fi
}

push() {
  local tag; tag="$(git rev-parse --short HEAD)"
  git diff --quiet HEAD -- 2>/dev/null || tag="$tag-dirty"
  # Tracked files plus new ones not committed yet (still honouring .gitignore: no .env, .secrets, keys, connections
  # file); files deleted in the working tree are skipped
  [ -n "$(git ls-files --others --exclude-standard -- . ':!.claude')" ] && tag="${tag%-dirty}-dirty"
  git ls-files -z --cached --others --exclude-standard -- . ':!.claude' | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done > "$TMP/files"
  tar --force-local --null -czf "$TMP/src.tar.gz" -T "$TMP/files"
  scp "${SCP_OPTS[@]}" "$TMP/src.tar.gz" "$REMOTE:aud-src.tar.gz"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -rf ~/aud-dashboard && mkdir -p ~/aud-dashboard && tar -xzf ~/aud-src.tar.gz -C ~/aud-dashboard && rm ~/aud-src.tar.gz && echo $tag > ~/aud-dashboard/.source-sha"
  echo "pushed $(tr -cd '\0' < "$TMP/files" | wc -c | tr -d ' ') files as $tag (gitignored ones never: .env, .secrets, config/connections.json)"
}

env_files() {
  node scripts/onprem-env.mjs "$TMP/env" --local-port "$LOCAL_PORT" "$@"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "umask 077; mkdir -p ~/aud-runtime/config"
  scp "${SCP_OPTS[@]}" "$TMP/env/api.env" "$TMP/env/web.env" "$REMOTE:aud-runtime/"
  [ -f "$TMP/env/connections.json" ] && scp "${SCP_OPTS[@]}" "$TMP/env/connections.json" "$REMOTE:aud-runtime/config/connections.json"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "chmod 600 ~/aud-runtime/api.env ~/aud-runtime/web.env; [ -f ~/aud-runtime/config/connections.json ] && chmod 644 ~/aud-runtime/config/connections.json; true"
  echo "settings uploaded — run: scripts/onprem.sh up"
}

tunnel() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
    echo "local port $LOCAL_PORT is busy (a dev server?) — stop it or set AUD_LOCAL_PORT"; exit 1
  fi
  echo "open http://localhost:$LOCAL_PORT  (Ctrl-C closes the tunnel)"
  ssh -N "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -L "$LOCAL_PORT:127.0.0.1:3000" "$REMOTE"
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  push) push ;;
  build) remote_sudo build "$@" ;;
  env) env_files "$@" ;;
  up) remote_sudo up "$@" ;;
  status) remote_sudo status ;;
  logs) remote_sudo logs "$@" ;;
  down) remote_sudo down ;;
  deploy) push; remote_sudo build; remote_sudo up ;;
  tunnel) tunnel ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
