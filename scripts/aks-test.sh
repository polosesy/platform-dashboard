#!/usr/bin/env bash
# Manual TEST deployment in a private, Entra-only AKS cluster (Git Bash; PowerShell: scripts\aks-test.ps1).
# Guide: docs/deployment/kubernetes.md "시험 배포 — 프라이빗 클러스터".
#
#   scripts/aks-test.sh connect    http://localhost:3000 → svc/aud-dashboard (Ctrl-C closes every tunnel)
#   scripts/aks-test.sh check      the same tunnels, one /readyz through them, then close
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
WORK="$PWD/.secrets/aks-test"
mkdir -p "$WORK"

RG="${AUD_AKS_RG:?set AUD_AKS_RG (or .secrets/aks-test.env)}"
AKS="${AUD_AKS_NAME:?set AUD_AKS_NAME}"
NS="${AUD_TEST_NAMESPACE:-aud-dashboard}"
LOCAL_PORT="${AUD_LOCAL_PORT:-3000}"
q() { "$@" | tr -d '\r'; }                      # az on Windows ends tsv lines with \r
open_port() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() {
  for _ in $(seq 1 30); do open_port "$1" && return 0; ping -n 2 127.0.0.1 >/dev/null; done
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
  echo "1/3 Bastion → jumpbox"
  az network bastion tunnel -n "$BAS" -g "$BAS_RG" --subscription "$SUB" --target-resource-id "$VM_ID" \
    --resource-port 22 --port 2222 >"$WORK/bastion.log" 2>&1 & pids+=($!)
  wait_port 2222 bastion.log
  echo "2/3 jumpbox → API server (Entra SSH)"
  az ssh vm --ip 127.0.0.1 --port 2222 -- -N -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$WORK/known_hosts" -o ServerAliveInterval=30 -L "8443:$PEIP:443" >"$WORK/ssh.log" 2>&1 & pids+=($!)
  wait_port 8443 ssh.log
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
  echo "3/3 open http://localhost:$LOCAL_PORT  (Ctrl-C closes the tunnels)"
  kubectl -n "$NS" port-forward svc/aud-dashboard "$LOCAL_PORT:80"
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
  cleanup) cleanup ;;
  *) sed -n '2,7p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
