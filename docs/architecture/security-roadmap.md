---
status: draft
owner: platform-security
last-verified: 2026-10-30
covers: [apps/api/src/services/imageVulns.ts, apps/api/src/services/policyInsights.ts, apps/api/src/services/policyInsightsCollector.ts, apps/web/src/app/policies/insights/KbomPanel.tsx, apps/web/src/app/policies/insights/RiskCombos.tsx]
---
# 보안 기능 고도화 계획 — CNAPP(Wiz) 데모와 비교

이 문서는 클라우드 보안 플랫폼(CNAPP) 데모의 핵심 개념과 이 대시보드의 보안 기능을 나란히 놓고, **빈 곳을 메우는 순서**를 정합니다. 단계마다 설계·완료 조건·상태를 적고, 구현하면 같은 커밋에서 이 문서를 고칩니다.

> **5살 비유**: 도둑이 집에 들어오려면 ① 열린 창문(노출·취약한 이미지) ② 열쇠(권한) ③ 보물(데이터·클러스터)이 이어져야 해요. 따로따로 보면 "창문 하나 열림", "열쇠 하나 있음"이지만, **이어서 보면** "이 창문으로 들어와 이 열쇠로 보물상자를 열 수 있다"가 보여요. 우리는 이미 ②③을 잇고 있었고, ①(어느 창문이 정말 깨질 수 있는지)이 비어 있었어요.

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
| Issues 단일 목록 | 클러스터 위험 조합(AKS 보안 점검) · 통합 위험 · WI-17 · Defender 경고가 화면마다 | 하나의 우선순위·상태(열림·진행·해결·예외) 없음 → P2 |
| 소유 | Helm 차트·kubectl로 추정 | 팀 단위 소유·필터 없음 → P3 |
| CIEM | RBAC 행렬 · 워크로드 ID 매핑 · IMDS 경로 | 받은 권한 대비 **실제로 쓴** 권한 없음 → P3 |
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

### P2 — 통합 이슈 목록 (다음)

- **무엇**: '통합 위험'(`/security/risk`)을 모든 출처의 이슈 목록으로 — 클러스터 위험 조합, WI-17(IMDS), 공용 노출, 긴급 취약점(악용), Defender 경고(경고가 있는 워크로드는 진입을 `obs`로)
- **상태**: 열림 · 진행 · 해결 · 예외(사유·만료일) — 서버 저장(구성도 팀 배치 `arrangementStore` 방식 재사용: 연결별 JSON, 운영자 이상만 쓰기, 낙관적 잠금)
- **완료 조건**: 같은 이슈 키가 재수집 뒤에도 유지(키 = 종류 + 대상 ARM/K8s ID), 예외 만료 시 다시 열림, 테스트

### P3 — 소유와 실제 사용 권한

- 연결 파일에 `owners`(네임스페이스·리소스 그룹 → 팀) → 이슈·히트맵 '내 팀' 필터
- 권한 사용 여부: Key Vault 감사 로그(WI-17의 `imdsKvQuery` 확장)·Activity Log로 '받았지만 안 쓰는 권한' 표시 — 근거 `obs`, 로그 보존 기간을 같이 표시

### P4 — 이미지 → 코드

- OCI 라벨(`org.opencontainers.image.source`·`revision`)을 레지스트리 매니페스트에서 읽어 KBOM에 '출처 저장소·커밋' 열
- 조치 코드에 고칠 위치(Helm values 경로) — 고객 GitOps 저장소 연결은 선택

### P5 — 보안 그래프 탐색

- 기존 모델(구성도 그래프 + 정책 인사이트 + WI 매핑 + Defender)을 하나의 노드·간선 모델로 합치고 저장된 질의 제공(예: "인터넷 노출 ∧ Secret 조회 SA ∧ Key Vault 접근")
- 큰 작업 — P2·P3의 이슈 키·소유가 먼저 있어야 질의 결과를 조치로 이을 수 있음

## 4. UI·UX 원칙 (데모에서 가져온 것)

1. 이슈 카드 = **한 줄 문장 + 네 칸 요약**(대상 · 닿는 곳 · 끊을 곳 · 근거). 이름 목록은 접힌 표로 — P0에서 '상시 고권한'에 적용, 다른 조합(exfil·vnet) 제목도 같은 틀로 줄일 것
2. 그래프는 왼쪽 → 오른쪽 = 공격 방향, 같은 권한·같은 대상은 노드 하나로 묶고 '외 n개'로 생략을 밝힘
3. 숫자에는 단위('선 n개', '계정 n개', '스캔 n/m')
4. 같은 사실 = 같은 등급(히트맵 · 조합 · 경로 · KBOM), 테스트로 고정
