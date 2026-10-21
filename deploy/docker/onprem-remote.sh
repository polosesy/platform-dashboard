#!/usr/bin/env bash
# Runs ON the on-prem Docker host, as root (sudo) — driven by scripts/onprem.sh from a workstation.
#   source  ~<user>/aud-dashboard   (replaced on every push — tracked files only)
#   runtime ~<user>/aud-runtime     (kept: api.env, web.env, config/, tls/, nginx.conf copy, .image-tag)
# The web is published on 127.0.0.1:${AUD_HTTP_PORT:-3000} only: open it from a workstation through an SSH tunnel
# (http://localhost:3000 — a secure context for sign-in, no certificate, no firewall change).
#
#   onprem-remote.sh build [tag] | up [tag] | status | logs [service] [lines] | down | sample-env
set -euo pipefail

OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
SRC="${AUD_SRC:-$OWNER_HOME/aud-dashboard}"
RUN="${AUD_RUNTIME:-$OWNER_HOME/aud-runtime}"
HTTP_PORT="${AUD_HTTP_PORT:-3000}"

tag_or_default() { [ -n "${1:-}" ] && echo "$1" || cat "$RUN/.image-tag" 2>/dev/null || cat "$SRC/.source-sha"; }
compose() { AUD_IMAGE="aud-dashboard:$TAG" AUD_HTTP_PORT="$HTTP_PORT" docker compose -f "$SRC/deploy/docker/compose.yaml" --project-directory "$RUN" "$@"; }

# Sample mode: no Azure identity — anonymous visitors get sample data, sign-in stays off. Real values come from
# `scripts/onprem.sh env` (never overwritten here)
sample_env() {
  mkdir -p "$RUN/config" "$RUN/tls"
  if [ ! -f "$RUN/api.env" ]; then
    cat > "$RUN/api.env" <<EOF
# sample mode (scripts/onprem.sh env replaces this file)
NODE_ENV=production
AZURE_AD_TENANT_ID=00000000-0000-0000-0000-000000000000
AZURE_AD_CLIENT_ID=00000000-0000-0000-0000-000000000000
AZURE_SUBSCRIPTION_IDS=00000000-0000-0000-0000-000000000000
CORS_ORIGIN=http://localhost:${HTTP_PORT}
AUD_AUDIT_LOG=stdout
EOF
    echo "wrote sample api.env"
  fi
  [ -f "$RUN/web.env" ] || { echo "# sample mode — sign-in off (no AUD_WEB_CLIENT_ID)" > "$RUN/web.env"; echo "wrote sample web.env"; }
}

ensure_runtime() {
  mkdir -p "$RUN/config" "$RUN/tls"
  sample_env
  cp "$SRC/deploy/docker/nginx.conf" "$RUN/nginx.conf"
  # Env files hold secrets: the owner only (docker reads them as root). config/ is mounted into the containers
  # (user 65532): readable files, IDs and names only — no secrets in connections.json
  chown -R "$OWNER": "$RUN"
  chmod 700 "$RUN"; chmod 600 "$RUN"/api.env "$RUN"/web.env
  chmod 755 "$RUN/config"; find "$RUN/config" -type f -exec chmod 644 {} +
}

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 "http://127.0.0.1:${HTTP_PORT}/readyz" >/dev/null 2>&1; then echo "ready: http://127.0.0.1:${HTTP_PORT}"; return 0; fi
    sleep 2
  done
  echo "not ready after 120 s — last api logs:"; compose logs --tail 30 api || true; return 1
}

cmd="${1:-status}"
case "$cmd" in
  build)
    # The pushed source names the image (not the last .image-tag — that is the image running now)
    TAG="${2:-$(cat "$SRC/.source-sha")}"
    docker build -t "aud-dashboard:$TAG" --build-arg "AUD_VERSION=$TAG" "$SRC"
    mkdir -p "$RUN" && echo "$TAG" > "$RUN/.image-tag" && chown "$OWNER": "$RUN" "$RUN/.image-tag"
    docker image ls aud-dashboard --format '{{.Tag}}  {{.Size}}  {{.CreatedSince}}'
    ;;
  up)
    TAG="$(tag_or_default "${2:-}")"
    docker image inspect "aud-dashboard:$TAG" >/dev/null 2>&1 || { echo "image aud-dashboard:$TAG not built — run build first"; exit 1; }
    ensure_runtime
    compose up -d --remove-orphans
    wait_ready
    compose ps
    ;;
  status)
    TAG="$(tag_or_default "")"
    compose ps
    printf 'readyz: '; curl -sS -m 5 "http://127.0.0.1:${HTTP_PORT}/readyz" || echo "unreachable"; echo
    ;;
  logs)
    TAG="$(tag_or_default "")"
    compose logs --tail "${3:-100}" ${2:+"$2"}
    ;;
  down)
    TAG="$(tag_or_default "")"
    compose down
    ;;
  sample-env)
    sample_env
    ;;
  *)
    echo "usage: $0 build [tag] | up [tag] | status | logs [service] [lines] | down | sample-env"; exit 2 ;;
esac
