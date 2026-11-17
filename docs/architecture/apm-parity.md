---
status: draft
owner: platform-observability
last-verified: 2026-11-16
covers: [apps/api/src/services/serviceGraph.ts, apps/api/src/services/appErrors.ts, apps/api/src/services/rollouts.ts, apps/api/src/services/appDependencies.ts, apps/api/src/services/k8sRecommendedAlerts.ts, apps/api/src/services/msRecommendedAlerts.ts, apps/web/src/lib/apmServiceMap.ts, apps/web/src/app/observability/components/ServiceMapView.tsx, apps/api/src/services/workloadRed.ts, apps/api/src/services/workloadSlo.ts, apps/api/src/services/promScope.ts]
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
