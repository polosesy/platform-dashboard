---
status: current
owner: platform-observability
last-verified: 2026-11-13
covers: [apps/api/src/services/hubbleClient.ts, apps/api/src/services/hubbleMerge.ts, apps/api/src/services/hubbleUiSource.ts, apps/api/src/services/hubbleDrops.ts]
---
# Hubble 트러블슈팅 가이드

> Cilium Hubble 연동 과정에서 발생한 에러 케이스와 해결 방법을 정리한 문서입니다.
> 환경: AKS (Azure CNI Overlay + Cilium), Cilium 1.17.x

---

## 목차

1. [환경 정보](#1-환경-정보)
2. [에러 케이스](#2-에러-케이스)
3. [진단 명령어](#3-진단-명령어)
4. [AKS + Cilium 특이사항](#4-aks--cilium-특이사항)

---

## 1. 환경 정보

| 항목 | 값 |
|------|-----|
| AKS Kubernetes | 1.32.x |
| Cilium | 1.17.9 (AKS managed) |
| Hubble | 활성화 (enable-hubble: "true") |
| Hubble TLS | 활성화 (hubble-disable-tls: "false") |
| Hubble Relay | kube-system, port 443→4245 (gRPC) |
| Hubble Socket | /var/run/cilium/hubble.sock (각 노드 로컬) |

---

## 2. 에러 케이스

### ERR-001: `exec failed: command terminated with exit code 1`

- **증상**: Service Map API 500 에러
  ```json
  {"error":"service_map_failed","message":"exec failed: command terminated with non-zero exit code: command terminated with exit code 1"}
  ```
- **원인**: cilium-agent pod에서 `hubble observe --server hubble-relay:443` 실행 시 TLS 인증 실패. Hubble gRPC는 mTLS가 활성화되어 있어 CLI에서 직접 relay로 연결 시 인증서가 필요함.
- **해결**: 로컬 소켓(`/var/run/cilium/hubble.sock`)을 통한 `hubble observe` 사용. 로컬 소켓은 TLS 불필요.

### ERR-002: `unknown command "hubble" for "cilium-dbg"`

- **증상**: `cilium hubble observe` 실행 시 에러
  ```
  Error: unknown command "hubble" for "cilium-dbg"
  Run 'cilium-dbg --help' for usage.
  ```
- **원인**: Cilium 1.17에서 CLI 바이너리가 `cilium` → `cilium-dbg`로 리네이밍. `hubble`은 별도 바이너리(`/usr/bin/hubble`)로 분리됨. `cilium hubble observe` 서브커맨드는 더 이상 존재하지 않음.
- **해결**: `cilium hubble observe` 대신 `hubble observe` 직접 호출.

### ERR-003: `unknown flag: --tls-allow-server-name`

- **증상**: `hubble observe --server relay --tls --tls-allow-server-name` 실행 시 에러
- **원인**: AKS에 포함된 hubble CLI 버전에 `--tls-allow-server-name` 플래그가 없음.
- **해결**: TLS 플래그 없이 로컬 소켓 경유로 전환. relay 경유가 필요한 경우 인증서 마운트 경로 확인 후 `--tls-client-cert-file`, `--tls-client-key-file`, `--tls-ca-cert-files` 사용.

### ERR-004: `Hubble 연결됨` 이지만 flows 0건

- **증상**: UI에서 "Hubble Relay: 연결됨, 노드: 0, 플로우: 0 / 0" 표시. API 로그에서 `Strategy 2b success: parsed 0 flows`.
- **원인 (복합)**:
  1. `cilium hubble observe` 명령 자체가 실패하지만 에러 메시지가 stdout으로 출력됨
  2. 파싱 함수가 에러 메시지 텍스트를 JSON으로 파싱 시도 → 0건 반환
  3. status API는 relay pod 발견만으로 "연결됨" 표시 (실제 flow 수 미확인)
- **해결**: `hubble observe` (로컬 소켓) 전략 우선 사용 + status에서 `cilium-dbg status --brief` 파싱으로 실제 flow 수 확인.

### ERR-005: relay pod에서 `hubble` CLI 없음

- **증상**: relay pod exec 시 `exitCode=1, stderr=` (빈 stderr)
- **원인**: `hubble-relay` 컨테이너는 relay daemon만 실행. `hubble` CLI 바이너리가 포함되어 있지 않음.
- **해결**: relay pod 대신 cilium pod (`k8s-app=cilium` label)에서 exec. cilium pod에 `/usr/bin/hubble` 바이너리 존재.

### ERR-006: Source/Destination에 "unknown" 표시

- **증상**: Flows 탭에서 source 또는 destination이 "unknown"으로 표시됨
- **원인**: Cilium reserved identity 엔드포인트(`reserved:host`, `reserved:world`, `reserved:remote-node` 등)는 namespace/podName이 없음. `parseEndpoint`에서 모든 식별 필드가 비어있으면 "unknown"으로 fallback됨.
- **해당 identity 목록**:

  | Identity | 이름 | 의미 |
  |----------|------|------|
  | 0 | unknown | `reserved:unknown` — Cilium이 주소를 엔드포인트로 못 바꿈(예: IPv6 멀티캐스트 `ff02::2`). 화면 '식별자 없음' (2026-11-13 전에는 init으로 잘못 표시) |
  | 1 | host | 노드 자체 (kubelet, kube-proxy 등) |
  | 2 | world | 클러스터 외부 트래픽 |
  | 3 | unmanaged | Cilium 미관리 엔드포인트 |
  | 4 | health | Cilium 헬스체크 |
  | 5 | init | 아직 identity를 받는 중인 엔드포인트 |
  | 6 | remote-node | 다른 노드 (Cilium numericidentity.go) |
  | 7 | kube-apiserver | API 서버 |

- **해결**: `parseEndpoint`에서 `reserved:*` 라벨과 identity 숫자를 의미 있는 이름으로 매핑. Cilium 1.17+ `workloads` 배열 활용 (`{"workloads":[{"name":"konnectivity-agent","kind":"Deployment"}]}`).

### ERR-007: `HTTP 502 hubble_ui_unsupported — Hubble UI answered something other than the JSON envelope`

- **증상**: Pod 트래픽(Hubble) › 보안(정책 판정)에 `보안 오류: HTTP 502 … hubble_ui_unsupported`. 다시 열면 대개 정상.
- **원인 (2026-11-13 stg 실측)**: 오류 시각(06:37:39Z)에 kube-system `hubble-ui`의 **backend 컨테이너가 OOMKilled**(한도 256Mi, exit 137). 응답 도중 죽어 본문이 끊겼고, 대시보드는 '본문이 JSON이 아님'을 프로토콜 불일치(`unsupported`)로 잘못 분류했다.
  - Hubble UI 채널 하나마다 백엔드가 relay에서 **최근 10,000건을 다시 받아 서비스 맵을 만든다**(`GET_FLOWS_LAST` 기본, 50 ms·500건씩 내보냄). 실측: 채널 둘(전체 + 정책 판정)을 읽자 backend 132Mi → 209Mi, 1분 뒤 145Mi.
  - 대시보드가 채널을 동시에 여럿 열었다: 보안 탭 혼자 둘(전체·정책 판정), 출처 확인(`/api/hubble/sources`)의 별도 '작은' 표본(백엔드에는 똑같이 10,000건), 흐름 탭의 limit·verdict마다 다른 채널.
  - backend 작업 메모리는 대시보드를 쓴 날마다 계단식으로 올랐다(4일: 12 → 38 → 51 → 85 → 130 → 150Mi → 06:37 OOM).
  - **누수**(인프라 세션의 업스트림 소스 확인, v0.13.6 = master): backend `service_map_stream.go`가 채널마다 `data_throttler.New(50ms, 500)`를 만들고 `Stop()`을 부르지 않아, 채널이 끝나도 Ticker 고루틴과 흐름 버퍼가 남는다(채널당 약 3.5MiB 추정). 그래서 **채널을 여닫는 횟수**가 바닥선을 올리고, 채널마다 1만 건 재생이 순간 상승을 만든다 — 한도만 올리면 결국 재발한다.
  - nginx 접속 기록 4일치의 호출자는 전부 대시보드(UA `node`)였고, 06시대에만 728회였다.
- **해결 (`hubbleUiSource.ts`)**:
  - 클러스터마다 **한 번에 채널 하나**(`gated`)만 연다.
  - 표본은 **사용자와 무관한 클러스터 공용**이다(캐시 키에 사용자 접두사 없음 — 클러스터 접근은 `authorize`가 먼저 확인하고 `assertSignedInForCluster`도 유지).
  - 표본을 **2분 재사용**한다(`HUBBLE_UI_TTL_MS`). 화면의 '실시간 30초'·'새 표본'도 그 안에서는 같은 표본이고, '마지막 표본'은 표본의 가장 새 흐름 시각을 보인다.
  - 스트림을 공유한다(`streamOf`). 서비스 맵·요약·흐름 표(어떤 limit이든)·verdict·이벤트 유형 거르기는 '요청 + 드롭' 스트림 하나를 쓰고, **policy-verdict만 따로** 연다 — 공유 스트림에는 같은 구간 정책 판정이 약 ⅔뿐이다(654 vs 1,008, 실측).
  - 출처 확인은 그 공유 스트림을 읽어 캐시를 채운다.
  - 결과: 클러스터당 2분에 채널 최대 2개.
  - 200인데 본문이 비었거나 JSON이 반쯤 끊겼으면 `failed`('응답이 중간에 끊김 — 백엔드 재시작(메모리 한도?)')로 분류하고 1.5초 뒤 한 번 다시 시도한다. HTML 같은 다른 형식일 때만 `unsupported`다(`nonJsonAnswer`).
- **고객 쪽 권장 (대시보드가 바꾸지 않음)**: hubble-ui backend 메모리 한도 256Mi → 512Mi 이상 + `GOMEMLIMIT`(순간 상승 흡수 — 누수는 못 막음), 업스트림에 `Stop()` 누락 보고.
- **재생 건수는 백엔드에서만 줄일 수 있다**: `GET_FLOWS_LAST`는 백엔드 환경 변수뿐이다(`ui.GetEventsRequest.since`는 v0.13.6이 무시). 대시보드가 덜 읽고 멈추면 재생이 오래된 것부터라 **가장 오래된** 부분만 남으므로 클라이언트에서는 줄이지 않는다. 백엔드에서 줄이면 표본 구간이 비례해 짧아진다(stg 약 150건/초: 10,000건 ≈ 0.9분, 2,000건 ≈ 13초).

### ERR-008: 서비스 맵의 빨간 '차단'이 `UNSUPPORTED_L3_PROTOCOL` → 대상 `unknown`

- **증상**: 서비스 맵 '차단' 필터에 여러 워크로드가 각각 드롭 1건으로 '클러스터 밖 · 구성 요소'의 `unknown`(초기화 중 엔드포인트) 카드에 빨간 점선으로 이어진다. 네트워크 탭 '차단 상위 플로우'의 목적지는 `/unknown`, 사유는 `UNSUPPORTED_L3_PROTOCOL`. 보안 탭은 '지금 정책이 차단 0'.
- **원인 (2026-11-13 stg 실측)**:
  - Hubble UI DROPPED 45초 표본의 11건이 모두 `UNSUPPORTED_L3_PROTOCOL`·ICMPv6·INGRESS였다. 대상은 identity 0(`reserved:unknown`, 멀티캐스트 주소)이거나 파드였다.
  - AMW `hubble_drop_total` 1시간 동안 `unsupported_l3_protocol` 308건, `policy_denied` 0건.
  - 정체: **IPv4 전용 Cilium 데이터 경로가 버리는 IPv6 패킷**(파드의 이웃 탐색·라우터 요청)이다. 연결도 정책 결정도 아니다. 'Hubble이 버렸다'는 사실은 맞지만, '차단된 연결'(빨강)이라는 표시와 identity 0 = '초기화 중'은 틀렸다.
- **해결 (`hubbleDrops.ts`)**:
  - 드롭을 셋으로 나눈다.
    - **policy**: POLICY_DENIED·POLICY_DENY·AUTH_REQUIRED
    - **ipv6**: UNSUPPORTED_L3_PROTOCOL이면서 IPv6 주소
    - **datapath**: 그 밖
  - 맵 표시
    - 빨간 점선 ■ = 정책 차단만
    - 주황 점선 ▲ = 기타 데이터 경로 드롭
    - 회색 점선 = IPv6 패킷. 카드 상태는 바꾸지 않고 툴팁으로 설명한다.
  - 보안 탭의 '거부'는 정책 드롭만 센다(나머지는 `nonPolicyDrops` 안내).
  - 네트워크 탭은 사유 옆에 분류를 보인다.
  - identity 0 = '식별자 없음'.
- **IPv6 드롭이 많아 보기 싫다면**: 고객 클러스터의 IPv6 커널 설정(파드 `net.ipv6.conf.all.disable_ipv6`)은 플랫폼이 바꾸지 않는다. 숫자는 그대로 보이고 분류만 바르게 한다.

### ERR-009: 서비스 맵 1·5·15·30분을 바꿔도 차단이 보였다 안 보였다 함

- **증상**: 기간을 바꾸면 드롭이 사라지거나 다른 기간과 똑같다. 1분이 빈 경우도 있다.
- **원인**:
  1. **표본이 잘렸다.** Hubble UI는 10,000건을 오래된 것부터 50 ms마다 내보내는데, 대시보드는 10 ms 간격 빈 응답 두 번에 멈췄다. 그래서 표본은 179~4,500건(실측)의 **가장 오래된 부분**뿐이었다. 최근 1분이 빠져 1분 창이 비곤 했고, 드문 드롭이 표본마다 들쭉날쭉했다.
  2. **실시간 표본은 원래 약 1분이다**(노드 링 버퍼, '공통 관측 0.8분'). 5·15·30분은 같은 1분을 보였다.
- **해결**:
  - 표본기는 백엔드의 `poll_delay_ms`(약 200 ms)를 기다리고, 채널을 연 시각까지 따라잡으면(+1번 더) 멈춘다. 데이터 없이 1.5초가 지나도, 상한(10,000건·12초)에 닿아도 멈춘다. 이제 표본에 최신 1분이 들어 있다.
  - 표본보다 오래된 구간의 드롭은 **Loki의 hubble-flow-exporter 기록**(`getLokiDropFlows`, `{job="hubble-flows"}`)에서 채운다. 표본의 가장 오래된 흐름보다 이전 것만 가져와 같은 드롭을 두 번 세지 않고, 화면에 '{w}분 중 … Loki에서 n건'으로 알린다.
  - Loki에 있는 것은 exporter가 보내는 드롭뿐이다. stg는 **정책 차단만** 보낸다(24시간 652줄, 전부 POLICY_DENIED, 4시간마다 :56–:57에 몰림 — 실측). IPv6 패킷 드롭은 실시간 표본에만 있다.

---

## 3. 진단 명령어

### Hubble 활성화 상태 확인
```bash
kubectl exec -n kube-system ds/cilium -c cilium-agent -- cilium-dbg status | grep -i hubble
# 정상: Hubble: Ok   Current/Max Flows: 4095/4095 (100.00%), Flows/s: 43.63
```

### Hubble flow 직접 수집 테스트
```bash
# 로컬 소켓 경유 (TLS 불필요)
kubectl exec -n kube-system ds/cilium -c cilium-agent -- hubble observe --last 5 -o json

# 특정 namespace 필터
kubectl exec -n kube-system ds/cilium -c cilium-agent -- hubble observe --last 10 -o json --namespace default
```

### Hubble Relay 상태 확인
```bash
kubectl get svc -n kube-system hubble-relay -o yaml
kubectl logs -n kube-system deployment/hubble-relay --tail=30
```

### Cilium ConfigMap 확인
```bash
kubectl get configmap -n kube-system cilium-config -o yaml | grep -i hubble
# 핵심: enable-hubble: "true", hubble-listen-address: :4244
```

### 바이너리 확인
```bash
kubectl exec -n kube-system ds/cilium -c cilium-agent -- which hubble
# /usr/bin/hubble

kubectl exec -n kube-system ds/cilium -c cilium-agent -- which cilium-dbg
# /usr/bin/cilium-dbg (cilium 1.17+)
```

---

## 4. AKS + Cilium 특이사항

### CLI 바이너리 변경 (Cilium 1.17+)

| 기존 | 현재 | 비고 |
|------|------|------|
| `cilium` | `cilium-dbg` | 메인 CLI 리네이밍 |
| `cilium hubble observe` | `hubble observe` | hubble 서브커맨드 분리, 별도 바이너리 |
| `cilium hubble status` | `hubble status` | 동일 |

### Hubble 접근 경로

```
┌─────────────────────────────────────────────────┐
│  cilium-agent pod (각 노드)                      │
│                                                  │
│  /usr/bin/hubble  ──→  /var/run/cilium/hubble.sock │ ← 로컬 소켓 (TLS 불필요)
│                          │                        │
│                          ▼                        │
│                    hubble (eBPF)                   │
│                    4095 flow buffer               │
└─────────────────────────────────────────────────┘
        │
        │ gRPC (port 4244, mTLS)
        ▼
┌─────────────────────────────────────────────────┐
│  hubble-relay pod                                │
│  port 4245 (gRPC) ← svc:443                     │
│  클러스터 전체 flow 집계                           │
└─────────────────────────────────────────────────┘
```

- **로컬 소켓**: 해당 노드의 flow만 조회 (단일 노드 관점)
- **Relay 경유**: 클러스터 전체 flow 조회 (mTLS 인증서 필요)
- **현재 구현**: 모든 노드의 로컬 소켓에 팬아웃 → `hubbleMerge.ts`로 병합(관측점·노드·SNAT 중복 제거, `coverage` 노드 n/m). 한계 = 노드당 링 버퍼 4,095건.
- **501 `hubble_exec_disabled`**: 운영에서는 exec가 기본 꺼짐 — `HUBBLE_EXEC_ENABLED`·연결 `aks.hubbleExec`·클러스터 Role 세 겹([aks.md](../integrations/azure/aks.md)). **403 `aks_rbac_forbidden`**: ClusterRoleBinding 주체가 연결 신원의 개체 ID인지 확인

### AKS에서 Hubble 비활성화 시 활성화 방법

```bash
az aks update \
  --resource-group <RG> \
  --name <CLUSTER_NAME> \
  --enable-hubble
```

---

*최종 업데이트: 2026-03-26*
