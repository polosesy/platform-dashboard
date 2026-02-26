# Azure API Integration & Troubleshooting Guide

> "Failed to load: Failed to fetch" 에러의 원인 분석과 Azure 실연동 설정 가이드

---

## 목차

1. ["Failed to fetch" 에러 원인 분석](#1-failed-to-fetch-에러-원인-분석)
2. [필요한 Azure 리소스 총정리](#2-필요한-azure-리소스-총정리)
3. [Service Principal (SP) 인증 설정](#3-service-principal-sp-인증-설정)
4. [App Registration 설정 (Azure Portal)](#4-app-registration-설정-azure-portal)
5. [RBAC 역할 할당](#5-rbac-역할-할당)
6. [환경변수 설정](#6-환경변수-설정)
7. [도메인별 Azure API 상세](#7-도메인별-azure-api-상세)
8. [연동 검증 체크리스트](#8-연동-검증-체크리스트)
9. [일반적인 에러와 해결 방법](#9-일반적인-에러와-해결-방법)

---

## 1. "Failed to fetch" 에러 원인 분석

### 에러 발생 시나리오

```
Browser Console:
  Failed to load: Failed to fetch
  TypeError: Failed to fetch
```

### 원인 우선순위

| 순위 | 원인 | 확인 방법 |
|------|------|-----------|
| **1** | API 서버가 실행되지 않음 | `curl http://localhost:4000/health` |
| **2** | CORS 설정 불일치 | Browser DevTools → Network 탭 → `Access-Control-Allow-Origin` 확인 |
| **3** | `.env` 파일 누락 또는 잘못된 값 | API 시작 시 Zod validation 에러 확인 |
| **4** | MSAL 로그인 실패 (토큰 없음) | Browser Console에서 MSAL 에러 확인 |
| **5** | OBO 토큰 교환 실패 | API 로그에서 `OBO token exchange failed` 확인 |
| **6** | Azure RBAC 권한 부족 | API 응답의 `note` 필드 확인 |
| **7** | Azure Feature Flag 비활성화 | `.env`에서 `AZURE_*_ENABLED=true` 확인 |

### 빠른 진단

```bash
# 1. API 서버 생존 확인
curl http://localhost:4000/health

# 2. Mock 데이터로 API 동작 확인 (인증 없이)
curl http://localhost:4000/api/cost/summary
curl http://localhost:4000/api/security/score
curl http://localhost:4000/api/health/summary
curl http://localhost:4000/api/live/snapshot

# 3. 응답에 "note" 필드가 있으면 Azure 연동 실패 → mock fallback
# 예: { "note": "OBO token exchange failed: AADSTS..." }
```

---

## 2. 필요한 Azure 리소스 총정리

### 인증 인프라 (필수)

| 리소스 | 용도 | 생성 위치 |
|--------|------|-----------|
| **Azure AD Tenant** | 인증 기반 | 기존 테넌트 사용 |
| **App Registration (API)** | Backend OBO 인증 | Azure AD → App registrations |
| **App Registration (Web)** | Frontend MSAL SPA | Azure AD → App registrations |
| **Client Secret** | API 앱의 자격증명 | API App Registration → Certificates & secrets |

### 데이터 소스 (도메인별)

| Azure API | 사용 도메인 | 필수 여부 | 필요 리소스 |
|-----------|-------------|-----------|-------------|
| **Resource Graph** | Architecture | 핵심 | 구독 내 리소스 존재 |
| **Azure Monitor Metrics** | Live Diagram | 핵심 | 모니터링 대상 리소스 |
| **Alert Management** | Live Diagram | 핵심 | Alert Rule 설정 |
| **Cost Management** | Cost | 선택 | 구독에 비용 발생 |
| **Defender for Cloud** | Security | 선택 | Defender Plan 활성화 |
| **Resource Health** | Health | 선택 | 구독 내 리소스 존재 |
| **Log Analytics** | Network | 선택 | Workspace + Traffic Analytics |
| **Application Insights** | Live Diagram Edge | 선택 | App Insights 인스턴스 |
| **Consumption API** | Reservations | 선택 | RI 보유 시 |

---

## 3. Service Principal (SP) 인증 설정

이 프로젝트는 **OBO (On-Behalf-Of)** 인증 플로우를 사용합니다.

### 인증 흐름

```
사용자 (Browser)
  │
  │ 1. MSAL loginPopup() → Azure AD에 로그인
  │ 2. acquireTokenSilent() → user_impersonation scope 토큰 획득
  │
  ▼
Next.js Frontend (SPA)
  │
  │ 3. Authorization: Bearer <user-token> 헤더로 API 호출
  │
  ▼
Express API (Confidential Client)
  │
  │ 4. OBO Flow: user-token → ARM access-token 교환
  │    ConfidentialClientApplication.acquireTokenOnBehalfOf({
  │      oboAssertion: user-token,
  │      scopes: ["https://management.azure.com/.default"]
  │    })
  │
  │ 5. ARM access-token으로 Azure REST API 호출
  │
  ▼
Azure REST APIs (management.azure.com)
```

### OBO vs Service Principal 직접 인증

| 방식 | 장점 | 단점 |
|------|------|------|
| **OBO (현재 구현)** | 사용자 권한 기반, 감사 로그에 실제 사용자 표시 | 설정 복잡, 2개 App Registration 필요 |
| **SP 직접 (Client Credentials)** | 설정 간단, 1개 App Registration | 모든 호출이 SP 계정으로 기록 |

> 이 프로젝트는 OBO 방식을 사용하므로 **2개의 App Registration**이 필요합니다.

---

## 4. App Registration 설정 (Azure Portal)

### 4.1 API App Registration (Confidential Client)

**Azure Portal → Microsoft Entra ID → App registrations → New registration**

```
Name: aud-api (또는 원하는 이름)
Supported account types: Accounts in this organizational directory only
Redirect URI: (비워둠)
```

#### A) Client Secret 생성

1. `aud-api` → **Certificates & secrets** → **New client secret**
2. Description: `aud-api-secret`, Expires: 24 months
3. **Value 복사** → `.env`의 `AZURE_AD_CLIENT_SECRET`에 저장
   > ⚠️ Secret value는 생성 직후에만 볼 수 있습니다. 즉시 복사하세요.

#### B) API 노출 (Expose an API)

1. `aud-api` → **Expose an API**
2. **Application ID URI** → `api://<aud-api-client-id>` (자동 제안 수락)
3. **Add a scope**:
   ```
   Scope name: user_impersonation
   Who can consent: Admins and users
   Admin consent display name: Access Azure Unified Dashboard API
   Admin consent description: Allows the app to access Azure APIs on behalf of the signed-in user
   State: Enabled
   ```

#### C) API Permissions

1. `aud-api` → **API permissions** → **Add a permission**
2. **APIs my organization uses** → `Azure Service Management` 검색
3. **Delegated permissions** → `user_impersonation` 체크 → **Add permissions**
4. **Grant admin consent for [Tenant]** 클릭 (관리자 권한 필요)

```
최종 API permissions 목록:
┌─────────────────────────────────┬────────────┬──────────────┐
│ API                             │ Permission │ Type         │
├─────────────────────────────────┼────────────┼──────────────┤
│ Azure Service Management        │ user_impersonation │ Delegated │
│ Microsoft Graph (기본)          │ User.Read  │ Delegated    │
└─────────────────────────────────┴────────────┴──────────────┘
```

#### D) 값 기록

| 항목 | 위치 | .env 변수 |
|------|------|-----------|
| Application (client) ID | Overview 페이지 | `AZURE_AD_CLIENT_ID` |
| Directory (tenant) ID | Overview 페이지 | `AZURE_AD_TENANT_ID` |
| Client secret value | Certificates & secrets | `AZURE_AD_CLIENT_SECRET` |

---

### 4.2 Web App Registration (SPA)

**Azure Portal → Microsoft Entra ID → App registrations → New registration**

```
Name: aud-web (또는 원하는 이름)
Supported account types: Accounts in this organizational directory only
Redirect URI: Single-page application (SPA) → http://localhost:3000
```

#### A) Authentication 설정

1. `aud-web` → **Authentication**
2. **Single-page application** 섹션 확인:
   ```
   Redirect URIs:
     http://localhost:3000          (개발)
     https://app.yourdomain.com    (운영 — 추후 추가)
   ```
3. **Implicit grant and hybrid flows**:
   - ☐ Access tokens (체크 안 함 — SPA는 PKCE 사용)
   - ☐ ID tokens (체크 안 함)

#### B) API Permissions

1. `aud-web` → **API permissions** → **Add a permission**
2. **My APIs** → `aud-api` 선택
3. **Delegated permissions** → `user_impersonation` 체크 → **Add permissions**
4. **Grant admin consent for [Tenant]** 클릭

```
최종 API permissions 목록:
┌────────────────────┬────────────────────┬──────────────┐
│ API                │ Permission         │ Type         │
├────────────────────┼────────────────────┼──────────────┤
│ aud-api            │ user_impersonation │ Delegated    │
│ Microsoft Graph    │ User.Read          │ Delegated    │
└────────────────────┴────────────────────┴──────────────┘
```

#### C) 값 기록

| 항목 | .env 변수 |
|------|-----------|
| Application (client) ID | `NEXT_PUBLIC_AZURE_AD_CLIENT_ID` |

---

## 5. RBAC 역할 할당

### 왜 필요한가?

OBO 토큰은 **사용자의 Azure 권한**으로 API를 호출합니다.
따라서 대시보드를 사용하는 **Azure AD 사용자 계정**에 아래 역할이 할당되어야 합니다.

> 또는 Azure AD 그룹에 역할을 할당하고, 사용자를 그룹에 추가하는 방식도 가능합니다.

### 최소 역할 매트릭스

| 도메인 | Azure 역할 | 범위 | Azure CLI |
|--------|-----------|------|-----------|
| Architecture | `Reader` | Subscription | 필수 |
| Live Diagram | `Monitoring Reader` | Subscription | 필수 |
| Cost | `Cost Management Reader` | Subscription | 선택 |
| Security | `Security Reader` | Subscription | 선택 |
| Health | `Reader` | Subscription | 필수 (Reader에 포함) |
| Network | `Log Analytics Reader` | Workspace | 선택 |
| Reservations | `Reader` | Subscription | 필수 (Reader에 포함) |

### Azure CLI로 역할 할당

```bash
# 변수 설정
SUBSCRIPTION_ID="<your-subscription-id>"
USER_OBJECT_ID="<user-or-group-object-id>"

# 1. Reader (Architecture, Health, Reservations 커버)
az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"

# 2. Monitoring Reader (Live Diagram, Monitor Metrics, Alerts)
az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Monitoring Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"

# 3. Cost Management Reader (Cost 도메인)
az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Cost Management Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"

# 4. Security Reader (Defender for Cloud)
az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Security Reader" \
  --scope "/subscriptions/$SUBSCRIPTION_ID"

# 5. Log Analytics Reader (Network — Workspace 범위)
WORKSPACE_RESOURCE_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws-name>"
az role assignment create \
  --assignee "$USER_OBJECT_ID" \
  --role "Log Analytics Reader" \
  --scope "$WORKSPACE_RESOURCE_ID"
```

### Azure Portal에서 역할 할당

1. **Azure Portal → Subscriptions → [구독 선택]**
2. **Access control (IAM)** → **Add** → **Add role assignment**
3. Role: `Reader` → Members: 사용자 또는 그룹 선택 → **Review + assign**
4. 나머지 역할도 동일하게 반복

---

## 6. 환경변수 설정

### 전체 `.env` 파일

```env
# ── Shared ──
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000

# ── API Server ──
PORT=4000
CORS_ORIGIN=http://localhost:3000

# ── Azure AD: Web (SPA) ──
NEXT_PUBLIC_AZURE_AD_TENANT_ID=<your-tenant-id>
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=<aud-web-client-id>
NEXT_PUBLIC_AZURE_AD_REDIRECT_URI=http://localhost:3000
NEXT_PUBLIC_AZURE_AD_API_SCOPE=api://<aud-api-client-id>/user_impersonation

# ── Azure AD: API (Confidential Client) ──
AZURE_AD_TENANT_ID=<your-tenant-id>
AZURE_AD_CLIENT_ID=<aud-api-client-id>
AZURE_AD_CLIENT_SECRET=<aud-api-client-secret-value>

# ── Azure Subscriptions ──
AZURE_SUBSCRIPTION_IDS=<subscription-id-1>,<subscription-id-2>

# ── 도메인별 Feature Flags ──
# 아래 플래그가 false이면 mock 데이터가 반환됩니다.
# 실연동을 원하는 도메인만 true로 설정하세요.
AZURE_COST_MANAGEMENT_ENABLED=true
AZURE_SECURITY_ENABLED=true
AZURE_HEALTH_ENABLED=true
AZURE_LIVE_DIAGRAM_ENABLED=true

# ── Network (Log Analytics) ──
AZURE_LOG_ANALYTICS_WORKSPACE_ID=<workspace-guid>
AZURE_LOG_ANALYTICS_TABLE=NTANetAnalytics

# ── Application Insights (선택) ──
# AZURE_APP_INSIGHTS_APP_ID=<app-insights-component-name>

# ── Reservations ──
# AZURE_RESERVATIONS_GRAIN=monthly

# ── ArgoCD (선택) ──
# ARGOCD_BASE_URL=https://argocd.example.com
# ARGOCD_TOKEN=<argocd-auth-token>

# ── Cache TTL (선택 — 기본값 사용 권장) ──
# AZURE_RESOURCE_GRAPH_CACHE_TTL_MS=60000
# AZURE_COST_CACHE_TTL_MS=300000
# AZURE_SECURITY_CACHE_TTL_MS=300000
# AZURE_HEALTH_CACHE_TTL_MS=120000
# AZURE_LIVE_METRICS_CACHE_TTL_MS=60000
# AZURE_MONITOR_ALERTS_CACHE_TTL_MS=60000
```

### 필수 vs 선택 구분

```
필수 (앱 실행에 필요):
  ✅ NEXT_PUBLIC_API_BASE_URL
  ✅ PORT, CORS_ORIGIN
  ✅ NEXT_PUBLIC_AZURE_AD_TENANT_ID
  ✅ NEXT_PUBLIC_AZURE_AD_CLIENT_ID
  ✅ NEXT_PUBLIC_AZURE_AD_REDIRECT_URI
  ✅ NEXT_PUBLIC_AZURE_AD_API_SCOPE
  ✅ AZURE_AD_TENANT_ID
  ✅ AZURE_AD_CLIENT_ID
  ✅ AZURE_AD_CLIENT_SECRET
  ✅ AZURE_SUBSCRIPTION_IDS

선택 (실연동 시 필요):
  ⬜ AZURE_*_ENABLED flags
  ⬜ AZURE_LOG_ANALYTICS_WORKSPACE_ID
  ⬜ AZURE_APP_INSIGHTS_APP_ID
  ⬜ ARGOCD_BASE_URL, ARGOCD_TOKEN
```

---

## 7. 도메인별 Azure API 상세

### 7.1 Architecture — Resource Graph

```
API: Azure Resource Graph
Endpoint: POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
SDK: @azure/arm-resourcegraph (ResourceGraphClient)
Auth: OBO → ARM token
```

**KQL 쿼리 대상 리소스**:
- `microsoft.network/virtualnetworks` (VNET)
- `microsoft.network/virtualnetworks/subnets` (Subnet)
- `microsoft.network/networkinterfaces` (NIC)
- `microsoft.compute/virtualmachines` (VM)
- `microsoft.containerservice/managedclusters` (AKS)
- `microsoft.network/applicationgateways` (App Gateway)
- `microsoft.network/loadbalancers` (Load Balancer)
- `microsoft.network/privateendpoints` (Private Endpoint)
- `microsoft.storage/storageaccounts` (Storage)
- `microsoft.sql/servers` (SQL Server)

### 7.2 Live Diagram — Azure Monitor

```
API: Azure Monitor Metrics
Endpoint: GET https://management.azure.com/{resourceId}/providers/microsoft.insights/metrics?api-version=2024-02-01
Auth: OBO → ARM token
```

**메트릭 예시**:
- AKS: `node_cpu_usage_percentage`, `node_memory_rss_percentage`
- App Gateway: `Throughput`, `FailedRequests`, `CurrentConnections`
- SQL: `cpu_percent`, `dtu_consumption_percent`
- VM: `Percentage CPU`, `Network In Total`

```
API: Azure Alert Management
Endpoint: GET https://management.azure.com/subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts?api-version=2023-01-01
Filter: properties/essentials/monitorCondition eq 'Fired' and properties/essentials/alertState ne 'Closed'
```

### 7.3 Cost Management

```
API: Cost Management Query
Endpoint: POST https://management.azure.com/subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-11-01
Auth: OBO → ARM token
```

**요청 Body 예시**:
```json
{
  "type": "ActualCost",
  "timeframe": "MonthToDate",
  "dataset": {
    "aggregation": {
      "totalCost": { "name": "Cost", "function": "Sum" }
    },
    "granularity": "Daily"
  }
}
```

### 7.4 Security — Defender for Cloud

```
API: Secure Score
Endpoint: GET /subscriptions/{sub}/providers/Microsoft.Security/secureScores/ascScore?api-version=2020-01-01

API: Score Controls
Endpoint: GET /subscriptions/{sub}/providers/Microsoft.Security/secureScoreControls?api-version=2020-01-01&$expand=definition

API: Security Alerts
Endpoint: GET /subscriptions/{sub}/providers/Microsoft.Security/alerts?api-version=2022-01-01
```

> ⚠️ Defender for Cloud **Free tier**에서도 Secure Score가 제공되지만, 일부 컨트롤은 **Defender Plan 활성화**가 필요합니다.

### 7.5 Resource Health

```
API: Resource Health Availability Statuses
Endpoint: GET /subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2024-02-01&$top=200
```

**Health States**: `Available`, `Degraded`, `Unavailable`, `Unknown`

### 7.6 Network — Log Analytics

```
API: Log Analytics Query
Endpoint: POST https://api.loganalytics.io/v1/workspaces/{workspaceId}/query
Auth: OBO → ARM token (scope: https://api.loganalytics.io/.default)
```

**전제 조건**:
1. Log Analytics Workspace 존재
2. **Traffic Analytics** 활성화 (NSG Flow Logs → Workspace)
3. `NTANetAnalytics` 테이블에 데이터 존재

### 7.7 Application Insights

```
API: Application Insights Metrics (Azure Monitor REST 사용)
Endpoint: GET https://management.azure.com/{appInsightsResourceId}/providers/microsoft.insights/metrics?api-version=2024-02-01
```

**지원 메트릭**:
- `requests/failed`, `requests/count`, `requests/duration`
- `dependencies/duration`, `dependencies/failed`
- `exceptions/count`
- `performanceCounters/requestsPerSecond`

### 7.8 Reservations

```
API: Consumption Reservation Summaries
Endpoint: GET /subscriptions/{sub}/providers/Microsoft.Consumption/reservationSummaries?api-version=2024-08-01&grain=monthly
```

---

## 8. 연동 검증 체크리스트

### Phase 1: Demo Mode (Azure 없이)

```bash
# 1. .env 파일 생성 (최소 설정)
cp .env.example .env
# 기본값 그대로 사용 → 모든 AZURE_*_ENABLED=false

# 2. 앱 실행
npm run dev

# 3. 확인
# http://localhost:3000 접속 → 모든 페이지에서 mock 데이터 표시
# http://localhost:4000/health → { "status": "ok" }
# http://localhost:4000/api/cost/summary → mock 비용 데이터
```

- [ ] API 서버 정상 시작 (port 4000)
- [ ] Web 서버 정상 시작 (port 3000)
- [ ] Overview 페이지 렌더
- [ ] 각 도메인 페이지에서 mock 데이터 표시
- [ ] Live Diagram 페이지에서 mock 토폴로지 표시

### Phase 2: Azure AD 인증

```bash
# .env에 Azure AD 값 설정 후 재시작
npm run dev
```

- [ ] 로그인 버튼 클릭 → Microsoft 로그인 팝업 표시
- [ ] 로그인 성공 → TopNav에 사용자 이름 표시
- [ ] Browser DevTools → Application → Session Storage → MSAL 토큰 존재
- [ ] API 호출 시 `Authorization: Bearer ...` 헤더 전송 (Network 탭)

### Phase 3: Azure API 실연동

```bash
# .env에서 원하는 도메인 활성화
AZURE_COST_MANAGEMENT_ENABLED=true
AZURE_SECURITY_ENABLED=true
AZURE_HEALTH_ENABLED=true
AZURE_LIVE_DIAGRAM_ENABLED=true
```

- [ ] `/api/cost/summary` → 실제 비용 데이터 (note 필드 없음)
- [ ] `/api/security/score` → 실제 Secure Score
- [ ] `/api/health/summary` → 실제 리소스 상태
- [ ] `/api/live/snapshot` → 실제 Monitor 메트릭
- [ ] `/api/live/status` → 설정 상태 확인

### Phase 4: 고급 기능

- [ ] Live Diagram 2D Animated 모드 → 파티클 애니메이션
- [ ] Live Diagram 3D 모드 → Three.js 렌더
- [ ] Fault Ripple 오버레이 → critical 노드 ripple
- [ ] Traffic Heatmap → 엣지 색상 강도

---

## 9. 일반적인 에러와 해결 방법

### AADSTS50011: Reply URL mismatch

```
원인: Web App Registration의 Redirect URI가 실제 URL과 불일치
해결: Azure Portal → aud-web → Authentication → Redirect URIs에 http://localhost:3000 추가
```

### AADSTS65001: User has not consented

```
원인: Admin consent가 부여되지 않음
해결: Azure Portal → aud-web → API permissions → Grant admin consent 클릭
      또는 aud-api에서도 동일하게 Grant admin consent 클릭
```

### AADSTS700024: Client assertion is not within its valid time range

```
원인: Client Secret 만료
해결: aud-api → Certificates & secrets → 새 Client Secret 생성 → .env 업데이트
```

### AADSTS7000215: Invalid client secret provided

```
원인: .env의 AZURE_AD_CLIENT_SECRET 값이 잘못됨
해결: Secret의 "Value"를 사용 (ID가 아닌 Value)
      Secret 생성 직후에만 Value가 표시되므로, 새로 생성 필요할 수 있음
```

### 403 Forbidden — AuthorizationFailed

```json
{
  "error": {
    "code": "AuthorizationFailed",
    "message": "The client '...' does not have authorization to perform action '...' over scope '...'"
  }
}
```

```
원인: 사용자 계정에 해당 Azure 역할이 없음
해결: 섹션 5의 RBAC 역할 할당 수행
```

### Network Error / CORS

```
원인: API의 CORS_ORIGIN이 프론트엔드 URL과 불일치
해결: .env에서 CORS_ORIGIN=http://localhost:3000 확인
      포트가 다르거나 https인 경우 정확히 일치해야 함
```

### API 응답에 `note` 필드 포함

```json
{
  "totalCost": 0,
  "note": "Cost Management query failed: 403 ..."
}
```

```
원인: Azure API 호출 실패 → mock fallback 동작
해결: note의 에러 메시지를 확인하여 해당 문제 해결
      대부분 RBAC 권한 부족 또는 feature flag 미설정
```

### Live Diagram: 모든 노드 "unknown" 상태

```
원인 1: AZURE_LIVE_DIAGRAM_ENABLED=false (mock 데이터)
원인 2: DiagramSpec의 azureResourceId가 실제 리소스와 불일치
원인 3: Monitoring Reader 역할 미할당

확인: curl http://localhost:4000/api/live/status
     → { "enabled": true/false, "subscriptionCount": N }
```

### Log Analytics: 빈 결과

```
원인 1: AZURE_LOG_ANALYTICS_WORKSPACE_ID 미설정
원인 2: Traffic Analytics 미활성화 (NSG Flow Logs 필요)
원인 3: NTANetAnalytics 테이블에 데이터 없음 (Traffic Analytics 활성화 후 최소 10분 대기)
```

---

## 부록: Azure Resource Provider 등록

일부 Azure API는 Resource Provider가 등록되어 있어야 합니다.

```bash
# 필요한 Resource Provider 등록
az provider register --namespace Microsoft.ResourceGraph
az provider register --namespace Microsoft.CostManagement
az provider register --namespace Microsoft.Security
az provider register --namespace Microsoft.ResourceHealth
az provider register --namespace Microsoft.Insights
az provider register --namespace Microsoft.AlertsManagement
az provider register --namespace Microsoft.Consumption

# 등록 상태 확인
az provider show --namespace Microsoft.ResourceGraph --query "registrationState"
```

---

## 부록: 전체 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Next.js 16 + React 19)                        │
│                                                         │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │Overview  │  │Live      │  │Health    │  │Cost     │ │
│  │         │  │Diagram   │  │         │  │         │ │
│  └─────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                         │
│  MSAL v5 (SPA, PKCE) → Bearer Token                   │
└────────────────────┬────────────────────────────────────┘
                     │ Authorization: Bearer <user-token>
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Express API (port 4000)                                │
│                                                         │
│  middleware/          infra/                             │
│  ├─ subscriptionCtx   ├─ oboTokenPool (OBO → ARM)      │
│  └─ requestId         ├─ cacheManager (LRU + TTL)      │
│                       └─ azureClientFactory             │
│                                                         │
│  routes/              services/                         │
│  ├─ cost.ts           ├─ cost.ts          → CostMgmt   │
│  ├─ security.ts       ├─ security.ts      → Defender   │
│  ├─ health.ts         ├─ health.ts        → ResHealth  │
│  ├─ liveDiagram.ts    ├─ liveAggregator.ts→ Monitor    │
│  ├─ architecture.ts   ├─ azure.ts         → ResGraph   │
│  └─ network.ts        ├─ network.ts       → LogAnaly   │
│                       ├─ metricsCollector  → Metrics    │
│                       ├─ alertsCollector   → Alerts     │
│                       └─ appInsightsCol    → AppInsight │
└────────────────────┬────────────────────────────────────┘
                     │ OBO Token → ARM Access Token
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Azure REST APIs (management.azure.com)                 │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ResourceGraph│  │CostManagement│  │Defender Cloud │ │
│  └─────────────┘  └──────────────┘  └───────────────┘ │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │Monitor      │  │ResourceHealth│  │Log Analytics  │ │
│  │Metrics      │  │              │  │               │ │
│  └─────────────┘  └──────────────┘  └───────────────┘ │
│  ┌─────────────┐  ┌──────────────┐                     │
│  │Alert Mgmt   │  │Consumption   │                     │
│  └─────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```
