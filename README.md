# Azure Unified Dashboard (MVP)

Monorepo:

- `apps/web`: Next.js (TypeScript) UI
- `apps/api`: Node.js (TypeScript) API

## Prereqs

- Node.js 20+

## Quick start

```bash
cd azure-unified-dashboard
npm install
cp .env.example .env
npm run dev
```

Web: `http://localhost:3000`

API: `http://localhost:4000/health`

## Env vars

See `.env.example`.

## Azure (MVP stub)

`/api/architecture/graph` uses Azure Resource Graph via On-Behalf-Of when configured; otherwise it returns mock data.

### Required config

Env vars:

- Web (SPA): `NEXT_PUBLIC_AZURE_AD_*` + `NEXT_PUBLIC_AZURE_AD_API_SCOPE`
- API (confidential client): `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`
- Azure target: `AZURE_SUBSCRIPTION_IDS`

### App registration checklist (high-level)

1. Create an Entra ID app for the API (confidential client)
2. Expose an API scope on the API app, e.g. `user_impersonation`
3. Create an Entra ID app for the Web (SPA)
4. Grant the Web app permission to call the API scope (`NEXT_PUBLIC_AZURE_AD_API_SCOPE=api://<api-client-id>/user_impersonation`)
5. Assign Azure RBAC to the API app's service principal:
   - Resource Graph Reader (or Reader) on the target subscriptions

## Network Flow (Traffic Analytics)

UI page: `/network`

API endpoint: `/api/network/summary`

- If Log Analytics is configured, the API queries `NTANetAnalytics` (Traffic Analytics enriched flow logs) using OBO.
- Otherwise it serves mock data.

### Required config

Env vars:

- Same API OBO vars: `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`
- Workspace: `AZURE_LOG_ANALYTICS_WORKSPACE_ID`
- Table (optional): `AZURE_LOG_ANALYTICS_TABLE` (default: `NTANetAnalytics`)

### RBAC

Grant the API app's service principal access to query the workspace:

- `Log Analytics Reader` on the workspace (or broader roles that include it)

### Implementation

- API uses `@azure/identity` `OnBehalfOfCredential` + `@azure/arm-resourcegraph` to query a curated set of resource types.
- Graph nodes/edges are derived from Resource Graph results (RG containment + vnet/subnet + nic/vm + aks subnet + private endpoint subnet).

## Reservations (Consumption)

UI page: `/architecture`

API endpoint: `/api/reservations/utilization`

- If Azure Reservations is configured, the API queries ARM `Microsoft.Consumption/reservationSummaries` using OBO.
- Otherwise it serves mock data.

Query params:

- `grain`: `daily` | `monthly`
- `subscriptionId`: optional; when present, it must be in `AZURE_SUBSCRIPTION_IDS`.

### Required config

Env vars:

- Same API OBO vars: `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`
- Azure target allow-list: `AZURE_SUBSCRIPTION_IDS`
- Optional: `AZURE_RESERVATIONS_GRAIN` (default: `monthly`)

### RBAC

The signed-in user (via OBO) must have permission to read reservation summaries on the target subscription(s) (e.g. `Cost Management Reader` or equivalent).

## ArgoCD

UI page: `/argocd`

API endpoint: `/api/argocd/apps`

- If `ARGOCD_BASE_URL` + `ARGOCD_TOKEN` are set, the API calls ArgoCD `/api/v1/applications` and maps results.
- Otherwise it serves mock data.

## Notes

- By default the API serves mock graph/metrics data until Azure/ArgoCD env vars are configured.
