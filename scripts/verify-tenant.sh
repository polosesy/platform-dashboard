#!/usr/bin/env bash
# Read-only connection check from a shell (docs/integrations/azure/verify.md). Sign in AS THE CONNECTION'S IDENTITY
# first (az login --service-principal … for platform / Lighthouse / customer SP; your own account for a delegated one).
# The in-app check (Settings › Azure connections › Check, admins) runs the same steps.
# Prints counts and statuses only — never a response body, key or token.
#   usage: scripts/verify-tenant.sh <TENANT_ID> <SUBSCRIPTION_ID> [LOG_ANALYTICS_WORKSPACE_GUID]
set -u
export MSYS_NO_PATHCONV=1
TENANT="${1:?tenant id}"; SUB="${2:?subscription id}"; WS="${3:-}"
mask() { sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{8})([0-9a-f]{4})/…\2/g'; }
ok() { printf '  %-34s %s\n' "$1" "$2"; }

echo "== signed in as"
az account show --query "{user:user.name, homeTenant:tenantId}" -o tsv 2>/dev/null | mask || { echo "  az login first"; exit 1; }

echo "== subscription visible (the connection's identity reaches it)"
n=$(az graph query -q "resourcecontainers | where type=='microsoft.resources/subscriptions' and subscriptionId=='$SUB' and tenantId=='$TENANT' | count" --query "data[0].Count" -o tsv 2>/dev/null)
ok "Resource Graph" "${n:-0} (1 = visible)"

echo "== effective permissions on the subscription"
perm=$(az rest --method get --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.Authorization/permissions?api-version=2022-04-01" -o json 2>/dev/null)
if [ -z "$perm" ]; then ok "permissions" "not readable"; else
  for a in "*/read" "Microsoft.Insights/metrics/read" "Microsoft.Security/*" "Microsoft.CostManagement/*" "listClusterUserCredential"; do
    c=$(printf '%s' "$perm" | grep -c -- "$a" || true); ok "$a" "$([ "$c" -gt 0 ] && echo granted || echo not-at-subscription)"
  done
fi

echo "== resources readable"
ok "resources" "$(az graph query -q "Resources | where subscriptionId=='$SUB' | count" --query "data[0].Count" -o tsv 2>/dev/null || echo error)"

if [ -n "$WS" ]; then
  echo "== Log Analytics"
  az monitor log-analytics query -w "$WS" --analytics-query "print 1" -o none 2>/dev/null && ok "query" "ok" || ok "query" "denied or missing"
fi

echo "== AKS kubeconfig (HTTP status only)"
for id in $(az graph query -q "Resources | where subscriptionId=='$SUB' and type=~'microsoft.containerservice/managedclusters' | project id" --query "data[].id" -o tsv 2>/dev/null); do
  code=$(az rest --method post --url "https://management.azure.com$id/listClusterUserCredential?api-version=2024-09-01" -o none 2>&1 | grep -oE "\(([A-Za-z]+)\)" | head -1)
  ok "$(basename "$id")" "${code:-ok}"
done
echo "Then open GET /api/azure/tenants/<key>/check while signed in."
