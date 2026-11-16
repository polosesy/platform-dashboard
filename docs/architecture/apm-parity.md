---
status: draft
owner: platform-observability
last-verified: 2026-11-16
covers: [apps/api/src/services/serviceGraph.ts, apps/api/src/services/appDependencies.ts, apps/api/src/services/k8sRecommendedAlerts.ts, apps/api/src/services/msRecommendedAlerts.ts, apps/web/src/lib/apmServiceMap.ts, apps/web/src/app/observability/components/ServiceMapView.tsx, apps/api/src/services/workloadRed.ts, apps/api/src/services/workloadSlo.ts, apps/api/src/services/promScope.ts]
---
# Kubernetes APM — 글로벌 APM(Datadog · New Relic · Dynatrace · AppDynamics) 대비 검토와 구현 순서

> 목표: Kubernetes 기능은 클라우드(AKS · EKS · GKE)에 묶이지 않고, 글로벌 APM과 비교해 빠지는 것이 없게.
> 판단 기준은 의견이 아니라 ① 네 제품 공식 문서의 기능 범주, ② **고객 작업 영역에 이미 있는 원본 데이터**(stg, 2026-11-16 Prometheus `label/__name__/values` · PromQL, 읽기 전용), ③ Microsoft 권장 AKS 경고 29개([kubernetes-ia.md](kubernetes-ia.md) 7절).

## 1. 원칙 — 벤더 중립

- 신호는 **표준 이름**만 씁니다. kube-state-metrics · cAdvisor · kubelet · node-exporter, OpenTelemetry/Alloy의 `traces_spanmetrics_*` · `traces_service_graph_*`, Micrometer, Loki 로그를 씁니다. 이 이름들은 EKS(AMP)·GKE(GMP)에서도 같습니다.
- 클라우드에 묶인 곳은 두 군데뿐입니다.
  - **어디서 읽나**: 지금은 Azure Monitor 작업 영역(`resolvePrometheusTarget`)과 Entra 토큰입니다.
  - **클러스터 구성**: ARM입니다.
- 남은 일 1번이 '임의 Prometheus 호환 엔드포인트'(AMP SigV4 · GMP · 자체 Prometheus/Mimir)입니다. 순서는 아래 4절. [multi-cloud.md](multi-cloud.md) Phase 0의 연결 `provider`에 이어집니다.
- 숫자마다 PromQL이 함께 나오고, 시계열이 없으면 '미측정'입니다. 목표 없이 색칠하지 않습니다. 실패는 사실(▲)로만 표시합니다.

## 2. 기능 범주 대비표

✓ = 있음 · △ = 일부 · ✗ = 없음. '데이터'는 그 기능에 쓸 원본이 stg 작업 영역에 이미 있는지입니다.

| # | APM 기능 (네 제품 공통) | 제품 예 | 지금 | 데이터 | 비고 |
|---|---|---|---|---|---|
| 1 | **서비스 맵** — 트레이스로 본 호출 관계, 실패 · 지연 | Datadog Service Map · Dynatrace Smartscape · AppD Flow Map(동기 실선/비동기 점선) · NR Service map | **✓ (2026-11-16)** | `traces_service_graph_*` 연결 33개 | 이 문서와 함께 구현 — 3절 |
| 2 | 서비스 목록 + RED | Datadog Service page · NR APM summary | ✓ | spanmetrics | 서비스 (APM) › RED |
| 3 | 엔드포인트(트랜잭션)별 | AppD Business Transactions · Datadog resources | **✓ (2026-11-16)** | spanmetrics `span_name` (서버 444 · 1시간 활성 92) | 서비스 (APM) › 엔드포인트 — 모든 서비스, 오류·요청·p95 정렬 |
| 4 | SLO · 오류 예산 · 소진율 경보 | Datadog SLO · Dynatrace SLO | ✓ | Micrometer | 서비스 (APM) › 서비스 SLO |
| 5 | 런타임(JVM · Node …) | 공통 | ✓ | jvm_* 27 · process_* | 히트맵 JVM 여유 · 앱 종류 |
| 6 | 로그 ↔ 트레이스 연결 | 공통 | ✓ | Loki + traceId | 로그 줄 → Tempo 링크 |
| 7 | **외부 호출 · 의존성**(HTTP 클라이언트 · DB) | Datadog external services · AppD backends · NR externals | **✓ (2026-11-16)** | `http_client_requests_seconds` 두 규약(앱·대상 32쌍) · hikaricp 풀 11 | 서비스 (APM) › 의존성 + 서비스 맵 카드 패널 — 히스토그램이 없어 평균·최대만 |
| 8 | **메시징 지연**(Kafka 소비 지연) | Datadog Data Streams · Dynatrace queues | **✓ (2026-11-16)** | `kafka_consumer_fetch_manager_records_lag_max` (앱·토픽 9) | 의존성 보기 · 맵 패널 — 지금과 기간 중 최고 |
| 9 | 오류 추적(예외 묶음) | Datadog Error Tracking · NR Errors inbox | △ | Loki 예외 클래스 | 로그 지표의 워크로드 × 예외 Top 15 — 서비스 · 처음 본 시각 · 추세 묶음은 다음 |
| 10 | 분산 트레이스 검색 · 워터폴 | Datadog Trace Explorer · AppD snapshots · NR distributed tracing | ✗(링크만) | Tempo(클러스터 안) | 인증 없는 백엔드를 직접 읽지 않는 원칙 — Grafana `/api/ds/query` 연결별 opt-in(관측 스택 절 2단계)으로 |
| 11 | 지속 프로파일링 | Datadog Continuous Profiler · Dynatrace | ✗(링크만) | Pyroscope(클러스터 안) | 10과 같은 길 |
| 12 | 배포 추적 · 버전 비교 | Datadog deployment tracking · Dynatrace release | ✗ | Argo CD 출처(정책 화면) · `kube_*_metadata_generation` | platform-roadmap ② 변경 타임라인 |
| 13 | 자동 기준선 · 이상 탐지 | AppD dynamic baselines · Dynatrace Davis | ✗ | 모든 시계열 | 결정 대기 — 임계값 없는 색 금지 원칙과 충돌하지 않게 '평소 대비 n배'를 사실로 |
| 14 | Kubernetes 상태 경고 신호 | Dynatrace warning signals · Recommendations | **✓ (2026-11-16)** | Microsoft 권장 30개 원문 평가 | 탭 '경고 신호' — 4절 |
| 15 | 경고 규칙 작성 · 적용 현황 | 공통 | △ | Resource Graph 규칙 그룹 0개 조회 | '경고 신호'가 권장 규칙을 켜면 어떻게 될지(울림·평가 불가)를 보여 줌 — 규칙 작성은 아직 |
| 16 | RUM · 합성 | 공통 | ✗ | 없음 | 범위 밖(브라우저 · 외부 프로브) |
| 17 | 클라우드 중립 데이터 원천 | 공통(에이전트 기반) | ✗ | — | 1절 — Prometheus 호환 엔드포인트 추상화 |

**완료의 객관적 기준(이 문서 범위)**

- 1~15 중 데이터가 있는 항목(1·2·3·5·7·8·9·12·14)을 모두 ✓로 만듭니다.
- 새 값마다 PromQL이 함께 나옵니다.
- stg에서 같은 PromQL을 작업 영역에 직접 물어 화면 숫자와 일치시킵니다.
- 10·11·13·17은 결정이나 고객 작업이 필요합니다.

## 3. 구현 — 서비스 맵 (2026-11-16)

**원본 확인**(stg, 1시간 창)

| 항목 | 값 |
|---|---|
| 호출 관계 | 33개 (직접 12 · 한쪽 미계측 17 · 메시징 4) |
| 요청 | 28,157건 |
| 실패 | 60건 — 한 관계에 몰림, 그 관계의 p95는 10초 버킷 |
| 리셋 | 10분 0회 · 6시간 36회(연결당 약 1회 — 수집기 재시작, `increase()`가 처리) |

`request_total`은 `failed` 라벨로 나뉩니다. false 28,097 + true 60이고, `request_failed_total` 60과 같습니다. 그래서 둘을 합친 값이 전체이고 이중 계산이 없습니다.

**API** `GET /api/observability/service-map?clusterId&window=5|15|60|360|1440[&at]` → `services/serviceGraph.ts`

- RED와 같은 범위·실패 격리·캐시를 씁니다.
- 질의 4개: 요청 · 실패 · 서버 지연 버킷 · 리셋 + 워크로드 이름
- `connection_type`은 Azure·벤더 구분 없이 그대로 나눕니다: direct · virtual(한쪽 미계측 — 클라이언트 `user` = 루트 스팬의 호출자) · messaging · database · other
- 지연은 분위가 든 버킷입니다(보간 없음).
- 워크로드는 파이프라인이 붙인 서버 네임스페이스로 찾고, 없으면 같은 이름이 하나뿐일 때만 잇습니다.

**화면** 탭 'SLO' → **'서비스 (APM)'**, 첫 보기는 **서비스 맵**이고 이어서 서비스 SLO · RED · 설정 · 가이드입니다. `ServiceMapView` + 순수 `lib/apmServiceMap.ts`는 Pod 트래픽 서비스 맵 문법을 그대로 씁니다.

- 배치: 네임스페이스 = 상자, 서비스 = 카드, 왼→오 = 호출 단계, 트레이스 밖 호출자는 왼쪽 레인
- 선: 회색 = 요청, 주황 점선 = 실패 있음, 점선 = 메시징, 굵기 = 초당 요청
- 카드를 고르면 들어오고 나가는 호출이 실패 많은 순으로 나오고, 각 호출의 초당 요청 · p95 · 실패율, '워크로드 신호 보기 →'가 붙습니다.
- 'PromQL' 접기에 질의가 그대로 있습니다.

테스트는 `serviceGraph.test.ts`입니다.

## 4. 구현 — 의존성 · 엔드포인트 · 경고 신호 (2026-11-16, 2차)

**의존성** `GET /api/observability/dependencies` → `services/appDependencies.ts`

원본(stg, 1시간)을 먼저 확인했습니다.

- 외부 HTTP는 태그 규약이 **둘**입니다.
  - 기존 Micrometer `client_name`·`status`·`outcome`·`exception`: 535건
  - Observation `clientname`·`http_status_code`·`error`: 1,618건, 앱 6개
- `_bucket` 0개입니다. 히스토그램이 없으므로 **평균(합÷개수)과 최대만** 보여 주고 분위수는 주장하지 않습니다.
- 수집기는 하나(alloy)입니다.
- `application` 라벨이 트레이스 서비스 이름과 **정확히 같은 앱은 11개 중 10개**입니다. 그 10개만 서비스 맵 카드와 잇습니다.

실패의 정의는 서버 쪽과 같습니다: 5xx, 응답 없는 I/O 오류(`status`가 IO_ERROR·CLIENT_ERROR), 예외·error 태그. 4xx는 실패가 아닙니다.

**독립 질의 대조**

| 항목 | 집계 | 독립 질의 |
|---|---|---|
| 앱·대상 쌍 | 32 | 32 |
| 요청 | 1,895 | 1,895 |
| DB 풀 | 11 | 11 |
| Kafka | 9 | 9 |

평균이 없는 20쌍은 모두 이 기간 요청이 0건입니다.

**엔드포인트**: RED가 서비스마다 상위 5개 대신 **요청이 있는 엔드포인트 전부**(상한 200)를 줍니다. 서비스 (APM) › 엔드포인트가 모든 서비스를 한 표로 보여 줍니다(오류·요청·p95 정렬).

**경고 신호** `GET /api/observability/recommended-alerts` → `services/k8sRecommendedAlerts.ts` + `msRecommendedAlerts.ts`

- 규칙: Microsoft [recommendedMetricAlerts.json](https://github.com/Azure/prometheus-collector/blob/main/GeneratedMonitoringArtifacts/Default/recommendedMetricAlerts.json) 30개 **원문**(MIT)
- 바꾸는 것은 `job="…"` 자리뿐입니다. 그 메트릭 계열을 이 작업 영역에서 실제로 쓰는 범위(클러스터 · 여럿이면 job · 수집기)를 넣습니다.
- `for` 확인: `E and count_over_time(E[for:step]) >= n`
- 지금 시계열이 없는 계열은 1일을 되돌아보고 판단합니다. `waiting_reason`은 대기 중일 때만 생깁니다.

stg 실측 결과(30개):

| 상태 | 수 | 내용 |
|---|---|---|
| 정상 | 24 | |
| **울림** | 1 | KubePodFailedState — Failed 파드 1개, 독립 질의로 확인 |
| **메트릭 없음** | 4 | 쿼터 3개(`kube_resourcequota` 없음) + **KubeJobFailed**(`kube_job_failed` 없음 — 작업 영역에는 `kube_job_status_failed`) |
| **식 오류** | 1 | KubePVUsageHigh — 파드에 PVC가 여럿이면 `on(namespace,cluster,pod,container)` 짝이 중복 |

'메트릭 없음'과 '식 오류'는 **켜도 이 클러스터에서 울리지 않는 규칙**입니다. 정상으로 세지 않습니다.

**바로잡음**: kubernetes-ia 7.4에서 '✗ 15 중 13개는 데이터 있음'이라고 썼지만, 쿼터 규칙 2개는 `kube_resourcequota`가 없어 **11개**가 맞습니다.

**벤더 중립 메모**: Azure Monitor 작업 영역은 라벨 값을 대소문자 구분 없이 비교합니다(실측: `phase=~"Running|Pending"`도 소문자 값 200개와 일치). Microsoft 식의 `phase="failed"`는 여기서는 맞지만, 일반 Prometheus(AMP·GMP)의 kube-state-metrics 값 `Failed`와는 맞지 않습니다. 17번 작업 때 규칙을 대소문자 무시 정규식으로 옮겨야 합니다.

## 5. 다음 순서 (데이터가 이미 있는 것부터)

1. ~~외부 호출 · 의존성(7)~~ · ~~Kubernetes 경고 신호(14)~~ · ~~메시징 지연(8)~~ · ~~엔드포인트 표(3)~~ — 4절에서 구현
4. **오류 묶음**(9): Loki 예외 클래스를 서비스 · 처음 본 시각으로
   - 보류 이유: '처음 본 시각'은 Loki에 긴 기간 정규식 질의가 필요합니다. 이는 작은 Loki를 과부하시킵니다(6시간 상한 원칙).
   - 방법 후보: 앱의 `logback_events_total{level="error"}`(Micrometer — 메트릭이라 싸게 30일)로 시작 시각을 잡고, 예외 클래스는 6시간 안 Loki로.
5. **Prometheus 호환 엔드포인트**(17): 연결에 `prometheus {url, auth: azure | sigv4 | google | bearer}`
   - `resolvePrometheusTarget` 뒤로 숨깁니다. 질의 · 집계 코드는 그대로입니다.
   - 보류 이유: 검증할 AWS·GCP 환경이 없어, 확인하지 못한 인증 코드를 내보내지 않습니다.
   - 먼저 할 것: 시험용 EKS/AMP 또는 GKE/GMP, 또는 자체 Prometheus 하나와 대소문자 규칙 전환(4절 메모).
6. **결정 대기**: 트레이스 · 프로파일 읽기(10 · 11, Grafana 경유 opt-in), 기준선(13), 배포 추적(12 — 로드맵 ②)

## 출처

- Datadog: [Service Page](https://docs.datadoghq.com/tracing/services/service_page/) · [Trace View](https://docs.datadoghq.com/tracing/trace_explorer/trace_view/) · [Container Monitoring](https://docs.datadoghq.com/containers/monitoring)
- Dynatrace: [Kubernetes app](https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/container-platform-monitoring/kubernetes-app)
- AppDynamics(Splunk): [Flow Map Overview](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/26.3.0/business-applications/flow-maps/flow-map-overview) · [Dynamic Baselines](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/25.7.0/business-transactions/monitor-the-business-transaction-performance/dynamic-baselines)
- New Relic: [Explore Kubernetes](https://docs.newrelic.com/docs/kubernetes-pixie/kubernetes-integration/understand-use-data/explore-k8s/)
- Microsoft: [Recommended alert rules for Kubernetes clusters](https://learn.microsoft.com/azure/azure-monitor/containers/kubernetes-metric-alerts) · [Default Prometheus metrics configuration](https://learn.microsoft.com/azure/azure-monitor/containers/prometheus-metrics-scrape-default)
