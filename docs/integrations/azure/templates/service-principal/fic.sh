#!/usr/bin/env bash
# Customer tenant admin: let the dashboard's connection app sign in WITHOUT a secret (workload identity federation).
# The app (the service principal of the servicePrincipal connection) trusts the platform's Kubernetes service account.
# Needs: Application Administrator, Cloud Application Administrator, or owner of the app.
#
#   bash fic.sh <APP_CLIENT_ID> <PLATFORM_OIDC_ISSUER_URL> system:serviceaccount:<NAMESPACE>:<SERVICE_ACCOUNT>
#
# issuer / subject / audience must match EXACTLY (case-sensitive). A credential just created can fail for a few
# minutes (directory cache). Revoke: delete the credential (az ad app federated-credential delete).
set -euo pipefail
APP_ID="${1:?app (client) id}"
ISSUER="${2:?platform OIDC issuer URL}"
SUBJECT="${3:?system:serviceaccount:<namespace>:<name>}"
case "$SUBJECT" in system:serviceaccount:*:*) ;; *) echo "subject must be system:serviceaccount:<namespace>:<name>" >&2; exit 1 ;; esac

APP_OBJECT_ID="$(az ad app show --id "$APP_ID" --query id -o tsv)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<JSON
{
  "name": "fed-common-aud-dashboard",
  "issuer": "$ISSUER",
  "subject": "$SUBJECT",
  "description": "Azure Unified Dashboard (read-only) - workload identity federation, no secret",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
az ad app federated-credential create --id "$APP_OBJECT_ID" --parameters "@$TMP" --query "{name:name,issuer:issuer,subject:subject}" -o table
echo "Done. Then remove the app's client secret once the dashboard's connection check reports 'Federated (no secret)'."
