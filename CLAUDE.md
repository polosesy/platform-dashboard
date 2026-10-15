# CLAUDE.md

## Project
Azure Unified Dashboard — TypeScript monorepo. Enterprise Azure Operations Platform.
AKS 클러스터 + Azure 리소스의 시각화/모니터링/운영을 단일 대시보드로 통합.

## Structure
| Path | Role |
|------|------|
| `packages/types/` | `@aud/types` — 공유 타입 (14 domain modules) |
| `apps/api/` | Express 4 (port 4000) — Azure SDK, Zod, SSO 토큰 검증 + 플랫폼 역할 + Azure 연결 |
| `apps/web/` | Next.js 16 (port 3000) — React 19, ReactFlow, MSAL |
| `apps/api/src/infra/` | connectionRegistry·connectionCredentials·platformAccess, AzureClientFactory, CacheManager, OBOTokenPool(delegated) |
| `apps/api/src/routes/` | 도메인별 라우트 (index.ts 오케스트레이터) |
| `apps/api/src/services/` | 비즈니스 로직 (hubbleClient, hubbleCollector 등) |
| `apps/api/src/middleware/` | requestId, authorize(역할·연결 접근·감사) |
| `docs/` | 운영 가이드, 트러블슈팅, 용어집 |

## Domain Routes (API)
| Route | 타입 모듈 | 설명 |
|-------|-----------|------|
| `/api/azure/*`, `/api/me` | `common.ts`·`connection.ts` | 구독 목록, Azure 연결 목록·점검(관리자), 내 역할 |
| `/api/architecture/*` | `architecture.ts` | 리소스 토폴로지 (`source: "mock"`이면 예시 데이터). 공용 IP는 `metadata.attachedTo`(소유자 ARM ID) |
| `/api/live-diagram/*` | `liveDiagram.ts` | 실시간 다이어그램 (ReactFlow) |
| `/api/health/*` | `health.ts` | 리소스 헬스 |
| `/api/network/*` | `network.ts` | `flows`(탭별 KQL)·`coverage`(흐름 로그 수집 범위)·`summary`(구성도 오버레이) |
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
| `/live-diagram` | 라이브 다이어그램 | VNet 1개 실측 메트릭·알림·장애 영향(구성 연결 1홉). 실측 없는 값은 만들지 않음(`coverage`·미측정), 추정 연결은 기본 끔 (`lib/liveScope.ts`) |
| `/health` | 리소스 상태 | Service Health · Resource Health |
| `/network` | VNet 트래픽 (Flow Log) | 탭(`?tab=`): 개요·상위 통신·차단·인터넷·위협·수집 범위 — VNet 흐름 로그 + Traffic Analytics |
| `/hubble` | Pod 트래픽 (Hubble) | Observability의 Hubble 탭과 같은 컴포넌트 |
| `/kubernetes` | AKS 클러스터 | 클러스터 객체 브라우저 |
| `/observability` | AKS 모니터링 | 탭: 개요·워크로드·인프라·로그·Hubble 네트워크 |
| `/security/risk` | 통합 위험 | 클러스터 위험 조합 + 근거로 연결된 Azure 리소스의 Defender 권고·경고 (`lib/riskJoin.ts`, 새 API 없음) |
| `/security` | 보안 개요 | Defender 점수·심각도별 권고·영역별 위험·위협·보호 범위 |
| `/security/findings` | 보안 권고 | CSPM — 영역 탭(`?domain=`), 권고 행 펼치면 조치 방법·Portal |
| `/security/identity` | ID·권한 | CIEM — IdentityAndAccess 권고 |
| `/security/threats` | 위협 탐지 | Defender 활성 경고 + Free 플랜(탐지 공백) |
| `/security/compliance` | 규정 준수 | 표준별 통과·실패 + Defender 플랜 |
| `/policies` | AKS 보안 점검 | 탭 그룹(`?tab=<패널>`): 위험 개요 · 네트워크 노출 · ID·권한 · 구성 점검 · 인벤토리 (`policies/tabs.ts`) |
| `/cost` | 비용 관리 | 비용 추이·예산·예측 + 예약 인스턴스 사용률 |
| `/settings/connections` | Azure 연결 | 연결 목록(방식·구독·작업 영역) + 관리자 점검(토큰·보이는 구독·기능별 권한·과도 권한·작업 영역) |

**메뉴** (`apps/web/src/lib/navConfig.ts` 단일 설정 → TopNav·Sidebar·홈 카드): 개요 · Azure 리소스(인프라 구성도·라이브 다이어그램·리소스 상태) · 네트워크(VNet 트래픽·Pod 트래픽) · Kubernetes(AKS 클러스터·AKS 모니터링) · 보안(소제목 Azure + 클러스터: 통합 위험 / Azure 보안: 보안 개요·보안 권고·ID·권한·위협 탐지·규정 준수 / 클러스터 보안: AKS 보안 점검) · 비용 · 설정(Azure 연결)
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
- `apps/api/src/infra/connectionRegistry.ts` · `connectionCredentials.ts` · `platformAccess.ts` — Azure 연결·자격 증명·플랫폼 역할
- `apps/api/src/infra/oboTokenPool.ts` — OBO credential pool (delegated 연결 전용)
- `apps/api/src/infra/cacheManager.ts` — LRU cache (bearer key prefix 패턴)
- `apps/api/src/env.ts` — Zod 환경변수 스키마 (불리언은 `envBool` — `z.coerce.boolean` 금지)
- `apps/api/src/infra/requestParams.ts` — 쿼리 파싱, 구독 허용목록·ARM ID 검증, `kqlString`, `respondWithFallback`
- `apps/api/src/infra/azureClientFactory.ts` — ARM/LogAnalytics/Prometheus fetcher (타임아웃, OBO→SP 폴백)
- `apps/web/src/lib/useApiQuery.ts` — 웹 데이터 로딩 공통 훅 (key 기반, stale 응답 무시)
- `apps/web/src/components/ui/` — 공용 UI 키트 (PageHeader·Panel·Tabs·Segmented·Select·Button·Toggle·Notice·SampleDataNotice·Loading/EmptyState·Badge·Stat) + `ui.module.css`
- `apps/web/src/app/globals.css` — 디자인 토큰 (색 `--success/--danger/--warning(-soft)`, 심각도 `--sev-*`, 반경 `--radius-*`, 그림자 `--shadow-*`). 폰트 별칭은 `body`에 선언(next/font 변수가 body에 붙음)
  - 색의 원천은 채널 토큰 `--x-rgb`(예: `--danger-rgb`) 하나 — 다른 투명도는 `rgba(var(--x-rgb), a)`. canvas·SVG 속성·D3처럼 CSS 변수를 못 쓰는 곳은 `lib/palette.ts`(`rgba(key, a)`/`hex(key)`)를 쓰고, `apps/api/test/palette.test.ts`가 두 곳의 값이 같음을 검증
  - 남겨 둔 직접 색: 흰 글자·내보내기 배경 (각 파일에 이유 주석)

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
  - 흡수: NIC→VM, NSG→서브넷/VM 배지, 공용 IP→소유자 배지(VM 없는 NIC는 서브넷), AKS 노드풀 VMSS→AKS, Flexible VMSS 인스턴스 VM→VMSS 타일(`instances`, 인스턴스 NIC가 배치·선 도착). 소유자가 그래프에 없는 공용 IP는 ID의 유형으로 '정리 필요'에 표시(추측 연결 금지). 인바운드 규칙 0인 LB/AGW의 공용 IP는 진입 선 없음. VM 자체 공용 IP의 노출 선(exposure)은 NSG 판정(`metadata.inboundExposure`)이 closed·noNsg면 없음, 배지 색 = 판정(open 빨강·scoped 주황·unknown 파랑·닫힘 회색)
  - 리전(관계 사전 REG): `location`이 리전, `"global"`(Front Door·Traffic Manager·DNS 영역)만 글로벌 박스, **위치 없음 = '리전 미상'(맨 뒤, 글로벌 아님)**. PaaS는 명시적 배치 관계일 때만 서브넷 안(PostgreSQL/MySQL Flexible 위임 서브넷 PAAS-02, Redis 주입 PAAS-04), 아니면 리전 PaaS 레인. 예시(`mockData.ts`)는 ARM 형식 ID·리전 지정
  - 모든 그래프 노드는 `accounting`의 한 버킷에만 들어간다(테스트로 검증)
  - 선은 구성 기준만: 인터넷 진입·VM 공용 IP·LB/AppGW 백엔드·Private Link·피어링·NAT 아웃바운드·VNet 통합·로그. 관측 트래픽은 별도 레이어(기본 꺼짐, 켤 때만 요청)
- **React Flow 규칙**: 커스텀 노드에 숨김 `Handle` 필수(없으면 선이 안 그려짐), 박스 노드 래퍼 `pointerEvents: none`, `elevateNodesOnSelect={false}`, `minZoom 0.05`, nodeTypes는 모듈 상수. 개발 모드의 경고 002는 React 19 StrictMode 이중 useMemo 때문(프로덕션 0건)
- **표시 범위 필터**: `filterArchModel(model, cats)`(순수) — 레이아웃 전에 모델을 걸러 유령 선이 생기지 않음. 선택 분류 + routes·privateLink 1홉 연결 맥락(점선 타일), 숨긴 쪽으로 이어진 선은 `crossing`(배너·Inspector), 박스의 '숨김 n'. 9개 모두 선택 = `null`(같은 모델 참조). 숨긴 분류의 리소스를 검색하면 그 분류를 자동 추가
- **내보내기**: draw.io(`lib/archDrawio.ts` `toDrawio` — 순수, 부모 상대 좌표·html=0·hex 선 색), PNG(`hooks/useDiagramExport.ts`, html-to-image 동적 import, 내보내는 동안 `onlyRenderVisibleElements` 끔). 파일·캡션에 필터·선 표시·RG 강조·'GUID 마스킹·내부 네트워크 구성 정보 포함'을 적음. 리소스 이름의 GUID는 `lib/mask.ts`로 마스킹
- **테스트**: `apps/api/test/archModel.test.ts`(필터 포함), `archDrawio.test.ts` (합성 픽스처 — 실데이터 graph.json은 커밋하지 않음)

## Live Diagram (/live-diagram)
- **원칙**: 실측이 아닌 값은 만들지 않는다 — 측정 없음은 `미측정`·`coverage`(수집원별 `ok|empty|signin|disabled|failed`), 예시 다이어그램(`prod-infra`)·mock 응답은 `dataSource:"mock"` + 샘플 배너. 전원 상태·헬스는 수집된 것만(활동 규칙 `metric > 0`은 위험 판정에 쓰지 않음), running만으로는 정상이 아님(회색)
- **API**: `services/liveAggregator.ts`(스냅샷 — 수집원 8개(메트릭·선 메트릭·App Insights·알림·알림 규칙·전원·트래픽·Resource Health)를 **동시에**, 예산 `SNAPSHOT_BUDGET_MS` 20초: 늦은 것은 이번 회차 미측정, 진행 중 요청은 캐시를 채워 다음 폴링에 반영(`untilDeadline`·`withBudget`). 웹 rewrite 프록시는 `next.config` `experimental.proxyTimeout` 120초(기본 30초 → ECONNRESET), `buildFaultImpacts` = 구성 연결 1홉·위험 경고도 시작점) · `healthCalculator.ts` · `metricsCollector.ts`(값이 있는 마지막 1분 버킷, 노드·선 공용 `queryResourceMetrics`: `$filter`별 요청·이름 대소문자 무시·`optional` 거부(400) 기억·`complement`(100−값)→`scale`(바이트/분→bit/s 등)→`derived`(share·ratio·sum, 분모 부족은 null). 스파크라인은 메트릭마다) · `specGenerator.ts` `NODE_BINDINGS`(종류별 대표 지표 + 단계 규칙 `level` warning/critical·`when` 표본 가드, 테넌트 16종은 실리소스 정의로 검증) · `effectiveBindings`/`normalizeSpecBindings`(서버가 바인딩 소유 — `auto-*` 스펙은 저장 시 현재 표로 교체) · `edgeBindings`(인터넷→공용 LB = LB `ByteCount` `Direction eq 'In'`·`node:"target"`, →AppGW = **규칙이 연결된 공용 리스너만** `BytesReceived` `Listener eq …`(+ 참고값 `gatewayTotal` 전체 리스너 — 공용 값이 없고 전체가 있으면 '사설 리스너로 들어온 트래픽'), PE→PaaS = PEBytesIn+Out. 백엔드 바이트는 Azure에 없음 → AGW→멤버 = `BackendResponseStatus`·`BackendConnectTime` `BackendServer eq 'ip:port'`(품질, 파티클 없음), LB→멤버 = `DipAvailability` `BackendIPAddress`; `LiveEdge.metrics.responsesPerMin·connectMs·probePct·gatewayTotalBps`, 여러 시계열은 `mergeSeries`(합/평균)) · 트래픽 단계는 절대 bit/s 구간(`resolveTrafficLevel`) · `specGenerator.ts`(서브넷 `egressVia`, 인입 `internet-in-*` 노드 — 부하 분산 규칙 0개인 공용 LB는 인입 아님, VNet `peerings`(`LivePeering[]` — 링크 이름 키, 양쪽 플래그 null=미확인, 상대 `other`, 전송 `uses|provides`는 양쪽 Connected·플래그 일치 때만, 그래프 밖 상대는 `id:null`·원격 ARM ID 미전송, 최대 50 + `peeringCount`), VM 공용 IP는 카드 칩, 공용 전용 LB는 백엔드 VNet 소속 `placement:"public-frontend"`, 리소스 그룹 추정 배치는 `placement:"rg-guess"`) · `dependencyInference.ts`(같은 리전·신호 2개 이상·PE 경로 제외, `reasons`) · `edgeDetailService.ts`(예시 값은 `/subscriptions/mock/` 리소스만)
- **웹 순수 모듈** (`apps/web/src/lib/`)
  - `liveScope.ts` VNet 범위(구성 연결로 1회 확장, 다른 VNet은 고스트) · 선 레이어 7종 · 화면 범위 커버리지. 1홉으로 들어온 글로벌 진입점(Front Door)의 인터넷 쪽(`internet-in-external`, 2홉)은 `withGlobalInbound`: 화면의 인바운드 인터넷 카드가 정확히 1개면 그 카드로 선을 옮김(같은 edge id), 0·2개 이상이면 외부 카드를 가져옴. 인터넷 카드 `entryCount` = 화면에 그린 인입 선 수. 인터넷→AGW/LB가 Front Door 오리진이기도 하면 caveat `viaFrontDoor`(수신량에 Front Door 경유가 섞임·전용 제한 여부 미확인)
  - `liveLayout.ts` 연결 기반 배치(연결 없는 서브넷·VNet 직속 카드는 연결 흐름 아래 '연결 없음 n' 틀 안 격자, tier→이름 순 — 틀은 장식, 부모는 VNet / 미사용 공용 IP·분리된 NSG는 오른쪽 맨 아래 '미사용 · 분리됨' 레인): 공용 LB·Front Door는 인입 레인, 서브넷 연결 그래프의 성분 = 띠(줄바꿈 없음), 층 = 인입(또는 출구) 쪽에서 BFS 거리, barycenter 정렬, 층 사이 48px 통로, 연결 없는 서브넷만 tier→이름, 카드 L/R/LR/N 배치, 레인 세로 정렬, 빈 서브넷 접기/펼치기. 서브넷 3단계 슬롯은 아무 행도 안 쓰는 열을 지움(R만 있는 PE 서브넷 = 1열), 오른쪽 레인을 쌓은 뒤 `orderToTargets`가 서브넷의 R 카드(`meta.rSlots`)를 대상 높이 순으로 다시 배정(교차 0, 같은 크기만), PaaS 레인은 6개 이하면 1열. 문자열 비교는 코드포인트(결정적)
  - `liveRoute.ts` 선마다 핸들(`s-l/r/t/b`, `t-l/r/t/b` — 모든 노드에 `HiddenHandles`)과 경로(직각 step: 세로 구간은 통로·인입 간격에 고정 / 오른쪽 레인·연결선은 bezier)
  - `liveStyle.ts` 선 문법(색=관계, 점선=약한 근거만, 빨강=장애 영향 전용, 관계 라벨, 역방향 병합, 범례) + 실측 트래픽 코멧(`particlePlan` px/s 고정 속도·화살촉 전 페이드, `particleTone` down 선엔 없음, 꼬리 그라데이션은 캔버스에 한 번, reduced-motion이면 정지) · `liveStatus.ts` `cardStatus`(카드·미니맵·패널 공용) · `liveMetricFormat.ts` 단위(%·/분·KB/분·ms)·0 기준 추세 척도 · `liveNames.ts` VNet 단어를 뺀 짧은 이름(`shortNamesWithParts` — 전체 이름 조각에 남은 단어 표시) · 배치 엔진 `boxPack.ts`(archModel과 공유)
- **카드**: 220×100 하나(상태 띠 · 짧은 이름 + 상태 알약 · 종류·사설 IP·칩 · 단위 붙은 메트릭 칸 2개 + 추세). 칸은 종류별 `CARD_CELLS`(1칸 = 부하·활동 + 추세, 2칸 = 품질 — LB 데이터 경로·백엔드, AppGW 요청·백엔드, Storage 트랜잭션·가용성, Redis 부하·메모리, Service Bus 대기·서버 오류 …), 색은 상태와 같은 단계 규칙(`cellTone`, 카드 안 위험도 주황). NSG·NIC·DNS는 메트릭 줄 없음. 메모리가 있는 컴퓨팅(VM·VMSS·AKS·Redis·PostgreSQL·SQL)은 사용률 쌍(CPU/DTU + 메모리, 키 줄의 22×4 게이지, 헬스 규칙 임계값(없으면 85) 이상만 주황, 미측정은 막대 없음) — 요약 줌은 막대 2줄(`lib/liveMetricFormat` `pairPrimary`·`usageTone`). 선택하면 카드 위에 전체 이름표(NodeToolbar, 화면 12px, 복사는 원문 — 서브넷 머리글도). 줌 단계(`data-lod`: 상세 ≥0.78 / 요약 / 윤곽 <0.40)는 CSS로만 전환. 드래그 없음
- **상세 패널** (320px): 고정 헤더(짧은 이름·전체 이름·위치·상태 근거·Portal·ID 복사) → 장애 영향 → 알림 → 메트릭 → 연결(누르면 이동) → 네트워크 → 종류별(LB/AppGW·NSG·AKS·VMSS·PE·NAT) → 속성(접힘, GUID 마스킹·복사는 원문). 조회 실패는 Notice. 계층은 `detail/primitives`의 깊이 context: 1단 `Section` = 불투명 띠(sticky), 2단(중첩 Section·`Group`) = 작은 제목 + 규칙선, 행 = 왼쪽 레일. 열지 않는 띠는 `StaticSection`
- **백엔드 멤버** (`services/backendMembers.ts` 순수): 풀 멤버 = NIC 참조(`cfg`) · IP(`ipMatch`) · FQDN(`fqdnMatch`, App Service·Container App 호스트 이름 정확 일치, DNS 조회 안 함). 주소는 **허용 VNet(게이트웨이 VNet + Connected 피어, LB IP 풀은 멤버 VNet) 안에서 보유자가 정확히 하나일 때만** 선, 아니면 노드 `unresolvedBackends`(카드 칩 '백엔드 미확인 n'·패널 이유). 규칙이 안 쓰는 풀은 선 없음(Resource Graph가 빈 배열을 생략 → LB 전체 규칙 수로 대체), SNAT은 NIC 기반 풀 + 아웃바운드 규칙만. 프런트엔드는 공용·사설 모두 칩(`metadata.frontends`), AGW `inboundRules` = 규칙 연결 공용 리스너 수. AKS가 만든 LB는 태그/노드 RG로만 판단(`managedBy`, 칩 'AKS 관리'·'아웃바운드 전용'). Flexible VMSS 인스턴스(일반 VM, `member-of`)는 카드 유지 + 칩 '확장 집합 x'(선 아님)
- **VM 공용 IP 인입** (관계 사전 PIP-04): 판정은 API 순수 모듈 `services/nsgExposure.ts` `internetInboundExposure`(서브넷 NSG → NIC NSG 둘 다 허용, 우선순위 첫 일치, 기본 규칙 65000/65001/65500, 목적지는 변환 뒤 사설 IP·ASG·VirtualNetwork, 복수 필드, Standard+NSG 없음 = `noNsg`(기본 차단)·Basic = open, 0.0.0.0/0 UDR = `vnetTagWidened`·AVNM 존재·읽기 실패 = `unknown`) → `azure.ts`가 NIC의 **모든 ipconfig**를 보고 NIC·VM `metadata.inboundExposure`(+ `publicIPs`), 경로 테이블·Network Manager는 별도 Resource Graph 쿼리(노드 아님). 라이브: open·scoped = `internet-in-*` → VM 실선, unknown = 점선(`ingressUnknown`, 위험 색 없음), closed·noNsg = 선 없이 칩(`lib/livePip.ts` `pipChip` — 주황은 위험 포트를 구성으로 연 경우만). 선은 레이아웃 간선 아님(`isLayoutEdge`), bezier. 측정은 **공용 IP 리소스**: 바인딩 `on:"publicIp"` → `liveAggregator.measuredResources`가 카드의 publicIP 하위 리소스 ID만(같은 구독·publicipaddresses 유형) 읽고 `sumMetricRecords`로 합산. `SynCount`·`ByteCount` `Direction eq 'In'`(포트 차원은 인스턴스 공용 IP에서 '0' 하나 — 포트는 NSG 구성 기준) → `LiveEdge.metrics.synInPerMin·bytesInBps`. 코멧(`throughput`)은 서브넷 출구가 NAT 게이트웨이일 때만(그 밖엔 VM이 연 연결의 응답이 섞임), SYN은 상태·색에 쓰지 않고 라벨은 '인바운드 SYN 패킷'(연결 시도라고 단정 금지 — SYN-ACK 포함·NSG 전후 집계는 문서 미기재, caveat). 위험 포트 목록은 `services/riskPorts.ts` = `web/lib/riskPorts.ts`(테스트로 일치, `@aud/types`엔 런타임 값 없음). 테스트 `nsgExposure.test.ts`·`livePip.test.ts`
- **AKS 노드 인스턴스 카드**(`VmssInstanceNode`, 리소스 카드 양식 58px): 상태 = 노드 Ready — Kubernetes API, 안 되면(자격 증명 403·Entra 전용) AKS 플랫폼 메트릭 `kube_node_status_condition`(읽기만, `parseNodeReady`), 그다음 Container Insights. 출처는 `conditionsSource`, 근거 문구는 툴팁
- **상태 근거** (`services/healthEvidence.ts` 순수 `resolveEvidence` → `LiveNode.basis`·`reasons`): `health`는 위험 축 그대로(장애 영향 입력), basis = metric(품질 규칙) · resourceHealth(`resourceHealthCollector.ts` — Resource Graph `healthresources` 한 번 + **빠진 id는 리소스별 ARM `availabilityStatuses/current`**(`healthresources`에 네트워크 유형이 없음 — VPN 게이트웨이·연결·LB·Front Door, 최대 40개·6개씩·8초), Learn 지원 유형만 `RH_SUPPORTED`, 호출자 구독만, 3분 캐시) · observed(창 안에서 양방향 >0 — PE `PEBytesIn/Out` 1시간·공용 IP In/Out·DNS 쿼리, **health는 unknown 유지** — 카드 '트래픽 확인' ◎ info, 정상 수에 안 넣음) · configured(프로비저닝 Succeeded·PE Approved, 관측 없음 — 사유 idle(0)·noSeries(null)·oneWay, 네트워크·게이트웨이 종류만) · notApplicable(NSG·미사용 공용 IP — 알약 없음) · none. 위험: RH Unavailable critical / Degraded warning, 구성 결함(provisioning Failed, PE Rejected·Disconnected)은 **warning까지만**, Pending은 사유만. 메트릭 창은 바인딩 `window`(PT15M/PT1H — 창 하나를 버킷 하나로, 0과 null 구분), NAT 데이터 경로는 15분 평균(문서 권고). `cardStatus(health, power, impact, basis)` — 전원 상태 행이 basis보다 먼저
- **AGC** (Application Gateway for Containers, 관계 사전 §5a AGC-01..05, `services/agc.ts` 순수): `trafficcontrollers` 노드 kind `agc` + 자식(associations·frontends·securityPolicies)은 별도 Resource Graph 쿼리로 부모 metadata에 흡수. 위임 서브넷 = association `subnet.id`(AGC-01, 추측 배치 금지), 인입 = 공용 프런트엔드(`publicNetworkAccess`≠Disabled, Succeeded) ≥1(AGC-03, 요청/분·파티클 없음), AKS = `resolveAgcCluster`(노드 RG 일치 하나 = 실선 `nodeRg` / 그 VNet 클러스터가 하나뿐 = 점선 `configWeak` `sameVnet` / 그 밖 선 없음 + `clusterCandidates`). 바인딩 TotalRequests·BackendConnectionTimeouts 비율·BackendHealthyTargets
- **Front Door Standard/Premium** (`microsoft.cdn/profiles`, sku `*_AzureFrontDoor`만 — 다른 CDN은 노드 아님; classic은 칩 '2027-03-31 종료'): 오리진·라우트는 Resource Graph에 없어 `services/frontDoorConfig.ts`가 ARM 자식 GET(캐시 10분·single-flight, 실패 = `configUnreadable`). `resolveAfdOrigins`(순수) = 활성 라우트가 쓰는 그룹의 활성 오리진만, Private Link(EDGE-07) > azureOrigin(EDGE-06) > IP 리터럴의 공용 IP 소유자(EDGE-05, NIC는 VM으로) > 호스트 이름(EDGE-04: App Service·Container App·AGC 프런트엔드·공용 IP DNS) **정확히 하나**일 때만 선, 나머지는 외부/모호 개수. 패널은 오리진 그룹별 이름·호스트·연결 대상·상태(`metadata.originList`: linked/external/unrouted/disabled). 바인딩 `frontDoorAfd`(OriginHealthPercentage·Percentage5XX — `effectiveBindings`가 ARM 유형으로 고름). 인입 = 활성 라우트(활성 엔드포인트의)가 있을 때만. **WAF**(EDGE-10/11): 보안 정책(ARM 자식 `securityPolicies`, 실패 = `null` → '미확인', 부분 실패는 1분만 캐시) + WAF 정책(Resource Graph, 동시 쿼리 스로틀 시 1회 재시도) → `resolveAfdWaf`(순수) — 서비스 도메인(활성 라우트의 사용자 지정 도메인 + 기본 도메인 연결 시 엔드포인트)마다 prevent/detect/disabled/none/unknown(정책 못 읽음·경로 한정·정책 2개) → 메타 `wafState`·`wafCounts`·`wafPolicies`·`wafDomains`. 카드 칩 `lib/liveWaf.ts` `wafChip`('WAF 방지' 중립 / '방지 n/m'·'탐지'·'없음' 주황 / 미확인 회색 — 카드 상태·장애 영향엔 안 씀), 패널 `detail/AfdWafSection`(정책별 모드·관리 규칙·도메인, 판정 수 `wafBlock/wafLog/wafTotal` 1시간 프로필 합계 — 헬스 규칙 아님). AGW WAF는 아직(쿼리만)
- **새 타일**: VPN/ER 게이트웨이(`vnetGateway`)·Bastion = 전용 서브넷(CT-07), 공용 IP는 진입점(ENTRY). PE 대상인데 종류가 없는 PaaS(ACR·AI Services·Redis Enterprise·Mongo vCore) = kind `paas` + `metadata.armType`(PL-01 선의 끝, PaaS 레인 other). 그리지 않는 유형은 `graph.undrawnTypes`(개수만) → /architecture 빈 Inspector 목록
- **Private Link 사용** (`/api/live/private-link-usage`, `services/privateLinkUsage.ts` 순수 조인 + `privateLinkUsageCollector.ts`): 근거는 관측만 — PaaS 접근 로그(KV AuditEvent·Storage 로그·Redis 연결 클라이언트, 진단 설정이 워크스페이스로 보낼 때만 조회) `access` / VNet 흐름 로그+Traffic Analytics(호출 쪽 VNet) `flow`. 호출자는 NIC IP·서브넷 단독 소유자·관리 ID로 정확히 하나일 때만, 아니면 `unresolved`(VM 없는 NIC·모호·PE 미확정·차단). 후보가 **한 AKS 클러스터의 노드풀들**뿐이면(소속은 `ArchMeta.aksNodeId` → `aksClusterArmId`, 이름 역조회 금지) 그 클러스터로 귀속(`attribution:"aksCluster"`, `viaNodeIds`, PE는 출발 서브넷의 VNet 기준). 모호는 `basis` subnet/identity로 구분(서브넷 후보를 ID 보유자로 바꾸지 않음). 범위 밖 주소는 `place`(다른 VNet 서브넷 = 이름·단독 소유자 / 겹침 / private / cgnat — 선 없음). 공용 판정은 `isInternalV4`(RFC1918 ∪ 100.64/10 ∪ 다이어그램 prefix). 패널·칩은 `groupUnresolved`(사유·후보·위치별 그룹, 고유 IP 수 — 칩 '미확인 n' = 패널 합계, 해결 방법 한 줄) 공용 경로는 개수만. 로그인 사용자 전용(`AZURE_PL_USAGE_SP_FALLBACK`은 로컬 검증용), 사용자별 5분 캐시. 웹 `lib/plUsage.ts`: 레이아웃 뒤에 워크로드→PE 실선(레이어 `privateLinkUsage`, 기본 켬, 파티클 없음), PE/PaaS 칩(사용 n·근거 없음·사용처 n·공용 접근), 승인 안 된 PE→PaaS는 회색 '연결 끊김'. 패널 '사용 중인 워크로드'에 근거·켜는 명령(복사만, 실행 안 함)
- **허브·스포크 피어링** (EDGE-02, `lib/livePeering.ts` 순수): VNet↔VNet은 선이 아니라 VNet 머리글 아래 한 줄(`LIVE.PEER_ROW`) — 요약 칩(피어링 n · 확인 필요 n) + 들어가는 만큼의 이름 칩(`peeringChipFit`, 문제→게이트웨이 전송→화면 안→이름 순 `sortPeerings`) + '+n'. 누르면 VNet 패널 `PeeringSection`이 그 피어링을 펼침(이쪽/상대편 상태·동기화·플래그 4개·전송·주소 공간, 이 VNet만 보기/화면에 추가, Portal). 확인 필요(`peeringIssue`) = 미연결·프로비저닝·주소 공간 동기화·전송 반쪽(경고), 원격 접근 꺼짐은 중립 — 빨강 금지. 배치는 피어링이 가장 많은 VNet을 먼저, 그 상대들을 이름 순으로. 예시처럼 피어링 선이 있는 스펙은 `EdgeDetailPanel`이 양쪽 비교(`peeringPairOf`, edge-detail 요청 안 함, 트래픽 미측정), 미연결은 회색 `peeringInactive`
- **S2S VPN·온프레미스** (EDGE-08/09): `azure.ts`가 IPsec 연결 + 로컬 네트워크 게이트웨이를 게이트웨이 `metadata.s2s`로 접음 → 연결마다 `onPremSite` 카드(`site-*`, **리소스 = 연결** — Resource Health·`BitsIn/OutPerSecond`가 카드 상태·칸) + 게이트웨이→사이트 `hybrid` 선(레이어 `hybrid`, 청록, 실측 `LiveEdge.metrics.siteIn/OutBps`, 파티클). 사이트는 왼쪽 인입 아래 `onprem` 레인(6단계에서 인입 레인을 다시 쌓은 뒤 그 아래 24px 이상·연결 게이트웨이 높이로 이동 — 겹침 없음). 게이트웨이 칸 = `AverageBandwidth`×8(게이트웨이 메트릭은 1분 grain 거부 → `window:"PT15M"`), 칩 A/A·BGP. 연결 상태·터널·누적 바이트는 '조회 시점'(패널 `HybridSection`, 카드 색에 안 씀). Private Link 사용의 미확인 호출자: 사설 IP가 **정확히 한 사이트**의 LNG 대역(/8~/31, BGP·NAT 사이트 제외)에 들면 `place:{kind:"onPremSite", basis:"cfg"}`, VNet·다른 사이트와 겹치면 overlap. 범위 = 스코프 VNet의 게이트웨이 + `transit==="uses"` 피어의 게이트웨이. 미구현: ExpressRoute·VNet 간 연결·P2S·터널별 메트릭·Traffic Analytics S2S 흐름
- **툴바**: `연결선 ▾`(레이어) · `연결 강조`(호버 시 나머지 흐림 on/off, 브라우저에 기억) · `트래픽 (실측)`(실측 없으면 비활성) · `장애 영향 (n)`(개수·캔버스 흐림·패널이 모두 `scopeImpacts` 한 목록 — 화면 밖 장애가 이 VNet을 흐리게 하면 안 됨). 라벨·서브넷→NAT 연결선·서브넷의 기본 아웃바운드 점선은 호버·선택 때만(`isFocusOnlyEdge`, 범례는 포커스 필터 전 목록으로). 알림 탭: 목록 = 심각도 순, 타임라인 = 발생 시각 순 + 누적 그래프
- **React Flow 주의**: 기본 `.react-flow__node-group` 스타일(padding 10px·테두리)을 캔버스에서 0으로 덮어씀(머리글·카드 오프셋이 레이아웃과 일치해야 함). 선은 `zIndex: 1000`, 라벨 레이어는 1001 — VNet·서브넷 박스 위에 그림. 빈 서브넷은 VNet 맨 아래 별도 영역(접기 행 + 같은 크기 격자)
- **테스트**: `apps/api/test/liveDiagram.test.ts`·`liveScope.test.ts`·`liveLayout.test.ts`·`liveRoute.test.ts`(교차·결정성)·`liveCard.test.ts`·`specGenerator.test.ts`·`backendMembers.test.ts`(멤버 해석·프런트엔드·바인딩)·`relationshipCatalog.test.ts`·`nsgExposure.test.ts`·`livePip.test.ts`·`healthEvidence.test.ts`(근거 사다리·AGC·AFD 오리진·인스턴스 상태)·`livePeering.test.ts`(피어링 키·전송·칩 맞춤·양쪽 비교, S2S 사이트·선·레인)

## VNet Traffic (/network)
- **개념**: 기간을 정한 흐름 로그 감사(그림 없음). NSG 흐름 로그는 2027-09-30 종료 → VNet 흐름 로그 + Traffic Analytics(`NTANetAnalytics`·`NTAIpDetails`). NSG만 있는 VNet은 '이전 필요'로만 표시(옛 `AzureNetworkAnalytics_CL`은 집계 안 함)
- **API**: `services/networkQueries.ts`(순수 — `baseQuery` 범위 접두사 `구독/rg/vnet/`는 `kqlString`, 불확실 열은 `column_ifexists`, 인터넷 탭은 `mv-expand` 후 바이트 합산 금지(기록 수), 라벨에서 구독 제거·GUID 마스킹) · `flowLogCoverage.ts`(순수 — vnet/partial/nsgOnly/none, 켜진 로그만, 작업 영역 일치) · `networkFlows.ts`(탭 하나만 조회, 캐시+single-flight, `laState` → `noAccess`/`noTable`, 연결 거부는 그대로 오류) · `networkMock.ts`(익명 전용, RFC 5737 IP). 라우트는 `respondLiveOrSignin` — 로그인 사용자에게 mock 없음, 상태(`disabled`·`noAccess`·`noTable`·`empty`)로 답함. 구성도 흐름 오버레이도 로그인 사용자에게 mock 없음
- **웹**: `app/network/page.tsx`(`useQueryParam("tab")`, Suspense) + `tabs.ts`(`isRiskyPort` = 인터넷 허용 관리 포트) + `components/`(CoverageStrip·SectionState·Overview(SVG 막대+선)·Talkers·Blocked·Internet·CoverageTable — 켜는 명령은 자리표시자, 복사만)
- **테스트**: `apps/api/test/networkQueries.test.ts`

## Security (Defender for Cloud)
- **서비스**: `apps/api/src/services/securityPosture.ts` — Resource Graph 6개 쿼리(권고 summarize·점수·컨트롤·규정 준수·플랜·경고), 섹션별 실패는 `gaps`(메시지의 구독 ID·GUID 마스킹), 동시 요청 병합
- **인증**: 로그인 사용자만(연결의 자격 증명으로 읽음 — delegated 연결이면 OBO). 비로그인은 mock(`source:"mock"`, 화면에 '예시 데이터' 배너). `AZURE_SECURITY_SP_FALLBACK=true`일 때만 익명에게 플랫폼 자격 증명(로컬 검증용)
- **웹**: `app/security/layout.tsx`가 구독 선택·조회를 공유(하위 화면 이동 시 유지). 영역 분류는 Defender `metadata.categories`만 사용, 없으면 '분류 없음'(추측 재분류 금지)
- **통합 위험** (`/security/risk`): `lib/riskJoin.ts`(순수)가 posture·구성도 그래프·정책 인사이트를 조인. 키 = (RG, 전체 ARM 유형 `provider/type`, 이름) + GUID 마스킹, 후보가 정확히 1개일 때만 연결(2개 이상은 '모호'로 집계). 흡수는 1:1(NIC→VM·VMSS→AKS·공용 IP→소유자)만, NSG는 연결하지 않음. LB는 `metadata.inboundRules`>0이면 진입, 0이면 '백엔드만', 미상이면 unk. unk 연결은 요약 숫자에서 빼고 '식별 불확실'로 따로. 샘플 데이터는 조인하지 않음, 로딩 중·다른 구독 응답은 섞지 않음. 테스트 `apps/api/test/riskJoin.test.ts`
- **테스트**: `apps/api/test/securityPosture.test.ts`

## Env
`.env.example` 참조. 필수: `AZURE_AD_*`, `AZURE_SUBSCRIPTION_IDS`
인증: `API_BIND_HOST`(기본 127.0.0.1 — 웹 rewrite는 localhost를 127.0.0.1로 바꿔 보냄), `NODE_ENV`, `AUD_DEFAULT_ROLE`(앱 역할 없을 때 — 개발 기본 viewer, 프로덕션은 none만), `AUD_AUDIT_LOG`, `AUD_ANONYMOUS_SP`·`AUD_ANONYMOUS_K8S`(기본 false, 로컬 전용), `AUD_AUTH_SCOPES`, `AUD_AUTH_AUDIENCES`
연결: `AUD_CONNECTIONS_FILE`(→ `config/connections.json`, 커밋 금지; 옛 `AUD_TENANTS_FILE`도 읽음), `AUD_HOME_CONNECTION_MODE`(platform|delegated), `AUD_PLATFORM_CERT_PATH`, `AUD_CONN_<KEY>_SECRET`(servicePrincipal 비밀 값 — 파일엔 이름만)
VNet 트래픽: `AZURE_LOG_ANALYTICS_WORKSPACE_ID`·`AZURE_LOG_ANALYTICS_TABLE`(기본 NTANetAnalytics)·`AZURE_NETWORK_COVERAGE_TTL_MS`
Hubble: `HUBBLE_ENABLED`, `HUBBLE_RELAY_NAMESPACE`, `HUBBLE_RELAY_PORT`, `HUBBLE_FLOW_LIMIT`
보안: `AZURE_SECURITY_ENABLED`, `AZURE_SECURITY_SP_FALLBACK`(기본 false)
리소스 상태: `AZURE_TRANSLATOR_KEY`·`AZURE_TRANSLATOR_REGION`(Service Health 이벤트 번역 — `services/health.ts` `translateTexts`: 키 있으면 Azure Translator만(100개·4만 자씩, 문장별 1일 캐시, 실패 사유 `translator_auth|quota|error`), 없으면 키 없는 엔드포인트(429 잦음) → 내장 예시 번역, 실패는 `not_configured`+`freeStatus`. 다중 서비스 키는 지역 필수. error-catalog HEALTH-001). 인스턴스 탭 Resource Health 요약은 번역기 없이 `?lang=` → ARM fetcher `fetchJson(url, { language })` = `Accept-Language`(Azure가 현지화하는 문구만 한국어)

## Coding Patterns
- **타입 추가 흐름**: `packages/types/src/<domain>.ts` → `index.ts` re-export → API/Web에서 import
- **API 라우트 추가**: `routes/<domain>.ts` 생성 → `routes/index.ts`에 등록
- **리소스 관계(그래프 간선)**: `docs/architecture/azure-resource-relationships.md`(공식 문서 근거·ARM 경로·근거 유형·표현) 행 먼저 → `services/relationships.ts` `REL`(+ `spec: {type, path}` = 그 관계를 **설정하는** ARM 속성) → `relEdge("AGW-04", …)`(`metadata.rel`). `azure.ts`에 간선 리터럴 금지, 규칙으로 구현한 행은 코드 주석에 ID. 새 관계를 설계할 때는 `docs/architecture/relationships/<영역>.md`와 `catalog.json`(유형별 참조 속성·읽기 전용 역참조·리전 범위)을 먼저 본다 — `relationshipCatalog.test.ts`가 REL↔스펙, 카탈로그 공개성(테넌트 데이터·GUID 없음), 영역 페이지(ID·경로·출처)를 검사
- **API import**: 상대 경로는 `.js` 확장자 필수 (`import { x } from "./foo.js"`) — `NodeNext` 모듈, `npm start`(node dist) 실행 조건
- **입력 검증**: `subscriptionId`는 `querySubscriptionId`, ARM 리소스 ID는 `queryArmResourceId`, KQL 값은 `kqlString()` — 문자열 직접 삽입 금지
- **Azure 호출**: raw `fetch` 대신 `getArmFetcherAuto(...).fetchJson/postJson` (타임아웃 포함)
- **캐시**: `CacheManager` + `cachePrefix(token)` 패턴 (사용자별 캐시 격리, TTL은 env `*_CACHE_TTL_MS`)
- **로그**: 진단 로그는 `debug()` (`AUD_DEBUG=true`일 때만 출력), `console.log` 지양
- **웹 데이터 로딩**: `useApiQuery` / `useSubscriptions` / `useAksClusters` 사용, URL은 `apiUrl(path, params)` (`new URL()` 금지 — 브라우저 base가 "")
- **인증 = 로그인(SSO)과 Azure 연결의 분리** (Datadog·Managed Grafana 모델, 문서 `docs/integrations/azure/`)
  - 로그인: MSAL (Web) → Bearer token(대상 `api://<aud-api>`, Azure 권한 없음) → **검증**(`infra/tokenVerifier.ts` — jose, RS256·발급자 v1/v2·대상·만료·`scp` `Azure.Read.All`·홈 `tid`, `auth.ts`가 `/api`에서 401/403) → **역할**(`infra/platformAccess.ts` `platformRole` — 토큰 `roles`의 `AUD.Viewer`<`AUD.Operator`<`AUD.Admin`, 없으면 `AUD_DEFAULT_ROLE`) → `middleware/authorize.ts`(역할 없음 403 `no_platform_role`(/api/me 제외), 쿼리의 구독이 내 역할로 못 쓰는 연결이면 403 `connection_forbidden` — 캐시·Azure 호출 전, 감사 줄 `AUD_AUDIT_LOG`). 라우트 게이트 `requireRole(env, "operator"|"admin")` — Pod 로그 운영자, 연결 점검 관리자
  - Azure 연결: `infra/connectionRegistry.ts`(zod strict, 비밀 값·PEM 거부, 홈 정확히 1개, 구독·작업 영역 중복 금지, v1 `tenants` 변환) — `mode` platform(aud-api SP)·lighthouse(홈 자격 증명)·servicePrincipal(고객 앱, `secretEnv`/`certificatePath`)·delegated(사용자 OBO). `credentialGroup`으로 자격 증명 묶음
  - 누구의 신원으로 읽나: `azureClientFactory.ts`의 사용자 fetcher가 **요청마다** 구독(URL·Resource Graph 본문·리소스 ID)/작업 영역 → 연결 → 역할 확인 → `connectionToken`(`infra/connectionCredentials.ts` — 자격 증명 생성은 여기와 `oboTokenPool.ts`만, 토큰 `tid` ≠ 연결 테넌트면 거부, 오류는 `connection_*` 코드·마스킹, **다른 연결·자격 증명으로 폴백 없음**). Resource Graph는 자격 증명별로 나눠 보내고 합침. SDK는 `connectionCredentialGroups`/`homeConnectionCredential`. delegated의 OBO 실패는 `mapOboError`(`consent_required` …)
  - 익명은 `signin_required`(401, 예시 데이터가 있는 라우트는 `respondWithFallback`/`respondLiveOrSignin`이 mock + `note:"signin_required"` — **로그인 사용자에게는 mock 금지**). 플랫폼 자격 증명은 `getAnonymous*` 게이트로만 — `AUD_ANONYMOUS_SP=true`(로컬, 루프백 바인드, 연결 1개) [+ `AZURE_SECURITY_SP_FALLBACK`·`AZURE_PL_USAGE_SP_FALLBACK`, AKS는 `AUD_ANONYMOUS_K8S`]. 정적 테스트(`authPolicy.test.ts`)가 자격 증명 생성 위치·services의 OBO 직접 사용을 막음
  - fetcher 오류 메시지는 `<ARM|LogAnalytics> <status>: <code>: <마스킹된 메시지>`(원문 본문은 비열거 `detail`, 응답에 안 나감)
  - AKS 로그인(`services/aksAccess.ts`, 문서 `docs/integrations/azure/aks.md`): `loadKubeConfig` = ARM GET(호스트·Entra) → `listClusterUserCredential`(서버·CA) → `planClusterAuth` → DNS·TCP 사전 점검(`cluster_dns_unresolved`/`cluster_unreachable`, 메시지에 호스트 없음) → Entra 클러스터는 `aksApiToken`(AKS 서버 앱 상수 scope, aud 검증 — kubelogin 실행 안 함, `--server-id`는 비교만, 호스트는 ARM FQDN만, CA 필수). 로컬 계정(Entra 없음 = 관리자 인증서)은 403 `aks_local_account_refused`(연결 `aks.allowLocalAccount`, 개발 `AUD_AKS_ALLOW_LOCAL_ACCOUNTS`). 다른 테넌트 Entra 클러스터(Lighthouse) 501. K8s 오류는 `k8sError`(403 `aks_rbac_forbidden` …)
  - 클러스터 안 권한 = `services/k8sReadSurface.ts`(list만) → `docs/integrations/azure/templates/aks/*.yaml` 생성(`apps/api/scripts/gen-aks-rbac.ts`), `k8sReadSurface.test.ts`가 코드의 client-node 호출 ↔ 역할·생성 파일을 검사. Hubble exec·service proxy는 `assertHubbleExecAllowed`(`HUBBLE_EXEC_ENABLED` 미설정 = 개발 켬·프로덕션 끔 + 홈 연결 또는 `aks.hubbleExec`), Pod 로그는 연결 `aks.podLogNamespaces`(없으면 홈 전체·고객 없음, 거부 시 Container Insights)
  - 예시 데이터의 리소스 ID는 구독이 전부 0 — `assertArmResourceId`가 401 `signin_required`로 답함(익명이 예시 클러스터로 Hubble·관측·정책을 열 때). 웹 `fetchJson`은 인증 코드를 현재 언어 문장(`auth.state.*`)으로 바꿔 어디서 출력해도 읽히게 함
  - 캐시 키 = `cachePrefix(token)`: 플랫폼 자격 증명만 쓰는 사용자는 연결 집합 `c:home,custa`(같은 데이터 공유), delegated가 섞이면 `u:{tid}:{oid}`(`initPlatformAccess`가 리졸버 설치). 라이브 다이어그램 소유자 = `principalKey(token)` = `u:{tid}:{oid}` — 생성한 다이어그램은 소유자만 읽음, 샘플만 공개, SSE는 샘플 전용(사용자 다이어그램은 토큰 실린 폴링)
  - 웹: `ApiError`(`lib/api.ts`, `authStateOf`/`authStateOfCode` — `norole`·`denied`·`connection`·`consent` …), `SampleDataNotice`/`useNoteText`가 노트의 코드를 현재 언어 문장으로. `lib/useMe.ts`(`/api/me`) → 상단 역할 배지(`AuthControls`, 기본 역할이면 `*`)
  - MSAL v5 팝업은 redirect bridge 필수 — `providers.tsx`가 팝업 응답을 `broadcastResponseToMainFrame()`로 전달 (error-catalog AUTH-005)
  - 웹은 루트 `.env`를 `next.config.ts`에서 로드해 `NEXT_PUBLIC_*` 인라인 — 값 변경 시 dev 서버 재시작 (AUTH-004)
- **UI 텍스트**: 한국어 기본 (i18n: `useI18n()`, 번역표는 `apps/web/src/lib/i18nMessages.ts` + 영역 모듈 `i18nPolicies.ts`·`i18nOps.ts`, `MODULES`로 병합). 고유명사(Azure·AKS·NSG·Hubble)와 K8s 필드명만 영어. 웹 코드에 한국어 문자열 금지·키 존재·ko/en 자리표시자 일치는 `apps/api/test/i18n.test.ts`가 검사
  - 날짜·시각은 `toLocaleString(dateLocale(locale))` (브라우저 로캘이 아닌 앱 언어)
  - API가 만드는 문장(정책 점검·인사이트·Hubble 메시지)은 `?lang=en|ko` → `infra/lang.ts`: 동기 빌더는 `withLang(lang, () => …)` 안에서 `L(ko, en)`, 비동기 코드는 `lang`을 인자로. 캐시 키에 `lang` 포함, 웹은 쿼리 키에 `locale` 포함
  - 여러 사용자가 공유하는 라이브 다이어그램 스펙은 고정 토큰(`Internet`)을 담고 웹이 `localizeLabel`로 번역
- **스타일**: CSS Modules (`styles.module.css`). 페이지 헤더·탭·선택 상자·버튼·알림·빈/로딩 상태는 `@/components/ui`만 사용 (탭은 밑줄 `Tabs`(페이지 섹션)과 `Segmented`(하위 보기) 2종). 색은 토큰(`var(--danger)` 등)으로, 페이지 자체 padding·max-width 금지(AppShell이 담당)
- **URL 상태**: 탭을 URL에 둘 때는 `useQueryParam`(`lib/useQueryParam.ts`, `useSearchParams` 기반 — 페이지를 `<Suspense>`로 감싸야 빌드 통과)

## Docs
| 경로 | 내용 |
|------|------|
| `docs/integrations/` | **연동 문서 표준**(`_template.md` 12절: 개요·동작·준비·자동 설정·Portal·권한·수집 데이터·확인·문제 해결·교체·해제·보안 FAQ). `azure/`: overview·sso(앱 역할)·connect-tenant(A 홈·B 고객 SP·C Lighthouse·연결 파일)·permissions·data-collected·verify·troubleshooting·lifecycle·security-faq + `templates/`(lighthouse ARM, service-principal `onboard.sh`·`roles.bicep`). `scripts/verify-tenant.sh` 읽기 전용 |
| `docs/getting-started/` | setup-guide, azure-integration-guide(앱 등록·RBAC — 로그인·연결은 integrations), multi-tenant-onboarding(이동 안내) |
| `docs/architecture/` | GLOSSARY (용어집), azure-resource-relationships(리소스 관계 사전 핵심 — 입문 7장 + 코드가 쓰는 행), `relationships/`(영역 6개: network-core NET·network-edge EDG·compute-containers CMP·app-integration APP·data DAT·identity-security-monitoring IDM, 약 250행) + `relationships/catalog.json`(Azure REST API 스펙 리버스 엔지니어링: 유형 3,012·참조 속성 2,872, 공개 자료만). 재생성 `scripts/relationships/`(README) |
| `docs/observability/` | instrumentation-guide, hubble-guide, hubble-troubleshooting, vnet-flow-logs(VNet 트래픽 화면) |
| `docs/troubleshooting/` | error-catalog (도메인별 에러 통합 — AUTH·CONN·NET 포함) |

## Session Rules
- 기능 단위로 세션 분리 (10~15턴).
- `/compact` = 수동 컨텍스트 압축 (8~10턴 기점).
- 파일 수정 전 반드시 Read → 내용 확인 후 Edit.
- typecheck (`npx tsc --noEmit`) 수정 후 항상 실행.
- subagent: 세션당 최대 2개 (Explore/Plan 타입만).
