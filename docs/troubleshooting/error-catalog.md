# 에러 카탈로그

> 프로젝트 전체에서 발생한 주요 에러 케이스, 원인, 해결 방법을 도메인별로 정리한 문서입니다.
> 새로운 에러 발생 시 해당 도메인 섹션에 추가합니다.

---

## 목차

1. [Hubble (Cilium 네트워크)](#1-hubble-cilium-네트워크)
2. [Observability (Container Insights / Prometheus)](#2-observability)
3. [Azure 인증 / OBO](#3-azure-인증--obo)
4. [Kubernetes API](#4-kubernetes-api)
5. [프론트엔드 (Next.js / React)](#5-프론트엔드)
6. [보안 (Defender for Cloud)](#6-보안-defender-for-cloud)

---

## 1. Hubble (Cilium 네트워크)

> 상세: [observability/hubble-troubleshooting.md](../observability/hubble-troubleshooting.md)

### HUB-001: exec 500 에러
- **에러**: `{"error":"service_map_failed","message":"exec failed: command terminated with exit code 1"}`
- **원인**: cilium-agent pod에서 `hubble observe --server relay:443` 실행 시 mTLS 인증 실패
- **해결**: 로컬 소켓(`/var/run/cilium/hubble.sock`) 경유 전략으로 변경

### HUB-002: `cilium hubble` 명령 불가
- **에러**: `unknown command "hubble" for "cilium-dbg"`
- **원인**: Cilium 1.17에서 CLI 리네이밍 (`cilium` → `cilium-dbg`, `hubble` 별도 바이너리)
- **해결**: `cilium hubble observe` → `hubble observe` 직접 호출

### HUB-003: TLS 플래그 미지원
- **에러**: `unknown flag: --tls-allow-server-name`
- **원인**: AKS 포함 hubble CLI 버전에 해당 플래그 없음
- **해결**: TLS 플래그 제거, 로컬 소켓 우선 전략

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

## 3. Azure 인증 / OBO

### AUTH-001: AADSTS65001 — 동의 누락
- **에러**: `AADSTS65001: The user or administrator has not consented to use the application`
- **원인**: API App Registration에 대한 admin consent 미완료
- **해결**: Azure Portal → App Registration → API Permissions → Grant admin consent

### AUTH-002: OBO 토큰 교환 실패
- **에러**: `AADSTS50013: Assertion failed signature validation`
- **원인**: API와 Web의 App Registration audience/scope 불일치
- **해결**: API의 `AZURE_AD_API_SCOPE`와 Web의 `loginRequest.scopes` 일치 확인

### AUTH-003: ECONNRESET
- **에러**: `read ECONNRESET` (Azure SDK 호출 시)
- **원인**: 네트워크 불안정 또는 Azure 서비스 일시적 장애
- **해결**: OBO token pool에 retry 로직 포함, 요청 타임아웃 설정

### AUTH-004: 로그인 버튼이 동작하지 않음 — AADSTS900144 (client_id 누락)
- **증상**: 로그인 팝업이 `AADSTS900144: The request body must contain the following parameter: 'client_id'`로 끝나거나 `/common` 권한으로 열림
- **원인**: Next.js는 앱 디렉터리(`apps/web`)의 `.env`만 읽는데 환경 파일은 저장소 루트에만 있어, 브라우저 번들의 `NEXT_PUBLIC_AZURE_AD_*`가 빈 값
- **해결**: `apps/web/next.config.ts`가 루트 `.env*`를 `processEnv`로 반영하고 `NEXT_PUBLIC_*`를 `env`로 넘겨 인라인. 변경 후 dev 서버 재시작 필요. 확인: 번들에 `"TURBOPACK compile-time value"`로 clientId가 들어 있는지

### AUTH-005: 로그인 팝업에서 계정 선택 후 60초 뒤 `timed_out`
- **에러**: `BrowserAuthError: timed_out` (`redirect_bridge_timeout`), 팝업이 닫히지 않음
- **원인**: MSAL v5는 팝업 응답을 BroadcastChannel(redirect bridge)로만 받음. 리디렉트 URI 페이지가 `broadcastResponseToMainFrame()`을 호출하지 않으면 원래 창이 응답을 받지 못함 (v2/v3의 팝업 URL 감시 방식은 제거됨)
- **해결**: `apps/web/src/app/providers.tsx`가 모듈 로드 시 URL에 인증 응답(`state` + `code|error`)이 있으면 `@azure/msal-browser/redirect-bridge`의 `broadcastResponseToMainFrame()`을 호출하고 앱을 렌더링하지 않음. 리디렉트 URI(`NEXT_PUBLIC_AZURE_AD_REDIRECT_URI`)는 Entra 앱 등록의 **SPA** 플랫폼에 등록되어 있어야 함

---

## 4. Kubernetes API

### K8S-001: Kubeconfig 획득 실패
- **에러**: `Failed to get cluster credentials`
- **원인**: Service Principal에 AKS `Azure Kubernetes Service Cluster User Role` 미할당
- **해결**: RBAC 역할 할당 확인 (`az role assignment list`)

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
- **원인**: `/api/security/posture`는 로그인 사용자 권한(OBO)으로만 실데이터를 읽음. 비로그인이면 mock(`source:"mock"`)
- **해결**: 로그인. 사용자에게 구독의 **Security Reader**(또는 Reader) 권한이 있어야 함. 로컬 검증에서만 `AZURE_SECURITY_SP_FALLBACK=true`로 서비스 주체 사용 가능(기본 false — 운영에서 켜지 말 것)

### SEC-002: 보안 화면에 '일부 데이터를 가져오지 못했습니다'
- **원인**: Resource Graph 6개 쿼리 중 일부 실패(권한·스로틀링 429) — 실패 섹션은 `gaps`로 오고 화면에 '수집 실패'로 표시(0건으로 표시하지 않음)
- **해결**: API 로그(`[posture]`, `AUD_DEBUG=true`)와 응답 `gaps[].message` 확인(구독 ID는 `[scope]`로 마스킹됨). 5분 캐시(`AZURE_SECURITY_CACHE_TTL_MS`) 후 재시도

### SEC-003: 통합 위험에 '근거 있는 연결이 없습니다' 또는 '미확인'만 나옴
- **원인**: 연결은 근거가 있을 때만 만듦 — ① 클러스터가 선택한 구독의 구성도에 없음(`clusterNotInGraph`), ② Hubble 관측 없음(`hubble`)이나 Azure PaaS 목록 실패(`azureMatch`), ③ Defender 샘플(권고당 최대 5개) 밖의 리소스, ④ 같은 키 후보가 둘 이상(모호), ⑤ 비로그인(예시 데이터는 조인하지 않음)
- **해결**: 화면 위 '미확인' 알림의 항목부터 확인. 클러스터와 같은 구독을 고르고, AKS 보안 점검의 Hubble 상태를 확인. 연결 0건은 '안전'을 뜻하지 않으며 하단 '연결 근거가 없는 항목'에서 원 화면으로 이동

---

## 에러 추가 가이드

새로운 에러 발견 시 아래 포맷으로 추가:

```markdown
### [도메인]-[번호]: 간략 제목
- **에러**: 에러 메시지 (코드 블록)
- **원인**: 근본 원인 1줄
- **해결**: 해결 방법 1줄
```

도메인 접두사: `HUB` (Hubble), `OBS` (Observability), `AUTH` (인증), `K8S` (Kubernetes), `FE` (프론트엔드), `NET` (Network), `COST` (Cost), `SEC` (Security)

---

*최종 업데이트: 2026-10-08*
