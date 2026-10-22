---
status: current
owner: platform-observability
last-verified: 2026-10-22
covers: [apps/api/src/services/hubbleClient.ts, apps/api/src/services/hubbleMerge.ts, apps/api/src/services/aksAccess.ts]
---
# Hubble 네트워크 관측 가이드

> AKS Cilium 클러스터에서 Hubble을 통한 네트워크 가시성 확보 방법을 정리한 문서입니다.

---

## 1. 개요

Cilium Hubble은 eBPF 기반 네트워크 관측 도구로, 클러스터 내 모든 네트워크 플로우를 L3/L4/L7 레벨에서 관찰합니다.

### 대시보드 기능

| 탭 | 설명 |
|----|------|
| Service Map | d3-force 기반 서비스 의존성 그래프. K8s Service/Pod 엔드포인트 표시 |
| Flows | 실시간 네트워크 플로우 테이블 (source, destination, verdict, protocol) |
| Network | 네트워크 요약 (dropped, DNS 에러, namespace별 트래픽, 프로토콜 분포) |
| Security | 보안 관측 (policy verdict, identity 기반 플로우 매트릭스) |

## 2. 아키텍처

```
┌─────────────────────────────────────────────┐
│  Azure Unified Dashboard                     │
│                                              │
│  Web (Next.js) ──→ API (Express) ──→ K8s API │
│                                      │       │
│                              kubectl exec    │
│                                      ▼       │
│                            cilium-agent pod   │
│                        /usr/bin/hubble observe│
│                                      │       │
│                          hubble.sock (로컬)   │
│                                      │       │
│                            eBPF flow buffer   │
│                            (4095 flows)       │
└─────────────────────────────────────────────┘
```

### 데이터 흐름

1. **Web** → `GET /api/hubble/service-map?clusterId=...&timeWindow=5`
2. **API** → `aksAccess.loadKubeConfig`(연결의 자격 증명 · Entra 토큰, kubelogin 없음) → `assertHubbleExecAllowed`(아래 게이트) → **모든 cilium agent**(노드당 1개)에 K8s Exec `hubble observe --output json --last min(HUBBLE_FLOW_LIMIT, 10000)` → `hubbleMerge.ts`가 관측점·노드·SNAT 중복 제거, 응답 `coverage`(노드 n/m·공통 관측 구간)
3. **hubbleCollector** → flow 집계 → Service Map/Network/Security 응답 생성
4. **K8s Service enrichment** → Service/Endpoint 매칭 → Pod 엔드포인트 추가

## 3. API 엔드포인트

| Endpoint | 설명 |
|----------|------|
| `GET /api/hubble/status` | Hubble 연결 상태 확인 |
| `GET /api/hubble/service-map` | 서비스 의존성 맵 |
| `GET /api/hubble/flows` | 원시 flow 목록 |
| `GET /api/hubble/network-summary` | 네트워크 모니터링 요약 |
| `GET /api/hubble/security-summary` | 보안 관측 요약 |

## 4. 주요 파일

| 파일 | 역할 |
|------|------|
| `packages/types/src/hubble.ts` | 타입 정의 (Flow, ServiceNode, Edge, K8sService) |
| `apps/api/src/services/hubbleClient.ts` | K8s Exec → hubble CLI 실행, flow 파싱 |
| `apps/api/src/services/hubbleCollector.ts` | Flow 집계, Service Map 생성, K8s Service enrichment |
| `apps/api/src/routes/hubble.ts` | Express 라우트 |
| `apps/web/src/app/hubble/components/ServiceMapTab.tsx` | d3-force + ReactFlow 시각화 |
| `apps/web/src/app/observability/components/HubbleTab.tsx` | Observability 페이지 내 Hubble 래퍼 |

## 5. 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `HUBBLE_ENABLED` | `true` | Hubble 기능 활성화 |
| `HUBBLE_RELAY_NAMESPACE` | `kube-system` | Hubble Relay가 설치된 네임스페이스 |
| `HUBBLE_RELAY_PORT` | `80` | Relay 서비스 포트 (AKS 밖 대체 경로) |
| `HUBBLE_FLOW_LIMIT` | `10000` | 요청당 최대 flow 수 |
| `HUBBLE_EXEC_ENABLED` | 미설정 = 개발 켬·운영 끔 | Pod exec 허용 — 운영은 홈 연결 또는 연결 `aks.hubbleExec` + 클러스터의 [`aud-dashboard-hubble-exec.yaml`](../integrations/azure/templates/aks/aud-dashboard-hubble-exec.yaml) Role까지 세 겹. 꺼져 있으면 501 `hubble_exec_disabled` |
| `HUBBLE_CACHE_TTL_MS` | `30000` | 응답 캐시 |

## 6. Cilium 1.17+ (AKS) 특이사항

- CLI: `cilium` → `cilium-dbg`, `hubble` 별도 바이너리 (`/usr/bin/hubble`)
- 접근 순서: ① 모든 노드의 로컬 소켓(`/var/run/cilium/hubble.sock`, TLS 불필요) 팬아웃 + 병합 ② `--server` Relay(AKS 밖 대체) ③ K8s API 프록시로 Relay
- 한계: 노드당 링 버퍼 4,095건 — 바쁜 노드는 1~3분치. 장기 관측은 흐름 로그

## 7. K8s Service + Pod Endpoint 표시

Service Map 노드에 K8s Service 정보가 자동으로 매핑됩니다:

1. Hubble flow에서 workload 라벨 추출 (`k8s:app`, `k8s:app.kubernetes.io/name`)
2. K8s Service의 `spec.selector`와 라벨 매칭
3. 매칭된 Service의 Endpoint 목록 (Pod name, IP, Ready 상태) 표시

### Detail Panel 구조

```
[노드 클릭] → Detail Panel
├─ Meta (namespace, identity, pod count)
├─ Kubernetes Service (매칭된 경우)
│  ├─ Service 이름 + ClusterIP + Type
│  ├─ Ports (port→targetPort/protocol)
│  ├─ Selector 라벨
│  └─ Endpoint 테이블 (Pod | IP | Node | 상태)
├─ Metrics
├─ Labels
├─ Inbound Connections
└─ Outbound Connections
```

## 8. 트러블슈팅

→ [hubble-troubleshooting.md](./hubble-troubleshooting.md) 참고
→ [에러 카탈로그](../troubleshooting/error-catalog.md) HUB 섹션 참고

---

*이력은 git log — 확인 날짜는 문서 머리의 `last-verified`*
