---
status: current
owner: platform-observability
last-verified: 2026-10-30
covers: [apps/api/src/services/nodeMaintenance.ts, apps/web/src/lib/nodeMaintView.ts, apps/web/src/lib/k8sNetMap.ts, apps/api/src/services/observabilitySources.ts, apps/api/src/services/hubbleUiSource.ts, apps/api/src/routes/observability.ts, apps/web/src/lib/workloadHeatView.ts, apps/web/src/lib/logView.ts, apps/api/src/services/workloadHeatmap.ts, apps/api/src/services/kubeEvents.ts, apps/api/src/services/lokiLogs.ts, apps/api/src/services/observabilityStack.ts, apps/api/src/services/logRedaction.ts]
---
# AKS 모니터링 연동 — 워크로드 히트맵 · kube 이벤트 · 로그 스트림 · Hubble 드롭 · AKS 관리형 파드

고객 클러스터가 이미 모으는 신호(Azure Monitor 작업 영역의 메트릭, 클러스터 안 Loki, Kubernetes API)를 대시보드가 **읽기만** 해서 SRE 화면으로 엮습니다. 값은 모두 측정값이고, 시계열·행이 없으면 '미측정'으로 둡니다(0 금지). 2026-10-23에 실제 고객 stg 클러스터(AKS + ACNS Cilium 1.19, Alloy → AMW, Loki 3.7, Tempo 3.1)로 확인했습니다.

## 1. 데이터 경로

| 화면 | 출처 | 신원·권한 | 없을 때 |
|---|---|---|---|
| 워크로드 히트맵 | AMW: cAdvisor·kube-state-metrics·Micrometer(`jvm_*`·`hikaricp_*`·`http_server_requests_*`)·로그 ERROR 카운터 | 클러스터 연결 신원 — 작업 영역 Monitoring Data Reader | 상태(작업 영역 없음·권한 없음·실패) |
| Warning 이벤트 | Kubernetes API core/v1 `events` (list, `type=Warning`) | `aud-dashboard-reader`에 `events` 추가(이 문서와 함께 생성 — [템플릿](../integrations/azure/templates/aks/aud-dashboard-reader.yaml)) | 403 `aks_rbac_forbidden` |
| 로그 스트림 | 클러스터 안 Loki `query_range` (연결 파일 `aks.observability.loki`) | Pod 로그와 같은 문: 운영자 + `aks.podLogNamespaces` | `notConfigured` / `unreachable`(정책) / `failed` |
| 로그 탭 (Pod 하나) | ① Loki `{namespace, pod[, container]}` → ② kubelet → ③ Container Insights — 응답 `attempts`에 출처마다 결과 | ①② 운영자 + `aks.podLogNamespaces`, ② `pods/log` Role(네임스페이스별), ③ Log Analytics Reader | 칩: 읽음·이 기간 줄 없음·설정 안 됨·허용 안 됨·권한 없음·연결 안 됨·실패 |
| Hubble 드롭 | Loki `{job="hubble-flows"}` (hubble-flow-exporter — **DROPPED만** 보냄, 연결선 없음) | 보기 권한 | 위와 같음 |
| Hubble 흐름·서비스 맵 (exec 꺼짐) | 클러스터의 Hubble UI 백엔드 `service-map-stream`(연결 파일 `aks.observability.hubbleUi`) — Relay '최근 10,000건' 표본, 응답(reply)은 Relay에서 제외 | 보기 권한, 네트워크만(파드 exec·Secret 없음) | `notConfigured`·`unreachable`·`unsupported`(0.13 미만)·`failed` |
| 관측 스택 | AMW (Alloy·Loki·Tempo·Pyroscope·수집 대상·Cilium) | 작업 영역 Monitoring Data Reader | 상태 |

**왜 Loki를 직접 읽나**: Managed Grafana `/api/ds/query`는 Viewer 역할이 인스턴스의 모든 데이터 원본(stg·prd 공용 인스턴스)에 미쳐 범위가 더 넓고, 네임스페이스 경계는 어차피 대시보드가 지켜야 합니다. 클러스터 안 Loki는 대시보드가 이미 kubelet으로 읽을 수 있는 Pod 로그와 같은 범위에 과거 기록만 더합니다. 질의(LogQL)는 서버가 검증된 이름으로만 만들고 브라우저 문자열은 받지 않습니다. 줄은 4 KB·500줄·응답 2 MB로 자르고, 토큰·키·비밀번호·SAS·PEM을 가립니다(`logRedaction.ts` — kubelet Pod 로그에도 적용).

**Loki가 막혀 있을 때**: 고객의 `monitor` 네임스페이스 정책이 같은 네임스페이스와 Grafana 관리형 사설 엔드포인트만 Loki 3100에 들입니다(확인함). 그러면 화면은 `unreachable`과 함께 아래 규칙을 보여 줍니다 — 적용은 클러스터 관리자가 GitOps로 합니다(대시보드는 쓰지 않음).

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

**화면 구성**(2026-10-27 개편 — Datadog Kubernetes 개요 방식): 탭 5개 = 클러스터 · 워크로드(기본) · 노드 · 로그 · 네트워크(Hubble) · 수집 상태. 첫 탭 맨 위 **클러스터 한눈에 보기** 띠(`clusterGlance` — 히트맵이 잰 값만): 워크로드(위험·주의·정상 쌓은 막대, 누르면 문제만) · Ready 파드 n/m · 레플리카 부족 · 재시작(기간) · OOMKilled 파드 — 칸을 누르면 아래 히트맵이 그 신호로 칠해집니다. 아무도 재지 않은 값은 '—'·'미측정'(0 아님). 예전 '개요' 탭(Container Insights 요약)은 DCR에 Container Insights가 없으면 0만 보여 없앴고, 목록 보기는 첫 탭의 [히트맵 | 목록]으로 남았습니다.

고객 Grafana '컨테이너 맵'을 한 장으로, **문제 먼저**: 요약 한 줄(판정 알약 '● 주의 필요 없음'/'■ 위험 n · 주의 m' + 울린 신호만 칩 — 누르면 그 신호로 칠함, 나머지는 '정상 신호 n개'·'미측정 신호 n개' 글자(목록은 툴팁) + 범례) → **주의 필요** 목록(있을 때만 — 위험 먼저, `ns / 워크로드`와 이유 '메모리 96% · 재시작 3') → 네임스페이스 카드 **모자이크**(가장 나쁜 카드 먼저; 바깥 격자 = 타일 칸 132px·4px 행, 카드는 자기 타일 수만큼 √(2.2n)열 안팎(빈칸 가장 적은 열)·높이만큼 행을 차지, 배치는 순수 `packMosaic` — 문제 순서대로 가장 위·왼쪽 빈자리, 더 위에 들어가면 폭을 ½까지 바꾸고, 놓은 뒤 오른쪽 빈 열로 넓히고 맨 아래 선까지 늘려 바깥 모양을 직사각형으로(2026-10-30 — `grid-auto-flow: dense`는 카드 크기를 못 바꿔 9칸 화면의 18%가 페이지 배경으로 비었음 → 98%), 카드 사이 틈은 불투명 패널 바탕 `.hmSurface` — 타일 1개 네임스페이스는 타일 1칸 폭, 열 수는 너비에 따라 `mosaicColumns`·`cardShape`). 타일 = **라이브 다이어그램 카드 문법**(흰 바탕 + 왼쪽 상태 띠 + 기호: ● 정상 초록 · ▲ 주의 · ■ 위험 · ○ 실행 대상 없음 · ◎ 측정됨·판정 기준 없음 · ? 미측정 점선 · – 계측 없음 빗금), 주의·위험 값은 색 알약, 이름은 네임스페이스 접두와 카드 공통 접두(`sharedPrefix`, 머리글에 '· 접두…')를 뺌, 종류는 툴팁. 기호가 항상 상태를 함께 보임. 모든 워크로드를 그림(Grafana 통계 패널은 48개 중 26개만 그렸음), '문제만' 토글은 기본 꺼짐. 신호 선택은 묶은 선택 상자 하나(쿠버네티스·Java/Spring·로그). 타일을 누르면 오른쪽 상세(값·파드·Warning 이벤트·로그 스트림 — ERROR 먼저, 예외 클래스 상위 10, trace ID → Tempo 링크), 방향키로 타일 이동·Esc로 닫기. 보기 모델은 `apps/web/src/lib/workloadHeatView.ts`(순수, `workloadHeatView.test.ts`).

| 신호 | 계산(파드별 → 워크로드의 가장 나쁜 파드) | 주의 / 위험 |
|---|---|---|
| 가용 | KSM ready/desired (Deployment·StatefulSet·DaemonSet). 목표 0 = 실행 대상 없음 — DaemonSet은 '대상 노드 없음'(`noNodes`), 그 밖은 '0개로 줄임'(`scaledToZero`), 나머지 신호는 '파드 없음'(`noPods`) | <1 / 0 |
| 메모리 | 컨테이너 WS / memory limit (+ 바이트 `abs`) + 마지막 종료 OOMKilled. limit 없음 = **측정됨·기준 없음**(`noBaseline` — 사용량 Mi만, 색 없음) | 80% / 90% |
| CPU | 사용 / request (+ 코어 `abs`). request 없음 = 측정됨·기준 없음(m = 1/1000 코어) | 100% / 150% |
| 재시작 | `changes(restarts[기간])` 합 | 1 / 5 |
| Old Gen | `jvm_memory_usage_after_gc` | 70% / 85% |
| JVM 여유 | 파드의 컨테이너 메모리 limit − JVM 최대 heap(`jvm_memory_max_bytes{area="heap"} > 0` 합 — G1 eden/survivor는 −1이라 뺌) = metaspace·code cache·스레드·네이티브 메모리 자리, 패널에 limit·heap·지금 non-heap 사용(`jvm_memory_used_bytes{area="nonheap"}`) 풀이. 낮을수록 나쁨, limit 없음 = 기준 없음 | 250Mi 미만 / 지금 non-heap 사용보다 작음(heap이 차면 limit 초과 → OOMKilled) |
| HTTP 5xx | 워크로드 전체 5xx / 전체 요청(`/actuator` 제외), 요청 0 = 트래픽 없음 | 0.5% / 1% |
| 로그 ERROR | 수집기가 만든 ERROR 카운터(연결 파일 `aks.observability.logErrors`)의 기간 증가 — 기간 중 생긴 시계열도 전부 셈 | 1 / 50 |
| 커넥션 풀 | Hikari active/max (가장 나쁜 풀), pending | 70% / 90%, pending ≥1 |

Java/Spring 지표가 없는 워크로드는 '계측 없음', 작업 영역에 그 지표 묶음이 아예 없으면 '미측정'. 완료된 파드(Job, `az aks command invoke`)는 타일·파드 행을 만들지 않음 — 이미 있는 워크로드의 로그 ERROR 수에만 더함(예전엔 재시작·cAdvisor 행이 `command-…` 타일을 '? 미측정'으로 만들었음).

**실측(2026-10-26, stg)**: Windows 노드가 없는 클러스터의 Windows 전용 DaemonSet 10개와 `retina-agent`(노드 조건 `kubernetes.azure.com/ebpf-dataplane NotIn cilium` — Cilium 노드를 피함)는 목표 0 — 예전엔 '0/0 0/0'·'? 미측정'으로 보였음, 이제 기본 숨김('대상 노드가 없는 DaemonSet n개 숨김 · 보이기'). AKS 관리 `cilium`·`acns-security-agent`는 컨테이너에 requests·limits가 아예 없음(`kubectl get ds -o jsonpath` 확인) — 비율이 없으니 사용량(예: 366Mi·49m)만.

**RED(트레이스 spanmetrics) — 보류**: 서버 span 서비스 17개가 워크로드 이름과 정확히 일치하지만, `traces_spanmetrics_calls_total`이 10분에 4번 리셋되어(값은 1분에 약 12 증가) `rate()`가 리셋마다 누적값을 더함 → 합계 7,906/s, Micrometer `http_server_requests_seconds_count` 합계는 10/s(약 800배, 대부분 `/actuator/health` span). 같은 시계열에 쓰는 곳이 둘(alloy-traces 복제본·재시작)이거나 spanmetrics 설정 문제로 보임 — 고객 파이프라인에서 `resets(traces_spanmetrics_calls_total[10m])` = 0이 된 뒤 구현(틀린 숫자는 그리지 않음). 확인 질의: `max(resets(traces_spanmetrics_calls_total{span_kind="span_kind_server"}[10m]))`.

**VPA 권장**(패널, `WorkloadVpaSection` + `services/workloadVpa.ts`): 작업 영역에는 VPA 시계열이 없어(AKS kube-state-metrics가 내보내지 않음) Kubernetes API로 VPA 객체와 워크로드 템플릿을 같은 시점에 읽음(기존 list 권한, 60초 캐시). 컨테이너마다 메모리·CPU의 request·limit·VPA 권장·VPA 범위, 표시는 VPA 자체 의미만 — 권장 > limit·request < 하한(주의), request > 상한(참고: VPA는 CPU를 25m 아래로 권장하지 않아 흔함). 모드 Off = 권장만. 실측(stg): VPA 26개 모두 Off, 컨테이너 28개 중 권장 > limit 1·메모리 request < 하한 7.

**로그 스트림**(패널, `WorkloadLogStream` + 순수 `apps/web/src/lib/logView.ts`): 같은 메시지(수·ID만 다른 것 포함 — `logSignature`)는 한 줄 '×n'(처음~마지막 시각·파드 수), 줄 = 로거가 되풀이한 앞 시각을 뺀 메시지(logback `… LEVEL … - 메시지`는 메시지만), 2줄 말줄임, 누르면 첫 줄 전체·앱 코드 스택(`▸ 클래스.메서드 (파일:줄)`, 패키지는 툴팁, 라이브러리 프레임은 'n개 더 보기')·Caused by·원문 복사·trace. 예외 클래스 칩 = 거르기. 스크롤은 패널 하나(목록 자체 스크롤 없음). 가리기는 MDC `[TOKEN-ID:…]`·세션 ID도(`logRedaction.ts`). 메트릭 묶음 존재는 묶음마다 따로 셉니다(`a or b`는 이름을 무시하고 라벨이 같은 시계열을 지움 — Hubble 메트릭 쪽에도 있던 버그).

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

`GET /api/observability/node-maintenance?clusterId=&days=1|7|14|30` → `services/nodeMaintenance.ts`

| 출처 | 읽는 것 | 왜 |
|---|---|---|
| Activity Log (클러스터 RG·노드 RG) | `agentPools/upgradeNodeImageVersion`, `managedClusters`·`agentPools` write, 노드 확장 집합 reimage·manualupgrade·delete, Resource Health | **실제 작업 시각**과 시작 주체(호출자 `Microsoft.ContainerService` = AKS 자동). `resourcechanges`는 감지 시각이라 쓰지 않음(10-23 17:00Z 업그레이드가 10-24 20:57Z로 기록) |
| 클러스터 ARM | `autoUpgradeProfile`(클러스터·노드 OS 채널), 노드 풀(이미지·최대 추가 노드·드레인), `maintenanceConfigurations` | 작업이 **유지 보수 창 안**이었는지, 다음 창은 언제인지 |
| kube-state-metrics | `kube_node_spec_unschedulable`(cordon)·Ready·`kube_node_created`(재등록 — reimage는 이름 유지)·`kube_node_info`(커널·kubelet)·`kube_pod_start_time` | 노드가 실제로 겪은 일과 다시 시작된 파드 수 |

- 사건 = 변경 작업과 노드 변화를 30분 간격으로 묶은 것. 읽기·자격 증명 조회·runCommand·역할/정책 할당은 넣지 않음(stg Activity Log의 대부분이 이 대시보드의 자격 증명 조회). kubelet 버전이 바뀌면 'Kubernetes 업그레이드'. 클러스터 작업이 없으면 시작 주체 '기록 없음'(추측 없음).
- 사건 밖의 노드 NotReady는 '유지 보수 밖'으로 따로.
- stg 실측: 10-09 17:00Z Kubernetes 1.36.2→1.36.4(클러스터 자동 창, 둘째 토요일), 10-23 17:00–17:49Z 노드 이미지 202609.15→202610.08(노드 OS 창, 넷째 토요일 02:00 KST) — 임시 노드 4, 재등록 5, 커널 6.8.0-1067→1070, 다음 창 11-28 02:00 KST.
- 30일은 Activity Log가 길어(3,282건/17쪽) 기간을 조각내 동시에 읽고, 쪽 제한에 걸리면 '일부만 읽음'.

## 4. 연결 파일

```json
"aks": { "observability": {
  "grafana": { "endpoint": "https://<grafana>.<region>.grafana.azure.com", "datasources": { "prometheus": "<uid>", "loki": "<uid>", "tempo": "<uid>" } },
  "loki": { "url": "http://<loki-svc>.<namespace>:3100" },
  "hubbleUi": { "url": "http://hubble-ui.kube-system:80" },
  "logErrors": { "metric": "<collector log-error counter>", "podLabel": "exported_pod" } } }
```

`loki.url`·`hubbleUi.url`은 클러스터 안 주소(`<svc>.<ns>[.svc]`)나 사설 IP만, `grafana.endpoint`는 `https://*.grafana.azure.com`만 받습니다.

## 5. 다음

예외 분석 화면(서비스 × 예외 클래스 추이, 본문 검색) · VPA 권장과 JVM 헤드룸을 워크로드 상세에 · RED(spanmetrics) · 다른 클러스터의 Loki(Grafana 경유, opt-in).
