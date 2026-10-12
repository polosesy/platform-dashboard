# CLAUDE.md

## Project
Azure Unified Dashboard — TypeScript monorepo. Enterprise Azure Operations Platform.
AKS 클러스터 + Azure 리소스의 시각화/모니터링/운영을 단일 대시보드로 통합.

## Structure
| Path | Role |
|------|------|
| `packages/types/` | `@aud/types` — 공유 타입 (14 domain modules) |
| `apps/api/` | Express 4 (port 4000) — Azure SDK, Zod, OBO auth |
| `apps/web/` | Next.js 16 (port 3000) — React 19, ReactFlow, MSAL |
| `apps/api/src/infra/` | OBOTokenPool, CacheManager, AzureClientFactory |
| `apps/api/src/routes/` | 도메인별 라우트 (index.ts 오케스트레이터) |
| `apps/api/src/services/` | 비즈니스 로직 (hubbleClient, hubbleCollector 등) |
| `apps/api/src/middleware/` | subscriptionContext, requestId |
| `docs/` | 운영 가이드, 트러블슈팅, 용어집 |

## Domain Routes (API)
| Route | 타입 모듈 | 설명 |
|-------|-----------|------|
| `/api/azure/*` | `common.ts` | 구독/리소스 목록 |
| `/api/architecture/*` | `architecture.ts` | 리소스 토폴로지 (`source: "mock"`이면 예시 데이터). 공용 IP는 `metadata.attachedTo`(소유자 ARM ID) |
| `/api/live-diagram/*` | `liveDiagram.ts` | 실시간 다이어그램 (ReactFlow) |
| `/api/health/*` | `health.ts` | 리소스 헬스 |
| `/api/network/*` | `network.ts` | NSG/네트워크 플로우 |
| `/api/cost/*` | `cost.ts` | 비용 분석 |
| `/api/security/*` | `security.ts` | 보안 점수/경고 (OBO 전용) |
| `/api/security/posture` | `securityPosture.ts` | Defender 권고·컨트롤·규정 준수·플랜·경고 (Resource Graph `securityresources`, 섹션별 실패는 `gaps`) |
| `/api/kubernetes/*` | `kubernetes.ts` | AKS 클러스터/워크로드 |
| `/api/kubernetes/policies` | `policy.ts` | 클러스터 정책 점검 (PSA·NetworkPolicy·RBAC·VPA/HPA/PDB·리소스) |
| `/api/kubernetes/policies/insights` | `policyInsights.ts` | 위험 조합·공격 경로·권한 행렬·워크로드 네트워크 맵·KBOM |
| `/api/observability/*` | `observability.ts` | Container Insights, Prometheus 메트릭 |
| `/api/hubble/*` | `hubble.ts` | Cilium Hubble 네트워크 플로우 |

## Web Pages
제목·부제는 메뉴에서 온다 — 모든 `page.tsx`는 `PageHeader`(`@/components/ui`)를 쓰고, 제목 = `nav.item.*`, 부제 = `nav.desc.*` (정적 검사: `apps/api/test/uiConsistency.test.ts`)

| 경로 | 메뉴 이름 | 설명 |
|------|-----------|------|
| `/` | 개요 | 메뉴와 같은 구성의 기능 카드 (navConfig에서 생성) |
| `/architecture` | 인프라 구성도 | 구독 전체 draw.io식 구성도 — 리전 › VNet › 서브넷 › 리소스, 인터넷·엣지 레인, PaaS 레인 |
| `/live-diagram` | 라이브 다이어그램 | VNet 1개 실시간 메트릭·알림·장애 파급 |
| `/health` | 리소스 상태 | Service Health · Resource Health |
| `/network` | VNet 트래픽 (NSG) | NSG Flow Log · Traffic Analytics |
| `/hubble` | Pod 트래픽 (Hubble) | Observability의 Hubble 탭과 같은 컴포넌트 |
| `/kubernetes` | AKS 클러스터 | 클러스터 객체 브라우저 |
| `/observability` | AKS 모니터링 | 탭: 개요·워크로드·인프라·로그·Hubble 네트워크 |
| `/security` | 보안 개요 | Defender 점수·심각도별 권고·영역별 위험·위협·보호 범위 |
| `/security/findings` | 보안 권고 | CSPM — 영역 탭(`?domain=`), 권고 행 펼치면 조치 방법·Portal |
| `/security/identity` | ID·권한 | CIEM — IdentityAndAccess 권고 |
| `/security/threats` | 위협 탐지 | Defender 활성 경고 + Free 플랜(탐지 공백) |
| `/security/compliance` | 규정 준수 | 표준별 통과·실패 + Defender 플랜 |
| `/policies` | AKS 보안 점검 | 탭 그룹(`?tab=<패널>`): 위험 개요 · 네트워크 노출 · ID·권한 · 구성 점검 · 인벤토리 (`policies/tabs.ts`) |
| `/cost` | 비용 관리 | 비용 추이·예산·예측 + 예약 인스턴스 사용률 |

**메뉴** (`apps/web/src/lib/navConfig.ts` 단일 설정 → TopNav·Sidebar·홈 카드): 개요 · Azure 리소스(인프라 구성도·라이브 다이어그램·리소스 상태) · 네트워크(VNet 트래픽·Pod 트래픽) · Kubernetes(AKS 클러스터·AKS 모니터링) · 보안(소제목 Azure 보안: 보안 개요·보안 권고·ID·권한·위협 탐지·규정 준수 / 클러스터 보안: AKS 보안 점검) · 비용
- 활성 항목은 최장 접두사 일치 `activeNavItem()` (`/security/findings`에서 `/security`는 비활성)
- 소제목은 `NavItem.section`(i18n 키), 같은 소제목은 연속 배치
- 페이지를 추가하면 메뉴에도 넣어야 `navConfig.test.ts`(경로 ↔ 메뉴 1:1)가 통과

## Commands
| Command | Action |
|---------|--------|
| `npm run dev` | 양쪽 앱 동시 시작 |
| `npm run build` | API tsc → Web next build |
| `npm run typecheck` | 양쪽 --noEmit |
| `npm test --workspace apps/api` | API 단위 테스트 (`node:test` + tsx, `apps/api/test/`) |
| `scripts/gp.sh "<msg>"` | git add → commit → push (자동화) |

## Critical Files
- `packages/types/src/index.ts` — 전체 공유 타입 re-export
- `apps/api/src/routes/index.ts` — registerAllRoutes
- `apps/api/src/infra/oboTokenPool.ts` — OBO credential pool
- `apps/api/src/infra/cacheManager.ts` — LRU cache (bearer key prefix 패턴)
- `apps/api/src/env.ts` — Zod 환경변수 스키마 (불리언은 `envBool` — `z.coerce.boolean` 금지)
- `apps/api/src/infra/requestParams.ts` — 쿼리 파싱, 구독 허용목록·ARM ID 검증, `kqlString`, `respondWithFallback`
- `apps/api/src/infra/azureClientFactory.ts` — ARM/LogAnalytics/Prometheus fetcher (타임아웃, OBO→SP 폴백)
- `apps/web/src/lib/useApiQuery.ts` — 웹 데이터 로딩 공통 훅 (key 기반, stale 응답 무시)
- `apps/web/src/components/ui/` — 공용 UI 키트 (PageHeader·Panel·Tabs·Segmented·Select·Button·Toggle·Notice·SampleDataNotice·Loading/EmptyState·Badge·Stat) + `ui.module.css`
- `apps/web/src/app/globals.css` — 디자인 토큰 (색 `--success/--danger/--warning(-soft)`, 심각도 `--sev-*`, 반경 `--radius-*`, 그림자 `--shadow-*`). 폰트 별칭은 `body`에 선언(next/font 변수가 body에 붙음)

## Hubble (Cilium 네트워크 관측)
- **클라이언트**: `apps/api/src/services/hubbleClient.ts` — K8s exec → `hubble observe`
- **집계**: `apps/api/src/services/hubbleCollector.ts` — Service Map, Network, Security 집계
- **타입**: `packages/types/src/hubble.ts`
- **AKS 환경**: Cilium 1.17+ (`cilium-dbg`, `hubble` 바이너리 분리)
- **접근 전략**: 모든 cilium agent pod(노드당 1개) → `hubble observe` (로컬 소켓 `/var/run/cilium/hubble.sock`) 팬아웃 후 병합
- **병합/중복 제거**: `apps/api/src/services/hubbleMerge.ts` — 관측점(TO_STACK/TO_ENDPOINT)·노드·SNAT 전후 중복 제거, 응답 `coverage`(노드 n/m, 공통 관측 구간)
- **버퍼 한계**: 노드당 링 버퍼 4,095건 → 바쁜 노드는 1~3분치만 보관. 장기 관측은 Flow Log 저장 필요
- **트러블슈팅**: `docs/hubble-troubleshooting.md`

## Cluster Policy (정책 점검)
- **판정 엔진**: `apps/api/src/services/policyAnalyzer.ts` — 순수 함수, 규칙 ID(PSA-/NET-/RBAC-/VPA-/HPA-/PDB-/RES-/SA-)마다 근거 문서 링크
- **수집기**: `apps/api/src/services/k8sPolicyCollector.ts` — K8s API 목록 조회 (VPA·Cilium CRD 없으면 해당 영역만 생략)
- **규칙 추가 시**: analyzer에 규칙 + `apps/api/test/policyAnalyzer.test.ts`에 픽스처 테스트 추가
- **시스템 객체**(kube-*, `system:` 역할, AKS 애드온 라벨)는 점수에서 제외, UI 토글로만 표시
- **인사이트**: `services/policyInsights.ts`(순수) ← `policyInsightsCollector.ts`(인벤토리·정책·Hubble·Azure 병렬, 소스별 실패는 `gaps`)
  - 요인 11개 × 워크로드, 조합 4종(exfil/takeover/standing/vnet) + AKS 로컬 계정 → `issues`(공격 경로 노드·간선·조치)
  - 근거 등급 `obs|perm|cfg|unk` — 모르는 값은 `unk`로만, 위험 색칠 금지
  - "AKS 관리" = 라벨 `kubernetes.azure.com/managedby=aks` 또는 `addonmanager.kubernetes.io/mode`
  - Azure 매칭: `services/azureEndpoints.ts` (Resource Graph + DNS, 공유 IP는 같은 RG·이름으로 판별 후 `sharedIpWith`로 불확실 표시). 구독 ID는 응답에 넣지 않음
  - 테스트: `apps/api/test/policyInsights.test.ts`, 포함 관계 레이아웃 `apps/web/src/lib/nestLayout.ts` → `apps/api/test/nestLayout.test.ts`
  - 웹: `apps/web/src/app/policies/insights/*` — 공통 `Inspector`(상세 카드) 하나를 공격 경로·히트맵·네트워크 맵이 공유

## Infrastructure Diagram (/architecture)
- **모델·레이아웃**: `apps/web/src/lib/archModel.ts` (순수) — `buildArchModel`(흡수·배치·선) → `layoutArch`(헤더 위 중첩 박스, 절대 좌표) → `architecture/utils/toFlow.ts`(React Flow 노드·선)
  - 흡수: NIC→VM, NSG→서브넷/VM 배지, 공용 IP→소유자 배지(VM 없는 NIC는 서브넷), AKS 노드풀 VMSS→AKS. 소유자가 그래프에 없는 공용 IP는 ID의 유형으로 '정리 필요'에 표시(추측 연결 금지)
  - 모든 그래프 노드는 `accounting`의 한 버킷에만 들어간다(테스트로 검증)
  - 선은 구성 기준만: 인터넷 진입·VM 공용 IP·LB/AppGW 백엔드·Private Link·피어링·NAT 아웃바운드·VNet 통합·로그. 관측 트래픽은 별도 레이어(기본 꺼짐, 켤 때만 요청)
- **React Flow 규칙**: 커스텀 노드에 숨김 `Handle` 필수(없으면 선이 안 그려짐), 박스 노드 래퍼 `pointerEvents: none`, `elevateNodesOnSelect={false}`, `minZoom 0.05`, nodeTypes는 모듈 상수. 개발 모드의 경고 002는 React 19 StrictMode 이중 useMemo 때문(프로덕션 0건)
- **테스트**: `apps/api/test/archModel.test.ts` (합성 픽스처 — 실데이터 graph.json은 커밋하지 않음)

## Security (Defender for Cloud)
- **서비스**: `apps/api/src/services/securityPosture.ts` — Resource Graph 6개 쿼리(권고 summarize·점수·컨트롤·규정 준수·플랜·경고), 섹션별 실패는 `gaps`(메시지의 구독 ID·GUID 마스킹), 동시 요청 병합
- **인증**: 로그인 사용자(OBO)만. 비로그인은 mock(`source:"mock"`, 화면에 '예시 데이터' 배너). `AZURE_SECURITY_SP_FALLBACK=true`일 때만 서비스 주체 사용(로컬 검증용), OBO 실패 시 SP로 넘어가지 않음
- **웹**: `app/security/layout.tsx`가 구독 선택·조회를 공유(하위 화면 이동 시 유지). 영역 분류는 Defender `metadata.categories`만 사용, 없으면 '분류 없음'(추측 재분류 금지)
- **테스트**: `apps/api/test/securityPosture.test.ts`

## Env
`.env.example` 참조. 필수: `AZURE_AD_*`, `AZURE_SUBSCRIPTION_IDS`
Hubble: `HUBBLE_ENABLED`, `HUBBLE_RELAY_NAMESPACE`, `HUBBLE_RELAY_PORT`, `HUBBLE_FLOW_LIMIT`
보안: `AZURE_SECURITY_ENABLED`, `AZURE_SECURITY_SP_FALLBACK`(기본 false)

## Coding Patterns
- **타입 추가 흐름**: `packages/types/src/<domain>.ts` → `index.ts` re-export → API/Web에서 import
- **API 라우트 추가**: `routes/<domain>.ts` 생성 → `routes/index.ts`에 등록
- **API import**: 상대 경로는 `.js` 확장자 필수 (`import { x } from "./foo.js"`) — `NodeNext` 모듈, `npm start`(node dist) 실행 조건
- **입력 검증**: `subscriptionId`는 `querySubscriptionId`, ARM 리소스 ID는 `queryArmResourceId`, KQL 값은 `kqlString()` — 문자열 직접 삽입 금지
- **Azure 호출**: raw `fetch` 대신 `getArmFetcherAuto(...).fetchJson/postJson` (타임아웃 포함)
- **캐시**: `CacheManager` + `cachePrefix(token)` 패턴 (사용자별 캐시 격리, TTL은 env `*_CACHE_TTL_MS`)
- **로그**: 진단 로그는 `debug()` (`AUD_DEBUG=true`일 때만 출력), `console.log` 지양
- **웹 데이터 로딩**: `useApiQuery` / `useSubscriptions` / `useAksClusters` 사용, URL은 `apiUrl(path, params)` (`new URL()` 금지 — 브라우저 base가 "")
- **인증**: MSAL (Web) → Bearer token → OBO (API) → Azure SDK
  - MSAL v5 팝업은 redirect bridge 필수 — `providers.tsx`가 팝업 응답을 `broadcastResponseToMainFrame()`로 전달 (error-catalog AUTH-005)
  - 웹은 루트 `.env`를 `next.config.ts`에서 로드해 `NEXT_PUBLIC_*` 인라인 — 값 변경 시 dev 서버 재시작 (AUTH-004)
- **UI 텍스트**: 한국어 기본 (i18n: `useI18n()`, 번역표는 `apps/web/src/lib/i18nMessages.ts`). 고유명사(Azure·AKS·NSG·Hubble)만 영어
- **스타일**: CSS Modules (`styles.module.css`). 페이지 헤더·탭·선택 상자·버튼·알림·빈/로딩 상태는 `@/components/ui`만 사용 (탭은 밑줄 `Tabs`(페이지 섹션)과 `Segmented`(하위 보기) 2종). 색은 토큰(`var(--danger)` 등)으로, 페이지 자체 padding·max-width 금지(AppShell이 담당)
- **URL 상태**: 탭을 URL에 둘 때는 `useQueryParam`(`lib/useQueryParam.ts`, `useSearchParams` 기반 — 페이지를 `<Suspense>`로 감싸야 빌드 통과)

## Docs
| 경로 | 내용 |
|------|------|
| `docs/getting-started/` | setup-guide, azure-integration-guide |
| `docs/architecture/` | GLOSSARY (용어집) |
| `docs/observability/` | instrumentation-guide, hubble-guide, hubble-troubleshooting |
| `docs/troubleshooting/` | error-catalog (도메인별 에러 통합) |

## Session Rules
- 기능 단위로 세션 분리 (10~15턴).
- `/compact` = 수동 컨텍스트 압축 (8~10턴 기점).
- 파일 수정 전 반드시 Read → 내용 확인 후 Edit.
- typecheck (`npx tsc --noEmit`) 수정 후 항상 실행.
- subagent: 세션당 최대 2개 (Explore/Plan 타입만).
