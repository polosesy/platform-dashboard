---
status: draft
owner: platform-observability
last-verified: 2026-11-16
covers: [apps/api/src/services/serviceGraph.ts, apps/web/src/lib/apmServiceMap.ts, apps/web/src/app/observability/components/ServiceMapView.tsx, apps/api/src/services/workloadRed.ts, apps/api/src/services/workloadSlo.ts, apps/api/src/services/promScope.ts]
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
| 3 | 엔드포인트(트랜잭션)별 | AppD Business Transactions · Datadog resources | △ | spanmetrics `span_name` | RED 패널에 상위 5개만 — 전체 표·정렬은 다음 |
| 4 | SLO · 오류 예산 · 소진율 경보 | Datadog SLO · Dynatrace SLO | ✓ | Micrometer | 서비스 (APM) › 서비스 SLO |
| 5 | 런타임(JVM · Node …) | 공통 | ✓ | jvm_* 27 · process_* | 히트맵 JVM 여유 · 앱 종류 |
| 6 | 로그 ↔ 트레이스 연결 | 공통 | ✓ | Loki + traceId | 로그 줄 → Tempo 링크 |
| 7 | **외부 호출 · 의존성**(HTTP 클라이언트 · DB) | Datadog external services · AppD backends · NR externals | ✗ | `http_client_requests_seconds` 앱 8개(client_name · uri · status) · hikaricp 24 | 맵이 그리지 못하는 '트레이스 밖 대상'(외부 API · DB) — 다음 1순위 |
| 8 | **메시징 지연**(Kafka 소비 지연) | Datadog Data Streams · Dynatrace queues | ✗ | `kafka_consumer_fetch_manager_records_lag*` 15 | 맵에는 메시징 선만 |
| 9 | 오류 추적(예외 묶음) | Datadog Error Tracking · NR Errors inbox | △ | Loki 예외 클래스 | 로그 지표의 워크로드 × 예외 Top 15 — 서비스 · 처음 본 시각 · 추세 묶음은 다음 |
| 10 | 분산 트레이스 검색 · 워터폴 | Datadog Trace Explorer · AppD snapshots · NR distributed tracing | ✗(링크만) | Tempo(클러스터 안) | 인증 없는 백엔드를 직접 읽지 않는 원칙 — Grafana `/api/ds/query` 연결별 opt-in(관측 스택 절 2단계)으로 |
| 11 | 지속 프로파일링 | Datadog Continuous Profiler · Dynatrace | ✗(링크만) | Pyroscope(클러스터 안) | 10과 같은 길 |
| 12 | 배포 추적 · 버전 비교 | Datadog deployment tracking · Dynatrace release | ✗ | Argo CD 출처(정책 화면) · `kube_*_metadata_generation` | platform-roadmap ② 변경 타임라인 |
| 13 | 자동 기준선 · 이상 탐지 | AppD dynamic baselines · Dynatrace Davis | ✗ | 모든 시계열 | 결정 대기 — 임계값 없는 색 금지 원칙과 충돌하지 않게 '평소 대비 n배'를 사실로 |
| 14 | Kubernetes 상태 경고 신호 | Dynatrace warning signals · Recommendations | △ ✓10/29 | ✗ 15 중 13은 데이터 있음 | kubernetes-ia 7.6 순서 |
| 15 | 경고 규칙 작성 · 적용 현황 | 공통 | △ | Resource Graph 규칙 그룹 0개 조회 | 알림 센터는 받기만 |
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

## 4. 다음 순서 (데이터가 이미 있는 것부터)

1. **외부 호출 · 의존성**(7): `http_client_requests_seconds`(client_name · uri · status) + hikaricp(대기 · 시간 초과)
   - 서비스 카드에 '외부 대상' 줄을 붙입니다. 맵의 트레이스 밖 대상을 채웁니다.
2. **Kubernetes 경고 신호**(14): PV · Job · HPA · 대기 이유 · 시작 지연 · 과할당 → 개요 탭(kubernetes-ia 7.5)
3. **메시징 지연**(8): Kafka `records_lag_max` → 맵의 메시징 선과 소비 서비스 카드
4. **엔드포인트 표 · 오류 묶음**(3 · 9): spanmetrics 전체 `span_name` 정렬 표, Loki 예외 클래스를 서비스 · 처음 본 시각으로
5. **Prometheus 호환 엔드포인트**(17): 연결에 `prometheus {url, auth: azure | sigv4 | google | bearer}`
   - `resolvePrometheusTarget` 뒤로 숨깁니다. 질의 · 집계 코드는 그대로입니다.
6. **결정 대기**: 트레이스 · 프로파일 읽기(10 · 11, Grafana 경유 opt-in), 기준선(13), 배포 추적(12 — 로드맵 ②)

## 출처

- Datadog: [Service Page](https://docs.datadoghq.com/tracing/services/service_page/) · [Trace View](https://docs.datadoghq.com/tracing/trace_explorer/trace_view/) · [Container Monitoring](https://docs.datadoghq.com/containers/monitoring)
- Dynatrace: [Kubernetes app](https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/container-platform-monitoring/kubernetes-app)
- AppDynamics(Splunk): [Flow Map Overview](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/26.3.0/business-applications/flow-maps/flow-map-overview) · [Dynamic Baselines](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/25.7.0/business-transactions/monitor-the-business-transaction-performance/dynamic-baselines)
- New Relic: [Explore Kubernetes](https://docs.newrelic.com/docs/kubernetes-pixie/kubernetes-integration/understand-use-data/explore-k8s/)
- Microsoft: [Recommended alert rules for Kubernetes clusters](https://learn.microsoft.com/azure/azure-monitor/containers/kubernetes-metric-alerts) · [Default Prometheus metrics configuration](https://learn.microsoft.com/azure/azure-monitor/containers/prometheus-metrics-scrape-default)
