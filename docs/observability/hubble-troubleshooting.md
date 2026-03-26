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
  | 0 | init | 아직 identity 미할당 |
  | 1 | host | 노드 자체 (kubelet, kube-proxy 등) |
  | 2 | world | 클러스터 외부 트래픽 |
  | 3 | unmanaged | Cilium 미관리 엔드포인트 |
  | 4 | health | Cilium 헬스체크 |
  | 6 | kube-apiserver | API 서버 |
  | 7 | remote-node | 다른 노드 |

- **해결**: `parseEndpoint`에서 `reserved:*` 라벨과 identity 숫자를 의미 있는 이름으로 매핑. Cilium 1.17+ `workloads` 배열 활용 (`{"workloads":[{"name":"konnectivity-agent","kind":"Deployment"}]}`).

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
- **현재 구현**: 로컬 소켓 우선 → 단일 노드 flow 수집. 클러스터 전체 수집을 위해서는 향후 gRPC 클라이언트 직접 연결 검토 필요.

### AKS에서 Hubble 비활성화 시 활성화 방법

```bash
az aks update \
  --resource-group <RG> \
  --name <CLUSTER_NAME> \
  --enable-hubble
```

---

*최종 업데이트: 2026-03-26*
