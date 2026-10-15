# Azure 관계 사전 — 재생성 파이프라인

`docs/architecture/relationships/catalog.json`(기계용 관계 목록)과 영역별 문서의 근거 데이터를 다시 만드는 도구입니다. 사람이 읽는 사전은 [`docs/architecture/azure-resource-relationships.md`](../../docs/architecture/azure-resource-relationships.md)입니다.

> **5살 비유**: Azure가 공개한 "레고 설명서 전집"(REST API 스펙)을 기계로 한 장씩 넘기며 "이 블록에는 저 블록을 끼우는 홈이 있다"를 받아 적고(추출), 우리 집에 실제로 조립된 레고와 맞춰 보고(검증), 설명서가 틀린 곳은 공식 안내문(Learn)으로 고쳐 적습니다(보정).

## 단계

| 단계 | 명령 | 입력 → 출력 | 비고 |
|---|---|---|---|
| 1. 스펙 받기 | `git clone --filter=blob:none --sparse --depth 1 https://github.com/Azure/azure-rest-api-specs.git <dir>` → `git config core.longpaths true` | GitHub → 로컬 트리(blob 없음) | Windows는 longpaths 필수. 저장소에 커밋하지 않음 |
| 2. 최신 stable 파일 고르기 | `git ls-tree -r --name-only HEAD specification` 에서 `/resource-manager/…/stable/<날짜>/*.json`(examples 제외)을 **파일마다** 가장 새 버전으로 고름 → `latest-files.txt`(새 버전 먼저) | | 버전 폴더에는 그 버전에 바뀐 파일만 있다 — 폴더 단위로 고르면 서비스가 빠진다 |
| 3. 체크아웃 + 참조 닫힘 | `git sparse-checkout set --no-cone --stdin < patterns` 후 `node closure.mjs <dir>`가 `$ref`로 가리키는 빠진 파일을 출력 → 패턴에 추가, 0이 될 때까지 반복 | | 공급자 내부 `common-types` 등 |
| 4. 추출 | `node extract.mjs <dir> latest-files.txt spec-refs.json` | 스펙 → 리소스 유형별 참조 속성 | `arm-id`·`typed-ref`·`subresource`·`id-string`, 읽기 전용(역참조) 구분, 이름 추정은 `inferred:"name"` |
| 5. 범위 | `providers.json` — `apps/api/scripts/relationship-scan.ts`가 함께 만든다(ARM `GET /subscriptions/{id}/providers`) | 유형별 위치 → regional / global / mixed / none | 읽기 전용 |
| 6. (선택) 테넌트 교차 검증 | `cd apps/api && npx tsx scripts/relationship-scan.ts <out>` → `node verify.mjs spec-refs.json providers.json check.json --tenant <out>/tenant-refs.json` | 실제 리소스 속성의 ARM ID → (유형, 경로, 대상 유형) 집계 | **ID·이름 없음, 결과 파일 커밋 금지**. 통계(일치·해결·불일치·테넌트만)만 문서에 |
| 7. 공개 카탈로그 | `node verify.mjs spec-refs.json providers.json ../../docs/architecture/relationships/catalog.json --public` | → 커밋되는 `catalog.json` | 공개 자료(스펙·providers·`overrides.json`)만, 테넌트 데이터 없음 |
| 8. 영역 요약 | `node digest.mjs check.json providers.json <digest dir>` | 영역별 마크다운 요약 | 영역 문서를 쓰는 사람(또는 에이전트)이 읽는 원자료 |

## `overrides.json`

스펙 메타데이터가 Learn 설명보다 좁을 때의 보정입니다(예: Private Endpoint 대상은 스펙상 Private Link Service만이지만 실제로는 모든 Private Link 리소스). 항목마다 `reason`과 Learn `source`를 적습니다. 테넌트 교차 검증에서 "대상 불일치"가 남으면 여기 추가할지 검토합니다.

## 마지막 실행 (2026-10-15)

- 스펙: 최신 stable 파일 기준, 리소스 유형·참조 속성 수는 `catalog.json`의 `types`·`references`
- 추출 규칙 추가(같은 날): `{ id: string }`만 가진 정의는 이름과 상관없이 참조로 본다(AGC association `subnet`, WAF `policy`, PE 연결의 `privateEndpoint` 등 222개). 이전 추출 결과에 이 규칙의 추가분만 합쳐 다시 만들었다(2,650 → 2,872). 현재 추출기를 처음부터 다시 돌리면 내장 객체의 깊은 경로까지 세어 약 1만 개가 나오므로, 전체 재생성 전에는 깊은 경로 정리 규칙을 먼저 정할 것
- providers API: 네임스페이스 309, 리소스 유형 4,749 (regional 2,995 · global 295 · mixed 129 · 위치 없음 1,330)
- 테넌트 교차 검증(579 리소스, 69 유형): 결과는 `docs/architecture/azure-resource-relationships.md` "이 사전이 만들어진 방법"
- 테스트: `apps/api/test/relationshipCatalog.test.ts`가 코드의 관계(`REL`)마다 스펙 경로가 `catalog.json`에 있는지, `catalog.json`에 테넌트 데이터·GUID가 없는지 검사
