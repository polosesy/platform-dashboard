# AUD 프로젝트 용어 사전 (Glossary)

> Azure Unified Dashboard 개발 및 프롬프트 작성 시 혼선을 방지하기 위한 공식 용어 정리.
> 신규 용어 추가 시 이 파일을 먼저 업데이트한다.

---

## 1. 캔버스 & 다이어그램 레이어

| 공식 용어 | 동의어 (사용 가능) | 사용 금지 | 설명 |
|-----------|------------------|-----------|------|
| **리소스 카드** | LiveNode 카드 | "노드" (단독 사용) | 캔버스 위에 그려지는 Azure 리소스 1개를 나타내는 네모 박스. 컴포넌트명: `LiveNode.tsx` |
| **GroupNode** | VNet 박스, Subnet 박스 | "그룹", "컨테이너" (단독) | VNet 또는 Subnet 범위를 나타내는 리소스 카드 묶음 컨테이너. 컴포넌트명: `GroupNode.tsx` |
| **VMSS 인스턴스 카드** | VmssInstanceNode | "VMSS 노드" | VMSS 스케일셋 내 개별 인스턴스를 나타내는 리소스 카드. 컴포넌트명: `VmssInstanceNode.tsx` |
| **NsgBadgeNode** | 분리된 NSG 노드 | "NSG 노드" (단독) | Subnet/NIC에 연결되지 않은 독립 NSG를 표시하는 빨간 X 마커 노드. 컴포넌트명: `NsgBadgeNode.tsx` |
| **ReactFlow 엣지** | 연결선, 캔버스 엣지 | "엣지" (단독) | 캔버스 위 리소스 카드 간의 시각적 연결선. ReactFlow 라이브러리 개념 |
| **캔버스 레이아웃** | 다이어그램 레이아웃 | "레이아웃" (단독) | `specGenerator.ts`가 계산하는 리소스 카드의 X/Y 포지션 배치 |
| **다이어그램 Spec** | LiveSpec, 레이아웃 Spec | "spec" (단독) | `specGenerator.ts`가 출력하는 `{ nodes, edges }` JSON 구조체. K8s spec과 무관 |

---

## 2. 배지 (Badge) 레이어

배지는 리소스 카드 또는 GroupNode에 부착되는 소형 아이콘/레이블이다. **반드시 종류를 명시**한다.

| 공식 용어 | 위치 | 설명 |
|-----------|------|------|
| **NSG 배지** (GroupNode) | GroupNode 헤더 좌측 | Subnet에 연결된 NSG를 나타내는 아이콘 배지. `GroupNode.tsx` 헤더 내 렌더링 |
| **NSG 배지** (NIC/VM) | 리소스 카드 좌상단 | NIC 또는 VM에 직접 연결된 NSG. `liveNsgBadge` CSS 클래스 |
| **상태 배지** | 리소스 카드 우측 | RUNNING / STOPPED 등 리소스 전원 상태 표시 레이블 |
| **K8s Pod 배지** | 리소스 카드 하단 | Kubernetes Pod 수를 표시하는 배지 |
| **리전 배지** | GroupNode 헤더 우측 | Azure 리전명(예: Korea Central)을 표시하는 배지 |
| **역할 배지** | 리소스 카드 내부 | LB, Ing, VMSS, Pool 등 리소스 역할을 나타내는 태그형 배지 |

---

## 3. Azure 리소스 용어

| 공식 용어 | 약어 | 주의사항 |
|-----------|------|----------|
| **Virtual Network** | VNet | VPC와 혼용 금지 |
| **Network Security Group** | NSG | 방화벽 규칙 그룹. "NSG 필터 규칙"은 Azure NSG inbound/outbound 규칙을 의미 |
| **Load Balancer** | LB | Azure Load Balancer |
| **Virtual Machine Scale Set** | VMSS | 스케일셋 전체를 가리킴. 개별 인스턴스는 "VMSS 인스턴스" |
| **Azure Kubernetes Service** | AKS | 관리형 K8s 클러스터 서비스 |
| **Backend Pool** | 백엔드 풀 | LB가 트래픽을 분산하는 대상 그룹 |
| **Public IP** | PIP | Azure Public IP Address 리소스 |
| **NAT Gateway** | NAT GW | Azure NAT Gateway 리소스 |

---

## 4. Kubernetes 용어 (AKS 컨텍스트)

| 공식 용어 | 사용 금지 | 설명 |
|-----------|-----------|------|
| **K8s 워커노드** | "노드" (단독) | Kubernetes 클러스터의 실제 워커 머신. VMSS 인스턴스와 1:1 대응 |
| **K8s Node Pool** | "노드풀" (단독) | AKS에서 동일 VM 크기의 워커노드 묶음. `aks-nodepool1` 형태 |
| **K8s Pod** | "pod" | 컨테이너 실행 단위. 캔버스의 K8s Pod 배지와 구분 필요 |
| **K8s Spec** | — | Kubernetes 리소스 정의 YAML의 `spec` 필드. 다이어그램 Spec과 무관 |

---

## 5. 코드 레이어 용어

| 공식 용어 | 위치 | 설명 |
|-----------|------|------|
| **specGenerator** | `apps/api/src/services/specGenerator.ts` | 서버사이드 레이아웃 엔진. 리소스 카드의 X/Y/W/H를 계산해 다이어그램 Spec 출력 |
| **LiveCanvas** | `apps/web/src/app/live-diagram/components/LiveCanvas.tsx` | ReactFlow 캔버스 전체를 관리하는 클라이언트 컴포넌트 |
| **azureIcons** | `apps/web/src/app/live-diagram/utils/azureIcons.ts` | 리소스 타입별 SVG 아이콘 매핑 유틸리티 |
| **ResourceDetailPanel** | `apps/web/src/app/live-diagram/components/ResourceDetailPanel.tsx` | 리소스 카드 클릭 시 나타나는 상세 정보 사이드패널 |
| **OBO Token** | `apps/api/src/infra/oboTokenPool.ts` | On-Behalf-Of 인증 토큰. 사용자 권한으로 Azure API 호출 시 사용 |

---

## 6. 필터 & UI 용어

| 공식 용어 | 사용 금지 | 설명 |
|-----------|-----------|------|
| **VNet 필터** | "필터" (단독) | 페이지 상단 드롭다운. 표시할 VNet을 선택하는 UI |
| **리전 필터** | — | VNet 필터와 연동된 Azure 리전 선택 드롭다운 |
| **NSG 필터 규칙** | "NSG 필터" | Azure NSG의 inbound/outbound 보안 규칙 항목. VNet 필터와 무관 |
| **포커스 뷰** | "확대", "줌" | 특정 VNet/리소스에 fitView를 적용해 캔버스를 이동하는 동작 |

---

## 7. 혼동 패턴 & 올바른 표현 예시

```
# 리소스 카드 관련
❌  "노드의 스타일을 바꿔줘"
✓   "리소스 카드(LiveNode)의 스타일을 바꿔줘"

# 배지 관련
❌  "배지를 추가해줘"
✓   "리소스 카드 좌상단에 NSG 배지(NIC 연결)를 추가해줘"

# 레이아웃 관련
❌  "레이아웃 수정"
✓   "specGenerator의 캔버스 레이아웃 포지션 계산 수정"

# Kubernetes 관련
❌  "AKS 노드 카드에 노드 정보 표시"
✓   "AKS 리소스 카드에 K8s 워커노드 수 표시"

# Spec 관련
❌  "spec 업데이트"
✓   "다이어그램 Spec 업데이트" 또는 "K8s Spec 업데이트" (컨텍스트 명시)

# 엣지 관련
❌  "엣지를 그려줘"
✓   "LB → VMSS 간 ReactFlow 엣지(연결선)를 추가해줘"
```

---

> **업데이트 기준**: 신규 컴포넌트 추가, 용어 혼선 발생 시 즉시 이 파일에 추가한다.
> Last updated: 2026-03-12

## 플랫폼 로그인·Azure 연결

| 용어 | 뜻 |
|---|---|
| 연결 (Connection) | 플랫폼이 한 고객의 Azure(테넌트 + 구독 + 작업 영역)를 읽는 단위. 자격 증명 방식(`mode`)과 쓸 수 있는 플랫폼 역할을 가짐 — `infra/connectionRegistry.ts` |
| 플랫폼 역할 | SSO 토큰의 앱 역할 `AUD.Viewer`(조회자)·`AUD.Operator`(운영자)·`AUD.Admin`(관리자). Azure 권한과 무관 — `infra/platformAccess.ts` |
| 플랫폼 ID (`platform`) | 홈 테넌트의 `aud-api` 서비스 주체로 읽는 연결 |
| Lighthouse 연결 | 고객이 Azure Lighthouse로 구독을 플랫폼 서비스 주체에 위임한 연결. 새 비밀 값 없음 |
| 고객 서비스 주체 (`servicePrincipal`) | 고객 테넌트에 고객이 만든 앱. 비밀 값은 환경 변수 `AUD_CONN_<KEY>_SECRET`(이름만 파일에), 또는 인증서 |
| 사용자 위임 (`delegated`) | 로그인한 사용자 본인의 Azure 권한(OBO)으로 읽는 연결 — 선택 사항 |
| 관리자 동의 | 테넌트 관리자가 앱의 권한을 조직 전체에 승인하는 것. `delegated` 연결의 위임 권한에 필요 |
| 연결 점검 | 설정 › Azure 연결 › 점검(관리자) — 토큰·보이는 구독·기능별 권한·과도한 권한·작업 영역 |
| VNet 흐름 로그 | VNet 단위 흐름 기록(NSG 흐름 로그의 후속). Traffic Analytics가 `NTANetAnalytics`로 집계 |
