---
status: current
owner: platform-observability
last-verified: 2026-11-11
covers: [apps/api/src/services/workloadSlo.ts, apps/web/src/lib/sloView.ts, apps/web/src/lib/timeRange.ts, apps/web/src/lib/useTimeRange.ts, apps/api/src/services/nodeMaintenance.ts, apps/web/src/lib/nodeMaintView.ts, apps/web/src/lib/k8sNetMap.ts, apps/api/src/services/observabilitySources.ts, apps/api/src/services/hubbleUiSource.ts, apps/api/src/routes/observability.ts, apps/web/src/lib/workloadHeatView.ts, apps/web/src/lib/logView.ts, apps/web/src/lib/kubeEventsView.ts, apps/web/src/lib/logInsightsView.ts, apps/web/src/lib/sloSettingsView.ts, apps/api/src/services/sloSettingsStore.ts, apps/api/src/services/workloadHeatmap.ts, apps/api/src/services/kubeEvents.ts, apps/api/src/services/lokiLogs.ts, apps/api/src/services/observabilityStack.ts, apps/api/src/services/logRedaction.ts]
---
# AKS 모니터링 연동 — 워크로드 히트맵 · kube 이벤트 · 로그 스트림 · Hubble 드롭 · AKS 관리형 파드

고객 클러스터가 이미 모으는 신호(Azure Monitor 작업 영역의 메트릭, 클러스터 안 Loki, Kubernetes API)를 대시보드가 **읽기만** 해서 SRE 화면으로 엮습니다. 값은 모두 측정값이고, 시계열·행이 없으면 '미측정'으로 둡니다(0 금지). 2026-10-23에 실제 고객 stg 클러스터(AKS + ACNS Cilium 1.19, Alloy → AMW, Loki 3.7, Tempo 3.1)로 확인했습니다.

## 1. 데이터 경로

| 화면 | 출처 | 신원·권한 | 없을 때 |
|---|---|---|---|
| 워크로드 히트맵 | AMW: cAdvisor·kube-state-metrics·Micrometer(`jvm_*`·`hikaricp_*`·`http_server_requests_*`)·로그 ERROR 카운터 | 클러스터 연결 신원 — 작업 영역 Monitoring Data Reader | 상태(작업 영역 없음·권한 없음·실패) |
| Warning 이벤트 | Kubernetes API core/v1 `events` (list, `type=Warning`) | `aud-dashboard-reader`에 `events` 추가(이 문서와 함께 생성 — [템플릿](../integrations/azure/templates/aks/aud-dashboard-reader.yaml)) | 403 `aks_rbac_forbidden` |
| 로그 스트림 | 클러스터 안 Loki `query_range` (연결 파일 `aks.observability.loki`) | Pod 로그와 같은 문: 운영자 + `aks.podLogNamespaces` | `notConfigured` / `unreachable`(연결 안 됨 — 정책) / `busy`(연결됨·느림·과부하) / `failed` |
| 로그 탭 (Pod 하나) | ① Loki `{namespace, pod[, container]}` → ② kubelet → ③ Container Insights — 응답 `attempts`에 출처마다 결과 | ①② 운영자 + `aks.podLogNamespaces`, ② `pods/log` Role(네임스페이스별), ③ Log Analytics Reader | 칩: 읽음·이 기간 줄 없음·설정 안 됨·허용 안 됨·권한 없음·연결 안 됨·실패 |
| Hubble 드롭 | Loki `{job="hubble-flows"}` (hubble-flow-exporter — **DROPPED만** 보냄, 연결선 없음) | 보기 권한 | 위와 같음 |
| Hubble 흐름·서비스 맵 (exec 꺼짐) | 클러스터의 Hubble UI 백엔드 `service-map-stream`(연결 파일 `aks.observability.hubbleUi`) — Relay '최근 10,000건' 표본, 응답(reply)은 Relay에서 제외 | 보기 권한, 네트워크만(파드 exec·Secret 없음) | `notConfigured`·`unreachable`·`unsupported`(0.13 미만)·`failed` |
| 관측 스택 | AMW (Alloy·Loki·Tempo·Pyroscope·수집 대상·Cilium) | 작업 영역 Monitoring Data Reader | 상태 |

**왜 Loki를 직접 읽나**: Managed Grafana `/api/ds/query`는 Viewer 역할이 인스턴스의 모든 데이터 원본(stg·prd 공용 인스턴스)에 미쳐 범위가 더 넓고, 네임스페이스 경계는 어차피 대시보드가 지켜야 합니다. 클러스터 안 Loki는 대시보드가 이미 kubelet으로 읽을 수 있는 Pod 로그와 같은 범위에 과거 기록만 더합니다. 질의(LogQL)는 서버가 검증된 이름으로만 만들고 브라우저 문자열은 받지 않습니다. 줄은 4 KB·500줄·응답 2 MB로 자르고, 토큰·키·비밀번호·SAS·PEM을 가립니다(`logRedaction.ts` — kubelet Pod 로그에도 적용).

**Loki가 막혀 있을 때**: 고객의 `monitor` 네임스페이스 정책이 같은 네임스페이스와 Grafana 관리형 사설 엔드포인트만 Loki 3100에 들입니다(확인함). 그러면 화면은 `unreachable`과 함께 아래 규칙을 보여 줍니다 — 적용은 클러스터 관리자가 GitOps로 합니다(대시보드는 쓰지 않음). 지금 stg 정책(`monitor-baseline`)에는 `app.kubernetes.io/name: aud-dashboard` + 네임스페이스 `aud-dashboard` → 3100 허용이 이미 있습니다.

**`unreachable`과 `busy`는 다릅니다**(2026-11-05 — Loki가 알림 조회로 포화된 동안 패널이 '닿지 않음'과 정책 규칙을 보였으나, 대시보드 파드에서 `/ready`는 104ms에 200이었고 Loki 지표에는 그 시각 `query_range` 499·500·p99 24.8초 — 15초에 끊은 읽기를 '연결 안 됨'으로 분류한 오진): 연결 전 단계 오류(`ECONNREFUSED`·`EHOSTUNREACH`·`ENOTFOUND`·`UND_ERR_CONNECT_TIMEOUT` …) = `unreachable`(정책 규칙 표시). 시간 초과·응답 중 끊김(Loki 쓰기 30초 EOF)·499/502/503/504/429·타임아웃류 500 = `/ready`를 한 번(3초) 물어 답하면 `busy`(규칙 없음, 원인 문장 + '다음 조회는 hh:mm 이후'), 답이 없으면 `unreachable`. `busy` 뒤 1분 동안 그 Loki로는 다시 묻지 않음(`BUSY_BACKOFF_MS` — 자동 새로 고침이 과부하에 조회를 더 쌓지 않게), 읽기 시간 한도 25초(Loki 쓰기 한도 30초 바로 아래 — 15초에 끊으면 Loki가 이미 한 일을 버림). 바쁜지 볼 곳: Grafana 'Loki 조회·수집 상태'(대기열·동시 처리).

```yaml
# monitor 네임스페이스 정책의 ingress에 추가
- fromEndpoints:
    - matchLabels: { "k8s:io.kubernetes.pod.namespace": aud-dashboard }
  toPorts: [{ ports: [{ port: "3100", protocol: TCP }] }]
```

> 고객에게 알릴 점: Loki가 `auth_enabled: false`로 내부 LB·Private Link 뒤에 있어 VNet 안에서는 인증 없이 모든 로그를 읽을 수 있습니다.

**로그 탭이 비던 이유**(2026-10-27 stg 실측): 연결은 `integration` 하나만 허용하는데 드롭다운은 모든 네임스페이스를 이름 순으로 보여 첫 선택이 거부됐고, 클러스터에는 `pods/log` Role이 없었으며(읽기 ClusterRole 하나뿐), 마지막 출처 Container Insights는 DCR이 Perf·Syslog뿐이라 0줄 — 이 셋이 모두 200 '로그 없음'으로 숨었습니다. 이제 Loki를 먼저 읽고(같은 문), 허용된 네임스페이스를 드롭다운 맨 앞에 두며, 출처마다 결과를 칩으로 보입니다.

**Hubble UI를 읽는 이유**: hubble-flow-exporter는 차단만 Loki에 보내 정상 연결선이 없고, ACNS 흐름 로그(`ContainerNetworkLog`)는 꺼져 있으며, Relay는 mTLS라 AKS가 관리하는 kube-system Secret(클라이언트 인증서)이 있어야 합니다. Hubble UI 백엔드는 그 인증서로 이미 Relay에 붙어 있으므로, 대시보드는 Secret·exec 없이 HTTP로 짧게(최대 8초·10,000건, 30초 캐시) 표본만 읽습니다. 공개 API가 아니어서(hubble-ui 0.13의 customprotocol: JSON 봉투 + protobuf 본문) 형식이 다르면 `unsupported`로 멈추고 추측하지 않습니다. stg 실측: 7,651건(중복 제거 후)·약 44초 구간·서로 다른 연결 281개·POLICY_DENIED 24건. 고객에게 알릴 점: Hubble UI는 인증 없이 클러스터의 모든 흐름을 보여 주므로 접근은 네트워크 정책으로 좁혀야 합니다(차트 `networkPolicy.hubbleUi: true`가 대시보드 쪽 송신 규칙을 추가).

**네트워크 (Hubble) › 서비스 맵**(2026-10-27 재작성): 라이브 다이어그램과 같은 문법 — 네임스페이스 상자 안 워크로드 카드(상태 띠 + ● ▲ ■ ○), 왼쪽 '인터넷 → 클러스터', 가운데 네임스페이스를 요청 단계 순서로, 오른쪽 '클러스터 밖 · 구성 요소'(인터넷 나감·API 서버·노드). 거의 모든 워크로드가 DNS·API 서버·노드와 통신하므로 그 선은 카드를 고를 때만 그리고 카드에는 칩만 둡니다. 화면은 저절로 다시 그려지지 않습니다: 열 때 표본 한 번, '새 표본', '실시간 (30초)'(기본 꺼짐). 표본은 15분 동안 누적되어 이번 표본에 없는 연결은 점선으로 흐려질 뿐 사라지지 않고, 배치는 카드·선이 생기거나 없어질 때만 바뀝니다. 같은 기회에 Cilium 예약 식별자 6(remote-node)·7(kube-apiserver)이 바뀌어 있던 것을 고쳤습니다(다른 노드 트래픽이 API 서버로 보였음).

## 2. 워크로드 히트맵 (AKS 모니터링 › 클러스터 · 워크로드)

**화면 구성**(2026-10-27 개편 — Datadog Kubernetes 개요 방식): 탭 5개 = 클러스터 · 워크로드(기본) · 노드 · 로그 · 네트워크(Hubble) · 수집 상태. 첫 탭 맨 위 **클러스터 한눈에 보기** 띠(`clusterGlance` — 히트맵이 잰 값만): 워크로드(위험·주의·정상 쌓은 막대, 누르면 문제만) · Ready 파드 n/m · 레플리카 부족 · 재시작(기간) · OOMKilled 파드 — 칸을 누르면 아래 히트맵이 그 신호로 칠해집니다. 아무도 재지 않은 값은 '—'·'미측정'(0 아님). 예전 '개요' 탭(Container Insights 요약)은 DCR에 Container Insights가 없으면 0만 보여 없앴습니다. **[히트맵 | 표]**(2026-11-03): 표 = 히트맵과 같은 값(같은 요청)을 워크로드 한 줄씩 — 열 = 한 워크로드라도 잰 신호만, 머리글을 누르면 그 신호의 등급 → 값(나쁜 쪽 먼저, JVM 여유는 낮을수록 나쁨) 순 정렬, 행을 누르면 같은 상세 패널(`tableColumns`·`tableRows`). 예전 '목록 (Container Insights)'은 없앴습니다 — DCR이 Perf·Syslog뿐인 stg에서 늘 비었고, 파드 상태는 AKS 클러스터 화면(Kubernetes API)과 겹쳤습니다.

고객 Grafana '컨테이너 맵'을 한 장으로, **문제 먼저**: 요약 한 줄(판정 알약 '● 주의 필요 없음'/'■ 위험 n · 주의 m' + 울린 신호만 칩 — 누르면 그 신호로 칠함, 나머지는 '정상 신호 n개'·'미측정 신호 n개' 글자(목록은 툴팁) + 범례) → **주의 필요** 목록(있을 때만 — 위험 먼저, `ns / 워크로드`와 이유 '메모리 96% · 재시작 3') → 네임스페이스 카드 **모자이크**(가장 나쁜 카드 먼저; 바깥 격자 = 타일 칸 132px·4px 행, 카드는 자기 타일 수만큼 √(2.2n)열 안팎(빈칸 가장 적은 열)·높이만큼 행을 차지, 배치는 순수 `packMosaic` — 문제 순서대로 가장 위·왼쪽 빈자리, 더 위에 들어가면 폭을 ½까지 바꾸고, 놓은 뒤 오른쪽 빈 열로 넓히고 맨 아래 선까지 늘려 바깥 모양을 직사각형으로(2026-10-30 — `grid-auto-flow: dense`는 카드 크기를 못 바꿔 9칸 화면의 18%가 페이지 배경으로 비었음 → 98%), 카드 사이 틈은 불투명 패널 바탕 `.hmSurface` — 타일 1개 네임스페이스는 타일 1칸 폭, 열 수는 너비에 따라 `mosaicColumns`·`cardShape`). 타일 = **카드 전체가 상태 색**(2026-11-11 — 왼쪽 상태 띠는 장식처럼 읽혀 바꿈: 바탕 옅은 색 + 진한 테두리, 정상 옅은 초록 · 주의 노랑 · 위험 빨강, 기준 없음·멈춤·미측정은 색 없음, 문제 네임스페이스 카드는 머리 띠를 칠함) + 기호: ● 정상 · ▲ 주의 · ■ 위험 · ○ 실행 대상 없음 · ◎ 측정됨·판정 기준 없음 · ? 미측정 점선 · – 계측 없음 빗금, 주의·위험 값은 흰 알약에 진한 글자, 이름은 네임스페이스 접두와 카드 공통 접두(`sharedPrefix`, 머리글에 '· 접두…')를 뺌, 종류는 툴팁. 기호가 항상 상태를 함께 보임. 모든 워크로드를 그림(Grafana 통계 패널은 48개 중 26개만 그렸음), '문제만' 토글은 기본 꺼짐. 신호 선택은 묶은 선택 상자 하나(쿠버네티스·Java/Spring·로그). 타일을 누르면 오른쪽 상세(값·파드·Warning 이벤트·로그 스트림 — ERROR 먼저, 예외 클래스 상위 10, trace ID → Tempo 링크), 방향키로 타일 이동·Esc로 닫기. 보기 모델은 `apps/web/src/lib/workloadHeatView.ts`(순수, `workloadHeatView.test.ts`).

| 신호 | 계산(파드별 → 워크로드의 가장 나쁜 파드) | 주의 / 위험 |
|---|---|---|
| 가용 | KSM ready/desired (Deployment·StatefulSet·DaemonSet). 목표 0 = 실행 대상 없음 — DaemonSet은 '대상 노드 없음'(`noNodes`), 그 밖은 '0개로 줄임'(`scaledToZero`), 나머지 신호는 '파드 없음'(`noPods`) | <1 / 0 |
| 메모리 | 컨테이너 WS / memory limit (+ 바이트 `abs`) + **기간 안에** 끝난 OOMKilled(`last_terminated_timestamp > time() − 기간`, 타임스탬프 없는 KSM은 예전 뜻). 풀이에 기간 최대 WS(`peak` — `max_over_time`, 등급은 지금 값). limit 없음 = **측정됨·기준 없음**(`noBaseline` — 사용량 Mi만, 색 없음) | 80% / 90% |
| CPU | **선택한 기간**의 5분 사용량 p95 / request(+ p95 코어 `abs`) — `quantile_over_time(0.95, …[기간:1m|5m])`(1h = 1m, 6h·24h = 5m), 컨테이너 시작 10분은 단계마다 뺌(`kube_pod_container_state_started`, 재시작 포함). 풀이 = p95·평균·최대·지금(5분)·request·CPU 대기(PSI `container_pressure_cpu_waiting_seconds_total` p95)·스로틀(CPU limit 있을 때만). request 없음 = 측정됨·기준 없음. 2026-11-05: 순간값이던 예전 칸은 캡처마다 위험·정상이 뒤바뀜(alloy 282% → 다음 날 45%, 기동 순간 429%) | 주의 = 150%+ 이면서 p95 ≥100m, 또는 PSI 5%+·스로틀 10%+ / 위험 = PSI 10%+ 또는 스로틀 25%+ (limit 없으면 request 초과는 노드의 남는 CPU를 빌려 쓸 뿐) · 100m 미만 = `belowFloor` · 시작 10분뿐 = `warmingUp` |
| **CPU 지금** (보기용 신호) | 최근 **15분 평균** 사용 / request(`rate[15m]`) — 고객 Grafana 컨테이너 맵 CPU 타일과 같은 식, 기간과 무관(끝 = 범위 끝). 풀이 = 15분 평균·5분·request + **기간 중 request 초과 분**(`count_over_time((5분 사용 > request)[기간:1m|5m])` × 간격 — 지금 값만 보면 되풀이 버스트가 가려짐, P2-5). 파드 표에 '지금' 열. 2026-11-05: stg 76개 중 '100m 미만 전부 회색'이면 70개가 회색이라 정상이 안 보였음 → 100m 기준은 request를 넘었을 때만 | 초록 <100% · 노랑 100%+ · 빨강 150%+ · request 초과인데 100m 미만 = 색 없음(`belowFloor`). **보기용**(`LENS_METRICS`) — 종합 등급·빨간 띠·전체 보기의 이유엔 안 들어감(CPU 판정은 위 p95 + PSI) |
| 재시작 | `changes(restarts[기간])` 합 | 1 / 5 |
| Old Gen | `jvm_memory_usage_after_gc` | 70% / 85% |
| JVM 여유 | heap이 **최대까지 찼을 때** limit에 남는 메모리 = limit − (heap 최대(Serial·Parallel은 survivor 풀이 1개만 보고하므로 한 번 더 더함 — 2026-11-05 postgresql-app 545→563Mi) + non-heap **committed** + direct 버퍼 + 네이티브). 네이티브 = max(0, RSS − heap committed − non-heap committed − direct) = 스레드 스택·malloc arena·JIT·GC 표(RSS 없으면 가장 큰 컨테이너 WS). SerialGC·ParallelGC는 키운 heap을 돌려주지 않아 바쁜 파드는 결국 최대에 감. committed·RSS가 없으면 있는 값만(`partial`). **네이티브는 지금 값과 그 파드의 24시간 최대 중 큰 쪽**(`jvmNativePeak` = `max_over_time((RSS − JVM 집계분)[1440m:5m])`, 기간 선택과 무관 — glibc가 arena를 돌려주면 지금 값이 내려감: stg Spring 앱 322 → 394Mi·365 → 430Mi), 풀이에 관측 시간(파드 나이, 최대 24) — 막 배포한 파드는 아직 최대에 닿지 않았을 수 있음. 수집기 이중 시계열은 모든 JVM 질의에서 `max by (…, id)`. 2026-11-05: 예전 식(limit − heap 최대)은 non-heap·네이티브를 빠뜨려 workflow-postgresql-app 205Mi(주의)로 보였으나 새 식 −181Mi | 폭 = max(100Mi, limit 10%): 주의 = 폭 미만(`marginal`) / 위험 = −폭 미만(`configDeficit`), 또는 0 미만이면서 메모리 80%+·Old Gen 70%+·기간 중 OOMKilled(`imminent`) — 빨간 띠는 위험만 |
| HTTP 5xx | **선택한 기간**의 워크로드 전체 5xx / 전체 요청(`increase`, `/actuator` 제외), 요청 0 = 트래픽 없음, 20건 미만 = 비율만 보이고 판정 안 함(`lowTraffic`) | 0.5% / 1% |
| 로그 ERROR | 수집기가 만든 ERROR 카운터(연결 파일 `aks.observability.logErrors`)의 기간 증가 — 기간 중 생긴 시계열도 전부 셈 | 1 / 50 |
| 커넥션 풀 | Hikari active/max (가장 나쁜 풀), pending | 70% / 90%, pending ≥1 |

Java/Spring 지표가 없는 워크로드는 '계측 없음', 작업 영역에 그 지표 묶음이 아예 없으면 '미측정'.

**AKS 관리형**(2026-11-05): konnectivity-agent·coredns·ama-*·cilium처럼 AKS가 설치·관리하는 워크로드는 CPU·메모리 값과 색을 그대로 두고 '**AKS 관리형 — 조치 불가**'를 붙여 **신호 띠에서 뺍니다**(재시작·가용은 그대로 셈), 주의 목록에서는 같은 등급의 우리 워크로드 뒤. 판정은 **워크로드 자체 라벨** `kubernetes.azure.com/managedby=aks` 또는 `addonmanager.kubernetes.io/mode`(정책 점검의 `isAksManaged`와 같음) — 이미지 출처(`mcr.microsoft.com`)·네임스페이스로 판정하지 않음(우리가 설치한 hubble-ui·hubble-flow-exporter도 kube-system·MCR 이미지, 라벨은 고객 플랫폼의 `app.kubernetes.io/managed-by`뿐). AKS KSM에는 `kube_*_labels` 시계열이 없어(stg 확인) VPA 패널이 이미 읽는 Kubernetes 워크로드 목록(기존 list 권한, 60초 캐시)에서 꺼냄 — 1.5초 안에 안 오거나 403이면 `managedState: unknown`(화면에 한 줄, 그때는 띠에 포함), 목록은 계속 읽혀 다음 새로 고침에 반영.

**조회 실패 격리**(2026-11-05 — 기간 서브쿼리가 늘어 쿼리 44개): 관측 스택과 같은 실행기(질의마다 12초·일시 오류 1회 재시도). 워크로드 목록 질의(소유자·레플리카 `CORE_QUERIES`)가 실패하면 오류, 그 밖은 그 신호에 필요한 질의(`SIGNAL_NEEDS`)가 실패한 칸만 '조회 실패'(`queryFailed` — 정상·미측정으로 바꾸지 않음, 띠 수 null), 응답 `gaps` → 화면 경고 '질의 n개가 응답하지 않음 · 조회 실패한 신호', 부분 결과는 15초만 캐시. stg 실측: 1시간 창 44개 모두 1초 미만, 24시간 창 서브쿼리 0.3–0.7초. 완료된 파드(Job, `az aks command invoke`)는 타일·파드 행을 만들지 않음 — 이미 있는 워크로드의 로그 ERROR 수에만 더함(예전엔 재시작·cAdvisor 행이 `command-…` 타일을 '? 미측정'으로 만들었음).

**실측(2026-10-26, stg)**: Windows 노드가 없는 클러스터의 Windows 전용 DaemonSet 10개와 `retina-agent`(노드 조건 `kubernetes.azure.com/ebpf-dataplane NotIn cilium` — Cilium 노드를 피함)는 목표 0 — 예전엔 '0/0 0/0'·'? 미측정'으로 보였음, 이제 기본 숨김('대상 노드가 없는 DaemonSet n개 숨김 · 보이기'). AKS 관리 `cilium`·`acns-security-agent`는 컨테이너에 requests·limits가 아예 없음(`kubectl get ds -o jsonpath` 확인) — 비율이 없으니 사용량(예: 366Mi·49m)만.

**RED(트레이스 spanmetrics) — 보류**: 서버 span 서비스 17개가 워크로드 이름과 정확히 일치하지만, `traces_spanmetrics_calls_total`이 10분에 4번 리셋되어(값은 1분에 약 12 증가) `rate()`가 리셋마다 누적값을 더함 → 합계 7,906/s, Micrometer `http_server_requests_seconds_count` 합계는 10/s(약 800배, 대부분 `/actuator/health` span). 같은 시계열에 쓰는 곳이 둘(alloy-traces 복제본·재시작)이거나 spanmetrics 설정 문제로 보임 — 고객 파이프라인에서 `resets(traces_spanmetrics_calls_total[10m])` = 0이 된 뒤 구현(틀린 숫자는 그리지 않음). 확인 질의: `max(resets(traces_spanmetrics_calls_total{span_kind="span_kind_server"}[10m]))`.

**VPA 권장**(패널, `WorkloadVpaSection` + `services/workloadVpa.ts`): 작업 영역에는 VPA 시계열이 없어(AKS kube-state-metrics가 내보내지 않음) Kubernetes API로 VPA 객체와 워크로드 템플릿을 같은 시점에 읽음(기존 list 권한, 60초 캐시). 컨테이너마다 메모리·CPU의 request·limit·VPA 권장·VPA 범위, 표시는 VPA 자체 의미만 — 권장 > limit·request < 하한(주의), request > 상한(참고: VPA는 CPU를 25m 아래로 권장하지 않아 흔함). 모드 Off = 권장만. 실측(stg): VPA 26개 모두 Off, 컨테이너 28개 중 권장 > limit 1·메모리 request < 하한 7.

**로그 스트림**(패널, `WorkloadLogStream` + 순수 `apps/web/src/lib/logView.ts`): 같은 메시지(수·ID만 다른 것 포함 — `logSignature`)는 한 줄 '×n'(처음~마지막 시각·파드 수), 줄 = 로거가 되풀이한 앞 시각을 뺀 메시지(logback `… LEVEL … - 메시지`는 메시지만), 2줄 말줄임, 누르면 첫 줄 전체·앱 코드 스택(`▸ 클래스.메서드 (파일:줄)`, 패키지는 툴팁, 라이브러리 프레임은 'n개 더 보기')·Caused by·원문 복사·trace. 예외 클래스 칩 = 거르기. 스크롤은 패널 하나(목록 자체 스크롤 없음). 가리기는 MDC `[TOKEN-ID:…]`·세션 ID도(`logRedaction.ts`). 메트릭 묶음 존재는 묶음마다 따로 셉니다(`a or b`는 이름을 무시하고 라벨이 같은 시계열을 지움 — Hubble 메트릭 쪽에도 있던 버그).

### 시간 범위 · 새로 고침 (페이지 머리 — 모든 탭)

Grafana의 시간 선택기 + 새로 고침 선택기와 같은 막대 하나(`TimeRangeBar` — 공용 UI 키트, 순수 계산 `apps/web/src/lib/timeRange.ts`, 상태 `useTimeRange`): **«** 범위의 절반만큼 뒤로 · **범위**(최근 5분~30일, 빠른 범위는 '지금까지') · **»** 절반만큼 앞으로(지금에서 멈춤) · **⊖** 다음 단계로 넓힘(가운데 유지) · **직접 입력…**(시작·끝 — 5분~30일, 끝은 30일 전까지, 브라우저 시간대) · 단축키 **t ← · t → · t z**(입력 중·Ctrl 조합 제외) | **↻ 새로 고침**(모든 패널이 답할 때까지 돎) · **자동 새로 고침**(끔·30초·1분·5분·15분). 상태는 URL `?range=1h&to=<epoch ms>&refresh=30s` — 링크로 같은 화면.

| 패널 | 범위를 읽는 방법 | 범위와 다를 때 |
|---|---|---|
| 히트맵·한눈에 보기 | 창 = 범위(5·15·30분, 1·3·6·12·24시간), 끝 = 범위 끝 — 모든 PromQL을 그 시각에 평가(`time` 매개변수: `[W]`·`time()`·`offset`이 그 구간을 읽음, '지금 값' 신호도 그 시각의 값) | 24시간 넘는 범위 = 범위의 마지막 24시간 + 'ⓘ 히트맵은 최대 24시간' 칩. 지난 구간 = '<시각> 기준 — 지난 구간' 칩(AKS 관리형 표시·옆 패널의 VPA·이벤트·로그는 지금 값) |
| 노드 유지 보수 | 날 수 = 범위를 올림한 일(1–30), 끝 = 범위 끝(Activity Log·노드 이력·'진행 중' 판정 모두 그 시각 기준) | 1일보다 짧은 범위 = 1일 + '유지 보수 기록은 최소 1일' 칩(업그레이드는 몇 시간에 걸침). 유지 보수 창(다음 시작)은 지금 구성 |
| 노드 카드 | 지금 상태(Container Insights·Kubernetes API) — 범위 미적용, 줄에 그렇게 씀 | 지난 구간이면 안내 상자 |
| 워크로드 옆 패널 | 로그 스트림 = 범위를 덮는 창(5·15·30분, 1·3·6시간) + 끝 = 범위 끝(Loki `start`/`end`) | 6시간 넘으면 '로그 스트림은 최대 6시간 (Loki 부하)' — 고객 Loki는 단일 바이너리라 알림 조회만으로 CPU가 찼음(2026-11-05). 지난 구간이면 이벤트('Kubernetes는 약 1시간만 보관 — 아래는 지금 이벤트')·VPA('지금 값') 안내 |
| 로그 탭 | 분 = 범위(≤ 1일), 끝 = 범위 끝: Loki·Container Insights(`TimeGenerated between`)는 그 구간, kubelet은 지금 로그만이라 지난 구간이면 건너뜀(출처 칩 '지난 구간은 못 읽음', 상태 `pastRange`) | 1일 넘으면 '로그는 최대 24시간' 칩. 예전 15초 자동 갱신은 페이지의 자동 새로 고침으로 |
| 네트워크 (Hubble) | 새로 고침 = 새 표본, 자동 새로 고침 = 그 간격마다 표본(하위 보기의 '실시간'·'새 표본'은 숨김 — /hubble 페이지는 그대로). 지표 보기 창 = 범위를 덮는 5·15·60·360분 | 흐름 표본은 노드 버퍼(최근 몇 분)·지표는 지금 끝 — 지난 구간이면 'Hubble은 지금 것만' + **그 구간의 드롭 흐름**(Loki hubble-flows — 드롭만, 창 15·60·360·1440분 중 범위를 덮는 것, `at`; stg 7일 전 구간에도 남음) |
| 수집 상태 | 창은 그대로 10분(멈췄는지 보려면 짧아야 함), 끝 = 범위 끝 — 모든 PromQL을 그 시각에, Pyroscope Ready는 파드의 `kube_pod_status_ready`(Service 엔드포인트는 지금 것이라 안 읽음), 지난 구간엔 '마지막 정상값' 대체 없음 | '수집 상태는 범위 끝 기준 10분' 칩 |

**자동 새로 고침 규칙**: 보이는 탭에서만(`startPolling`), 앞 새로 고침이 끝나기 전엔 다음을 건너뜀, **지난 구간을 볼 때는 멈춤**(값이 바뀌지 않음 — '멈춤' 표시, 지금까지로 돌아오면 다시 시작). 최소 30초 = 히트맵 서버 캐시(더 빠르면 같은 답). 지난 구간 응답은 10분 캐시(‹‹ ››가 같은 끝을 오감). API: `heatmap?window=5|15|30|60|180|360|720|1440&at=<epoch 초>`, `node-maintenance?days=1..30&at=`, `logs?sinceMinutes=&at=`, `workload-logs?minutes=5|15|30|60|180|360&at=`, `stack?at=` — `at`은 분 단위로 내림, 1분 안 = 지금, 미래·31일 넘게 과거·숫자 아님 = 400 `invalid_time`(`queryPastTime`). 범위는 URL에서 프리셋 키 또는 `<n>m|h|d`(직접 입력한 길이) — 히트맵·유지 보수는 그 길이를 덮는 가장 가까운 창/일로 읽고 'n 창으로 읽음' 칩.

### 데이터 소스 칩 (페이지 머리)

`GET /api/observability/sources?clusterId=`(`services/observabilitySources.ts`): Prometheus·Container Insights는 항상, Loki·Tempo·Pyroscope·Grafana는 설정됐거나 작업 영역 지표에 송신 흔적이 있을 때만 칩(나머지는 '+n 설정 안 됨' 하나). 상태는 사실만 — ✓ 읽음(대시보드가 지금 읽음: Loki는 연결 파일 `aks.observability.loki` + `/ready` 2xx, 클러스터별 60초 캐시) · ↗ 링크만(Grafana Explore — Tempo·Pyroscope·Grafana는 절대 '읽음'이 아님) · ✕ 막힘(연결 거부·시간 초과 — 보통 고객 monitor 네임스페이스 정책) · ! 오류(HTTP 상태만) · – 설정 안 됨. 툴팁 둘째 줄 '수집'은 관측 스택 지표(Alloy `logsSent`·`spansAccepted`, 구성 요소 존재)에서 옴.

## 3. AKS 관리형 파드(kube-system) — 연동 가능 범위

| 파드 | 신호가 있는 곳 | 대시보드에서 | 상태 |
|---|---|---|---|
| cilium · cilium-operator · hubble-relay · hubble-ui · hubble-flow-exporter | AMW `hubble_*`·`cilium_*`(`cilium_unreachable_nodes` …), Loki `{job="hubble-flows"}` | Hubble 메트릭 화면, Loki 드롭 + 릴레이 NODE_ERROR + 파이프라인 끊김 교차 검증, 관측 스택 'Cilium이 닿지 못하는 노드' | 구현 |
| coredns · coredns-autoscaler | AMW `hubble_dns_responses_total`(CoreDNS 자체 메트릭은 수집 안 됨) | NXDOMAIN — ndots 안내 | 구현(Hubble) |
| ama-metrics · ama-metrics-ksm · -node · -operator-targets | AMW `up{job="prometheus_collector_health"}`, KSM 재시작 | 관측 스택·히트맵(kube-system 재시작) | 구현 |
| ama-logs · ama-logs-rs (Container Insights) | DCR 스트림이 Perf·Syslog뿐 — KubeEvents·ContainerLogV2·KubePodInventory 0행 | '목록' 보기는 비어 있음 → 히트맵(AMW)이 기본 | 확인 |
| acns-security-agent | FQDN 정책·DNS 프록시 | 정책 판정(Hubble 보안) | 일부 |
| microsoft-defender-* · defender-admission-controller | Defender for Cloud | 보안 메뉴 | 구현(기존) |
| azure-policy · azure-policy-webhook · gatekeeper | ARM 정책 상태 | AKS 보안 점검 | 기존 |
| vpa-* | VPA 권장(CRD) | AKS 보안 점검 자동 크기 — 워크로드 상세는 다음 | 다음 |
| aks-secrets-store-* · csi-azuredisk/azurefile · azure-wi-webhook | Warning 이벤트(FailedMount·회전 오류) | 히트맵 패널의 이벤트 | 구현(이벤트) |
| konnectivity-agent · metrics-server · eraser · azure-cns · ip-masq · cloud-node-manager | KSM 준비 상태·재시작 | 히트맵(kube-system 네임스페이스) | 구현 |

## 3a. 수집 상태의 '정상'은 파드 Ready까지 본 것

- 구성 요소(Alloy·Loki·Tempo·수집 대상 job)마다 자기 파드의 Kubernetes Ready(`kube_pod_status_ready`)를 봅니다 — Ready 아닌 파드가 있으면 '저하', 카드에 'Ready n/m · 근거'와 파드별 'Ready 아님 · 언제부터(`max_over_time(timestamp(… == 1))[7d:1m]`)'.
- **Pyroscope**는 빌드 정보가 없어, Alloy의 `pyroscope.write` 메트릭 `endpoint` 라벨(= 서비스 주소)로 **그 서비스의 엔드포인트**(Kubernetes API, 읽기 역할의 `endpoints` list)를 읽어 파드를 찾습니다. API가 안 되면 그 네임스페이스에서 서비스와 이름이 같은 워크로드(근거를 카드에 적음). 파드를 못 찾으면 **'보낸 양 > 0'만으로 정상이라고 하지 않습니다**(상태 '판정 안 함'). 보내다 버린 프로파일(`pyroscope_write_dropped_profiles_total`) > 0이면 저하.
- 왜: 2026-10-28 21:38–10-29 01:14Z stg pyroscope-0가 Ready가 아니었는데(노드·디스크·메모리 정상, 재시작 0), Alloy는 계속 초당 3.2개를 보냈고 화면은 '정상'이었습니다. 노드 업그레이드(10-23)와는 5일 떨어진 별개의 사건 — 원인은 pyroscope 로그에 있고, 이 화면은 추측하지 않습니다.

### 질의 하나가 늦어도 화면 전체가 실패하지 않음

- 2026-10-29 stg: 29개 질의 중 28개는 1초 안에 답했는데, `prometheus_remote_storage_highest_timestamp_in_seconds`(원격 쓰기 지연) 하나를 Azure Monitor 작업 영역이 13–30초 붙잡거나 504로 답했고(연속 5번, 그다음엔 90ms) — 예전엔 질의 하나의 실패가 탭 전체의 '메트릭 조회 실패 (This operation was aborted)'였습니다.
- 지금: 질의마다 12초 제한 + 시간 초과·504·429·네트워크 오류는 1번 재시도(400·401·403·PromQL 오류는 재시도 안 함). 그래도 답이 없는 질의는 `gaps`로 알리고 **그 질의에 기댄 값만 '조회 실패'** — 예: `count(up == 0)`이 실패하면 '응답 없음 0'이 아니라 '조회 실패'(빈 결과의 0으로 바꾸지 않음). 나머지 값은 그대로 보여 줍니다.
- 클러스터 범위 질의(`group by (cluster) (up)`)는 10분 캐시, 일부 실패한 결과는 15초만 캐시(곧 다시 읽음).
- 새로 고침 전체가 실패하면(작업 영역 오류·한도) **마지막으로 끝까지 읽은 결과(15분 이내)** 를 '읽은 시각'과 '이번 실패 이유'를 붙여 보여 줍니다. 권한 거부(403)는 옛 값 뒤에 숨기지 않습니다.

## 3b. 노드 유지 보수 (AKS 모니터링 › 노드, 라이브 다이어그램 AKS 카드·패널)

`GET /api/observability/node-maintenance?clusterId=&days=1..30[&at=<epoch 초>]` → `services/nodeMaintenance.ts` (날 수·끝은 페이지의 시간 범위 — §2 '시간 범위')

| 출처 | 읽는 것 | 왜 |
|---|---|---|
| Activity Log (클러스터 RG·노드 RG) | `agentPools/upgradeNodeImageVersion`, `managedClusters`·`agentPools` write, 노드 확장 집합 reimage·manualupgrade·delete, Resource Health | **실제 작업 시각**과 시작 주체(호출자 `Microsoft.ContainerService` = AKS 자동). `resourcechanges`는 감지 시각이라 쓰지 않음(10-23 17:00Z 업그레이드가 10-24 20:57Z로 기록) |
| 클러스터 ARM | `autoUpgradeProfile`(클러스터·노드 OS 채널), 노드 풀(이미지·최대 추가 노드·드레인), `maintenanceConfigurations` | 작업이 **유지 보수 창 안**이었는지, 다음 창은 언제인지 |
| kube-state-metrics | `kube_node_spec_unschedulable`(cordon)·Ready·`kube_node_created`(재등록 — reimage는 이름 유지)·`kube_node_info`(커널·kubelet)·`kube_pod_start_time` | 노드가 실제로 겪은 일과 다시 시작된 파드 수 |

- 사건 = 변경 작업과 노드 변화를 30분 간격으로 묶은 것. 읽기·자격 증명 조회·runCommand·역할/정책 할당은 넣지 않음(stg Activity Log의 대부분이 이 대시보드의 자격 증명 조회). kubelet 버전이 바뀌면 'Kubernetes 업그레이드'. 클러스터 작업이 없으면 시작 주체 '기록 없음'(추측 없음).
- 사건 밖의 노드 NotReady는 '유지 보수 밖'으로 따로.
- stg 실측: 10-09 17:00Z Kubernetes 1.36.2→1.36.4(클러스터 자동 창, 둘째 토요일), 10-23 17:00–17:49Z 노드 이미지 202609.15→202610.08(노드 OS 창, 넷째 토요일 02:00 KST) — 임시 노드 4, 재등록 5, 커널 6.8.0-1067→1070, 다음 창 11-28 02:00 KST.
- 30일은 Activity Log가 길어(3,282건/17쪽) 기간을 조각내 동시에 읽고, 쪽 제한에 걸리면 '일부만 읽음'.

## 3c. SLO · SLI (AKS 모니터링 › SLO)

`GET /api/observability/slo?clusterId=[&at=<epoch 초>]` → `services/workloadSlo.ts`(순수 `aggregateSlo`) → 웹 `SloTab` + `lib/sloView.ts`

| 무엇 | 어떻게 |
|---|---|
| SLI 출처 | Micrometer `http_server_requests_seconds`(Spring) — `/actuator` 제외. **spanmetrics는 안 씀**: 2026-11-05 다시 재 보니 `traces_spanmetrics_calls_total`이 10분에 1,270번 리셋(시계열 732개 — 같은 시계열에 쓰는 곳 둘), Micrometer는 1시간 리셋 0·30일 보관 |
| 가용성 | 5xx로 답하지 않은 요청 / 전체 |
| 지연 | 기준 이하 **버킷 경계** 안에 끝난 요청 / 전체(1xx 제외, 보간 없음 — 실제로 센 경계를 표시, 기준이 경계가 아니면 '경계 추가' 안내). stg는 `slo` 버킷 0.1·0.3·0.5·1·3초가 정확히 있음 |
| 목표 | **SLO › 설정**(플랫폼, 아래) · 연결 파일 `slo` · 기본값 99.9% / 99% ≤ 1초 — 가장 구체적인 값이 이김: 서비스별(플랫폼) › 서비스별(연결 파일) › 클러스터 기본(플랫폼) › 연결 파일 › 기본값 — 기본값은 '기본값' 표시 + **빨강 없음(주황까지)**. '지난 기간이 지킨 단계'(90·95·99·99.5·99.9·99.95·99.99% 중 가장 높은 것)는 참고값 |
| 오류 예산 | 허용 실패 = (1 − 목표) × 요청 — 화면은 '허용 실패 n건 중 m건 씀' |
| 소진 경보 | SRE Workbook 5장 다중 창: 1시간·5분 ×14.4 / 6시간·30분 ×6 = 즉시 대응, 3일·6시간 ×1 = 티켓. 긴 창 요청 100건 미만 = 판단 안 함 |
| 요청 적음 | (1 − 목표) × 요청 < 1(실패 1건이면 바닥) = 비율 SLO 판정 안 함, 합성 점검 권장 |
| 원인 | 기간 중 실패(5xx·느림)가 많은 URI 상위 3 + 한 URI 비중 — 일부러 오래 걸리는 경로는 `excludeUris`(모든 창에 같이 적용) |
| 데이터 기간 | 30일 중 데이터가 있는 시간(`[30d:1h]`) — 90% 미만이면 'n일치뿐' |
| 질의 | 창마다(5m·30m·1h·6h·3d·30d) `(namespace, application, uri, method, status)`별 개수 1개 + 경계 버킷 1개 → TypeScript가 두 SLI·URI·제외를 한 번에. stg 14개 질의 12.5초(30일 9–12초, 질의마다 25초 한도·1회 재시도·실패 격리), 5분 캐시 |

stg 실측(2026-11-05, 기본 목표): 서비스 16 — 가용성은 모두 목표 안(gateway 99.956%·예산 44%), 지연은 7개가 기본 목표 미달. 원인이 한 URI에 몰림(workflow-service 웹훅 97%, http-app `POST /actions/make-request` 97%, gateway 웹훅 83%). 요청 적음 4(sap-app 2건, notification-app 0건 …), HTTP 지표 없는 워크로드 6(웹 프런트·fluentd·keycloak 등 — Spring 아님).

### SLO › 설정 — 목표와 에러 버짓 초기화를 화면에서 (2026-11-11)

`GET /api/observability/slo/settings?clusterId=`(로그인) · `PUT …/slo/settings`(운영자, 본문 `{baseRev, settings}` — 연결 파일 `slo`와 같은 모양·같은 zod) · `POST …/slo/resets`(운영자, `{service: "<ns>/<app>" | "*", reason 3–200자, at?}`) · `DELETE …/slo/resets?id=`(운영자) → `services/sloSettingsStore.ts`(클러스터마다 JSON 하나 — 파일 이름 = 클러스터 ARM ID 해시, `<AUD_ARRANGEMENT_DIR>/slo`, 없으면 메모리 + 화면 경고) → 웹 `SloSettings.tsx` + 순수 `lib/sloSettingsView.ts`.

| 무엇 | 어떻게 |
|------|--------|
| 목표 | 클러스터 기본(기간 7·14·28·30일 · 가용성 · 지연 기준 ms + 목표 · 세지 않을 URI)과 서비스별 표. **빈 칸 = 따르기** — 칸마다 '따르기 — 99.5% (연결 파일)'처럼 지금 따르는 값과 출처(웹 `inherited` = API `targetsFor`, 테스트로 일치), 지연 기준 칸은 실제로 세는 히스토그램 경계. 지연 기준·목표 중 하나만 바꾸면 다른 하나는 지금 값 |
| 저장 | 설정 리비전 `rev` — 다른 사람이 먼저 저장 = 409 → 최신 설정을 불러오고 다시 고르게 함. 저장 기록(누가·언제·바뀐 항목 이름 — 값은 안 남김) 30개 |
| 에러 버짓 초기화 | 서비스 카드의 '예산 초기화' 또는 설정 화면(모든 서비스 `*` 가능) — **사유 필수**, 지금 또는 지난 30일 안 시각. 그 서비스의 SLO 값·예산을 초기화 시각부터 지금까지로 셈(최대 SLO 기간) → 카드 칩 '예산 초기화 후 n시간'(툴팁 = 시각·누가·사유)·꼬리 '초기화 후 n 동안 요청 m건'. 서비스마다 하나(새 것이 대체), 서비스 초기화가 전체 초기화보다 나중이면 그것, 기간을 벗어나면 저절로 끝남, 취소 가능, 클러스터당 20개 |
| 초기화하지 않는 것 | **소진율 경보**(1시간·6시간·3일 창)는 '지금'을 재므로 그대로 — 장애가 계속되면 초기화 뒤에도 '빠른 소진'. 초기화는 이미 끝난(고치고 회고한) 사고가 남은 기간 내내 '예산 소진'으로 서비스를 묶어 두지 않게 하는 것 |
| 질의 | 초기화 시각 = 창 끝에서 n분 전 → 그 뒤의 3일 조각은 그대로 쓰고, 조각 경계까지 남은 조각 하나만 `increase(…[<m>m] offset <3k>d)`로 더 묻음(그 서비스로 걸러 작음, 전체 초기화는 거르지 않음 — `resetPlans`·`mergeSloParts`). 그 조각이 실패하면 그 서비스만 '조회 실패'. 설정 버전이 SLO 캐시 키에 있어 저장·초기화가 바로 보임 |
| 권한 | 읽기 = 로그인, 바꾸기 = 운영자(`AUD.Operator`) 이상 — 보기 전용 사용자에겐 칸이 잠기고 '보기 전용' 안내. 클러스터의 구독은 authorize 미들웨어가 호출자의 연결 권한으로 먼저 확인 |

연결 파일(GitOps)은 그대로 원본입니다. 플랫폼 설정은 그 위에 칸 단위로 덮어쓰고, 화면은 출처를 '플랫폼 설정 / 연결 파일 / 기본값'으로 구분해 보여 줍니다(가이드 표의 출처 칸도).

## 3d. K8s 이벤트 (AKS 모니터링 › 클러스터 · 워크로드 아래)

`kubectl get events -A --field-selector type=Warning`을 화면으로 옮긴 섹션입니다(2026-11-11 탭으로 시작 → 같은 날 **클러스터 · 워크로드 탭의 히트맵·표 아래**로 옮김 — 워크로드 상태와 Kubernetes가 왜 불평하는지를 한 화면에서). 같은 API `GET /api/observability/events`를 클러스터 전체로 읽습니다(500개씩 최대 4쪽, 더 있으면 '일부만 읽음'으로 표시).

| 무엇 | 어떻게 |
|------|--------|
| 머리 줄 | 'K8s 이벤트 (Warning)' + `n건 · ▲ 진행 중 m · 네임스페이스 k · 대상 o`(진행 중 = 마지막 발생이 읽은 시각 5분 안 — 지금도 되풀이) · 정렬(최근·횟수) · kubectl 줄 복사. 숫자 카드는 없음(히트맵 위 '클러스터 한눈에 보기'와 겹침) |
| 거르기 | 네임스페이스(앱/시스템 묶음) · 찾기(대상·이유·메시지·보고자) · 시스템 네임스페이스 포함 · 진행 중만 · **이유 칩**(이벤트의 REASON 그대로, 다른 조건 안에서 셈) |
| 표 | 마지막 발생(5분 안이면 '▲ 진행 중') · 네임스페이스 · 대상(`Kind/이름` + 보고자) · 이유(누르면 그 이유만) · ×횟수 + '…부터'(처음 발생부터 누적 — 최근 1시간 횟수 아님) · 메시지(운영자만, 민감한 값 가림) |
| 복사 | 보이는 행을 `네임스페이스  Kind/이름  [이유]  x횟수  메시지` 줄로 |
| 길이 | 표는 자기 스크롤 상자(높이 560px, 머리 고정), 처음 100행 + '모두 보기' — 페이지가 이벤트로 끝없이 길어지지 않음 |

- **심각도를 만들지 않습니다.** Kubernetes 이벤트에는 Normal·Warning만 있습니다. 대신 자주 나오는 이유 19개(Unhealthy·BackOff·FailedScheduling·FailedMount·Failed·OOMKilling·Evicted …)는 이유 칩을 고르면 '무슨 뜻 · 먼저 볼 곳'을 한 줄로 보여 줍니다(`lib/kubeEventsView.ts` `KNOWN_REASONS`).
- Kubernetes는 이벤트를 마지막 발생 후 약 1시간만 보관합니다. 시간 범위가 지난 구간이면 꼬리 줄에 '지난 구간을 골라도 지금 이벤트'를 적습니다(알림은 화면당 하나 — 히트맵이 씀). 오래된 기록이 필요하면 이벤트를 Loki 등으로 보내는 고객 파이프라인이 있어야 합니다(이 화면은 가정하지 않음).
- 새로 고침·자동 새로 고침은 페이지 위 시간 막대를 따릅니다.

## 3e. 로그 지표 (AKS 모니터링 › 로그, 뷰어 위)

로그를 한 줄씩 읽기 전에 네임스페이스의 로그를 **숫자로** 먼저 봅니다(2026-11-11). 고객 Grafana의 'Error & Exception Explorer' 대시보드와 같은 질문을 같은 방식(LogQL `count_over_time`)으로 Loki에 묻습니다 — 로그 줄은 Loki 밖으로 나오지 않고 개수만 옵니다.

| 칸 | 무엇 |
|---|---|
| ERROR 이벤트 · WARN 이벤트 | 창 안의 ERROR·FATAL / WARN 로그 줄 수 |
| ERROR 발생 워크로드 | ERROR가 한 줄이라도 있는 워크로드 수 |
| 예외 클래스 종수 | 오류 줄 본문에 적힌 서로 다른 `…Exception`·`…Error` 이름 수 |
| ERROR 발생 시각 | 창을 30칸으로 나눈 막대(가장 많은 때 표시) + 워크로드별 ERROR·WARN 줄 |
| 워크로드 × 예외 클래스 Top 15 | 어느 워크로드에서 어떤 예외가 몇 번 |

- 워크로드는 **파드 이름에서** 구합니다(Deployment `이름-해시-5자` · StatefulSet `이름-번호` · DaemonSet `이름-5자`). Loki 라벨 `service_name` 같은 사이트별 라벨에 기대지 않고, 히트맵의 워크로드 이름과 같습니다.
- 워크로드 이름을 누르면 그 워크로드만 다시 세고, 아래 로그 뷰어가 그 워크로드의 파드를 엽니다.
- 권한은 로그와 같습니다: 운영자 이상 + 이 연결이 로그를 읽는 네임스페이스(`aks.podLogNamespaces`).
- 창은 최대 6시간입니다(더 긴 범위를 고르면 마지막 6시간). 하루치 로그에 정규식을 돌리는 질의는 작은 Loki를 과부하시킵니다.
- Loki가 답하지 않은 값은 '—'로 두고 '응답 없는 값 n'으로 알립니다(0으로 쓰지 않음). Loki가 바쁘면 로그와 같은 대기(1분)를 따릅니다.

## 4. 연결 파일

```json
"aks": { "observability": {
  "grafana": { "endpoint": "https://<grafana>.<region>.grafana.azure.com", "datasources": { "prometheus": "<uid>", "loki": "<uid>", "tempo": "<uid>" } },
  "loki": { "url": "http://<loki-svc>.<namespace>:3100" },
  "hubbleUi": { "url": "http://hubble-ui.kube-system:80" },
  "logErrors": { "metric": "<collector log-error counter>", "podLabel": "exported_pod" },
  "slo": { "windowDays": 30, "availability": 0.999, "latency": { "thresholdMs": 1000, "target": 0.99 },
    "services": { "<namespace>/<application>": { "excludeUris": ["/public/*/webhooks/**"] } } } } }
```

`loki.url`·`hubbleUi.url`은 클러스터 안 주소(`<svc>.<ns>[.svc]`)나 사설 IP만, `grafana.endpoint`는 `https://*.grafana.azure.com`만 받습니다. `slo` 목표는 0.5–0.99999, `windowDays`는 7·14·28·30, 서비스 키는 `<namespace>/<application>`(Micrometer `application` 태그), `exclude: true`면 그 서비스를 뺍니다.

## 5. 다음

예외 분석 화면(서비스 × 예외 클래스 추이, 본문 검색) · VPA 권장과 JVM 헤드룸을 워크로드 상세에 · spanmetrics RED(고객 파이프라인의 카운터 리셋을 고친 뒤 `resets()` = 0 확인 — 요청 SLI는 Micrometer로 §3c) · 다른 클러스터의 Loki(Grafana 경유, opt-in).
