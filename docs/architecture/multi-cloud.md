---
status: draft
owner: platform-architecture
last-verified: 2026-10-22
covers: [packages/types/src/cloud.ts, apps/api/src/services/cloudKinds.ts, apps/api/src/infra/cloudRefs.ts]
---
# 멀티클라우드(Azure · AWS · GCP) 통합 대시보드 — 분석과 단계별 계획

참고 자료: [`docs/image/aws-azure-gcp-system.gif`](../image/aws-azure-gcp-system.gif) — 세 클라우드의 같은 역할 서비스를 영역 8개(컴퓨트·데이터베이스·스토리지·메시징·서버리스·모니터링·Kubernetes·AI)로 짝지은 지도. 이 문서는 지금 Azure 전용인 플랫폼을 세 클라우드로 넓히는 설계 초안이며, **Phase 0(동작 변화 없는 기반)만 구현**되어 있습니다.

> **5살 비유**: 지금 대시보드는 "Azure 말"만 알아듣는 통역사예요. 세 나라(Azure·AWS·GCP)는 같은 물건을 다른 이름으로 불러요(가상 머신 = EC2 = Compute Engine). 그래서 먼저 **공통 단어장**(표준 종류 `compute.vm`)을 만들고, 나라마다 **통역사(어댑터)**를 붙여요. 열쇠(자격 증명)는 나라마다 따로 — 한 나라 열쇠로 다른 나라 문을 열지 않아요.

## 1. 지금 무엇이 Azure에 묶여 있나

| 층 | Azure 전용 | 이미 중립 |
|---|---|---|
| 공유 타입 | 연결(`ConnectionMode`·테넌트·구독 GUID), 구성도 종류(`GraphNodeKind` 36종)·`azureId`, Resource Health 상태, Defender 모델, 라이브 다이어그램 바인딩 전체 | 비용(리소스 그룹 하나 빼고), 정책 점검·인사이트·Hubble·K8s 객체 |
| 신원·연결 | 레지스트리(GUID·홈 Entra 테넌트 하나), `@azure/identity` 자격 증명·`tid` 확인, 구독 GUID로 연결 찾기(**연결에 없는 구독은 홈으로 폴백** — 다른 클라우드로는 절대 안 됨), 권한 확인의 범위 추출(GUID만) | 플랫폼 역할(`AUD.*`)·연결 접근·캐시 격리 |
| 서비스 | Resource Graph·Azure Monitor·Resource Health·Defender·Cost Management·KQL, 관계 사전(ARM REST 스펙) | K8s 기능의 유일한 이음새 `loadKubeConfig` 뒤의 전부(라벨 몇 개 제외) |
| 화면 | 라이브 다이어그램(Front Door·WAF·AGC·NSG·UDR·S2S·Private Link) — 오래 Azure 전용 | 정책·K8s·관측 화면(클러스터 단위) |

## 2. 목표 구조

- **공통 단어장(표준 종류)**: `CanonicalKind` 약 45개 — 기능으로 분류(그림의 같은 줄이 아니라: AlloyDB = `db.relational`). Fargate·Autopilot·Archive 같은 실행 방식·계층은 종류가 아니라 속성(facet). 표는 [`cloudKinds.ts`](../../apps/api/src/services/cloudKinds.ts)(Azure = 소문자 ARM 유형, AWS = CloudFormation 유형, GCP = Cloud Asset Inventory 유형), 같은 유형이 여러 종류면 구분자, 없는 쪽은 이유(`gap` — 예: 관리형 Bastion은 AWS·GCP에 없음).
- **범위·리소스 참조**: `ScopeRef`(Azure 구독 · AWS 계정 12자리 · GCP 프로젝트 ID), `ResourceRef`(ARM ID · ARN · CAI 이름) — [`cloudRefs.ts`](../../apps/api/src/infra/cloudRefs.ts)가 ID에서 범위를 읽음(S3 ARN·GCP 프로젝트 번호처럼 조회가 필요한 형태는 거부).
- **클라우드별 어댑터** (응답 형식은 지금 것 + `provider`, 없는 값은 `coverage`/`gaps` — 지어내지 않음):

| 기능 | Azure | AWS | GCP |
|---|---|---|---|
| 인벤토리 | Resource Graph | Resource Explorer + Config 고급 쿼리 | Cloud Asset Inventory |
| 메트릭 | Azure Monitor | CloudWatch GetMetricData | Cloud Monitoring (PromQL) |
| 상태 | Resource Health | AWS Health(Business 이상 지원 플랜) + 상태 검사·알람 | Personalized Service Health |
| 보안 | Defender for Cloud | Security Hub · GuardDuty · Inspector | Security Command Center(조직) |
| 비용 | Cost Management | Cost Explorer(요청당 과금 → 수 시간 캐시) + CUR 2.0 | BigQuery 결제 내보내기(켠 날부터) |
| Kubernetes | AKS(Entra) | EKS(STS 서명 토큰, 바이너리 없음) | GKE(OAuth, Autopilot은 exec 금지 → Hubble은 relay) |

- **연결 일반화**: 연결 파일 스키마를 `provider`로 나눔(없으면 azure — 지금 파일 그대로). AWS = 계정·역할(`AudReadOnly`)·리전, GCP = 프로젝트·워크로드 ID 페더레이션 공급자. 범위 키는 `azure:sub:` / `aws:acct:` / `gcp:proj:`로 전체에서 유일, **홈 폴백은 Azure 구독에만**(AWS·GCP에서 모르는 범위는 403).
- **관계 사전**: 같은 방법(공개 스펙 → 참조 속성 → 문서 근거) — AWS는 CloudFormation 리소스 스키마의 `relationshipRef`, GCP는 Discovery 문서의 self-link 필드 → `catalog-aws.json`·`catalog-gcp.json`, 관계 ID에 접두사(`AWS-NET-01`).

## 3. 신원·보안 (지금 원칙 그대로: 비밀 없음 · 연결마다 자격 증명 하나 · 폴백 없음)

- **AWS**: `sts:AssumeRoleWithWebIdentity` — 파드 서비스 계정 토큰을 **대상 `sts.amazonaws.com`의 별도 투영 토큰**으로(Azure 토큰을 재사용하지 않음 — 대상마다 다른 토큰), 고객이 우리 클러스터 OIDC 발급자를 IAM 공급자로 등록·역할 신뢰 정책에 주체 `system:serviceaccount:aud-dashboard:aud-dashboard`. 온프레미스(공개 발급자 없음)는 Entra 토큰을 웹 ID로. 가정 후 `GetCallerIdentity`로 계정 일치 확인(지금의 `tid` 확인과 같은 역할). 권한: `ViewOnlyAccess` + `SecurityAudit` + 필요한 읽기 몇 개, `ReadOnlyAccess`는 데이터 읽기(S3·DynamoDB)까지라 과권한 경고.
- **GCP**: 워크로드 ID 페더레이션(같은 발급자) → STS 교환 → 서비스 계정 가장 또는 직접 주체. 권한: `roles/browser`·`cloudasset.viewer`·`monitoring.viewer`·`logging.viewer`·`servicehealth.viewer`·`container.clusterViewer`·SCC 결과 조회·결제 내보내기 데이터셋 읽기. `roles/viewer`는 넓다고 경고.
- **정적 검사 추가 예정**: 기본 자격 증명 체인(`fromNodeProviderChain`·`defaultProvider`·`new GoogleAuth(` 등) 금지, 이미지에 `AWS_EC2_METADATA_DISABLED=true`. 마스킹은 GUID + 12자리 계정 + 프로젝트 번호(`maskCloudIds`).

## 4. 화면

- 범위 선택 = 클라우드 › 연결 › 구독/계정/프로젝트. 메뉴 항목에 지원 클라우드 표시(연결 없는 클라우드 항목은 숨김·배지).
- **먼저 섞어 보는 화면**: 개요(영역 × 클라우드 수), 새 인벤토리(표준 종류 표 + 원래 유형), 리소스 상태(표준 종류로 묶음, 상태 출처 표시), 비용(클라우드별 쌓기 — 통화가 다르면 따로, 몰래 환산 금지), 보안 현황(심각도·영역 정규화), Kubernetes·관측·정책(클러스터 목록에 클라우드 배지).
- **클라우드별 전환**: 인프라 구성도(Azure 먼저, AWS·GCP VPC는 관계 사전 뒤), VNet 트래픽(VPC Flow Logs 나중), 통합 위험.
- **오래 Azure 전용**: 라이브 다이어그램.

## 5. 단계별 계획

| 단계 | 내용 | 공수(인·주) / 위험 | 완료 조건 |
|---|---|---|---|
| **0 기반 (구현됨)** | 타입 `cloud.ts`, 표준 종류 표 `cloudKinds.ts`, ID → 범위 `cloudRefs.ts`, 연결 `provider` 기본값 azure, 이 문서 | 1 / 낮음 | 기존 테스트 전부 통과, 응답·화면 변화 없음(추가 필드만), 이미지 빌드의 `@aud/types` 런타임 금지 유지 |
| 1 AWS 기반 (계정 1개) | 연결·웹 ID 자격 증명·연결 점검, 인벤토리·상태·비용 어댑터, 인벤토리 화면, 연동 문서(12절 양식), CloudFormation 역할 템플릿 | 6–8 / 중간 | 정적 키 없음(테스트), 계정 불일치 거부, 인벤토리 수 = Resource Explorer 검색, 비용 = 콘솔 |
| 2 EKS(+GKE) | `ClusterRef {provider,id}`로 `loadKubeConfig` 분기, 클라우드별 라벨, GKE Hubble relay | 4–6 / 중상 | 정책·인사이트 픽스처가 EKS/GKE 라벨로 통과, SSAR 점검 동작 |
| 3 GCP 기반 | WIF 연결, CAI 인벤토리, 서비스 상태, BigQuery 결제 | 5–7 / 중간 | 프로젝트 번호 ↔ ID 변환 테스트, 결제 내보내기 없음 = `gaps`(0 아님) |
| 4 보안 현황 | Security Hub·GuardDuty·SCC → 공통 모델, 통합 위험 조인 | 4–5 / 중간 | 심각도·영역 매핑 표 테스트, 추측 재분류 금지 |
| 5 네트워크·구성도 | VPC Flow Logs, AWS/GCP 구성도(관계 사전 기반) | 8+ / 높음 | 클라우드별 관계 사전 테스트, 선은 구성 참조로만 |

## 6. Phase 0에서 한 것과 확인 방법

- [`packages/types/src/cloud.ts`](../../packages/types/src/cloud.ts) — 타입만(런타임 값 없음 — Dockerfile 검사 규칙).
- [`apps/api/src/services/cloudKinds.ts`](../../apps/api/src/services/cloudKinds.ts) — `KIND_MAP`(표준 종류 × 3 클라우드), `AZURE_GRAPH_KIND_CANONICAL`(구성도 종류 전부 — `satisfies`로 컴파일 시 빠짐없음), `canonicalKindOf`.
- [`apps/api/src/infra/cloudRefs.ts`](../../apps/api/src/infra/cloudRefs.ts) — `scopeOfResourceId`, `maskCloudIds`.
- 연결 파일: `provider` 생략 = `"azure"`(다른 값은 아직 거부), 연결 목록 응답에 `provider: "azure"`.
- 테스트 `apps/api/test/cloudKinds.test.ts`: 구성도 종류 전부 매핑 · Azure 유형이 관계 카탈로그(REST 스펙)에 실제로 있음 · 클라우드별 이름 형식 · 세 클라우드 모두 있거나 이유 · 공유 유형엔 구분자 · 그림의 8개 영역마다 세 클라우드가 다 있는 종류 · 표에 테넌트 데이터 없음 · ID → 범위 · 마스킹.
