#!/usr/bin/env bash
# Manual TEST deployment in a private, Entra-only AKS cluster (Git Bash; PowerShell: scripts\aks-test.ps1).
# Guide: docs/deployment/kubernetes.md "시험 배포 — 프라이빗 클러스터".
#
#   scripts/aks-test.sh connect    http://localhost:3000 → svc/aud-dashboard (Ctrl-C closes every tunnel)
#   scripts/aks-test.sh check      the same tunnels, one /readyz through them, then close
#   scripts/aks-test.sh deploy     build → push → roll out → check the running version (needs `connect` open)
#   scripts/aks-test.sh cleanup    delete everything the test created (asks "yes" first)
#
#   PC :2222 ─Bastion─▶ jumpbox :22          (Bastion IP tunnels allow only 22/3389 → SSH is the hop)
#   PC :8443 ─SSH -L (Entra SSH)─▶ private API server :443
#   PC :3000 ─kubectl port-forward─▶ svc/aud-dashboard :80   (MSAL redirect is exactly http://localhost:3000)
#
# Names (environment, or the gitignored .secrets/aks-test.env — never in this repo):
#   AUD_AKS_RG, AUD_AKS_NAME, AUD_AKS_SUBSCRIPTION (optional: found from the cluster name)
#   AUD_BASTION_NAME, AUD_BASTION_RG, AUD_JUMPBOX_VM, AUD_JUMPBOX_RG (AUD_AKS_RG)
#   cleanup: AUD_TEST_IDENTITY (managed identity), AUD_TEST_FIC (its federated credential), AUD_TEST_ACR,
#            AUD_TEST_REPO (test/aud-dashboard)
#   AUD_TEST_NAMESPACE (aud-dashboard), AUD_LOCAL_PORT (3000)
# Working files (kubeconfig, known_hosts, logs, rendered values) stay in the gitignored .secrets/aks-test/.
set -euo pipefail
export MSYS_NO_PATHCONV=1
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."
[ -f .secrets/aks-test.env ] && . .secrets/aks-test.env
# C:/... form: under MSYS_NO_PATHCONV the Windows programs (az, kubectl, ssh) read /c/Users/... as C:\c\Users\...
WORK="$(cygpath -m "$PWD/.secrets/aks-test" 2>/dev/null || echo "$PWD/.secrets/aks-test")"
mkdir -p "$WORK"

RG="${AUD_AKS_RG:?set AUD_AKS_RG (or .secrets/aks-test.env)}"
AKS="${AUD_AKS_NAME:?set AUD_AKS_NAME}"
NS="${AUD_TEST_NAMESPACE:-aud-dashboard}"
LOCAL_PORT="${AUD_LOCAL_PORT:-3000}"
q() { "$@" | tr -d '\r'; }                      # az on Windows ends tsv lines with \r
open_port() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() {
  for _ in $(seq 1 30); do open_port "$1" && return 0; ping -n 2 127.0.0.1 >/dev/null; done
  # conditional access ends the az sign-in after a few hours — say so instead of "see the log"
  grep -q "AADSTS70043\|AADSTS50173\|az login" "$WORK/$2" 2>/dev/null &&
    { echo "the Azure sign-in expired — run 'az login', then connect again"; exit 1; }
  echo "port $1 did not open — see $WORK/$2"; exit 1
}
subscription() {
  [ -n "${AUD_AKS_SUBSCRIPTION:-}" ] && { echo "$AUD_AKS_SUBSCRIPTION"; return; }
  local s; s=$(q az resource list --name "$AKS" --query "[?type=='Microsoft.ContainerService/managedClusters'].id | [0]" -o tsv | cut -d/ -f3)
  [ -n "$s" ] || { echo "cluster $AKS not visible to az (az login / az account)" >&2; exit 1; }
  echo "$s"
}

# kill alone stops only the bash side; the Windows programs under it (az's python, ssh) keep the ports → kill the tree
close_all() {
  local p w
  for p in "${pids[@]}"; do
    w=$(cat "/proc/$p/winpid" 2>/dev/null || true)
    [ -n "$w" ] && taskkill /F /T /PID "$w" >/dev/null 2>&1 || kill "$p" 2>/dev/null || true
  done
}

tunnels() {   # $1 = connect | check
  local BAS="${AUD_BASTION_NAME:?set AUD_BASTION_NAME}" BAS_RG="${AUD_BASTION_RG:?set AUD_BASTION_RG}"
  local JBX="${AUD_JUMPBOX_VM:?set AUD_JUMPBOX_VM}" JBX_RG="${AUD_JUMPBOX_RG:-$RG}"
  for p in "$LOCAL_PORT" 2222 8443; do
    open_port "$p" && { echo "port $p is busy — stop the on-prem tunnel / dev server / an earlier run first"; exit 1; }
  done
  local SUB FQDN NRG PEIP VM_ID
  SUB=$(subscription)
  read -r FQDN NRG < <(q az aks show -g "$RG" -n "$AKS" --subscription "$SUB" --query "join(' ', [privateFqdn, nodeResourceGroup])" -o tsv)
  PEIP=$(q az network nic list -g "$NRG" --subscription "$SUB" --query "[?contains(name,'kube-apiserver')].ipConfigurations[0].privateIPAddress | [0]" -o tsv)
  VM_ID=$(q az vm show -g "$JBX_RG" -n "$JBX" --subscription "$SUB" --query id -o tsv)
  [ -n "$FQDN" ] && [ -n "$PEIP" ] && [ -n "$VM_ID" ] || { echo "could not read the API endpoint or the jumpbox"; exit 1; }

  pids=()
  trap close_all EXIT INT TERM
  legs() {
    echo "1/3 Bastion → jumpbox"
    az network bastion tunnel -n "$BAS" -g "$BAS_RG" --subscription "$SUB" --target-resource-id "$VM_ID" \
      --resource-port 22 --port 2222 >"$WORK/bastion.log" 2>&1 & pids+=($!)
    wait_port 2222 bastion.log
    echo "2/3 jumpbox → API server (Entra SSH)"
    az ssh vm --ip 127.0.0.1 --port 2222 -- -N -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$WORK/known_hosts" -o ServerAliveInterval=30 -L "8443:$PEIP:443" >"$WORK/ssh.log" 2>&1 & pids+=($!)
    wait_port 8443 ssh.log
  }
  legs
  export KUBECONFIG="$WORK/kubeconfig"
  az aks get-credentials -g "$RG" -n "$AKS" --subscription "$SUB" --file "$KUBECONFIG" --overwrite-existing >/dev/null
  kubelogin convert-kubeconfig -l azurecli --kubeconfig "$KUBECONFIG"
  kubectl config set-cluster "$AKS" --server=https://127.0.0.1:8443 --tls-server-name="$FQDN" >/dev/null
  kubectl -n "$NS" get pods
  if [ "$1" = check ]; then
    kubectl -n "$NS" port-forward svc/aud-dashboard "$LOCAL_PORT:80" >"$WORK/port-forward.log" 2>&1 & pids+=($!)
    wait_port "$LOCAL_PORT" port-forward.log
    echo "3/3 /readyz: $(curl -fsS "http://127.0.0.1:$LOCAL_PORT/readyz")"
    return
  fi
  # Bastion resets the SSH session now and then (ssh.log "client_loop: send disconnect: Connection reset") and every
  # leg after it falls with it ("lost connection to pod") → reopen the whole chain; stop after 5 quick failures in a row
  local fails=0 t0
  while :; do
    echo "3/3 open http://localhost:$LOCAL_PORT  (Ctrl-C closes the tunnels)"
    t0=$SECONDS
    kubectl -n "$NS" port-forward svc/aud-dashboard "$LOCAL_PORT:80" || true
    [ $((SECONDS - t0)) -lt 60 ] && fails=$((fails + 1)) || fails=0
    [ "$fails" -ge 5 ] && { echo "the tunnel keeps dropping — see $WORK/ssh.log, $WORK/bastion.log"; exit 1; }
    echo "tunnel dropped ($(tail -1 "$WORK/ssh.log" | tr -d '\r')) — reopening"
    close_all; pids=()
    ping -n 4 127.0.0.1 >/dev/null
    legs
  done
}

# build on the on-prem Docker server → docker save → push from this PC (the registry allows this IP) → values tag +
# digest → helm template → kubectl apply → rollout → /healthz must report the build. Every step that went wrong
# silently once has a check: the saved image's AUD_VERSION must be the build (a stale folder pushed the previous
# image under a new tag — 2026-11-12), and the running pod must report it.
deploy() {
  local ACR="${AUD_TEST_ACR:?set AUD_TEST_ACR}" REPO="${AUD_TEST_REPO:-test/aud-dashboard}" V="$WORK/values-test.yaml"
  local IMG="$WORK/image" BUILT TAG REG DIGEST HAVE v=""
  [ -f "$V" ] || { echo "no $V (the test values — docs/deployment/kubernetes.md)"; exit 1; }
  open_port "$LOCAL_PORT" || { echo "open the tunnel first: scripts/aks-test.sh connect"; exit 1; }
  BUILT=$(bash scripts/onprem.sh build | tee "$WORK/build.log" | sed -n 's/^built \([^ ]*\) .*/\1/p' | tail -1)
  [ -n "$BUILT" ] || { echo "the build did not report a tag — see $WORK/build.log"; exit 1; }
  TAG="0.1.0-${BUILT%%-*}-$(date -u +%m%d%H%M)"          # a new tag every time: the digest is pinned in the values
  rm -rf "${IMG:?}" "$IMG.tar"; mkdir -p "$IMG"
  bash scripts/onprem.sh save "$BUILT" > "$IMG.tar"
  tar --force-local -xf "$IMG.tar" -C "$IMG"; rm -f "$IMG.tar"
  HAVE=$(node -e 'const fs=require("fs"),p=require("path"),d=process.argv[1];const m=JSON.parse(fs.readFileSync(p.join(d,"manifest.json"),"utf8"))[0];const c=JSON.parse(fs.readFileSync(p.join(d,m.Config),"utf8"));console.log(((c.config.Env||[]).find(e=>e.startsWith("AUD_VERSION="))||"").slice(12))' "$IMG")
  [ "$HAVE" = "$BUILT" ] || { echo "the saved image is '$HAVE', not the build '$BUILT' — nothing pushed"; exit 1; }
  REG="$ACR.azurecr.io"
  for try in 1 2; do     # a push cut mid-way resumes: layers already there are skipped
    DIGEST=$(az acr login -n "$ACR" --expose-token --query accessToken -o tsv 2>/dev/null | tr -d '\r' \
      | node scripts/oci-push.mjs "$IMG" "$REG" "$REPO" "$TAG" 2>"$WORK/push.log" | sed -n 's/^DIGEST //p' | tail -1) || true
    case "$DIGEST" in sha256:*) break ;; esac
    [ "$try" = 2 ] && { echo "push failed — see $WORK/push.log (az login expired?)"; exit 1; }
  done
  sed -i -E "1s/tag: \"[^\"]+\"/tag: \"$TAG\"/; 1s/digest: \"sha256:[0-9a-f]+\"/digest: \"$DIGEST\"/" "$V"
  grep -q "tag: \"$TAG\".*digest: \"$DIGEST\"" "$V" || { echo "line 1 of $V is not the image line (tag · digest) — values not updated"; exit 1; }
  [ -f "$WORK/aud.yaml" ] && cp "$WORK/aud.yaml" "$WORK/aud.prev.yaml"
  helm template aud-dashboard deploy/helm/aud-dashboard -n "$NS" -f "$V" > "$WORK/aud.yaml"
  KUBECONFIG="$WORK/kubeconfig" kubectl apply -f "$WORK/aud.yaml" >/dev/null
  KUBECONFIG="$WORK/kubeconfig" kubectl -n "$NS" rollout status deploy/aud-dashboard --timeout=300s | tail -1
  for _ in $(seq 1 60); do      # the port-forward reattaches to the new pod after the old one goes
    v=$(curl -s --max-time 3 "http://localhost:$LOCAL_PORT/healthz" || true)
    case "$v" in *"$BUILT"*) break ;; esac
    ping -n 4 127.0.0.1 >/dev/null
  done
  case "$v" in *"$BUILT"*) echo "running $BUILT ($TAG)" ;; *) echo "rolled out, but /healthz says: ${v:-no answer} (expected $BUILT)"; exit 1 ;; esac
  node scripts/smoke.mjs "http://localhost:$LOCAL_PORT" --version "$BUILT"
}

cleanup() {   # order: cluster objects → role assignments → federated credential → identity → test image repository
  local MI="${AUD_TEST_IDENTITY:?set AUD_TEST_IDENTITY}" FIC="${AUD_TEST_FIC:?set AUD_TEST_FIC}"
  local ACR="${AUD_TEST_ACR:?set AUD_TEST_ACR}" REPO="${AUD_TEST_REPO:-test/aud-dashboard}" SUB PID ok
  SUB=$(subscription)
  read -r -p "Delete the $NS test in $AKS (namespace, RBAC, identity, roles, $REPO)? [yes/N] " ok
  [ "$ok" = "yes" ] || { echo "nothing deleted"; exit 0; }
  PID=$(q az identity show -g "$RG" -n "$MI" --subscription "$SUB" --query principalId -o tsv 2>/dev/null || true)
  az aks command invoke -g "$RG" -n "$AKS" --subscription "$SUB" -o tsv --query logs --command \
    "kubectl delete ns $NS --ignore-not-found --wait=true; kubectl delete clusterrolebinding aud-dashboard-reader --ignore-not-found; kubectl delete clusterrole aud-dashboard-reader --ignore-not-found"
  if [ -n "$PID" ]; then
    for id in $(q az role assignment list --assignee "$PID" --all --subscription "$SUB" --query "[].id" -o tsv); do
      az role assignment delete --ids "$id"
    done
    az identity federated-credential delete -g "$RG" --identity-name "$MI" -n "$FIC" --subscription "$SUB" --yes || true
    az identity delete -g "$RG" -n "$MI" --subscription "$SUB"
  fi
  az acr repository delete -n "$ACR" --repository "$REPO" --subscription "$SUB" --yes || true
  rm -f "$WORK/kubeconfig" "$WORK/known_hosts" "$WORK"/*.log
  echo "removed"
}

case "${1:-}" in
  connect) tunnels connect ;;
  check) tunnels check ;;
  deploy) deploy ;;
  cleanup) cleanup ;;
  *) sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
