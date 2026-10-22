---
status: current
owner: platform
last-verified: 2026-10-22
covers: [.env.example, package.json, apps/api/src/env.ts, apps/web/src/lib/runtimeConfig.ts]
---
# 개발 환경 설정 — 빠른 시작

로컬 PC에서 API(:4000)와 웹(:3000)을 띄워 화면을 보고, 로그인·Azure 읽기까지 붙이는 절차입니다. 운영 배포는 [container.md](../deployment/container.md)(온프레미스 Docker)·[kubernetes.md](../deployment/kubernetes.md)(AKS), 화면 목록은 [`CLAUDE.md`](../../CLAUDE.md)의 Web Pages 또는 [`navConfig.ts`](../../apps/web/src/lib/navConfig.ts)가 기준입니다.

## 1. 예시 데이터로 바로 보기 (Azure 없이)

준비: Node.js 24, npm, Git.

```bash
npm install
cp .env.example .env          # 값이 YOUR_* 그대로여도 시작됨
npm run dev                   # api(:4000) + web(:3000) 동시 시작
curl http://127.0.0.1:4000/healthz   # {"ok":true,...} — API는 루프백(API_BIND_HOST=127.0.0.1)에서만 들음
```

브라우저 `http://localhost:3000` — **로그인하지 않은 사용자는 예시 데이터**(`source:"mock"`, 화면 상단 '예시 데이터' 배너, 응답 `note:"signin_required"`)를 봅니다. 로그인한 사용자에게는 예시 데이터를 주지 않습니다(실제 값 또는 상태 — 권한 없음·미설정).

## 2. 로그인 붙이기 (Entra 앱 등록 2개)

홈 테넌트에 앱 두 개를 등록합니다. 앱 역할(`AUD.Viewer/Operator/Admin`)과 할당은 [sso.md](../integrations/azure/sso.md).

**`aud-api` (API — 토큰 대상 + 플랫폼 신원)**

1. App registrations → New registration → 이 디렉터리만, 리디렉션 없음
2. **Expose an API** → Application ID URI `api://<aud-api-client-id>` → 범위 **`Azure.Read.All`** 추가(API가 받는 범위 `AUD_AUTH_SCOPES` 기본값)
3. 플랫폼 자격 증명: 인증서(권장, `AUD_PLATFORM_CERT_PATH`) 또는 비밀 값(`AZURE_AD_CLIENT_SECRET`) — 운영 AKS는 워크로드 ID(비밀 없음, [kubernetes.md](../deployment/kubernetes.md))
4. `delegated` 연결(사용자 OBO)을 쓸 때만 API permissions에 `Azure Service Management` › `user_impersonation`(+ 관리자 동의). 기본 `platform` 연결에는 필요 없음

**`aud-web` (SPA)**

1. New registration → 플랫폼 **Single-page application**, 리디렉션 URI `http://localhost:3000` (운영 호스트는 `https://<host>/` 추가)
2. API permissions → My APIs → `aud-api` → **`Azure.Read.All`** → 관리자 동의

**`.env`**

| 변수 | 값 |
|---|---|
| `NEXT_PUBLIC_AZURE_AD_TENANT_ID` · `NEXT_PUBLIC_AZURE_AD_CLIENT_ID` | 홈 테넌트 · `aud-web` (개발용 — 웹 dev 서버가 빌드에 넣음, 바꾸면 재시작. 컨테이너는 `AUD_WEB_*`를 실행 시 읽음) |
| `NEXT_PUBLIC_AZURE_AD_API_SCOPE` | `api://<aud-api-client-id>/Azure.Read.All` |
| `AZURE_AD_TENANT_ID` · `AZURE_AD_CLIENT_ID` | 홈 테넌트 · `aud-api` (토큰 검증 대상) |
| `AZURE_AD_CLIENT_SECRET` 또는 `AUD_PLATFORM_CERT_PATH` | 플랫폼 자격 증명 (`AUD_PLATFORM_CREDENTIAL`로 고정 가능) |
| `AUD_DEFAULT_ROLE` | 앱 역할이 없을 때 역할 — 개발 기본 `viewer`, 운영은 `none`만 |

## 3. Azure 읽기 붙이기 (연결)

Azure는 **사용자 권한이 아니라 연결의 자격 증명**으로 읽습니다. 홈 구독만이면 `AZURE_SUBSCRIPTION_IDS`(허용 목록)와 홈 자격 증명에 역할을 주면 끝입니다. 고객 테넌트는 연결 파일(`AUD_CONNECTIONS_FILE`) — [connect-tenant.md](../integrations/azure/connect-tenant.md).

- 필요한 역할: [permissions.md](../integrations/azure/permissions.md) (화면별 필수·선택). 확인: 설정 › Azure 연결 › 점검(관리자) 또는 [verify.md](../integrations/azure/verify.md)
- 기능 스위치: 비용·보안·리소스 상태는 기본 켜짐(`AZURE_*_ENABLED=false`면 끔), 라이브 다이어그램 `AZURE_LIVE_DIAGRAM_ENABLED`, VNet 트래픽 `AZURE_LOG_ANALYTICS_WORKSPACE_ID` — 모두 [`.env.example`](../../.env.example) 주석
- AKS 클러스터 안(객체·정책·Pod 로그·Hubble)은 클러스터에 닿는 곳에서만 — 프라이빗 클러스터는 PC에서 `cluster_dns_unresolved`가 정상([aks.md](../integrations/azure/aks.md))

리소스 공급자가 등록되지 않은 구독은 일부 API가 실패합니다:

```bash
for ns in Microsoft.ResourceGraph Microsoft.CostManagement Microsoft.Security Microsoft.ResourceHealth \
          Microsoft.Insights Microsoft.AlertsManagement Microsoft.Consumption; do
  az provider show --namespace "$ns" --query "[namespace, registrationState]" -o tsv
done
# 미등록이면: az provider register --namespace <ns>   (구독 기여자 이상 — 읽기 전용 계정은 관리자에게 요청)
```

## 4. 코드 구조 한눈에

| 경로 | 역할 |
|---|---|
| `packages/types/` | 공유 타입 (`@aud/types`) |
| `apps/api/src/infra/` | 토큰 검증(`tokenVerifier`)·플랫폼 역할(`platformAccess`)·연결(`connectionRegistry`·`connectionCredentials`)·Azure 호출(`azureClientFactory`)·캐시 |
| `apps/api/src/middleware/` | `requestId`·`authorize`(역할·연결 접근·감사) |
| `apps/api/src/routes/` · `services/` | 도메인 라우트 · 비즈니스 로직 |
| `apps/web/src/` | Next.js 페이지·컴포넌트·순수 모듈(`lib/`) |

예시 데이터는 익명 요청에만: 라우트가 `respondWithFallback`/`respondLiveOrSignin`(`infra/requestParams.ts`)으로 응답합니다.

## 5. 확인·문제 해결

```bash
npm run typecheck                 # 양쪽 --noEmit
npm test --workspace apps/api     # 단위 테스트 (node:test + tsx)
```

| 증상 | 확인 |
|---|---|
| 로그인 후에도 예시 데이터 | 토큰이 API에 안 감 — 웹 `NEXT_PUBLIC_AZURE_AD_API_SCOPE`·dev 서버 재시작 ([error-catalog](../troubleshooting/error-catalog.md) AUTH) |
| 403 `no_platform_role` | 앱 역할 미할당 (개발은 `AUD_DEFAULT_ROLE=viewer`) |
| CORS 오류 | `CORS_ORIGIN`에 웹 주소 |
| 연결 오류 `connection_*` | 설정 › Azure 연결 › 점검 — 코드별 조치는 [troubleshooting.md](../integrations/azure/troubleshooting.md) |
