---
status: current
owner: platform-observability
last-verified: 2026-10-26
covers: [apps/api/src/services/observabilitySources.ts, apps/web/src/lib/workloadHeatView.ts, apps/web/src/lib/logView.ts, apps/api/src/services/workloadHeatmap.ts, apps/api/src/services/kubeEvents.ts, apps/api/src/services/lokiLogs.ts, apps/api/src/services/observabilityStack.ts, apps/api/src/services/logRedaction.ts]
---
# AKS 모니터링 연동 — 워크로드 히트맵 · kube 이벤트 · 로그 스트림 · Hubble 드롭 · AKS 관리형 파드

고객 클러스터가 이미 모으는 신호(Azure Monitor 작업 영역의 메트릭, 클러스터 안 Loki, Kubernetes API)를 대시보드가 **읽기만** 해서 SRE 화면으로 엮습니다. 값은 모두 측정값이고, 시계열·행이 없으면 '미측정'으로 둡니다(0 금지). 2026-10-23에 실제 고객 stg 클러스터(AKS + ACNS Cilium 1.19, Alloy → AMW, Loki 3.7, Tempo 3.1)로 확인했습니다.

## 1. 데이터 경로

| 화면 | 출처 | 신원·권한 | 없을 때 |
|---|---|---|---|
| 워크로드 히트맵 | AMW: cAdvisor·kube-state-metrics·Micrometer(`jvm_*`·`hikaricp_*`·`http_server_requests_*`)·로그 ERROR 카운터 | 클러스터 연결 신원 — 작업 영역 Monitoring Data Reader | 상태(작업 영역 없음·권한 없음·실패) |
| Warning 이벤트 | Kubernetes API core/v1 `events` (list, `type=Warning`) | `aud-dashboard-reader`에 `events` 추가(이 문서와 함께 생성 — [템플릿](../integrations/azure/templates/aks/aud-dashboard-reader.yaml)) | 403 `aks_rbac_forbidden` |
| 로그 스트림 | 클러스터 안 Loki `query_range` (연결 파일 `aks.observability.loki`) | Pod 로그와 같은 문: 운영자 + `aks.podLogNamespaces` | `notConfigured` / `unreachable`(정책) / `failed` |
| Hubble 드롭 | Loki `{job="hubble-flows"}` (hubble-flow-exporter) | 보기 권한 | 위와 같음 |
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

## 2. 워크로드 히트맵 (AKS 모니터링 › 워크로드 › 히트맵)

고객 Grafana '컨테이너 맵'을 한 장으로, **문제 먼저**: 요약 한 줄(판정 알약 '● 주의 필요 없음'/'■ 위험 n · 주의 m' + 울린 신호만 칩 — 누르면 그 신호로 칠함, 나머지는 '정상 신호 n개'·'미측정 신호 n개' 글자(목록은 툴팁) + 범례) → **주의 필요** 목록(있을 때만 — 위험 먼저, `ns / 워크로드`와 이유 '메모리 96% · 재시작 3') → 네임스페이스 카드 **모자이크**(가장 나쁜 카드 먼저; 바깥 격자 = 타일 칸 132px·4px 행, 카드는 자기 타일 수만큼 √(2.2n)열 안팎(빈칸 가장 적은 열)·높이만큼 행을 차지, `grid-auto-flow: dense`로 작은 카드가 큰 카드 옆 빈자리를 채움 — 타일 1개 네임스페이스는 타일 1칸 폭, 열 수는 너비에 따라 `mosaicColumns`·`cardShape`). 타일 = **라이브 다이어그램 카드 문법**(흰 바탕 + 왼쪽 상태 띠 + 기호: ● 정상 초록 · ▲ 주의 · ■ 위험 · ○ 실행 대상 없음 · ◎ 측정됨·판정 기준 없음 · ? 미측정 점선 · – 계측 없음 빗금), 주의·위험 값은 색 알약, 이름은 네임스페이스 접두와 카드 공통 접두(`sharedPrefix`, 머리글에 '· 접두…')를 뺌, 종류는 툴팁. 기호가 항상 상태를 함께 보임. 모든 워크로드를 그림(Grafana 통계 패널은 48개 중 26개만 그렸음), '문제만' 토글은 기본 꺼짐. 신호 선택은 묶은 선택 상자 하나(쿠버네티스·Java/Spring·로그). 타일을 누르면 오른쪽 상세(값·파드·Warning 이벤트·로그 스트림 — ERROR 먼저, 예외 클래스 상위 10, trace ID → Tempo 링크), 방향키로 타일 이동·Esc로 닫기. 보기 모델은 `apps/web/src/lib/workloadHeatView.ts`(순수, `workloadHeatView.test.ts`).

| 신호 | 계산(파드별 → 워크로드의 가장 나쁜 파드) | 주의 / 위험 |
|---|---|---|
| 가용 | KSM ready/desired (Deployment·StatefulSet·DaemonSet). 목표 0 = 실행 대상 없음 — DaemonSet은 '대상 노드 없음'(`noNodes`), 그 밖은 '0개로 줄임'(`scaledToZero`), 나머지 신호는 '파드 없음'(`noPods`) | <1 / 0 |
| 메모리 | 컨테이너 WS / memory limit (+ 바이트 `abs`) + 마지막 종료 OOMKilled. limit 없음 = **측정됨·기준 없음**(`noBaseline` — 사용량 Mi만, 색 없음) | 80% / 90% |
| CPU | 사용 / request (+ 코어 `abs`). request 없음 = 측정됨·기준 없음(m = 1/1000 코어) | 100% / 150% |
| 재시작 | `changes(restarts[기간])` 합 | 1 / 5 |
| Old Gen | `jvm_memory_usage_after_gc` | 70% / 85% |
| HTTP 5xx | 워크로드 전체 5xx / 전체 요청(`/actuator` 제외), 요청 0 = 트래픽 없음 | 0.5% / 1% |
| 로그 ERROR | 수집기가 만든 ERROR 카운터(연결 파일 `aks.observability.logErrors`)의 기간 증가 — 기간 중 생긴 시계열도 전부 셈 | 1 / 50 |
| 커넥션 풀 | Hikari active/max (가장 나쁜 풀), pending | 70% / 90%, pending ≥1 |

Java/Spring 지표가 없는 워크로드는 '계측 없음', 작업 영역에 그 지표 묶음이 아예 없으면 '미측정'. 완료된 파드(Job, `az aks command invoke`)는 타일·파드 행을 만들지 않음 — 이미 있는 워크로드의 로그 ERROR 수에만 더함(예전엔 재시작·cAdvisor 행이 `command-…` 타일을 '? 미측정'으로 만들었음).

**실측(2026-10-26, stg)**: Windows 노드가 없는 클러스터의 Windows 전용 DaemonSet 10개와 `retina-agent`(노드 조건 `kubernetes.azure.com/ebpf-dataplane NotIn cilium` — Cilium 노드를 피함)는 목표 0 — 예전엔 '0/0 0/0'·'? 미측정'으로 보였음, 이제 기본 숨김('대상 노드가 없는 DaemonSet n개 숨김 · 보이기'). AKS 관리 `cilium`·`acns-security-agent`는 컨테이너에 requests·limits가 아예 없음(`kubectl get ds -o jsonpath` 확인) — 비율이 없으니 사용량(예: 366Mi·49m)만.

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

## 4. 연결 파일

```json
"aks": { "observability": {
  "grafana": { "endpoint": "https://<grafana>.<region>.grafana.azure.com", "datasources": { "prometheus": "<uid>", "loki": "<uid>", "tempo": "<uid>" } },
  "loki": { "url": "http://<loki-svc>.<namespace>:3100" },
  "logErrors": { "metric": "<collector log-error counter>", "podLabel": "exported_pod" } } }
```

`loki.url`은 클러스터 안 주소(`<svc>.<ns>[.svc]`)나 사설 IP만, `grafana.endpoint`는 `https://*.grafana.azure.com`만 받습니다.

## 5. 다음

예외 분석 화면(서비스 × 예외 클래스 추이, 본문 검색) · VPA 권장과 JVM 헤드룸을 워크로드 상세에 · RED(spanmetrics) · 다른 클러스터의 Loki(Grafana 경유, opt-in).
