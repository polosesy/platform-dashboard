---
status: current
owner: platform
last-verified: 2026-10-29
covers: [apps/api/src/infra/connectionCredentials.ts, apps/api/src/services/aksAccess.ts]
---
# 에러 카탈로그

> 프로젝트 전체에서 발생한 주요 에러 케이스, 원인, 해결 방법을 도메인별로 정리한 문서입니다.
> 새로운 에러 발생 시 해당 도메인 섹션에 추가합니다.

---

## 목차

1. [Hubble (Cilium 네트워크)](#1-hubble-cilium-네트워크)
2. [Observability (Container Insights / Prometheus)](#2-observability)
3. [Azure 인증 · 플랫폼 역할](#3-azure-인증--플랫폼-역할)
4. [Kubernetes API](#4-kubernetes-api)
5. [프론트엔드 (Next.js / React)](#5-프론트엔드)
6. [보안 (Defender for Cloud)](#6-보안-defender-for-cloud)
7. [Azure 연결 (Connection)](#7-azure-연결-connection)
8. [VNet 트래픽 (Flow Log)](#8-vnet-트래픽-flow-log)
9. [리소스 상태 (Service Health 번역)](#9-리소스-상태-service-health-번역)

---

## 1. Hubble (Cilium 네트워크)

> 상세: [observability/hubble-troubleshooting.md](../observability/hubble-troubleshooting.md)

### HUB-001: exec 500 에러
- **에러**: `{"error":"service_map_failed","message":"exec failed: command terminated with exit code 1"}`
- **원인**: cilium-agent pod에서 `hubble observe --server relay:443` 실행 시 mTLS 인증 실패
- **해결**: 모든 노드의 로컬 소켓(`/var/run/cilium/hubble.sock`) 팬아웃 + 병합(`hubbleMerge.ts`)으로 변경

### HUB-002: `cilium hubble` 명령 불가
- **에러**: `unknown command "hubble" for "cilium-dbg"`
- **원인**: Cilium 1.17에서 CLI 리네이밍 (`cilium` → `cilium-dbg`, `hubble` 별도 바이너리)
- **해결**: `cilium hubble observe` → `hubble observe` 직접 호출

### HUB-003: TLS 플래그 미지원
- **에러**: `unknown flag: --tls-allow-server-name`
- **원인**: AKS 포함 hubble CLI 버전에 해당 플래그 없음
- **해결**: TLS 플래그 제거, 전 노드 로컬 소켓 팬아웃

### HUB-004: flows 0건 (Hubble 활성 상태)
- **증상**: `Hubble: Ok, Flows/s: 43.63` 이지만 UI에 0건
- **원인**: `cilium hubble observe` 명령 에러가 stdout으로 출력 → JSON 파싱 실패 → 0건
- **해결**: `hubble observe` 직접 호출 + 파싱 에러 로깅 강화

### HUB-005: Source/Destination "unknown"
- **증상**: Flows 탭에서 source/destination이 "unknown"
- **원인**: Cilium reserved identity (host, world, remote-node)는 namespace/podName 없음
- **해결**: `parseEndpoint`에서 reserved identity 라벨 + `workloads` 배열로 이름 매핑

---

## 2. Observability

### OBS-001: KQL SEM0525 타입 불일치
- **에러**: `column_ifexists` 함수의 int/string coalesce 타입 에러
- **원인**: AMA agent 버전에 따라 ContainerLogV2 스키마가 다름 (일부 컬럼 int vs string)
- **해결**: `column_ifexists(colName, defaultValue)` 사용 시 동일 타입 기본값 지정

### OBS-002: Workspace 자동 탐색 실패
- **에러**: `Log Analytics workspace not found for cluster`
- **원인**: AKS 클러스터에 Container Insights 미연동 또는 `AZURE_OBSERVABILITY_ENABLED` 게이트
- **해결**: workspace 자동 탐색 로직 추가, `AZURE_OBSERVABILITY_ENABLED` 게이트 제거

### OBS-003: ContainerLogV2 스키마 호환성
- **에러**: KQL 쿼리 실패 (`column not found`)
- **원인**: AMA agent 유무에 따라 `ContainerLogV2` vs `ContainerLog` 테이블 차이
- **해결**: `ContainerLogV2` 우선 조회 → 실패 시 `ContainerLog` fallback

---

## 3. Azure 인증 · 플랫폼 역할

### AUTH-001: AADSTS65001 — 동의 누락
- **에러**: `AADSTS65001: The user or administrator has not consented to use the application` (화면: `consent_required` 문장 — 원문·앱 ID·추적 ID는 더 이상 노출되지 않음)
- **원인**: 사용자 위임(OBO) 연결(`AUD_HOME_CONNECTION_MODE=delegated` 또는 `mode:"delegated"`)에서 API 앱의 위임 권한(Log Analytics `Data.Read` 등)에 관리자 동의가 없음. 기본 플랫폼 연결에서는 발생하지 않음
- **해결**: 플랫폼 연결을 쓰거나(권장, [overview](../integrations/azure/overview.md)), Azure Portal → App Registration → API Permissions → Grant admin consent

### AUTH-002: 토큰 대상·범위 불일치
- **에러**: `AADSTS50013: Assertion failed signature validation`(delegated OBO) 또는 401 `invalid_token` `reason:aud|scp`
- **원인**: 웹이 요청한 범위와 API가 받는 대상·범위가 다름
- **해결**: 웹 `AUD_WEB_API_SCOPE`(개발: `NEXT_PUBLIC_AZURE_AD_API_SCOPE`, `loginRequestFor`) = `api://<aud-api>/Azure.Read.All`, API `AUD_AUTH_SCOPES`(기본 `Azure.Read.All`)·`AUD_AUTH_AUDIENCES`(기본 `api://<AZURE_AD_CLIENT_ID>`) 일치 확인

### AUTH-003: ECONNRESET
- **에러**: `read ECONNRESET` (Azure 호출 또는 웹 `/api` 프록시)
- **원인**: 네트워크 불안정·Azure 일시 장애, 또는 프록시 타임아웃(웹 rewrite 기본 30초 — `next.config` `experimental.proxyTimeout` 120초로 늘림)
- **해결**: Azure 호출은 fetcher 타임아웃(`azureClientFactory`)으로 끊고 오류로 답함(재시도 없음). 운영에서 끊긴 소켓 ECONNRESET·EPIPE·ECONNABORTED는 프로세스를 종료하지 않음(`infra/lifecycle.ts`)

### AUTH-004: 로그인 버튼이 동작하지 않음 — AADSTS900144 (client_id 누락)
- **증상**: 로그인 팝업이 `AADSTS900144: The request body must contain the following parameter: 'client_id'`로 끝나거나 `/common` 권한으로 열림
- **원인**: Next.js는 앱 디렉터리(`apps/web`)의 `.env`만 읽는데 환경 파일은 저장소 루트에만 있어, 브라우저 번들의 `NEXT_PUBLIC_AZURE_AD_*`가 빈 값
- **해결**: `apps/web/next.config.ts`가 루트 `.env*`를 `processEnv`로 반영하고 `NEXT_PUBLIC_*`를 `env`로 넘겨 인라인. 변경 후 dev 서버 재시작 필요. 확인: 번들에 `"TURBOPACK compile-time value"`로 clientId가 들어 있는지. 컨테이너는 빌드 값이 아니라 실행 시 `AUD_WEB_TENANT_ID`·`AUD_WEB_CLIENT_ID`를 읽음(`runtimeConfig.ts`)

### AUTH-005: 로그인 팝업에서 계정 선택 후 60초 뒤 `timed_out`
- **에러**: `BrowserAuthError: timed_out` (`redirect_bridge_timeout`), 팝업이 닫히지 않음
- **원인**: MSAL v5는 팝업 응답을 BroadcastChannel(redirect bridge)로만 받음. 리디렉트 URI 페이지가 `broadcastResponseToMainFrame()`을 호출하지 않으면 원래 창이 응답을 받지 못함 (v2/v3의 팝업 URL 감시 방식은 제거됨)
- **해결**: `apps/web/src/app/providers.tsx`가 모듈 로드 시 URL에 인증 응답(`state` + `code|error`)이 있으면 `@azure/msal-browser/redirect-bridge`의 `broadcastResponseToMainFrame()`을 호출하고 앱을 렌더링하지 않음. 리디렉트 URI(개발 `NEXT_PUBLIC_AZURE_AD_REDIRECT_URI`, 컨테이너 `AUD_WEB_REDIRECT_URI` — 없으면 페이지 origin)는 Entra 앱 등록의 **SPA** 플랫폼에 등록되어 있어야 함

### AUTH-006: 401 `invalid_token` / `token_expired`
- **증상**: 모든 `/api` 호출이 401, 응답 `{"error":"invalid_token","reason":"aud|iss|signature|kid|tid|malformed"}` 또는 `token_expired`
- **원인**: API가 토큰을 검증함(`infra/tokenVerifier.ts`): 서명(RS256, 테넌트 공개 키) · 발급자(v1/v2) · 대상(`api://<AZURE_AD_CLIENT_ID>` 또는 client id) · 만료(60초 허용) · `scp`(`AUD_AUTH_SCOPES`, 기본 `Azure.Read.All`) · `oid`
- **해결**: `reason`이 가리키는 항목 확인 — `aud`면 웹의 `NEXT_PUBLIC_AZURE_AD_API_SCOPE`가 API 앱의 Application ID URI와 같은지, 다르면 `AUD_AUTH_AUDIENCES`로 지정. `token_expired`면 다시 로그인(웹은 자동으로 재로그인 안내). 위조·만료 토큰은 서비스 주체로 대신 조회되지 않음

### AUTH-007: `signin_required` — 로그인하지 않으면 예시 데이터
- **증상**: 화면에 '예시 데이터 — 로그인하면 실제 데이터', API 응답 `note:"signin_required"` 또는 401 `signin_required`
- **원인**: 익명 호출은 실제 Azure를 읽지 않음(정책). 예전에는 서비스 주체로 실제 인벤토리·kubeconfig까지 읽었음
- **해결**: 로그인. 로컬 개발에서만 `AUD_ANONYMOUS_SP=true`(루프백 바인드 필수, 다른 테넌트가 레지스트리에 있으면 시작 실패), AKS까지는 `AUD_ANONYMOUS_K8S=true`. 응답 헤더 `x-aud-principal: sp-anonymous`로 표시

### AUTH-008: `consent_required` / `interaction_required` / `access_blocked`
- **에러**: OBO 교환 실패 — AADSTS65001(동의 없음) · 50076/50079/50158(MFA·추가 인증) · 53003(조건부 액세스 차단)
- **해결**: 동의는 테넌트 관리자가 API 앱에 admin consent. 추가 인증은 다시 로그인(`claims`가 함께 옴). 차단은 조건부 액세스 정책 확인. 어느 경우에도 서비스 주체로 넘어가지 않음

### AUTH-009: 501 `aad_cluster_unsupported`
- **증상**: AKS 화면·Hubble·정책 점검이 501
- **원인**: **구형** Entra 연동(고객 서버 앱, `aadProfile.managed=false`) 클러스터. AKS 관리형 Entra 클러스터는 이제 연결의 자격 증명으로 받은 Entra 토큰으로 로그인함(`services/aksAccess.ts`, kubelogin 실행 없음)
- **해결**: AKS 관리형 Entra 연동으로 전환. 그 밖의 AKS 코드(`cluster_dns_unresolved`·`aks_rbac_forbidden`·`aks_local_account_refused` …)는 [aks.md §9](../integrations/azure/aks.md#9-문제-해결)

### AUTH-010: `subscription_not_allowed` / `tenant_not_allowed`
- **원인**: 구독이 어떤 연결(`AUD_CONNECTIONS_FILE`, 없으면 `AZURE_SUBSCRIPTION_IDS`)에도 없음 / 토큰의 테넌트가 홈 테넌트가 아님(게스트도 홈 테넌트로 로그인)
- **해결**: [연결 등록](../integrations/azure/connect-tenant.md#연결-등록-플랫폼-관리자) 확인

### AUTH-011: 403 `no_platform_role`
- **원인**: 토큰에 앱 역할(`AUD.Viewer`·`AUD.Operator`·`AUD.Admin`)이 없고 기본 역할이 `none`(프로덕션)
- **해결**: [sso.md](../integrations/azure/sso.md) — `aud-api` 엔터프라이즈 앱에서 사용자·그룹에 역할 할당 → 로그아웃 후 다시 로그인. 개발에서는 `AUD_DEFAULT_ROLE`(기본 `viewer`)

### AUTH-012: 403 `role_required`
- **원인**: 역할이 낮음 — Pod 로그는 운영자, 연결 점검은 관리자
- **해결**: 역할 상향

---

## 4. Kubernetes API

### K8S-001: Kubeconfig 획득 실패 (`aks_credential_forbidden`, 403)
- **에러**: 화면 "이 클러스터의 Azure 연결에 AKS 자격 증명 조회 권한이 없습니다" / API `403 aks_credential_forbidden` (예전: `HTTP 500 … policies_failed … ARM 403: AuthorizationFailed … listClusterUserCredential/action`)
- **원인**: 클러스터를 읽는 **Azure 연결**의 신원(홈 = aud-api SP, 고객 = 그 연결의 서비스 주체)에 kubeconfig 조회 권한이 없음. `listClusterUserCredential`은 읽기(`*/read`)가 아닌 **액션**이라 Reader로는 안 됨
- **해결**: 클러스터 범위에 `Azure Kubernetes Service Cluster User Role`(`4abbcc35-e782-43d8-92c5-2d3f1bd2253f`)을 그 연결의 서비스 주체에 할당 → 설정 › Azure 연결 › 점검의 'AKS 자격 증명'으로 확인 (`docs/integrations/azure/permissions.md`). Entra 클러스터에서는 이 역할로 받는 kubeconfig에 비밀이 없음(서버 주소·CA만 쓰고 로그인은 Entra 토큰). 다음 단계는 Kubernetes 읽기 역할 — 없으면 `403 aks_rbac_forbidden`([aks.md](../integrations/azure/aks.md))
- **예시**: `az role assignment create --assignee <연결의 appId> --role "Azure Kubernetes Service Cluster User Role" --scope <클러스터 리소스 ID>` (고객 테넌트 관리자가 실행 — 플랫폼은 Azure에 쓰지 않음)

### K8S-002: Pod exec 타임아웃
- **에러**: exec 명령이 30초 후 타임아웃
- **원인**: 대상 pod가 응답하지 않거나 컨테이너 이름이 잘못됨
- **해결**: 컨테이너 이름 자동 감지 로직 + 타임아웃 시 부분 결과 반환

---

## 5. 프론트엔드

### FE-001: 인증 토큰 fetch 패턴
- **증상**: API 호출 시 401 에러
- **원인**: `useApiToken` hook의 토큰 갱신 타이밍 이슈
- **해결**: `getApiToken()` → Bearer token 패턴으로 통일

### FE-002: 새 페이지가 메뉴에 표시되지 않음
- **증상**: 새 페이지가 상단 바·드로어에 없음, 또는 `navConfig.test.ts`가 실패
- **원인**: 메뉴는 `apps/web/src/lib/navConfig.ts` 하나에서 상단 바와 드로어가 함께 만들어짐 — 항목 미추가
- **해결**: `NAV_GROUPS`의 알맞은 그룹에 `item(href, key, icon)` 추가 → `i18nMessages.ts`에 `nav.item.<key>`·`nav.desc.<key>` ko/en 추가 → `npm test --workspace apps/api` (페이지 라우트와 메뉴 1:1, 아이콘 중복, 번역 누락 검사)

### FE-003: dev 서버에서 페이지가 무한 새로고침 (Turbopack 패닉)
- **에러**: `FATAL: An unexpected Turbopack error occurred` / HMR `reloadPage`: `Failed to write app endpoint /<page> — Next.js package not found`
- **원인**: 저장소 폴더를 이동한 뒤 `apps/web/.next/dev`(Turbopack 영속 캐시)에 옛 절대 경로(`<old>/node_modules/next`)가 남아 HMR 계산이 매번 실패 → 서버가 `reloadPage` 전송
- **해결**: `npm run dev`의 predev가 `apps/web/.next/.project-root`로 이동을 감지해 캐시를 자동 삭제. 수동: dev 서버 중지 후 `apps/web/.next/dev` 삭제. 워크스페이스 링크 경고가 나오면 `npm install`

### FE-004: 카드·선택 상자 배경이 투명하게 보임
- **증상**: 일부 페이지의 카드가 배경 없이 글자만 보임 (예전 Hubble·AKS 모니터링)
- **원인**: CSS에서 정의되지 않은 변수(`var(--surface)` 등)를 사용 — 브라우저는 오류 없이 투명으로 처리
- **해결**: 토큰은 `apps/web/src/app/globals.css`에만 정의(`--surface`·`--fg`·`--line`은 별칭). `uiConsistency.test.ts`가 정의되지 않은 변수·없는 CSS 모듈 클래스를 잡음. 폰트 변수(`--font-geist-*`)는 `body`에 붙으므로 별칭도 `body`에 선언

### FE-005: 인프라 구성도에 선이 하나도 그려지지 않음 / 박스가 클릭을 가로챔
- **증상**: 노드는 보이는데 선이 없음(콘솔 `error008`), 또는 빈 곳을 눌러도 선택이 해제되지 않음
- **원인**: React Flow 11은 커스텀 노드에 `Handle`이 없으면 선을 만들지 않음. 노드 래퍼(`.react-flow__node`)는 `pointer-events: all`이라 큰 경계 박스가 캔버스를 덮음
- **해결**: `architecture/components/ArchNodes.tsx`의 숨김 `Handle` 유지, 박스 노드는 `style.pointerEvents = "none"`(헤더만 클릭), `elevateNodesOnSelect={false}`. 개발 모드의 경고 `error#002`(nodeTypes)는 React 19 StrictMode가 useMemo를 두 번 실행해 생기는 오탐 — 프로덕션 빌드에서는 0건

### FE-006: 탭이 URL과 어긋남 / 빌드 시 `useSearchParams() should be wrapped in a suspense boundary`
- **증상**: 메뉴에서 같은 화면을 눌러도 탭이 그대로이거나, `next build`가 위 오류로 실패
- **원인**: 탭 상태를 URL에 둘 때 컴포넌트 state로 복사하면 같은 라우트 이동(쿼리 제거)을 놓침. `useSearchParams`는 정적 빌드에서 Suspense 경계가 필요
- **해결**: `useQueryParam(name, allowed, fallback)`(`lib/useQueryParam.ts`) 사용 — 값은 URL에서 매 렌더 읽고, 쓰기는 `history.replaceState`(Next가 감지). 해당 페이지는 `<Suspense>`로 감쌈 (`/policies`, `/security/findings`)

### FE-007: 영어로 바꿨는데 일부 문장이 한국어로 남음
- **증상**: 한영 토글 후에도 정책 점검 결과·위험 조합 제목·Hubble 상태 문구 또는 날짜(오전/오후)가 한국어
- **원인**: ① API가 만드는 문장은 요청의 `lang`으로 정해짐 — 호출에 `lang: locale`이 빠졌거나 쿼리 키에 `locale`이 없어 이전 언어 응답을 재사용. ② 날짜를 `toLocaleString()`(인자 없음)으로 찍으면 브라우저 로캘을 따름
- **해결**: ① `apiUrl(path, { …, lang: locale })` + 쿼리 키에 `:${locale}`, API는 `queryLang(req)` → 동기 빌더는 `withLang`, 캐시 키에 `lang` (`apps/api/src/infra/lang.ts`). ② `toLocaleString(dateLocale(locale))`. 새 화면 문구는 `t()` 키로만 추가 — `apps/api/test/i18n.test.ts`가 웹 코드의 한국어 문자열·없는 키·ko/en 자리표시자 불일치를 잡음

### FE-008: 구성도 PNG 내보내기가 '너무 커서 저장할 수 없습니다'
- **원인**: 브라우저 캔버스 한도(약 16.7MP, 한 변 16,000px) — 전체 리전처럼 큰 화면은 배율 0.5 미만이 되어 중단
- **해결**: 리전이나 표시 범위(카테고리)를 좁히거나 draw.io로 내보내기(크기 제한 없음, 같은 필터·접힘 상태). 노드 1,500개 초과도 같은 안내

---

## 6. 보안 (Defender for Cloud)

### SEC-001: 보안 화면이 '예시 데이터'로만 나옴
- **원인**: `/api/security/posture`는 로그인 사용자에게만 실데이터 — 연결의 자격 증명으로 읽음(delegated 연결만 OBO). 비로그인이면 mock(`source:"mock"`)
- **해결**: 로그인. 연결의 서비스 주체(또는 관리 ID)에 구독의 **Security Reader**(또는 Reader) 권한이 있어야 함. 로컬 검증에서만 `AZURE_SECURITY_SP_FALLBACK=true`로 서비스 주체 사용 가능(기본 false — 운영에서 켜지 말 것)

### SEC-002: 보안 화면에 '일부 데이터를 가져오지 못했습니다'
- **원인**: Resource Graph 6개 쿼리 중 일부 실패(권한·스로틀링 429) — 실패 섹션은 `gaps`로 오고 화면에 '수집 실패'로 표시(0건으로 표시하지 않음)
- **해결**: API 로그(`[posture]`, `AUD_DEBUG=true`)와 응답 `gaps[].message` 확인(구독 ID는 `[scope]`로 마스킹됨). 5분 캐시(`AZURE_SECURITY_CACHE_TTL_MS`) 후 재시도

### SEC-003: 통합 위험에 '근거 있는 연결이 없습니다' 또는 '미확인'만 나옴
- **원인**: 연결은 근거가 있을 때만 만듦 — ① 클러스터가 선택한 구독의 구성도에 없음(`clusterNotInGraph`), ② Hubble 관측 없음(`hubble`)이나 Azure PaaS 목록 실패(`azureMatch`), ③ Defender 샘플(권고당 최대 5개) 밖의 리소스, ④ 같은 키 후보가 둘 이상(모호), ⑤ 비로그인(예시 데이터는 조인하지 않음)
- **해결**: 화면 위 '미확인' 알림의 항목부터 확인. 클러스터와 같은 구독을 고르고, AKS 보안 점검의 Hubble 상태를 확인. 연결 0건은 '안전'을 뜻하지 않으며 하단 '연결 근거가 없는 항목'에서 원 화면으로 이동

---

## 7. Azure 연결 (Connection)

연결 = 플랫폼이 고객 Azure를 읽는 자격 증명 단위 — [docs/integrations/azure](../integrations/azure/overview.md). 화면 문장은 "Azure 연결에 문제가 있습니다"(관리자는 설정 › Azure 연결 › 점검).

### CONN-001: 403 `connection_forbidden`
- **원인**: 요청한 구독의 연결이 내 역할을 허용하지 않음(연결 파일 `roles`)
- **해결**: 연결의 `roles`에 역할 추가, 또는 역할 상향. Azure 호출 전에 막히므로 Azure 쪽 기록은 없음

### CONN-002: 503 `connection_unconfigured`
- **원인**: `secretEnv`가 가리키는 환경 변수 없음 / `AZURE_AD_CLIENT_SECRET`·`AUD_PLATFORM_CERT_PATH` 둘 다 없음
- **해결**: 메시지에 나온 **변수 이름**을 설정하고 API 재시작(값은 메시지에 나오지 않음)

### CONN-003: 503 `connection_credential_invalid`
- **에러**: AADSTS7000215(잘못된 비밀 값) · 7000222(만료) · 700027(인증서 불일치)
- **해결**: [lifecycle.md](../integrations/azure/lifecycle.md) 자격 증명 교체

### CONN-004: 403 `connection_not_consented`
- **에러**: AADSTS700016 — 그 테넌트에 앱(서비스 주체)이 없음
- **해결**: 연결의 `clientId`·`tenantId` 오타 확인, 고객이 `onboard.sh`를 실행했는지 확인

### CONN-005: 502 `connection_tenant_mismatch`
- **원인**: 발급된 토큰의 테넌트가 연결 테넌트와 다름 / AADSTS90002·50020
- **해결**: 연결 파일 `tenantId` 확인 (설정 실수로 다른 테넌트를 읽지 않도록 거부됨)

### CONN-006: 504 `connection_timeout`
- **원인**: 토큰 발급 10초 초과 (네트워크·프록시)
- **해결**: 아웃바운드 `login.microsoftonline.com` 확인 후 재시도

### CONN-007: 502 `connection_failed`
- **원인**: 그 밖의 토큰 실패(메시지는 GUID·추적 ID를 가림)
- **해결**: `AUD_DEBUG=true`로 API 로그 확인, 연결 점검 실행

### CONN-008: `ARM 403: AuthorizationFailed` (화면: 일부 데이터·권한 없음)
- **원인**: 연결의 자격 증명에 그 기능의 역할이 없음
- **해결**: [permissions.md](../integrations/azure/permissions.md)의 역할 부여 → 연결 점검의 기능 표가 `가능`인지 확인

### CONN-009: 503 `connection_federation_mismatch`
- **원인**: 페더레이션 연결(`federation: {kind: "kubernetes"}`)인데 고객 앱의 페더레이션 자격 증명이 플랫폼 서비스 계정 토큰의 발급자·주체와 맞지 않음(AADSTS70021·700211 발급자·700213 주체). 방금 만든 자격 증명은 디렉터리 캐시 때문에 몇 분간 실패할 수 있음
- **해결**: 연결 점검에 나오는 발급자·주체(`AUD_PLATFORM_OIDC_ISSUER`·`AUD_PLATFORM_FEDERATION_SUBJECT`)와 고객 앱의 자격 증명을 대소문자까지 비교, 대상 `api://AzureADTokenExchange` 확인 — [connect-tenant.md](../integrations/azure/connect-tenant.md) B-2

---

## 8. VNet 트래픽 (Flow Log)

### NET-001: '작업 영역을 읽을 권한이 없습니다' (`state: noAccess`)
- **원인**: 연결에 작업 영역의 Log Analytics Reader 없음 (예전 화면의 AADSTS65001 원문 노출은 수정됨 — 이제 코드·문장만)
- **해결**: 작업 영역(또는 구독)에 Log Analytics Reader 부여

### NET-002: 모든 탭이 '기록 없음' (`state: empty`)
- **원인**: ① VNet 흐름 로그가 없거나 Traffic Analytics가 꺼짐 ② NSG 흐름 로그만 있음(옛 테이블 `AzureNetworkAnalytics_CL`로 감 — 이 화면은 집계하지 않음) ③ TA 처리 간격(10/60분)만큼 아직 도착 전
- **해결**: '수집 범위' 탭에서 VNet별 상태 확인 → VNet 흐름 로그 + TA(간격 10분) 켜기. NSG 흐름 로그는 2027-09-30 종료 — [vnet-flow-logs.md](../observability/vnet-flow-logs.md)

### NET-003: '읽을 흐름 로그 작업 영역이 없습니다' (`state: disabled`) 또는 '읽지 않는 작업 영역' 경고
- **원인**: 흐름 로그가 Traffic Analytics를 보내는 작업 영역을 이 구독의 연결이 읽지 않음 — 연결 파일 `logAnalyticsWorkspaces`에 없음(흐름 로그 설정이 안 보이는 연결은 이 목록만 봄). 예전에는 `AZURE_LOG_ANALYTICS_WORKSPACE_ID` 하나만 읽어 연결 파일의 작업 영역을 무시했음
- **해결**: 그 작업 영역의 ID(GUID)를 연결 파일 `logAnalyticsWorkspaces`에 넣고 연결 신원에 Log Analytics Reader. 여러 작업 영역이면 모두 — 한 번의 교차 작업 영역 조회로 함께 읽음

### NET-004: 수집 범위가 '설정 못 읽음' (흐름 로그가 있는데 '없음'으로 보였던 문제)
- **원인**: 흐름 로그 리소스는 `NetworkWatcherRG`에 있음 → 리소스 그룹 몇 개만 Reader인 연결에는 Resource Graph가 빈 결과(오류 아님). 예전 화면은 이것을 '없음'(0/n VNet)으로 보였음
- **해결**: 화면은 이제 '설정 못 읽음' + 작업 영역 기록으로 켜짐을 판정. 처리 간격·보존 기간까지 보려면 `NetworkWatcherRG`에 Reader(또는 `Microsoft.Network/networkWatchers/flowLogs/read`)

---

## 9. 리소스 상태 (Service Health 번역)

### HEALTH-001: 이벤트 탭의 '한' 번역이 '번역 서비스 미설정' / '키 없이 쓰는 무료 번역도 응답하지 않음 (HTTP 429)'
- **원인**: Service Health 이벤트(제목·요약)는 Azure가 영어로만 줌(`Accept-Language` 무시) → 번역기가 필요. `AZURE_TRANSLATOR_KEY`가 없으면 키 없는 Google 엔드포인트로 시도하는데, 비공식이라 서버 주소에서는 짧은 글에도 **429로 막히는 경우가 많음**. (인스턴스 탭의 Resource Health 상태 문구는 번역기와 무관 — `/api/health/summary?lang=ko`가 `Accept-Language: ko-KR`로 읽어 Azure가 직접 한국어로 줌. 단 Azure가 현지화하지 않는 문구(실측 약 1/3)는 영어로 남음)
- **해결**: API 서버 `.env`에 Translator 키를 넣고 API 재시작
  - 전용 Translator 리소스(F0 무료 계층: 월 200만 자) 또는 기존 **다중 서비스 AI Services / Cognitive Services** 리소스의 키(Portal › 리소스 › 키 및 엔드포인트 › 키 1)
  - `AZURE_TRANSLATOR_REGION` = 그 리소스의 지역(예 `koreacentral`). **다중 서비스·지역 리소스는 필수**(없으면 401), 전역(global) Translator만 생략 가능
  - 키는 비밀 값 — 커밋 금지, 로그·응답에 나가지 않음(번역기 오류 본문도 전달하지 않고 상태 코드만)
- **화면 문구별**: '번역 키가 거부됨 (HTTP 401/403)' = 키 값 또는 지역 불일치 · '할당량 초과 (429)' = 가격 계층 한도 · '번역 실패' = 그 밖(시간 초과 10초 등, `AUD_DEBUG=true`로 `[health]` 로그 확인)
- 번역 결과는 문장별로 하루 캐시(키 과금 절약). 비로그인 사용자는 키를 쓰지 않음(예시 이벤트는 내장 번역)

---

## 에러 추가 가이드

새로운 에러 발견 시 아래 포맷으로 추가:

```markdown
### [도메인]-[번호]: 간략 제목
- **에러**: 에러 메시지 (코드 블록)
- **원인**: 근본 원인 1줄
- **해결**: 해결 방법 1줄
```

도메인 접두사: `HUB` (Hubble), `OBS` (Observability), `AUTH` (인증), `K8S` (Kubernetes), `FE` (프론트엔드), `NET` (Network), `COST` (Cost), `SEC` (Security), `HEALTH` (리소스 상태)

---

*최종 업데이트: 2026-10-15*
