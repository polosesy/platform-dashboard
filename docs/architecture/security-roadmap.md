---
status: draft
owner: platform-security
last-verified: 2026-10-30
covers: [apps/api/src/services/gitopsSource.ts, apps/api/src/services/workloadIdentityCollector.ts, apps/api/src/services/issueStateStore.ts, apps/web/src/lib/issueQueue.ts, apps/web/src/app/security/risk/IssueQueue.tsx, apps/api/src/services/imageVulns.ts, apps/api/src/services/policyInsights.ts, apps/api/src/services/policyInsightsCollector.ts, apps/web/src/app/policies/insights/KbomPanel.tsx, apps/web/src/app/policies/insights/RiskCombos.tsx]
---
# 보안 기능 고도화 계획 — CNAPP(Wiz) 데모와 비교

이 문서는 클라우드 보안 플랫폼(CNAPP) 데모의 핵심 개념과 이 대시보드의 보안 기능을 나란히 놓고, **빈 곳을 메우는 순서**를 정합니다. 단계마다 설계·완료 조건·상태를 적고, 구현하면 같은 커밋에서 이 문서를 고칩니다.

> **5살 비유**: 도둑이 집에 들어오려면 ① 열린 창문(노출·취약한 이미지) ② 열쇠(권한) ③ 보물(데이터·클러스터)이 이어져야 해요. 따로따로 보면 "창문 하나 열림", "열쇠 하나 있음"이지만, **이어서 보면** "이 창문으로 들어와 이 열쇠로 보물상자를 열 수 있다"가 보여요. 우리는 이미 ②③을 잇고 있었고, ①(어느 창문이 정말 깨질 수 있는지)이 비어 있었어요.

**한눈에 — 상태(2026-10-30)**

| 단계 | 내용 | 상태 | 커밋 |
|---|---|---|---|
| P0 | 같은 사실 = 같은 등급(상시 고권한 분할·경로 머리 4칸) | 완료 | `f5d4262` |
| P1 | 이미지 취약성 = 공격 경로 진입점(Defender + SBOM) | 완료 | `f5d4262` |
| P2 | 통합 이슈 목록 + 상태·예외 저장 | 완료 | `402be59` |
| P3 | 팀 소유(`owners`) + 받았지만 안 쓰는 권한(WI-18) | 완료 | `055f7d6` |
| P4a | 배포 출처·고칠 곳(Argo CD) | 완료 | `7d4d5c2` |
| P4b | 이미지 OCI 라벨 → 저장소·커밋 | 보류(라벨 없음·AcrPull 필요) | — |
| P5 | 보안 그래프 탐색 | 계획 | — |

사용법(화면 읽는 법·상태 규칙·'확인 불가' 이유)은 [보안 기능 운영 가이드](../security/security-operations-guide.md).

## 1. 비교 기준

참고: "Wiz in Action: Risk-Based Code-to-Cloud Security Monitoring" 데모 영상(본문은 직접 확인 못 함) — 같은 데모를 소개한 [Bridewell 웨비나](https://www.bridewell.com/webinars/detail/seeing-the-full-attack-path-continuous-code-to-cloud-security-with-wiz)와 [Wiz 제품 페이지](https://www.wiz.io/product)의 공개 설명을 기준으로 삼았습니다.

| 개념 | 공개 설명 요지 |
|---|---|
| Security Graph | 코드·클라우드 리소스·ID·취약점·잘못된 구성의 관계를 하나의 그래프로 |
| Issues (toxic combinations) | 따로는 작은 문제들이 겹쳐 실제로 악용될 조합을 **하나의 우선순위 목록**으로 |
| Attack path | 조합을 악용 가능성·영향으로 순위 매겨 다음 조치를 안내 |
| Code-to-Cloud | 실행 중인 리소스를 코드·파이프라인·개발자까지 거슬러 올라감, 수정 PR |
| Projects / 소유 | 조직 구조에 따라 환경을 묶고 접근 권한도 그 단위로 |
| Workflows | 탐지 → 담당자 → 조치를 자동화 |
| Runtime (Sensor) | 실시간 위협 탐지를 위험 맥락과 함께 |

## 2. 지금 상태와 빈 곳

| 개념 | 이 대시보드 | 빈 곳 |
|---|---|---|
| 공격 경로 **진입점** | 노출(LoadBalancer·Ingress·HTTPRoute)만 — 대부분 '진입 미확인' | 실행 중인 이미지의 취약성과 경로가 이어지지 않음 → **P1 (구현)** |
| Issues 단일 목록 | 클러스터 위험 조합(AKS 보안 점검) · 통합 위험 · WI-17 · Defender 경고가 화면마다 | 하나의 우선순위·상태(열림·진행·해결·예외) 없음 → **P2 (구현)** |
| 소유 | Helm 차트·kubectl로 추정 | 팀 단위 소유·필터 없음 → **P3 (구현)** |
| CIEM | RBAC 행렬 · 워크로드 ID 매핑 · IMDS 경로 | 받은 권한 대비 **실제로 쓴** 권한 없음 → **P3 (구현 — Key Vault·Storage 데이터 역할)** |
| Code-to-Cloud | KBOM(이미지·버전) | 이미지 → 저장소·커밋 연결 없음 → P4 |
| Security Graph 탐색 | 화면마다 그래프(구성도·라이브·공격 경로·네트워크 맵·WI 흐름도) | 화면을 가로지르는 질의 없음 → P5 |
| Runtime | Defender 경고 · Hubble 관측 | 경고가 경로 위에 안 보임 → P2와 함께 |
| DSPM | 없음 | 보류 — 데이터 직접 스캔은 '읽기만' 원칙과 충돌, Purview 분류 결과 읽기만 검토 |

**지킬 것(차별점)**: 근거 등급(`obs` 관측 · `perm` 권한 정의 · `cfg` 구성·스캔 · `unk` 추정·미확인). 모르는 것을 '안전'으로 칠하지 않습니다. 새 기능도 값마다 출처와 등급을 같이 냅니다.

## 3. 단계

### P0 — 같은 사실은 모든 화면에서 같은 등급 (완료, 2026-10-30)

- '상시 고권한' 조합을 히트맵과 같은 등급으로 나눔(장악 수준 = 위험 / 그 밖 = 주의), 위험순, 구성원 전부(`members`), 그래프는 8개 + '외 n개'(조용히 빼지 않음)
- 경로 머리: 한 줄 제목 → 4칸(대상 · 닿는 곳 · 끊을 곳 · 근거 — 단위 '선 n개') → 접힌 구성원 표
- 테스트: `policyInsights.test.ts` "standing privilege …", "path header …"

### P1 — 이미지 취약성 = 공격 경로의 진입점 (구현, 2026-10-30)

**왜**: 클러스터 장악 경로의 첫 칸이 '진입 미확인'이면 "정말 들어올 수 있나?"에 답하지 못합니다. 실행 중인 이미지의 미해결 CVE가 그 답의 가장 큰 부분입니다.

**출처 두 개 — 둘 다 추측이 아님** (`services/imageVulns.ts`)

| 출처 | 읽는 것 | 이미지와 잇는 규칙 | 근거 등급 |
|---|---|---|---|
| ① Defender for Containers | Resource Graph `securityresources` 하위 평가(Unhealthy) → 이미지(레지스트리·리포지토리·다이제스트·태그)별 요약 `DEFENDER_IMAGE_QUERY` | 파드 이미지의 **다이제스트**, 없으면 **태그**(같은 태그가 여러 다이제스트면 더 나쁜 쪽) | `cfg` |
| ② SBOM | 알려진 오픈소스 이미지(`sbom.ts` `KNOWN_IMAGES`)의 **정확한 semver 태그** → OSV 권고, CVE.org(CISA ADP SSVC 악용), CISA KEV | 모듈 버전 일치 — 미러·재빌드(`-dhi` 등)는 매핑하지 않음(업스트림 번호에 없는 패치가 있을 수 있음) | `cfg` |

- 합치기: 같은 이미지면 Defender(그 이미지 자체의 스캔)를 쓰고, KEV·CVE.org의 더 강한 악용 신호는 유지 (`mergeVulns`)
- 등급(`vulnWeight`): 실제 악용(KEV·CVE.org active) = 위험 · 치명/높음 = 주의 · 중간 이하·공개 익스플로잇만 = 낮음
- 스캔 결과 없는 이미지 = **'모름'** — 칸을 비우고 사실 행에 이유(Defender 결과 0건 / 이 이미지는 스캔 안 됨 / 알려진 오픈소스·정확한 버전 아님 / SBOM 조회 꺼짐)

**어디에 보이나**

1. 히트맵 12번째 요인 '취약 이미지'(노출 묶음) — 칸 = "치명 1 · 높음 3 · KEV 악용 (Defender)"
2. 공격 경로 진입 노드 — 치명·높음이 있으면 '취약 이미지'(노출도 있으면 '노출 + 취약 이미지'), 선 = `cfg` "CVE n · 악용", 카드 칩 "진입: CVE n". 없으면 '진입 미확인' + 이유(스캔됐고 치명·높음 없음도 '미확인' — 제로데이·설정 오류를 배제 못 함)
3. 워크로드 사실(상세 카드) — 상위 CVE 3개(패키지 현재 → 수정 버전, 악용 표시)
4. KBOM — 카드 '취약점(CVE)' = 치명·높음·악용이 있는 이미지 수 + '스캔 n/m · 출처', 표의 신호 열 칩

**권한·통신**: Defender는 `Security Reader`(구독) — 기능 카탈로그 `aksSecurityCheck`의 선택 권한. SBOM 조회는 긴급 취약점과 같은 외부 출처(OSV·CVE.org·CISA)와 스위치(`AUD_ADVISORY_FEEDS`·`AUD_ADVISORY_OSV`), 차트 `features.advisoryFeeds`의 CNP FQDN. 보내는 것은 오픈소스 모듈 이름·버전뿐(앱 이미지 이름은 안 보냄).

**캐시·예산**: 클러스터별 10분(조회 대기 중이면 저장 안 함). OSV 10초 · KEV 8초 · CVE.org 6초 예산 — 넘치면 다음 열기에 채움.

**한계(사실)**: 시험 환경(stg) 구독은 Defender for Containers 플랜이 켜져 있어도 Resource Graph 하위 평가가 0건이었고(2026-10-30), 앱 이미지 대부분이 미러·하드닝 재빌드라 SBOM 매핑도 적습니다 → 그 환경의 진입점은 여전히 대부분 '미확인'이지만 **이유가 보입니다**. Defender 질의는 공개 스키마 기준으로 작성하고 Resource Graph에서 실행되는 것까지 확인했으며, 실제 결과 행으로는 아직 검증하지 못했습니다.

**완료 조건**: 테스트 `imageVulns.test.ts`(다이제스트·태그 일치, 미러 비매핑, KEV 우선, 병합·등급, 질의에 테넌트 값 없음) + `policyInsights.test.ts` "entry point …"(진입 노드·12번째 요인·KBOM·이유 문구) — 충족.

### P2 — 통합 이슈 목록 + 상태·예외 (구현, 2026-10-30)

> **5살 비유**: 장난감 고장 신고가 네 군데(클러스터·ID·취약점·경보)에 따로 붙어 있었어요. 이제 **게시판 하나**에 모으고, 신고마다 "고치는 중 / 나중에(이유·날짜) / 고쳤어요" 스티커를 붙여요. 스티커를 붙여도 장난감이 아직 고장 나 있으면 게시판이 **"다시 고장"**이라고 알려 줘요.

**어디**: 보안 › 통합 위험(`/security/risk`) 맨 위 '이슈 목록' — 기존 자산 표는 그 아래 그대로.

**출처 4곳**(웹 순수 `lib/issueQueue.ts` `buildIssueQueue` — 새 수집 API 없음, 각 출처는 따로 실패하고 칩으로 상태 표시)

| 출처 | 무엇을 | 등급 | 키 |
|---|---|---|---|
| 클러스터 위험 조합 | AKS 보안 점검 `issues` | crit → 위험, warn → 높음 | `combo:<rg>/<cluster>:<조합 id>` |
| 워크로드 ID | 위험·주의 점검(WI-17 포함, 낮음·정보 제외) | crit → 위험, warn → 높음 | `wi:<rg>/<cluster>:<점검 id>` |
| 긴급 취약점 | 우리 대상에 영향(`affected`)인 것만 | KEV·실제 악용·CVSS 9 이상 → 위험, 그 밖 높음 | `vuln:<rg>/<cluster>:<공지 key>` |
| Defender 경고 | 활성 경고(정보 제외), 같은 탐지는 한 이슈 ×n | High·Medium·Low 그대로 | `alert:<심각도>:<제목 slug>` |

키는 공백 없는 ASCII(서버가 `ISSUE_KEY`로 검증), 구독 ID는 넣지 않음(저장 파일이 구독별).

**상태**(`services/issueStateStore.ts`, `GET/PUT /api/security/issue-states?subscriptionId=[&key=]`)

- 열림 · 진행 중 · 예외 · 해결 표시. 읽기 = 로그인, 쓰기 = **운영자 이상**(익명 거부), 구독 접근은 authorize 미들웨어가 먼저 확인
- **예외**: 사유(3자 이상) + 끝나는 날(내일 ~ 1년) 필수 → 그날이 지나면 화면이 '예외 만료'로 다시 엶
- **출처가 이김**: '해결 표시' 뒤에 출처가 다시 읽었는데 아직 있으면 '재발'(열림), 표시 뒤 아직 안 읽었으면 '다음 수집에서 확인'. 출처에서 사라진 이슈의 상태는 목록에 안 나오고 '더 이상 탐지 안 됨 n'(기록 보관) — 읽은 출처·지금 클러스터만 셈
- **동시 편집**: 이슈마다 `rev` — 다른 이슈는 서로 막지 않음, 같은 이슈를 먼저 바꾼 사람이 있으면 409 + 최신 값(화면이 다시 불러옴)
- **기록**: 변경 20개(시각·상태·표시 이름·메모·끝나는 날), 담당은 자유 텍스트(디렉터리 조회 안 함)
- **저장 위치**: `AUD_ISSUE_STATE_DIR` → 없으면 `<AUD_ARRANGEMENT_DIR>/issues`(온프렘은 추가 설정 없이 기존 쓰기 마운트) → 없으면 메모리(화면 경고 '서버 메모리에만 저장'). 구독마다 JSON 하나, 임시 파일 → rename, 구독별 잠금, 최대 3,000개
- **딥 링크**: 조합 이슈 → `/policies?tab=overview&cluster=…&issue=…`(그 클러스터·조합을 골라 엶), WI → 워크로드 ID 탭, 취약점 → 긴급 취약점, 경고 → 위협 탐지

**완료 조건**: `issueQueue.test.ts` — 예외 규칙, 이슈별 rev 충돌·기록 20개·키 검증, 파일 저장·기본 위치, 실효 상태(재발·확인 대기·만료), 4출처 키·등급·정렬, 탐지 안 됨 셈 — 충족.

**남은 것**: 이슈에 Defender 경고를 얹어 공격 경로 진입을 `obs`로(런타임), 이슈별 알림·티켓 연동(Teams·Jira), 팀 소유(P3)로 '내 팀' 필터.

### P3 — 팀 소유와 '받았지만 안 쓰는 권한' (구현, 2026-10-30)

> **5살 비유**: ① 장난감 상자마다 **이름표**(어느 반 것인지)를 붙여서 "우리 반 고장만 보기"가 돼요. ② 열쇠를 받았는데 한 달 동안 한 번도 안 쓴 친구는 **열쇠를 돌려주자**고 알려 줘요. 단, 문에 출입 기록장이 없으면 "안 썼다"가 아니라 "몰라요"라고 말해요.

**A. 팀 소유** — 연결 파일 `owners: [{team, namespaces?, resourceGroups?}]`(zod strict, 팀 이름만·GUID 거부, 정확한 이름 또는 `접두*`, 대소문자 무시). `GET /api/security/issue-states` 응답 `owners`(구독의 연결) → 웹 `teamOf`(순수): **네임스페이스 규칙이 리소스 그룹 규칙보다 먼저**, 같은 종류는 파일 순서. 이슈마다 `namespaces`·`resourceGroups`를 모음(위험 조합 = 구성원·노드 ref `ns/name`, WI = `w:ns/…`·`sa:ns/…` ref, 취약점 = 대상 워크로드, 경고 = K8s 네임스페이스·리소스 RG, 네임스페이스가 없으면 클러스터 RG). 화면: 행에 팀 칩, '팀' 선택 상자(모든 팀 / 팀 / 소유 미지정) — 로그인 사용자의 팀은 디렉터리로 찾지 않고 고른 값을 이 브라우저에만 기억(`aud.issues.team`).

**B. 받았지만 안 쓰는 권한(WI-18)** — 워크로드 ID 매핑의 관리 ID 역할 할당 중 **데이터 역할**(`DATA_ROLES` — Key Vault 9종·Storage 14종, **정의 ID**로 분류, 읽기/쓰기 구분)만:

| 단계 | 내용 |
|---|---|
| 읽기 | 역할 범위(리소스·RG·구독)마다 **Log Analytics 리소스 중심 조회** `POST /v1{scope}/query`, 30일 — Key Vault 감사 로그(`AzureDiagnostics` AuditEvent ∪ `AZKVAuditLogs`) / Storage 로그(`StorageBlobLogs`·File·Queue·Table). (범위, 서비스)마다 한 번, 그 범위에 역할이 있는 ID들을 함께(`roleUsageQuery` — GUID만 통과), 4개씩 동시, 10분 캐시 |
| 판정 `usageVerdict` | 이 ID(client·object ID) 요청 > 0 = **사용**(횟수·마지막) · 0이고 **같은 범위 다른 요청 > 0** = **미사용** · 범위 전체 0건 = **확인 불가(noLogs)** · 403 = 확인 불가(noAccess) · 관리 그룹 범위·제어 평면 역할·AcrPull = 확인 불가(notCovered) |
| 점검 | 미사용 데이터 역할 → WI-18(쓰기 역할 = 주의, 읽기 = 낮음, 근거 `obs`) + 지우기 명령(자리표시자) — 설명에 '월말 배치·보존 기간이 짧으면 놓칠 수 있음' |
| 화면 | 역할 카드 보조 줄 '30일 미사용', 역할 상세 '사용 기록'(횟수·마지막 / 미사용 + 같은 범위 요청 수 / 확인 불가 + 이유, 근거 등급), 표 보기 '(30일 미사용)' |

권한: Reader(리소스 로그 읽기 포함) — 기능 카탈로그 `aksSecurityCheck`의 선택 `logs`. 응답에는 전체 client·object ID를 넣지 않음(끝 4자리만).

**완료 조건**: `issueQueue.test.ts` "teams …"(규칙 우선순위·접두사·이슈별 네임스페이스), `workloadIdentity.test.ts` "WI-18 …" 2개(판정·질의·분류, 지도의 usage·점검·전체 ID 비노출) — 충족.

**한계(사실)**: 로그가 그 범위에서 작업 영역으로 가지 않으면 판정하지 않음(확인 불가). 제어 평면 역할의 '사용'은 읽기 호출이 Activity Log에 없어 판정하지 않음. Kubernetes RBAC 사용(감사 로그 `kube-audit`)은 아직 아님.

### P4 — 이미지·워크로드 → 코드 (P4a 구현 2026-10-30, P4b 보류)

> **5살 비유**: 장난감이 고장 나면 "어느 설명서(설계도)를 고쳐야 하나?"를 알아야 해요. 우리 반 장난감은 **선생님 장부(Argo CD)**에 "이 장난감은 저 설명서 몇 쪽"이라고 적혀 있어서 그걸 그대로 읽어요. 장난감 몸에 붙은 "공장 이름표(OCI 라벨)"는 대부분 비어 있어서 아직 못 읽어요.

**실측(2026-10-30, 시험 ACR 이미지 설정 읽기)**: 고객 앱 이미지 24개는 OCI 라벨 `created·description·title·version`만 있고 **`source`·`revision`이 없음** — 이미지 → 저장소·커밋은 지금 데이터로 알 수 없음(업스트림 OSS인 argocd·dex만 `source` 있음). 라벨을 읽으려면 대시보드에 **AcrPull(이미지 내려받기)** 데이터 권한이 필요 — 라벨만 보자고 이미지 전체를 받을 권한을 주는 것은 과함(보안 관점) → **P4b 보류**: 고객 CI가 `org.opencontainers.image.source`·`revision`을 넣은 뒤(예: `docker build --label`, Jib `container.labels`) 다시 판단.

**P4a — 배포 출처(GitOps)** (`services/gitopsSource.ts` 순수 + `k8sPolicyCollector`):

| 단계 | 내용 |
|---|---|
| 읽기 | Argo CD `applications.argoproj.io`(v1alpha1) **list만**(CRD 선택 — 없으면 `notInstalled`, 403이면 `forbidden`·화면 안내). 읽기 역할 템플릿 `aud-dashboard-reader.yaml`에 추가(코드에서 생성) |
| 정리 `parseArgoApplications` | 저장소 URL에서 사용자 정보·쿼리·조각 제거(`sanitizeRepoUrl`), 멀티 소스는 경로·차트가 있는 첫 소스가 주 소스, Helm 값 파일 `$ref/…`는 그 ref 저장소로 풀어 씀, 동기화된 리비전·상태 |
| 연결 `sourceOf` | **`status.resources`**(Argo CD가 관리한다고 적은 목록)의 `apps` 그룹 Deployment·StatefulSet·DaemonSet와 정확히 일치할 때만 — 이름·라벨로 짐작 안 함 |
| 화면 | 워크로드 사실 '배포 출처', 위험 조합 조치 '고칠 곳: Argo CD 앱 → 저장소/경로 @브랜치 · values: …'(RBAC 축소·securityContext·송신 정책·상시 고권한 계정별), KBOM '배포 출처' 열(앱·경로, 툴팁 저장소·리비전), 읽기 실패 안내 |

**완료 조건**: `gitopsSource.test.ts`(자격 증명 제거·멀티 소스·`$ref` 값 파일·`status.resources` 일치만·고칠 곳 문장), `policyInsights.test.ts` "where to fix …"(행·조치·사실·KBOM·요약·미수집이면 없음), `k8sReadSurface.test.ts`(코드 ↔ 템플릿) — 충족.

**한계**: Argo CD가 아닌 GitOps(Flux)는 아직 아님. 고객 클러스터에서는 읽기 역할을 갱신해야 보임(그전엔 '권한 없음' 안내).

### P5 — 보안 그래프 탐색

- 기존 모델(구성도 그래프 + 정책 인사이트 + WI 매핑 + Defender)을 하나의 노드·간선 모델로 합치고 저장된 질의 제공(예: "인터넷 노출 ∧ Secret 조회 SA ∧ Key Vault 접근")
- 큰 작업 — P2·P3의 이슈 키·소유가 먼저 있어야 질의 결과를 조치로 이을 수 있음

## 4. UI·UX 원칙 (데모에서 가져온 것)

1. 이슈 카드 = **한 줄 문장 + 네 칸 요약**(대상 · 닿는 곳 · 끊을 곳 · 근거). 이름 목록은 접힌 표로 — P0에서 '상시 고권한'에 적용, 다른 조합(exfil·vnet) 제목도 같은 틀로 줄일 것
2. 그래프는 왼쪽 → 오른쪽 = 공격 방향, 같은 권한·같은 대상은 노드 하나로 묶고 '외 n개'로 생략을 밝힘
3. 숫자에는 단위('선 n개', '계정 n개', '스캔 n/m')
4. 같은 사실 = 같은 등급(히트맵 · 조합 · 경로 · KBOM), 테스트로 고정
