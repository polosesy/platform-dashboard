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
2. **API** → `getKubeconfig()` → K8s Exec API → `hubble observe --output json --last 1000`
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
| `HUBBLE_RELAY_PORT` | `443` | Relay 서비스 포트 |
| `HUBBLE_FLOW_LIMIT` | `1000` | 단일 요청 최대 flow 수 |

## 6. Cilium 1.17+ (AKS) 특이사항

- CLI: `cilium` → `cilium-dbg`, `hubble` 별도 바이너리 (`/usr/bin/hubble`)
- 접근: 로컬 소켓 우선 (`/var/run/cilium/hubble.sock`), TLS 불필요
- Relay: gRPC (port 4245, TLS), K8s Service port 443

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

*최종 업데이트: 2026-03-26*
