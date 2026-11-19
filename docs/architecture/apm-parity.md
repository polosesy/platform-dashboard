---
status: draft
owner: platform-observability
last-verified: 2026-11-19
covers: [apps/api/src/services/serviceGraph.ts, apps/api/src/services/appErrors.ts, apps/api/src/services/rollouts.ts, apps/api/src/services/appDependencies.ts, apps/api/src/services/k8sRecommendedAlerts.ts, apps/api/src/services/msRecommendedAlerts.ts, apps/web/src/lib/apmServiceMap.ts, apps/web/src/app/observability/components/ServiceMapView.tsx, apps/api/src/services/workloadRed.ts, apps/api/src/services/workloadSlo.ts, apps/api/src/services/promScope.ts, apps/web/src/lib/traceView.ts, apps/web/src/lib/apmSignals.ts, apps/web/src/lib/apmDiscovery.ts, apps/web/src/lib/apmServiceMap.ts, apps/web/src/app/observability/components/TracesView.tsx]
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
| 9 | 오류 추적(예외 묶음) | Datadog Error Tracking · NR Errors inbox | **✓ 메트릭 부분 (2026-11-16)** · 예외 클래스는 △ | `log4j2_events_total` 앱 17 · 25일+ / Loki 예외 클래스(≤6시간) | 서비스 (APM) › 오류 — 앱별 ERROR·FATAL·WARN, 7일 날짜별, 처음·마지막 시각, 24시간 새로 생김. 예외 클래스 라벨은 메트릭에 없음 → 로그 지표(Loki) |
| 10 | 분산 트레이스 검색 · 워터폴 | Datadog Trace Explorer · AppD snapshots · NR distributed tracing | **✓ (2026-11-16)** | Tempo — **Grafana 데이터 원본 프록시 경유** | 4c절 — 연결별 opt-in · 운영자 · 연결 신원의 Grafana Viewer |
| 11 | 지속 프로파일링 | Datadog Continuous Profiler · Dynatrace | ✗(링크만) | Pyroscope(클러스터 안) | 10과 같은 길 |
| 12 | 배포 추적 · 버전 비교 | Datadog deployment tracking · Dynatrace release | **✓ (2026-11-16)** | `kube_replicaset_created`·`_owner`·`kube_pod_container_info` (7일 롤아웃 70) | 서비스 (APM) › 배포 — 이미지 이전 → 지금, 서비스 직전 30분 vs 직후. 기존 ReplicaSet으로의 롤백은 잡히지 않음 |
| 13 | 자동 기준선 · 이상 탐지 | AppD dynamic baselines · Dynatrace Davis | **△ 사실 비교 (2026-11-16)** | spanmetrics `offset 7d` 482 시계열 | RED에 '1주 전 같은 시각' 요청·오류·p95와 ×배 — 모델·색 없음. 학습형 기준선·이상 경보는 결정 대기 |
| 14 | Kubernetes 상태 경고 신호 | Dynatrace warning signals · Recommendations | **✓ (2026-11-16)** | Microsoft 권장 30개 원문 평가 | 탭 '경고 신호' — 4절 |
| 15 | 경고 규칙 작성 · 적용 현황 | 공통 | △ | Resource Graph 규칙 그룹 0개 조회 | '경고 신호'가 권장 규칙을 켜면 어떻게 될지 + **이 클러스터용으로 고친 규칙 그룹 템플릿(복사용)** — 배포는 운영자 |
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

**고친 규칙 그룹 (복사용, 2026-11-16 — 15번 '규칙 작성'의 첫 단계)**

이 화면이 '울림/정상'이라고 말할 수 있는 것은 `job` 자리를 이 작업 영역 값으로 바꿔 평가했기 때문입니다. Microsoft 규칙 그룹을 **그대로** 켜면 다음 규칙은 이 클러스터에서 절대 울리지 않습니다.

| 원인 | 규칙 | 고침 |
|---|---|---|
| job 이름 불일치 — kubelet 시계열의 job은 고객 Alloy가 붙인 `prometheus.scrape.kubelet` | KubePersistentVolumeFillingUp · KubePersistentVolumeInodesFillingUp · KubeletPodStartUpLatencyHigh · KubePVUsageHigh (4) | job을 이 작업 영역 값으로 (`jobMismatches`가 계열마다 실제 job 값과 비교) |
| 메트릭 없음 | KubeJobFailed | `msRuleFixes.ts` — `kube_job_status_failed > 0` 이고 같은 Job의 성공·진행 중 파드 0 (재시도 뒤 성공한 Job은 제외) |
| 짝 중복 | KubePVUsageHigh | 볼륨 메트릭에 없는 pod·container 대신 PVC 단위로 짝 (`on(namespace, persistentvolumeclaim, cluster, instance, job)`) |

- 고침은 **원문이 평가되지 않을 때만** 씁니다. 원문 표 `msRecommendedAlerts.ts`는 그대로 둡니다.
- `ruleGroupTemplate` = Microsoft와 같은 모양의 ARM 템플릿(규칙 그룹 3개 · apiVersion 2023-03-01 · `for`·등급 원문 그대로)입니다. 매개변수(클러스터·작업 영역·액션 그룹)는 운영자가 채웁니다. 대시보드는 Azure에 쓰지 않습니다.
- stg 실측: 포함 25 + 고침 2 + 제외 3(쿼터 — `kube_resourcequota` 없음). 템플릿의 27개 식을 모두 작업 영역에서 실행해 오류 0, `job="kubelet"` 0개를 확인했습니다. KubeJobFailed 원문 = 메트릭 없음 → 고침 = 정상, KubePVUsageHigh 원문 = 식 오류 → 고침 = 정상.
- 화면: 원문 job이 다른 규칙은 '정상'이어도 목록에 남기고 ▲ 표시, 고침이 있으면 그 판정 칩과 식, 아래 '이 클러스터용 고친 규칙 그룹'(JSON 받기 · 배포 명령 자리표시자 · 이미 켠 Microsoft 그룹은 꺼서 중복 경고를 막으라는 안내).

**바로잡음**: kubernetes-ia 7.4에서 '✗ 15 중 13개는 데이터 있음'이라고 썼지만, 쿼터 규칙 2개는 `kube_resourcequota`가 없어 **11개**가 맞습니다.

**벤더 중립 메모**: Azure Monitor 작업 영역은 라벨 값을 대소문자 구분 없이 비교합니다(실측: `phase=~"Running|Pending"`도 소문자 값 200개와 일치). Microsoft 식의 `phase="failed"`는 여기서는 맞지만, 일반 Prometheus(AMP·GMP)의 kube-state-metrics 값 `Failed`와는 맞지 않습니다. 17번 작업 때 규칙을 대소문자 무시 정규식으로 옮겨야 합니다.

## 4b. 구현 — 오류 · 배포 · 1주 전 비교 (2026-11-16, 3차)

**원본 확인과 정정**

- 5절의 계획 "오류 시작 시각은 `logback_events_total`로"는 **틀렸습니다.** 그 이름은 작업 영역에 있지만 시계열이 0개입니다(지금도, 29일 전도). 앱들이 쓰는 것은 `log4j2_events_total`입니다.
  - 앱 17개 · 파드 37개, 수집기 alloy 하나
  - 25일 넘게 보존, 1시간 리셋 0회
  - level 라벨: trace…fatal
  - **예외 클래스 라벨은 없습니다.**

**오류** `GET /api/observability/app-errors` → `services/appErrors.ts`

- 기간 ERROR·FATAL·WARN은 앱마다 소수 둘째 자리까지 유지합니다. 앱마다 먼저 정수로 반올림하면 730 vs 731처럼 합이 어긋났습니다.
- 7일은 **UTC 달력 날짜**, 범위 질의 하나(1시간 단계)입니다. 처음·마지막 오류 시각, '24시간 안에 새로 생김'(그 전 6일엔 없음)도 여기서 계산합니다.

| 대조 | 집계 | 독립 질의 |
|---|---|---|
| 1시간 ERROR+FATAL | 23 | 23 |
| 1시간 WARN | 731 | 731 |
| 24시간 시간별 합 | 112 | 112 |
| 7일 날짜별 합 | 8,801.12 | 같은 정의의 서버 하위 질의 8,801.13 |

처음엔 7일 합이 8,797 vs 9,109로 맞지 않았습니다. '끝에서 7×24시간'은 달력 날짜 8개에 걸치는데 날짜 목록이 7개라 가장 오래된 날의 시간을 버린 것이 원인이었습니다. 지금은 첫 날 자정부터 읽습니다. 단일 `increase` 8,777과의 0.3% 차이는 계산 방식 차이입니다. 7일 동안 시계열이 74 → 316개로 바뀌어(롤아웃) 외삽이 달라집니다.

**배포** `GET /api/observability/rollouts?days=1|7` → `services/rollouts.ts`

- 롤아웃 = Deployment 소유의 새 ReplicaSet
- 이미지: 지금은 새 ReplicaSet의 파드, 이전은 생성 1분 전 그 Deployment의 다른 ReplicaSet 파드(소유 관계로 고름 — 이름 접두사 `orders-`는 `orders-api`까지 잡는 버그였음)
- 같은 이름 트레이스 서비스의 서버 스팬을 직전 30분과 직후(최대 30분)로 나란히 둡니다. 최근 10개를 비교합니다.

| 대조 | 집계 | 독립 질의 |
|---|---|---|
| 1일 롤아웃 수 | 9 | 9 |
| 한 롤아웃의 직전 30분 요청 | 2.07 | 서버 스팬 − actuator 2.07 |

**1주 전 비교**: RED가 같은 창을 `offset 7d`로 다시 읽어 서비스마다 요청·오류율·p95와 ×배를 보여 줍니다. 대조: 1주 전 요청 18,310 = 18,310. 그 시각 지금은 3,417로, 1주 전의 0.19배였습니다.

## 4c. 구현 — 트레이스 검색 · 워터폴 (2026-11-16, 4차)

**원칙 유지**: 클러스터 안 Tempo는 인증이 없어 직접 읽지 않습니다. 고객의 Azure Managed Grafana가 문입니다.

- 경로: `GET <grafana>/api/datasources/proxy/uid/<tempo>/api/search?q=<TraceQL>&start&end&limit&spss` · `…/api/v2/traces/<id>` (Grafana 12.4에서 실측 — `/api/ds/query`보다 Tempo 원래 응답이 그대로 와서 단순함)
- 인증: 클러스터 연결의 신원으로 Managed Grafana 토큰(알림 센터 'Grafana에서 가져오기'와 같은 대상). 그 신원에 Grafana Viewer가 있어야 합니다. delegated · Lighthouse 연결은 고객 Grafana용 앱 토큰이 없어 `unsupportedMode`.
- 켜기: 연결 파일 `aks.observability.grafana.traces: true` + `datasources.tempo` UID. 기본 꺼짐.
- 문: **운영자만** — 스팬에 URL·속성·예외 문구가 있어 Pod 로그와 같은 문. 속성 값·상태 메시지·예외(스택 4,000자 상한)는 로그 가리기 규칙(`logRedaction`)을 거칩니다.
- API `GET /api/observability/traces?clusterId&service&namespace&name&errorsOnly&minDurationMs&minutes&at&limit` · `GET /api/observability/trace?clusterId&traceId` → `services/grafanaTraces.ts`. 필터 값은 모양 검사(400) 후에만 TraceQL에 들어갑니다(이스케이프로 넣지 않음).
- 상태: ok · notConfigured · forbidden(Grafana 401/403) · unsupportedMode · notFound(보존·샘플링) · failed — 빈 결과와 '못 읽음'을 섞지 않습니다.
- 화면: 서비스 (APM) › **트레이스** — 서비스 · 네임스페이스 · 스팬 이름 · 스팬 길이 · 오류만 → 트레이스 목록(루트 스팬 · 길이 · 스팬/오류 수 · 서비스) → 누르면 워터폴(부모 아래 자식, 이 트레이스의 시간 축 막대, 오류 스팬 ▲) → 스팬 속성 · 예외 · 이벤트, 'Grafana에서 열기'. 엔드포인트 표의 '트레이스 →'가 그 서비스·엔드포인트로 검색을 엽니다.

**검증 (stg, 2026-11-16 — 내 Entra 토큰, Grafana Viewer)**

| 대조 | 집계 | 독립 확인 |
|---|---|---|
| `{ status = error }` 1시간 상위 20개 | 행 20 | Tempo 원래 응답 20 |
| 트레이스 10개의 스팬 수 · 오류 스팬 수 · 길이 · 부모 연결 | 10개 모두 일치 | 다른 API(v1 `/api/traces`, base64 `batches`)를 따로 센 값과 검색의 `serviceStats` |
| 서비스 필터 | 20행 모두 그 서비스 포함 | — |

**보완 (2026-11-17) — '최대 30개'와 상세 위치**

- **기본 검색은 최신순이 아니었습니다.** Tempo 3.1.1은 `limit`만큼 찾으면 먼저 답한 블록에서 멈춥니다(실측: 작업 8개 중 5개, 37분 전 것이 섞임 — 더 새 오류가 있었음). 모든 검색에 `with (most_recent=true)`를 붙여 모든 블록을 훑고 진짜 최신 `limit`개를 받습니다(8/8, 최대 30분 전).
- **페이지**: 응답 `since`(기간 시작)·`next`(다음 쪽 끝 = 가장 오래된 시작 + 1초, 기간 시작에 닿으면 null) → `?since=&before=`로 다음 쪽, 화면 '다음 30개 더 보기', 트레이스 ID로 중복 제거, 새 것이 없는 쪽이면 멈춤.
- **문제 그룹**(트레이스 위): spanmetrics 전수(RED·엔드포인트와 같은 읽기)로 오류가 많은 엔드포인트 · p95가 가장 느린 엔드포인트 → 누르면 그 서비스·스팬 이름(+ 오류만 / p95 버킷 아래 경계 이상)으로 검색. 트레이스 기간 = RED 기간(5·15·60·360·1440분)이라 수가 같은 범위입니다.
- **상세 위치**: 루트 스팬을 누르면 상세가 **그 행 바로 아래**(표 안 다음 행)에 펼쳐지고 화면이 그곳으로 이동, 포커스도 옮깁니다(화면보다 길면 상세 시작에 맞춤). 예전엔 표 전체 뒤(스크롤 맨 아래)에 붙어 동작 여부를 알기 어려웠습니다.

| 검증 | 결과 | 기준 |
|---|---|---|
| 1시간 `{ status = error }`를 30개씩 끝까지(대시보드 `searchTraces` 그대로) | 3쪽 · 60개 · 일치 오류 스팬 60 | 한 번에 2000개 요청 60개(빠짐 0 · 더함 0) · spanmetrics 오류 스팬 60.00 |
| 끝을 지금 − 2분으로 | 61 vs 60.0 | span → 지표 지연(끝을 늘리면 61·62) — 비교는 5분 지난 창으로 |
| 브라우저(Edge CDP, 합성 데이터 30행) 12번째 행 클릭 | 상세 = 바로 다음 행(간격 1px), 화면 안(top 481/900), 포커스 이동, 스크롤 0 → 1099 | DOM 위치·getBoundingClientRect |
| 더 보기 | 30 → 60행 | — |

- Tempo의 `metrics.completedJobs < totalJobs`는 '한도에 차서 일찍 멈춤'이라 화면은 '더 있을 수 있음'으로만 말합니다.
- 시험 배포(2026-11-17): 배포본이 **자기 연결 신원**으로 읽음 — 1시간 오류 트레이스 3쪽 60개 · 일치 스팬 60 = spanmetrics 60.00, 트레이스 상세 정상. (2026-11-16엔 그 신원이 Grafana 401이었음 — 이후 역할이 생김.)
- 기능 × 권한 카탈로그에는 아직 없습니다(Grafana 데이터 평면 미모델 — Graph와 같음).

## 4d. 레퍼런스(Datadog DASH 2026) 대비 — 트레이스 상세 · 서비스 맵 신호 · 계측 범위 (2026-11-18)

**원본**: 사용자가 준 Datadog 화면 4장(서비스 맵 '신호로 거르기', OTel 수집기 토폴로지, 트레이스 플레임 그래프 2장)과 [DASH 2026 관측 기능 정리](https://www.datadoghq.com/blog/dash-2026-new-feature-roundup-observability/) 원문. 화면은 저장소에 넣지 않았습니다(제3자 이미지).

| Datadog 기능 | 이 플랫폼 (전) | 데이터 | 이번 결과 |
|---|---|---|---|
| 트레이스 플레임 그래프 · 워터폴 · 스팬 목록 · 맵 · JSON 탭 | 워터폴만 | Tempo(Grafana 경유) | **플레임 그래프 · 워터폴 · 스팬 목록** 보기 전환. 맵·JSON 탭 대신 스팬 속성 트리 + 'JSON 복사' |
| % 실행 시간(서비스별) · 색 = 서비스 | 없음 | 같음 | **서비스별 실행 시간**(자기 시간, 합 100%). 색 대신 목록에서 고른 서비스 강조 — 아래 '색' |
| 스팬 거르기(속성) · 오류만 n | 없음 | 같음 | 이름·서비스·속성 키·값 단어 거르기 + 오류만(n) — 안 맞는 블록은 흐림 |
| 스팬 속성 트리(JSON) | 키·값 표 | 같음 | 점 구분 키를 트리로(OTel semconv), JSON 복사 |
| 머리: 서비스 › 리소스 › trace_id · 길이 · HTTP 메서드·URL·상태 · 몇 분 전 · 링크 | 일부 | 같음 | 경로 머리 + 요청 줄(semconv 새·옛 이름) + 상대 시각 + **링크 복사**(`/observability?trace=<id>` → APM 탭이 그 트레이스를 엶) |
| 플레임 그래프 확대 | — | 같음 | 블록 두 번 누르기 · '고른 스팬으로 확대' · '전체 보기' (스팬 2,000개·286분 트레이스에서 필요) |
| 서비스 맵 '신호로 거르기: 지연 n · 오류율 n · 요청량 n' + 노드 신호 | 실패 ▲만 | spanmetrics 지금·1주 전, 서비스 그래프 | **신호 칩 3개 + 카드 신호 줄** — 판정 규칙은 아래(사실 비교) |
| 노드 주석 Critical dependency · High fan-out | 없음 | 서비스 그래프 | 카드에 '← 부르는 서비스 수 · → 부르는 대상 수'(사실 숫자, 등급 없음) |
| Map / List 전환 | 맵만 | 같음 | **목록** 보기(신호 먼저 · 요청 많은 순 · p95와 1주 전) |
| Service Discovery — 계측이 필요한 서비스 | 없음 | 앱 종류 API(실행 중인 파드 소유자) | **계측 범위** 패널 — 아래 |
| Trace Patterns(구조가 비슷한 트레이스 묶음) | 문제 그룹(엔드포인트 오류·p95) | 검색 표본 30개씩 | **하지 않음** — 표본 30개로 묶음을 만들면 순위가 표본에 좌우됨. spanmetrics 전수 '문제 그룹'이 같은 질문(어디부터)에 답함 |
| OTel 수집기 토폴로지(초당 points 선) | 관측 스택 표 | 수집기 간 연결 정보 없음 | **하지 않음** — Alloy 지표에 '누가 누구에게 보내는지'(내보내기 대상 라벨)가 없어 선을 그으면 추측. 관측 스택 탭의 구성 요소별 송신·수신·실패가 사실 범위 |
| (Wiz CTEM 대시보드 · 공격 경로 화면) | 보안 메뉴 | — | 이번 범위(APM) 밖 — security-roadmap에서 따로 |

**판정 규칙**(`lib/apmSignals.ts` — 모델·숨은 임계값 없음, 칩 툴팁에 같은 문장)
- 오류 = 이 기간 오류 상태 서버 스팬 > 0(RED), 없으면 서비스 그래프 실패 호출 > 0
- 지연 = p95 버킷이 1주 전 같은 시각의 p95 버킷보다 높음(버킷 경계, 보간 없음), 양쪽 요청 ≥ `RED_MIN_REQUESTS`(20)
- 요청량 = 지금 / 1주 전 ≥ 2 또는 ≤ ½(1주 전 0이면 '새로 생김'), 큰 쪽 ≥ 20
- 부르는/부름 받는 수 = 서비스 그래프의 서로 다른 상대(자기 호출 제외)

**계측 범위**: 범위 = 트레이스를 보내는 워크로드가 하나라도 있는 네임스페이스(시스템 네임스페이스를 이름으로 추측하지 않음). 워크로드 = 앱 종류 API의 실행 중인 파드 소유자. 짝 = 서비스 그래프·RED가 준 워크로드, 없으면 같은 네임스페이스의 정확히 같은 이름. 짝 없는 트레이스 서비스는 따로 적음(다른 이름으로 보내는 워크로드일 수 있음).

**색**: Datadog은 블록을 서비스마다 칠합니다. 이 플랫폼의 상태색(초록·주황·빨강)을 뺀 분류색으로 검증기(dataviz `validate_palette.js`, 블록은 아무 둘이나 붙으므로 모든 쌍)를 돌렸더니 4색은 파랑↔보라가 색약 ΔE 4.5·정상 시각 10.5로 실패, 3색은 어두운 모드에서 청록↔자홍 색약 ΔE 1.6으로 실패. 남는 색은 상태색과 겹침 → **블록은 한 색**, 서비스는 실행 시간 목록에서 골라 강조(진하게) + 블록 이름표 — 색만으로 정체를 말하지 않음. 오류 블록 = 빨간 테두리 + '!'.

**검증**
| 대조 | 결과 | 기준 |
|---|---|---|
| 실행 시간 — stg 트레이스 15개(스팬 75) | 15/15 일치, 최대 차이 0 ms, 비율 합 100% | 원본 OTLP JSON을 따로 읽어 나노초 BigInt · 사건 정렬(다른 알고리즘)로 계산 |
| 플레임 배치 — 같은 15개 + 스팬 3,581~4,704개 트레이스 3개(2,000개로 잘림) | 겹침 0 · 부모보다 위 0 · 배치 5–16 ms | 같은 줄 구간 비교 |
| 스팬 목록 | 개수·오류 합 = 원본 | 원본 스팬 수 |
| 서비스 맵 신호 — stg 1시간(서비스 18 · 연결 16) | 오류 1 = 1 · 요청량 8 = 8(같은 서비스) · 부르는 수 18/18 | 내 토큰으로 작업 영역에 PromQL 직접(지금·`offset 7d`) + 집합 계산 |
| 계측 범위 — stg | 범위 네임스페이스 1 · 워크로드 23 = 23 · 트레이스 없는 6 = 6(같은 목록) · 짝 없는 서비스 1 | `kubectl get deploy,sts,ds`(준비된 파드 > 0) − spanmetrics·서비스 그래프 이름 |
| 화면(로컬 웹 + 헤드리스 Chrome) | 블록 2,000 렌더 · 패널 넘침 0 · 링크로 열기 · 키보드 Enter · 확대 2,000 → 5블록 → 전체 2,000 · 신호 칩 2·1·1 = 합성 기대값 · 카드 넘침 0 · 목록 필터 1행 · 계측 범위 8개 중 5 | DOM 측정 |

지연 신호는 버킷 비교라 stg 대조에서 빼고 단위 테스트로만 확인했습니다(`apmSignals.test.ts`). 테스트 `traceDetail.test.ts`·`apmSignals.test.ts`.

## 4e. 지연 신호 실측 대조 · 플레임 그래프 색 · 계측 없는 서비스 발견 (2026-11-18, 2차)

**지연 신호 — stg 실데이터**: 대시보드 경로(API `redQueries` → `aggregateRed` → 웹 `serviceSignals`)와 독립 계산(따로 쓴 PromQL `sum by (service_name, le)` 지금·`offset 7d` + 별도로 구현한 p95 버킷 — 경계 오름차순, +Inf 개수의 95% 이상인 첫 경계)을 같은 작업 영역에서 비교.

| 기간 | 판정 대상(양쪽 ≥ 20건) | 대시보드 | 독립 계산 |
|---|---|---|---|
| 1시간 | 5 | 0 | 0 |
| 6시간 | 6 | 1 | 1 (같은 서비스, p95 버킷 0.1 → 0.3초) |

**플레임 그래프 색**(사용자 요청 — 4d의 '한 색' 결정을 바꿈): Datadog처럼 색 = 서비스. dataviz 참고 팔레트에서 이 플랫폼의 상태색과 겹치는 초록·노랑·빨강을 빼고 5색, 24개 순서를 검증기(인접 쌍 — 블록은 부모·자식으로 붙음)로 돌려 양쪽 모드를 통과하는 순서 중 파랑·주황·청록·보라·자홍(최악 색약 ΔE 9.2 밝음 / 9.4 어두움, 목표 8 이상). `globals.css` `--series1…5-rgb`(어두운 단계 따로) + `palette.ts` VIZ. 칸 = 트레이스에 처음 나타난 순서(`serviceSlots` — 거르기·확대로 다시 칠하지 않음), 6번째부터 slate '기타'(색을 만들지 않음). 인접하지 않은 블록끼리는 기준 밖 쌍이 붙을 수 있어 **색만으로 정체를 말하지 않음**: 블록 이름표 · 범례(실행 시간 목록의 색 견본 + 이름) · 고르면 강조. 오류는 색이 아니라 빨간 테두리 + '!'. '색: 서비스별 | 한 색'. 화면 측정: 서비스 7개 → 1–5칸 + slate 2, 채우기 6가지, 한 색 = 1가지.

**계측 없는 서비스 발견**(Datadog Service Discovery — 그쪽은 eBPF 에이전트): 같은 질문을 **Cilium이 이미 보는 네트워크 흐름**(Hubble 서비스 맵, Pod 트래픽과 같은 표본)으로 답함 — 앱 계측과 무관. `lib/apmDiscovery.ts`: Hubble 워크로드 ↔ 트레이스 서비스를 정확한 이름으로만(서비스 그래프·RED가 준 워크로드, 없으면 유일한 같은 이름) 짝짓고, 짝 없는 워크로드 = '네트워크로 발견 · 트레이스 없음' 카드(점선 ○, 흐름·드롭 — 요청·지연 없음), 트레이스에 없는 연결 = 청록 점선(흐름·드롭·포트). 범위 '트레이스 있는 네임스페이스'(기본) | 모든 네임스페이스. 켤 때만 표본을 읽음(Hubble UI 백엔드 보호 — CLAUDE.md Hubble UI 절). 합성 표본 화면 측정: 발견 2 · 연결 2 · 짝 2 = 기대값. stg 실데이터 대조는 로그인 토큰이 필요한 API라 배포본에서 아래 확인.

## 4f. 화면 다듬기 — 트레이스 글꼴 · 문제 그룹 · 서비스 발견 (2026-11-18, 3차)

사용자 검토 세 가지를 측정으로 확인하고 고쳤습니다. 측정 = 로컬 웹 + 헤드리스 Chrome, stg 모양의 합성 데이터(이름 지어냄, 문서용 IP).

| 항목 | 전 | 후 | 기준 |
|---|---|---|---|
| 트레이스 상세 — 고정폭 글꼴 | 2벌(브라우저 기본 Consolas 14px + Geist Mono 12px) | 1벌(Geist Mono 13px) | 요소마다 계산된 글꼴·크기·굵기 |
| 트레이스 상세 — (글꼴, 크기, 굵기) 조합 | 11 | 10 | 같은 측정 |
| 속성 표 | 키·값 모두 고정폭 12px, 키는 파랑 | 키 = 본문 글꼴 회색 · 값 = 고정폭, 깊이와 상관없이 값이 한 열에서 시작 | 화면 |
| 문제 그룹 — 두 주제의 경계 | 없음(간격만) | 세로 구분선 1px(좁은 화면은 가로선), 주제마다 머리 줄·개수 | 계산된 테두리 |
| 문제 그룹 — 숫자 열 | 문장 속에 섞임 | 순위 · 엔드포인트 + 서비스 · p95 또는 오류 · 요청, 숫자의 오른쪽 끝 x 좌표 8행 모두 같음 | DOM 좌표 |
| 서비스 발견(모든 네임스페이스) — 맵 크기 | 노드 41 · 2,904×1,146px, 트레이스 서비스가 시스템 네임스페이스 뒤로 밀림 | 노드 19 · 1,584×370px(넓이 −82%), 트레이스 서비스가 맨 앞 | 노드 좌표 |
| 서비스 발견 — 선 이름표 | 카드를 고르면 그 카드의 네트워크 선마다 | 기본 0 · 선을 가리키면 그 선 하나(`흐름 3 · 드롭 0 · 4317/TCP` = 합성 값) · 누르면 고정 | 실제 마우스 이동(CDP) |

**서비스 발견 배치**(`lib/apmServiceMap.ts`): 트레이스 서비스가 지도의 몸통이고, 트레이스가 없는 것은 한 단계 조용하게 그립니다.
- 트레이스 있는 네임스페이스 안: 서비스 뒤에 점선 상자 '계측 없음 · n'과 작은 카드(이름 + 흐름 · 드롭).
- 트레이스 서비스가 하나도 없는 네임스페이스(kube-system·모니터링·GitOps …): 네임스페이스마다 카드 하나, 레인 '트레이스 없는 네임스페이스 n'에 모읍니다. 누르면 그 네임스페이스가 펼쳐지고(워크로드마다 작은 카드), 머리의 '접기'로 닫습니다.
- 접힌 네임스페이스로 가는 연결은 그 카드로 모으고 흐름을 더합니다('연결 n개 합침'). 접힌 네임스페이스 안끼리의 연결만 선이 없고 `hiddenInside`로 셉니다.
- 단계(왼→오)는 트레이스 연결만으로 정합니다. 그래서 발견을 켜도 트레이스 서비스의 자리가 그대로입니다(테스트).
- 검증(`apmDiscovery.test.ts`): 발견한 워크로드 수 = 카드 + 네임스페이스 카드가 품은 수, 선의 흐름 합 = 원본 연결의 흐름 합(접어도 잃지 않음), 펼치기·접기 왕복.

React Flow는 노드 선택을 끈 화면에서 선에 마우스 이벤트를 보내지 않습니다(선 클릭 핸들러가 없으면 `pointer-events: none`). 그래서 선 클릭(이름표 고정)을 함께 둡니다. 터치 화면에는 가리키기가 없기도 합니다.

## 4g. 서비스 맵 — Datadog 서비스 디스커버리 양식 (2026-11-18, 4차)

Datadog 'Map and monitor all your services automatically' 화면의 구성을 따랐습니다. 다만 **이름표마다 규칙 하나**이고 근거 없는 색은 없습니다.

**화면 구성**: 맨 위 한 줄(요약 + 오른쪽 '서비스 계측하기 →' — 계측 범위 패널로 이동·포커스) → 테두리 틀 하나: 머리(기간 `1h` · 지난 1시간 | [⊶ 맵 · ☰ 목록]) → '신호로 거르기:' 칩 3개(아이콘 · 이름 · 개수 거품) + 오른쪽 보기·찾기 → 네트워크 발견 줄 → 맵(틀에 붙음) 또는 목록 → 범례(틀의 꼬리).

**카드**: 본문(서비스 사각형 · 이름 / 종류 · 네임스페이스 / 받은 요청 · 실패 / **신호 띠**) + 테두리 밖 **각주 한 줄**(자리는 늘 비워 둠 — 각주 유무로 카드 위치가 바뀌지 않음, `APM_CARD_H` = 본문 96 + 각주 20). 선은 곡선(베지어).

| 화면의 말 | 규칙 (`lib/apmSignals.ts`) | 단계·색 |
|---|---|---|
| 오류율 위험 · n% | 오류율 ≥ **1.44%** 이고 요청 ≥ 20건 — 1.44% = 14.4(SLO 빠른 소진 경보 배수, `SLO_ALERTS` page1h) × (1 − 99.9%(`SLO_DEFAULTS`)) — 30일 예산의 2%를 1시간에 쓰는 속도. 테스트가 두 상수를 API 값과 맞춤 | critical — 빨강, 사각형 ■ |
| 오류 n건 · n% | 그 밖의 오류(스팬 ERROR, 없으면 서비스 그래프 실패) | high — 주황, ▲ |
| 지연 증가 · p95 a → b | p95 버킷이 1주 전보다 높음(양쪽 요청 ≥ 20) | high — 주황, ▲ |
| 요청량 급증 ×n · 급감 ×n · 새 요청 | 1주 전의 ×2 이상 · ½ 이하 · 1주 전 0 | info — 파랑(변화이지 장애가 아님), ◆ |
| 신호 없음 | 위 어느 것도 아님 | 색 없음, ● |
| ⓘ 공유 의존 · n개 서비스가 부름 | 부르는 서비스 ≥ 2(자기 호출 제외) — 실패가 부르는 쪽 모두로 번짐 | 회색 각주 |
| ⓘ 넓은 팬아웃 · n개를 부름 | 부르는 대상 ≥ 3 — 한 요청이 모두를 기다림 | 회색 각주 |

신호가 둘 이상이면 띠는 가장 나쁜 것 + `+n`, 툴팁에 모두와 규칙. 목록은 같은 띠를 모두 보이고 정렬은 띠 무게(위험 8 · 오류 4 · 지연 2 · 요청량 1의 합) → 요청 수 → 이름(`serviceRows`).

**검증**
- 칩 숫자 = 맵에서 밝은 카드 수 = 목록 행 수 — 단위 테스트(`serviceRows` = `signalCounts`) + 실제 화면(로컬 웹 + 헤드리스 Chrome, 합성 데이터 7개 서비스): 지연 2 = 2 = 2 · 오류 2 = 2 = 2 · 요청량 2 = 2 = 2, 1440px·390px 모두.
- 경계: 오류율 1.44%는 위험, 1.43%는 오류, 요청 10건의 30%는 오류(테스트).
- stg 원 데이터(PromQL — 서비스 그래프·spanmetrics 1시간, 내 토큰)로 셈한 값 = 라이브러리: 서비스 18 · 오류 3 · **오류율 위험 0**(가장 높은 스팬 오류율 0.37%) · 공유 의존 6 · 넓은 팬아웃 1.
- 함께 고침: 목록 보기에서 맵이 아래에 그대로 남던 버그(`hidden` 속성이 클래스의 `display: grid`에 짐).
- 좁은 화면(같은 날 고침): APM 보기 전환 막대(버튼 8개, 내용 폭 514px)가 칸을 넓혀 390px에서 틀이 화면 밖으로 잘렸음 → 칸 = `minmax(0, 1fr)`, 막대만 자기 상자에서 가로 스크롤(`.viewScroll`, 포커스 고리 여백), 고른 보기는 상자 가운데로. 측정: 390px 페이지 넘침 0 · 틀 오른쪽 374 ≤ 390 · 8개 모두 화면 안에서 눌림(요소 적중) · 실제 클릭으로 SLO 선택 후 보임 / 1440px 상자 스크롤 없음(520 = 520).

## 4h. 프로필 — Datadog 프로필 시각화 (2026-11-19)

**원시 데이터(stg, 내 Grafana Viewer 토큰)**:
- 고객 Grafana에 Pyroscope 데이터 원본 2개. 하나는 Pyroscope에 닿지 못함(연결 시간 초과) — 연결 파일에 맞는 UID를 적어야 함.
- 닿는 쪽: Java만(`pyroscope_spy=javaspy`, `jfr_event=itimer`, 서비스 16개), 종류 3개 — CPU(`process_cpu`) · 할당 바이트 · 할당 개수(`alloc_in_new_tlab_*`).
- 라벨 `app_name · cluster · collector · jfr_event · namespace · pyroscope_spy · service_name` — **스레드 라벨 없음**.
- 프로필 하나 = flamegraph 프레임 하나(`level · value · self · label` 열거, 5,187–6,503행).

**구현**: `services/grafanaProfiles.ts`(Grafana 데이터 원본을 거쳐 읽음 — 트레이스와 같은 문: 연결 `grafana.profiles` + `datasources.pyroscope`, 운영자만) + 순수 `lib/profileView.ts` + `ProfilesView`.

| Datadog 보기 | 여기 | 데이터 |
|---|---|---|
| 플레임 그래프 | 루트 위 아이시클, 폭 = 비율, 누르면 확대 + 경로, 찾기, 색 = 코드 · 언어 런타임(JDK …) · 네이티브(.so·JVM) — 이름에서 아는 사실만 | 중첩 집합 → 형제 끝에서 시작(`flameRects`) |
| CPU time by Method | 상위 함수 — self(그 함수 안) · total(재귀는 한 번) | `topFunctions` — self 합 = 루트 |
| 호출 그래프 | 함수 하나를 가운데 두고 부르는 함수 · 부르는 대상(선 = 그 호출로 쓴 값), 누르면 그 함수로 | `callEdges`·`butterfly` |
| 단일 프로필 | 시간 그림의 점 하나 = 한 수집 구간(15초) — Pyroscope는 업로드 단위를 따로 주지 않음 | 시계열 한 칸 |
| 비교 | 바로 앞 같은 길이 구간 — 경로별 전체 대비 비율 차이(%p), 함수별 차이 | `shareDiff`·`functionDiff` |
| 스레드 타임라인 | **만들 수 없음** — 스레드 라벨·샘플 시각이 없음, 화면이 이유와 라벨 목록을 말함 | — |
| 언어별 프로필 종류 | Datadog 표(Java 10 · Python 7 · Go 8 · Ruby 4 · Node.js 4 · .NET 6 · PHP 5 · 네이티브 3) × 이 클러스터: 수집 중 · 수집 안 함(Java는 Pyroscope 에이전트 설정) · Pyroscope에 없음 | `languageCoverage` |

**시계열 단위(실측)**: Grafana가 CPU를 **코어**, 바이트를 **초당**, 개수를 **15초 칸마다**로 줌 → Σ × 칸(× 10⁹) ≈ 루트(CPU 6.56 s vs 6.54 s · 717.6 MB vs 716.5 MB · 1,359 vs 1,357 — 창 가장자리 차이).

**확인**:
- 중첩 집합 일관성(value = self + 자식) 0 / 6,503 위반 · self 합 = 루트(세 종류 모두).
- 실제 트리 화면: 프레임 5,187 · 상위 함수 100행 · 호출 그래프 부르는 함수 12 / 대상 2 · 오류 0.
- 테스트 `profiles.test.ts`(손으로 계산한 트리 — 폭·위치·재귀 total·호출 무게·비교 %p).

## 5. 다음 순서 (데이터가 이미 있는 것부터)

1. ~~외부 호출 · 의존성(7)~~ · ~~Kubernetes 경고 신호(14)~~ · ~~메시징 지연(8)~~ · ~~엔드포인트 표(3)~~ — 4절에서 구현
4. ~~오류 묶음(9)의 메트릭 부분~~ — 4b절에서 구현
   - 남은 것: **예외 클래스별** 처음 본 시각.
   - 보류 이유: 메트릭에 예외 클래스가 없고, Loki로 긴 기간 정규식은 6시간 상한 원칙에 걸립니다.
   - **앱 수정 없이 인프라만으로 됩니다**(2026-11-16 실측). 6시간 ERROR 이벤트 43개(오류가 있던 앱 8개 전부)를 보니 예외 클래스가 있는 26개는 **모두 첫 줄**에 클래스가 있었고, 둘째 줄 이후에만 있는 것은 0개였습니다. 고객 Alloy의 `errmetrics` 갈래(첫 줄만 보고 `stage.metrics`로 ERROR 카운터를 만듦)에 `stage.regex`로 클래스를 뽑아 카운터 하나를 더하면 됩니다. 여러 줄 합치기는 필요 없습니다.
   - 나머지 17개는 줄 어디에도 예외 클래스가 없습니다(`log.error("…")`만). 이것까지 클래스로 묶으려면 앱이 예외 객체를 함께 로깅해야 합니다 — 이것만 앱 수정입니다.
   - 주의: 클래스 이름은 라벨 값이라 종류 수만큼 시계열이 생깁니다(앱 × 클래스). 짧은 이름만(패키지 제외) · 정규식에 안 맞으면 라벨 없음으로 상한을 둡니다. 고객 저장소 변경이라 이 저장소에서는 적용하지 않았습니다.
   - Loki recording rule은 ruler가 설정돼 있지 않아 Alloy 쪽이 더 작습니다.
5. **Prometheus 호환 엔드포인트**(17): 연결에 `prometheus {url, auth: azure | sigv4 | google | bearer}`
   - `resolvePrometheusTarget` 뒤로 숨깁니다. 질의 · 집계 코드는 그대로입니다.
   - 보류 이유: 검증할 AWS·GCP 환경이 없어, 확인하지 못한 인증 코드를 내보내지 않습니다.
   - 먼저 할 것: 시험용 EKS/AMP 또는 GKE/GMP, 또는 자체 Prometheus 하나와 대소문자 규칙 전환(4절 메모).
6. **결정 대기**(구현하지 않은 이유)
   - ~~트레이스 검색(10)~~ — 4c절에서 Grafana 경유로 구현. 프로파일(11)은 같은 길(Pyroscope 데이터 원본 프록시)로 할 수 있지만 화면(플레임 그래프)이 커서 다음 차례입니다.
   - 학습형 기준선 · 이상 경보(13): '1주 전 비교'는 사실이라 구현했습니다. 모델이 정하는 기준선은 '임계값 없이 색칠하지 않는다'는 원칙과 맞춰야 해서 결정이 필요합니다.
   - 규칙 작성(15): 고친 규칙 그룹 템플릿을 **복사용**으로 제공합니다(4절). 대시보드가 직접 배포하는 것은 플랫폼이 읽기 전용이라 하지 않습니다.
   - RUM · 합성(16): 브라우저와 외부 프로브가 필요해 범위 밖입니다.

## 출처

- Datadog: [Service Page](https://docs.datadoghq.com/tracing/services/service_page/) · [Trace View](https://docs.datadoghq.com/tracing/trace_explorer/trace_view/) · [Container Monitoring](https://docs.datadoghq.com/containers/monitoring)
- Dynatrace: [Kubernetes app](https://docs.dynatrace.com/docs/observe/infrastructure-monitoring/container-platform-monitoring/kubernetes-app)
- AppDynamics(Splunk): [Flow Map Overview](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/26.3.0/business-applications/flow-maps/flow-map-overview) · [Dynamic Baselines](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/25.7.0/business-transactions/monitor-the-business-transaction-performance/dynamic-baselines)
- New Relic: [Explore Kubernetes](https://docs.newrelic.com/docs/kubernetes-pixie/kubernetes-integration/understand-use-data/explore-k8s/)
- Microsoft: [Recommended alert rules for Kubernetes clusters](https://learn.microsoft.com/azure/azure-monitor/containers/kubernetes-metric-alerts) · [Default Prometheus metrics configuration](https://learn.microsoft.com/azure/azure-monitor/containers/prometheus-metrics-scrape-default)
