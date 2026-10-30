---
status: current
owner: platform-auth
last-verified: 2026-10-30
covers: [apps/api/src/services/featureCatalog.ts]
---
# Azure 연결 권한 표

> **대상**: 고객 테넌트 관리자, 보안 검토자 · **소요 시간**: 읽기 5분 · **필요 권한**: 역할 부여 권한(Owner / User Access Administrator)

## 1. 개요

연결의 자격 증명(플랫폼 서비스 주체 · 고객 서비스 주체 · Lighthouse 위임 대상)에 **읽기 전용** 역할만 부여합니다. 쓰기 권한이 필요한 기능은 없습니다. 필요한 기능만 고르세요 — 빠진 역할은 그 화면만 '미측정/권한 없음'으로 표시됩니다.

> **5살 비유**: 창고 열쇠에 "보기만" 스티커를 붙여요. 그림 보는 방, 온도계 보는 방처럼 필요한 방 열쇠만 고리에 걸어요.

## 6. 권한

> **기능 × 권한의 원천은 코드 한 곳**입니다 — `apps/api/src/services/featureCatalog.ts`(패키지안 3단계·권한 11개·기능 13개). 대시보드 **설정 › 기능·권한**(`/settings/features`)이 이 카탈로그로 패키지별 기능과 최소 권한·부여 명령(복사만)을 보여 주고, **설정 › Azure 연결 › 점검**이 연결마다 기능별 준비 상태(사용 가능·일부 제한·사용 불가·확인 필요)를 계산합니다. 아래 표와 카탈로그가 어긋나면 `featureCatalog.test.ts`가 실패합니다.
>
> 점검 방법: 구독 범위 `Microsoft.Authorization/permissions` → 구독에 없는 권한(클러스터·작업 영역·Azure Monitor 작업 영역·흐름 로그 스토리지)은 **리소스 표본**(종류당 최대 3개, 클러스터 5개, 전체 20개)의 같은 API로 확인 → 클러스터 안 권한은 **클러스터 권한 점검**(SelfSubjectAccessReview — 클러스터에 저장되는 것 없음, 모든 로그인 신원에 기본 허용)으로 확인. 표본이라 '일부 n/m'은 일부 리소스에만 부여됐다는 뜻입니다.

| 기능 (화면) | 역할 | 범위 | 왜 필요한가 | 점검 키 |
|---|---|---|---|---|
| 리소스 목록·구성도·라이브 다이어그램 구성 | **Reader** | 구독 | Resource Graph·ARM 읽기 | `inventory` |
| 워크로드 ID 매핑(관리 ID·페더레이션 자격 증명·역할 할당) | **Reader** | 관리 ID가 있는 구독 | `*/read` — 관리 ID의 `federatedIdentityCredentials` 목록, Resource Graph `authorizationresources`(읽을 권한이 있는 범위의 할당만, PIM 적격 할당 제외) | `inventory` |
| 워크로드 ID 매핑 — 노드에 붙은 관리 ID(IMDS 경로) | **Reader** | AKS 노드 리소스 그룹(`MC_…`) | 노드 풀 VMSS의 사용자 할당 ID(Resource Graph), 클러스터 `networkProfile.podLinkLocalAccess`(미리 보기 api-version) — 없으면 IMDS 경로만 '읽지 못함' | `inventory` |
| 메트릭·알림·리소스 상태 | **Monitoring Reader** (Reader에 포함) | 구독 | Azure Monitor 메트릭·알림 규칙·Resource Health | `metrics` |
| 로그(Traffic Analytics·Container Insights·Private Link 사용 근거) | **Log Analytics Reader** | 작업 영역 (또는 구독) | KQL 쿼리 | `logs` |
| 워크로드 ID 매핑 — 받았지만 안 쓰는 권한(WI-18) | **Reader** (리소스 로그 읽기 `Microsoft.Insights/logs/*/read` 포함) | 역할 할당 범위(Key Vault·Storage 계정·RG·구독) | 그 범위의 접근 로그를 **리소스 중심**으로 KQL(작업 영역 접근 모드 '리소스 또는 작업 영역 권한'일 때). 없으면 사용 여부만 '확인 불가' | `logs` |
| 보안 개요·권고·위협·규정 준수 | **Security Reader** (Reader로도 대부분) | 구독 | Defender for Cloud | `security` |
| 비용 관리 | **Cost Management Reader** | 구독 | Cost Management 쿼리·예산 | `cost` |
| AKS 클러스터·모니터링·정책 점검 | **Azure Kubernetes Service Cluster User Role** | 클러스터 | `listClusterUserCredential` — API 서버 주소·CA (Entra 클러스터에서는 비밀 없음) | `aksCredential` |
| (클러스터 안) 같은 화면 | Kubernetes **`aud-dashboard-reader`** (list만) | 클러스터 | [aks.md](./aks.md) · [templates/aks](./templates/aks/) — Argo CD `applications.argoproj.io` 포함(배포 출처·고칠 곳, 없으면 그 부분만 '권한 없음') | — |
| AKS 보안 점검 — 이미지 취약성(진입점) | **Security Reader** (선택) | 구독 | Defender for Containers 취약성 결과(Resource Graph). 없으면 알려진 오픈소스 이미지의 버전 조회(OSV)만 | `security` |
| NSG 흐름 로그 원본(blob) | **Storage Blob Data Reader** | 흐름 로그 스토리지 계정 | 데이터 평면 읽기 | `flowLogBlobs` |
| Prometheus 메트릭 | **Monitoring Data Reader** | Azure Monitor 작업 영역 | PromQL | `prometheus` |

Microsoft 기본 제공 역할 정의 ID(템플릿에서 사용): Reader `acdd72a7-3385-48ef-bd42-f606fba81ae7` · Monitoring Reader `43d0d8ad-25c7-4714-9337-8ba259a9fe05` · Log Analytics Reader `73c42c96-874c-492b-b04d-ab87d138a893` · Security Reader `39bc4728-0917-49c7-9d2c-d95423bc2eb4` · Cost Management Reader `72fafb9e-0641-4937-9268-a91bfd8191a3` · AKS Cluster User Role `4abbcc35-e782-43d8-92c5-2d3f1bd2253f` · Storage Blob Data Reader `2a2b9908-6ea1-4ae2-8e65-a410df84e7d1` · Monitoring Data Reader `b0d8363b-8ddd-447d-831f-62ca05bff136`.

### 주의

- **AKS**: Entra 연동 클러스터는 연결의 자격 증명으로 받은 짧은 Entra 토큰으로 로그인합니다(kubelogin 실행 없음). Entra 연동이 **없는** 클러스터의 kubeconfig는 **클러스터 관리자 인증서**라 기본 거부합니다(`403 aks_local_account_refused`, 연결별 `aks.allowLocalAccount`로만 허용). 프라이빗 클러스터·Tier·네트워크 경로는 [aks.md](./aks.md).
- **Hubble exec**(Cilium agent Pod 안에서 `hubble observe`)는 노드 수준 접근입니다 — 프로덕션 기본 꺼짐(`HUBBLE_EXEC_ENABLED`), 고객 연결은 `aks.hubbleExec: true`일 때만. 읽기 역할(`aud-dashboard-reader`)에는 들어 있지 않습니다.
- **Lighthouse**는 일부 역할(예: DataActions가 있는 역할 — Storage Blob Data Reader, Monitoring Data Reader)의 위임을 제한할 수 있습니다. 배포 전에 최신 Microsoft 문서의 "Lighthouse에서 지원되는 역할"을 확인하고, 안 되면 그 기능만 고객 서비스 주체(B)로 연결하세요.
- 다음 권한이 보이면 연결 점검이 **경고**합니다(차단하지 않음): 모든 작업(`*`), 쓰기·삭제, 역할 할당 쓰기, 클러스터 관리자 자격 증명.

## 7. 플랫폼 쪽 권한 (참고)

| 앱 | 권한 | 용도 |
|---|---|---|
| `aud-web` (SPA) | `aud-api` / `Azure.Read.All` (위임) | 우리 API 호출 토큰 |
| `aud-api` | 앱 역할 3개 정의 | [sso.md](./sso.md) |
| `aud-api` (`delegated` 연결을 쓸 때만) | Azure Service Management `user_impersonation`, Log Analytics API `Data.Read`, Azure Storage `user_impersonation` (위임 + 관리자 동의) | 사용자 OBO |
