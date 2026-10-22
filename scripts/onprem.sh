#!/usr/bin/env bash
# Workstation side of the on-prem Docker deployment. The source stays here: deploy streams it into a temporary
# directory on the server, builds the image there and deletes the directory (also on failure). The server keeps only
# ~/aud-runtime (compose.yaml, nginx.conf, env files, config, state, and audctl to run it by hand).
# Guide: docs/deployment/container.md §5.
#
#   scripts/onprem.sh deploy            build on the server from this working tree + up (source removed after)
#   scripts/onprem.sh env [--test]      api.env / web.env (+ connections.json) from the local .env → server
#   scripts/onprem.sh tunnel            http://localhost:3000 → the server's 127.0.0.1:3000 (Ctrl-C to close)
#   scripts/onprem.sh build | up [tag] | down | restart [service] | status | logs [service] [lines] [-f]
#                     rollback [tag] | images | version | cleanup-source (one time: old ~/aud-dashboard)
#   on the server itself:  sudo ~/aud-runtime/audctl status | up | down | restart | logs | rollback | images | version
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

# The remote build context is removed even when this script fails before audctl's own trap is set
CTX=""
cleanup() {
  rm -rf "$TMP"
  if [ -n "$CTX" ]; then ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -rf -- '$CTX'" || true; fi
}
TMP="$(mktemp -d)"; trap cleanup EXIT

# A remote command as root: the sudo password from a file (piped, never on a command line), else the terminal
as_root() {
  if [ -n "${AUD_ONPREM_SUDO_PASSWORD_FILE:-}" ]; then
    { grep -m1 '^pw:' "$AUD_ONPREM_SUDO_PASSWORD_FILE" | sed 's/^pw://' || head -1 "$AUD_ONPREM_SUDO_PASSWORD_FILE"; } \
      | tr -d '\r' | ssh "${SSH_OPTS[@]}" "$REMOTE" "sudo -S -p '' $1"
  else
    ssh -t "${SSH_OPTS[@]}" "$REMOTE" "sudo $1"
  fi
}
ctl() { as_root "bash ~/aud-runtime/audctl $*"; }

# <sha>, or <sha>-dirty-<UTC time> with uncommitted changes (two dirty builds never share a tag, so rollback works
# between them)
source_tag() {
  local t; t="$(git rev-parse --short HEAD)"
  if ! git diff --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard -- . ':!.claude')" ]; then
    t="$t-dirty-$(date -u +%Y%m%dT%H%M%S)"
  fi
  echo "$t"
}

build() {
  local tag; tag="$(source_tag)"
  # Tracked files plus new ones not committed yet (still honouring .gitignore: no .env, .secrets, keys, connections
  # file); files deleted in the working tree are skipped
  git ls-files -z --cached --others --exclude-standard -- . ':!.claude' \
    | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done > "$TMP/files"
  # Streamed into a fresh directory — no tarball written on either side. mktemp -d makes it 0700 (others cannot enter);
  # the files inside keep normal modes (umask 022): docker COPY keeps them, and the image's user 65532 must read them
  CTX="$(tar --force-local --null -czf - -T "$TMP/files" | ssh "${SSH_OPTS[@]}" "$REMOTE" \
    'umask 022; d=$(mktemp -d "$HOME/.aud-build.XXXXXX") || exit 1
     tar -xzf - -C "$d" || { rm -rf -- "$d"; exit 1; }; echo "$d"')"
  [[ $CTX == /*/.aud-build.* ]] || { CTX=""; echo "upload failed"; exit 1; }
  echo "sent $(tr -cd '\0' < "$TMP/files" | wc -c | tr -d ' ') files as $tag into a temporary build directory"
  # The new audctl from the context builds, installs itself into ~/aud-runtime and deletes the context
  as_root "bash '$CTX/deploy/docker/audctl' build '$CTX' '$tag'"
  CTX=""; BUILT="$tag"
}

env_files() {
  node scripts/onprem-env.mjs "$TMP/env" --local-port "$LOCAL_PORT" "$@"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "umask 077; mkdir -p ~/aud-runtime/config"
  scp "${SCP_OPTS[@]}" "$TMP/env/api.env" "$TMP/env/web.env" "$REMOTE:aud-runtime/"
  [ -f "$TMP/env/connections.json" ] && scp "${SCP_OPTS[@]}" "$TMP/env/connections.json" "$REMOTE:aud-runtime/config/connections.json"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "chmod 600 ~/aud-runtime/api.env ~/aud-runtime/web.env; [ -f ~/aud-runtime/config/connections.json ] && chmod 644 ~/aud-runtime/config/connections.json; true"
  echo "settings uploaded — run: scripts/onprem.sh restart"
}

tunnel() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
    echo "local port $LOCAL_PORT is busy (a dev server?) — stop it or set AUD_LOCAL_PORT"; exit 1
  fi
  echo "open http://localhost:$LOCAL_PORT  (Ctrl-C closes the tunnel)"
  ssh -N "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -L "$LOCAL_PORT:127.0.0.1:3000" "$REMOTE"
}

# One time, after the first deploy with audctl: remove the source the old push left in ~/aud-dashboard. As the user
# (no sudo), and only when it is exactly that: a plain directory of the user's with the pushed marker files
cleanup_source() {
  ssh "${SSH_OPTS[@]}" "$REMOTE" 'set -eu; p="$HOME/aud-dashboard"
    [ -e "$p" ] || { echo "nothing to remove ($p does not exist)"; exit 0; }
    { [ -d "$p" ] && [ ! -L "$p" ]; } || { echo "refusing: $p is not a plain directory"; exit 1; }
    [ "$(stat -c %U "$p")" = "$(id -un)" ] || { echo "refusing: $p is not owned by $(id -un)"; exit 1; }
    { [ -f "$p/.source-sha" ] && [ -f "$p/deploy/docker/compose.yaml" ]; } || { echo "refusing: $p is not the pushed source"; exit 1; }
    { [ -x "$HOME/aud-runtime/audctl" ] && [ -s "$HOME/aud-runtime/.image-tag" ]; } || { echo "deploy first (no ~/aud-runtime/audctl)"; exit 1; }
    rm -rf -- "$p"; rm -f -- "$HOME/aud-src.tar.gz"
    echo "removed $p (runtime ~/aud-runtime kept)"'
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  deploy) build; ctl up "$BUILT" ;;
  build) build; echo "built $BUILT — start it: scripts/onprem.sh up $BUILT" ;;
  env) env_files "$@" ;;
  tunnel) tunnel ;;
  up|down|restart|status|logs|rollback|images|version) ctl "$cmd" "$@" ;;
  cleanup-source) cleanup_source ;;
  push) echo "removed: the source no longer stays on the server — use: scripts/onprem.sh deploy"; exit 2 ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
