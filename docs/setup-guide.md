# Azure Unified Dashboard — Setup & Integration Guide

## 1. Quick Start (Demo Mode)

Demo 모드는 Azure 자격증명 없이 mock 데이터로 전체 UI를 확인할 수 있습니다.

### Prerequisites

- Node.js 20+
- npm 10+

### Steps

```bash
# 1. Clone & install
git clone <repo-url> azure-unified-dashboard
cd azure-unified-dashboard
npm install

# 2. Create .env from example
cp .env.example .env

# 3. Start both apps
npm run dev
```

- **API**: http://localhost:4000 (Express)
- **Web**: http://localhost:3000 (Next.js)

Demo 모드에서는 모든 `AZURE_*_ENABLED` 플래그가 `false`이므로 mock 데이터가 자동 반환됩니다.

### Available Pages

| Route | Description |
|-------|-------------|
| `/` | Home (Architecture 그래프) |
| `/architecture` | Architecture 그래프 + Inspector + Flow Overlay |
| `/network` | Network topology |
| `/cost` | Cost Management (KPI, Trend, Budgets) |
| `/security` | Security (Secure Score gauge, Alerts) |
| `/health` | Resource Health (Donut chart, Resource table) |
| `/live-diagram` | Live Architecture Diagram (실시간 노드/엣지 애니메이션) |
| `/argocd` | ArgoCD applications |

### API Endpoints (Mock)

```bash
# Health check
curl http://localhost:4000/health

# Cost
curl http://localhost:4000/api/cost/summary
curl http://localhost:4000/api/cost/trend
curl http://localhost:4000/api/cost/budgets

# Security
curl http://localhost:4000/api/security/score
curl http://localhost:4000/api/security/alerts

# Resource Health
curl http://localhost:4000/api/health/summary

# Live Diagram
curl http://localhost:4000/api/live/diagrams
curl http://localhost:4000/api/live/snapshot
curl http://localhost:4000/api/live/status
```

---

## 2. Azure AD 설정 (실제 연동)

### 2.1 App Registration (Azure Portal)

Azure Portal → Azure Active Directory → App registrations에서 **2개의 앱**을 등록합니다.

#### A) API App (Confidential Client)

1. **New registration** → Name: `aud-api`
2. **Certificates & secrets** → New client secret → 값 복사
3. **Expose an API** →
   - Application ID URI: `api://<client-id>`
   - Add scope: `user_impersonation` (Admin consent)
4. **API permissions** →
   - `Azure Service Management` → `user_impersonation` (delegated)
   - 이 권한으로 OBO를 통해 Azure ARM API에 접근

#### B) Web App (SPA)

1. **New registration** → Name: `aud-web`
2. **Authentication** →
   - Platform: SPA
   - Redirect URIs: `http://localhost:3000`
3. **API permissions** →
   - Add `aud-api` → `user_impersonation` (delegated)

### 2.2 Environment Variables

```env
# Web (.env)
NEXT_PUBLIC_AZURE_AD_TENANT_ID=<your-tenant-id>
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=<web-app-client-id>
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=http://localhost:3000
NEXT_PUBLIC_AZURE_AD_API_SCOPE=api://<api-app-client-id>/user_impersonation

# API (.env)
AZURE_AD_TENANT_ID=<your-tenant-id>
AZURE_AD_CLIENT_ID=<api-app-client-id>
AZURE_AD_CLIENT_SECRET=<api-app-secret>
AZURE_SUBSCRIPTION_IDS=<subscription-id-1>,<subscription-id-2>
```

### 2.3 RBAC 권한

API 서비스 계정에 대상 구독에서 다음 역할이 필요합니다:

| Azure API | Required Role |
|-----------|---------------|
| Resource Graph | Reader |
| Cost Management | Cost Management Reader |
| Defender for Cloud | Security Reader |
| Resource Health | Reader |
| Azure Monitor | Monitoring Reader |
| Azure Monitor Alerts | Monitoring Reader |
| Log Analytics | Log Analytics Reader |

```bash
# 예시: 구독 레벨에서 Reader 할당
az role assignment create \
  --assignee <api-app-client-id> \
  --role "Reader" \
  --scope /subscriptions/<subscription-id>

# Cost Management Reader
az role assignment create \
  --assignee <api-app-client-id> \
  --role "Cost Management Reader" \
  --scope /subscriptions/<subscription-id>

# Security Reader
az role assignment create \
  --assignee <api-app-client-id> \
  --role "Security Reader" \
  --scope /subscriptions/<subscription-id>

# Monitoring Reader
az role assignment create \
  --assignee <api-app-client-id> \
  --role "Monitoring Reader" \
  --scope /subscriptions/<subscription-id>
```

---

## 3. Domain별 실연동 설정

각 도메인은 독립적인 feature flag로 제어됩니다. 필요한 도메인만 활성화할 수 있습니다.

### 3.1 Cost Management

```env
AZURE_COST_MANAGEMENT_ENABLED=true
AZURE_COST_CACHE_TTL_MS=300000   # 5분 캐시
```

**Required**: `Cost Management Reader` role on subscription

**API 경로**: `/api/cost/summary`, `/api/cost/trend`, `/api/cost/budgets`

**Azure REST API used**:
- `POST /subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`
- `GET /subscriptions/{sub}/providers/Microsoft.Consumption/budgets?api-version=2023-11-01`

### 3.2 Security (Defender for Cloud)

```env
AZURE_SECURITY_ENABLED=true
AZURE_SECURITY_CACHE_TTL_MS=300000
```

**Required**: `Security Reader` role on subscription

**API 경로**: `/api/security/score`, `/api/security/alerts`

**Azure REST API used**:
- `GET /subscriptions/{sub}/providers/Microsoft.Security/secureScores/ascScore?api-version=2020-01-01`
- `GET /subscriptions/{sub}/providers/Microsoft.Security/secureScoreControls?api-version=2020-01-01`
- `GET /subscriptions/{sub}/providers/Microsoft.Security/alerts?api-version=2022-01-01`

### 3.3 Resource Health

```env
AZURE_HEALTH_ENABLED=true
AZURE_HEALTH_CACHE_TTL_MS=120000   # 2분 캐시
```

**Required**: `Reader` role on subscription

**API 경로**: `/api/health/summary`

**Azure REST API used**:
- `GET /subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2024-02-01`

### 3.4 Live Diagram (Azure Monitor)

```env
AZURE_LIVE_DIAGRAM_ENABLED=true
AZURE_LIVE_METRICS_CACHE_TTL_MS=60000
AZURE_MONITOR_ALERTS_CACHE_TTL_MS=60000

# Optional: App Insights for edge metrics
AZURE_APP_INSIGHTS_APP_ID=my-appinsights-component
AZURE_APP_INSIGHTS_CACHE_TTL_MS=60000
```

**Required**: `Monitoring Reader` role on subscription

**API 경로**: `/api/live/snapshot`, `/api/live/stream` (SSE), `/api/live/status`

**Azure REST API used**:
- `GET /{resourceId}/providers/microsoft.insights/metrics?api-version=2024-02-01`
- `GET /subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts?api-version=2023-01-01`

### 3.5 Architecture (Resource Graph)

```env
AZURE_RESOURCE_GRAPH_PAGE_SIZE=1000
AZURE_RESOURCE_GRAPH_CACHE_TTL_MS=60000
```

**Required**: `Reader` role on subscription

### 3.6 Network (Log Analytics)

```env
AZURE_LOG_ANALYTICS_WORKSPACE_ID=<workspace-guid>
AZURE_LOG_ANALYTICS_TABLE=NTANetAnalytics
AZURE_LOG_ANALYTICS_CACHE_TTL_MS=60000
```

**Required**: `Log Analytics Reader` role + Traffic Analytics 활성화

---

## 4. Architecture Overview

```
Browser (Next.js 16, React 19)
  │
  │  MSAL v5 → Bearer Token
  │
  ├──→ GET /api/cost/summary ──→ Cost Management REST
  ├──→ GET /api/security/score ──→ Defender for Cloud REST
  ├──→ GET /api/health/summary ──→ Resource Health REST
  ├──→ GET /api/live/snapshot ──→ Azure Monitor Metrics + Alerts
  │
  └──→ Express API (port 4000)
        │
        ├── middleware/subscriptionContext.ts (구독 파싱)
        ├── middleware/requestId.ts (X-Request-Id)
        │
        ├── infra/
        │   ├── oboTokenPool.ts (OBO credential 풀)
        │   ├── cacheManager.ts (LRU 캐시, bearerKey 기반)
        │   └── azureClientFactory.ts (ARM/LogAnalytics fetcher)
        │
        ├── routes/ (도메인별 라우트 모듈)
        │   ├── cost.ts, security.ts, health.ts
        │   ├── architecture.ts, network.ts
        │   └── liveDiagram.ts
        │
        └── services/ (Azure API 통합)
            ├── cost.ts, security.ts, health.ts
            ├── metricsCollector.ts, healthCalculator.ts
            ├── appInsightsCollector.ts, alertsCollector.ts
            └── liveAggregator.ts
```

### Data Flow (예: Security Score)

```
1. Browser: MSAL acquireTokenSilent() → bearer token
2. Browser: GET /api/security/score (Authorization: Bearer <token>)
3. API: middleware extracts bearer → req.auth.bearerToken
4. API: tryGetSecureScore()
   a. bearerKeyPrefix(token) → cache key
   b. CacheManager.get() → cache hit? return
   c. OBOTokenPool.getArmToken() → ARM access token
   d. fetch('management.azure.com/.../secureScores')
   e. CacheManager.set() → cache result
5. API: real data → res.json(data)
   OR: catch → res.json(mockSecureScore)
6. Browser: renders Secure Score gauge
```

### Mock Fallback Pattern

모든 도메인은 동일한 패턴을 따릅니다:

```typescript
router.get("/api/{domain}/{endpoint}", (req, res) => {
  tryGet{Domain}(env, req.auth?.bearerToken, opts)
    .then((data) => res.json(data ?? mock{Domain}))
    .catch((e) => res.json({ ...mock{Domain}, note: e.message }));
});
```

- `tryGet*()` → Azure API 호출 시도
- 실패 시 → mock 데이터 + `note` 필드에 에러 메시지
- `AZURE_*_ENABLED=false` → mock 데이터만 반환 (Azure 호출 없음)

---

## 5. Live Diagram — DiagramSpec 커스터마이징

Live Diagram은 JSON DiagramSpec으로 노드/엣지/바인딩을 정의합니다.

### DiagramSpec 구조

```json
{
  "version": "1.0",
  "id": "my-infra",
  "name": "My Infrastructure",
  "nodes": [
    {
      "id": "aks",
      "label": "AKS Platform",
      "icon": "aks",
      "azureResourceId": "/subscriptions/.../managedClusters/aks-prod",
      "position": { "x": 400, "y": 120 },
      "bindings": {
        "cpu": { "source": "monitor", "metric": "node_cpu_usage_percentage", "aggregation": "avg" },
        "health": {
          "source": "composite",
          "rules": [
            { "metric": "cpu", "op": "<", "threshold": 80, "weight": 0.5 },
            { "metric": "memory", "op": "<", "threshold": 85, "weight": 0.5 }
          ]
        }
      }
    }
  ],
  "edges": [
    {
      "id": "appgw->aks",
      "source": "appgw",
      "target": "aks",
      "bindings": {
        "throughput": { "source": "monitor", "metric": "ByteCount", "aggregation": "total" }
      },
      "animation": "flow"
    }
  ],
  "settings": {
    "refreshIntervalSec": 30,
    "defaultTimeRange": "5m",
    "layout": "manual"
  }
}
```

### Custom DiagramSpec 등록

```bash
# POST로 커스텀 DiagramSpec 저장
curl -X POST http://localhost:4000/api/live/diagrams \
  -H "Content-Type: application/json" \
  -d @my-diagram.json

# 확인
curl http://localhost:4000/api/live/diagrams

# 스냅샷 조회
curl "http://localhost:4000/api/live/snapshot?diagramId=my-infra"
```

### Metric Binding Sources

| Source | Description | Example |
|--------|-------------|---------|
| `monitor` | Azure Monitor Metrics REST | `{ source: "monitor", metric: "Percentage CPU", aggregation: "avg" }` |
| `appInsights` | Application Insights metrics | `{ source: "appInsights", metric: "requests/failed", aggregation: "rate" }` |
| `composite` | Health rules (weighted evaluation) | `{ source: "composite", rules: [...] }` |
| `logAnalytics` | KQL query (Phase 3) | `{ source: "logAnalytics", kql: "..." }` |

---

## 6. Troubleshooting

### API returns mock data instead of real data

1. 해당 도메인의 `AZURE_*_ENABLED=true` 설정 확인
2. `AZURE_AD_TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` 설정 확인
3. `AZURE_SUBSCRIPTION_IDS` 설정 확인
4. API 응답의 `note` 필드에서 에러 메시지 확인

### CORS error

```env
CORS_ORIGIN=http://localhost:3000
```

### OBO token error

- API App Registration에 `Azure Service Management > user_impersonation` delegated 권한 추가
- Admin consent 완료 확인
- Client secret 만료 여부 확인

### Live Diagram shows all "unknown" health

- `AZURE_LIVE_DIAGRAM_ENABLED=true` 확인
- DiagramSpec의 `azureResourceId`가 실제 Azure 리소스 ID와 일치하는지 확인
- `/api/live/status` 엔드포인트로 설정 상태 확인

### Build errors

```bash
# Typecheck
npm run typecheck

# 캐시 초기화
rm -rf apps/web/.next
npm run build
```

---

## 7. Production Deployment

### Environment Variables (Production)

```env
# Web
NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=https://app.yourdomain.com

# API
CORS_ORIGIN=https://app.yourdomain.com
PORT=4000

# All domain flags
AZURE_COST_MANAGEMENT_ENABLED=true
AZURE_SECURITY_ENABLED=true
AZURE_HEALTH_ENABLED=true
AZURE_LIVE_DIAGRAM_ENABLED=true
```

### Build

```bash
npm run build
```

- API: `apps/api/dist/` (Node.js)
- Web: `apps/web/.next/` (Next.js standalone)

### Docker (예시)

```dockerfile
# API
FROM node:20-slim
WORKDIR /app
COPY apps/api/dist ./dist
COPY apps/api/package.json .
COPY node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

---

## 8. 현재 구현 상태

| Domain | API Service | Routes | Mock Data | Frontend Page | Azure API |
|--------|------------|--------|-----------|---------------|-----------|
| Architecture | `azure.ts` | `/api/graph/*` | Yes | `/architecture` | Resource Graph |
| Network | `network.ts` | `/api/network/*` | Yes | `/network` | Log Analytics |
| Cost | `cost.ts` | `/api/cost/*` | Yes | `/cost` | Cost Management |
| Security | `security.ts` | `/api/security/*` | Yes | `/security` | Defender |
| Health | `health.ts` | `/api/health/*` | Yes | `/health` | Resource Health |
| Live Diagram | `liveAggregator.ts` | `/api/live/*` | Yes | `/live-diagram` | Monitor + Alerts |
| Reservations | `reservations.ts` | `/api/reservations/*` | Yes | (architecture내) | Consumption |
| ArgoCD | `argocd.ts` | `/api/argocd/*` | N/A | `/argocd` | ArgoCD REST |
