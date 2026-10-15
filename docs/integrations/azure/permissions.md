# Azure 연결 권한 표

> **대상**: 고객 테넌트 관리자, 보안 검토자 · **소요 시간**: 읽기 5분 · **필요 권한**: 역할 부여 권한(Owner / User Access Administrator)

## 1. 개요

연결의 자격 증명(플랫폼 서비스 주체 · 고객 서비스 주체 · Lighthouse 위임 대상)에 **읽기 전용** 역할만 부여합니다. 쓰기 권한이 필요한 기능은 없습니다. 필요한 기능만 고르세요 — 빠진 역할은 그 화면만 '미측정/권한 없음'으로 표시됩니다.

> **5살 비유**: 창고 열쇠에 "보기만" 스티커를 붙여요. 그림 보는 방, 온도계 보는 방처럼 필요한 방 열쇠만 고리에 걸어요.

## 6. 권한

| 기능 (화면) | 역할 | 범위 | 왜 필요한가 | 점검 키 |
|---|---|---|---|---|
| 리소스 목록·구성도·라이브 다이어그램 구성 | **Reader** | 구독 | Resource Graph·ARM 읽기 | `inventory` |
| 메트릭·알림·리소스 상태 | **Monitoring Reader** (Reader에 포함) | 구독 | Azure Monitor 메트릭·알림 규칙·Resource Health | `metrics` |
| 로그(Traffic Analytics·Container Insights·Private Link 사용 근거) | **Log Analytics Reader** | 작업 영역 (또는 구독) | KQL 쿼리 | `logs` |
| 보안 개요·권고·위협·규정 준수 | **Security Reader** (Reader로도 대부분) | 구독 | Defender for Cloud | `security` |
| 비용 관리 | **Cost Management Reader** | 구독 | Cost Management 쿼리·예산 | `cost` |
| AKS 클러스터·모니터링·Hubble·정책 점검 | **Azure Kubernetes Service Cluster User Role** | 클러스터 | `listClusterUserCredential` (로컬 계정 클러스터) | `aksCredential` |
| NSG 흐름 로그 원본(blob) | **Storage Blob Data Reader** | 흐름 로그 스토리지 계정 | 데이터 평면 읽기 | `flowLogBlobs` |
| Prometheus 메트릭 | **Monitoring Data Reader** | Azure Monitor 작업 영역 | PromQL | `prometheus` |

Microsoft 기본 제공 역할 정의 ID(템플릿에서 사용): Reader `acdd72a7-3385-48ef-bd42-f606fba81ae7` · Monitoring Reader `43d0d8ad-25c7-4714-9337-8ba259a9fe05` · Log Analytics Reader `73c42c96-874c-492b-b04d-ab87d138a893` · Security Reader `39bc4728-0917-49c7-9d2c-d95423bc2eb4` · Cost Management Reader `72fafb9e-0641-4937-9268-a91bfd8191a3` · AKS Cluster User Role `4abbcc35-e782-43d8-92c5-2d3f1bd2253f` · Storage Blob Data Reader `2a2b9908-6ea1-4ae2-8e65-a410df84e7d1` · Monitoring Data Reader `b0d8363b-8ddd-447d-831f-62ca05bff136`.

### 주의

- **AKS 클러스터 사용자 자격 증명**은 Entra 인증·Azure RBAC를 쓰지 않는 클러스터(로컬 계정)에서 **클러스터 관리자와 같은 권한**의 kubeconfig를 줄 수 있습니다. 이 플랫폼은 읽기만 하지만, 이 역할은 꼭 필요한 클러스터에만 부여하세요. Entra 전용 클러스터는 지원하지 않습니다(`501 aad_cluster_unsupported`, kubelogin 실행 안 함).
- **Hubble**은 Cilium agent Pod에 `exec`해 `hubble observe`(읽기)를 실행합니다 — 노드 수준 접근이라는 점을 검토에 포함하세요.
- **Lighthouse**는 일부 역할(예: DataActions가 있는 역할 — Storage Blob Data Reader, Monitoring Data Reader)의 위임을 제한할 수 있습니다. 배포 전에 최신 Microsoft 문서의 "Lighthouse에서 지원되는 역할"을 확인하고, 안 되면 그 기능만 고객 서비스 주체(B)로 연결하세요.
- 다음 권한이 보이면 연결 점검이 **경고**합니다(차단하지 않음): 모든 작업(`*`), 쓰기·삭제, 역할 할당 쓰기, 클러스터 관리자 자격 증명.

## 7. 플랫폼 쪽 권한 (참고)

| 앱 | 권한 | 용도 |
|---|---|---|
| `aud-web` (SPA) | `aud-api` / `Azure.Read.All` (위임) | 우리 API 호출 토큰 |
| `aud-api` | 앱 역할 3개 정의 | [sso.md](./sso.md) |
| `aud-api` (`delegated` 연결을 쓸 때만) | Azure Service Management `user_impersonation`, Log Analytics API `Data.Read`, Azure Storage `user_impersonation` (위임 + 관리자 동의) | 사용자 OBO |
