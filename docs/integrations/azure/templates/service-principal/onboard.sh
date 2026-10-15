#!/usr/bin/env bash
# Customer-side onboarding for an Azure connection of mode "servicePrincipal" (docs/integrations/azure/connect-tenant.md B).
# Run by the CUSTOMER's admin, signed in to the customer tenant (az login --tenant <CUSTOMER_TENANT_ID>).
# Creates an app + service principal with READ-ONLY roles on one subscription and prints what to hand over.
# The secret is printed once — send it over a secure channel, never in mail/chat/tickets. Prefer a certificate
# (--cert) in production: az ad app credential reset --id <appId> --cert @cert.pem --append
#   usage: onboard.sh <SUBSCRIPTION_ID> <CONNECTION_KEY> [--no-secret]
set -euo pipefail
export MSYS_NO_PATHCONV=1
SUB="${1:?subscription id}"; KEY="${2:?connection key (a-z 0-9 -)}"; MODE="${3:-}"
NAME="aud-reader-${KEY}"
ENV_NAME="AUD_CONN_$(echo "$KEY" | tr 'a-z-' 'A-Z_')_SECRET"
SCOPE="/subscriptions/${SUB}"

TENANT=$(az account show --query tenantId -o tsv)
echo "== tenant ${TENANT:0:8}… · subscription ${SUB:0:8}…"

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
  echo "== created app $NAME"
fi
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$APP_ID" --query id -o tsv)

# Read-only roles (docs/integrations/azure/permissions.md). Remove the ones whose features you do not want.
for ROLE in "Reader" "Monitoring Reader" "Log Analytics Reader" "Security Reader" "Cost Management Reader"; do
  az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
    --role "$ROLE" --scope "$SCOPE" -o none 2>/dev/null && echo "  role: $ROLE" || echo "  role: $ROLE (already assigned or not allowed)"
done

echo
echo "== hand over to the platform admin"
echo "  connection key : $KEY"
echo "  tenantId       : $TENANT"
echo "  subscription   : $SUB"
echo "  clientId       : $APP_ID"
if [ "$MODE" != "--no-secret" ]; then
  SECRET=$(az ad app credential reset --id "$APP_ID" --append --years 1 --display-name "aud-platform" --query password -o tsv)
  echo "  secret         : (shown once below — the platform stores it in the env var $ENV_NAME)"
  echo "$SECRET"
  unset SECRET
else
  echo "  credential     : upload a certificate instead (az ad app credential reset --id $APP_ID --cert @cert.pem --append)"
fi
