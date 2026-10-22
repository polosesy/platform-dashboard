---
status: current
owner: platform
last-verified: 2026-10-22
---
# 문서 목록

현재 문서 전부가 여기 한 줄씩 있습니다(목록에 없는 문서는 `docs.test.ts`가 실패). 플랫폼 전체 설명의 기준은 저장소 루트 [`CLAUDE.md`](../CLAUDE.md)입니다.

## 시작하기 — `getting-started/`

- [setup-guide.md](getting-started/setup-guide.md) — 개발 환경: 예시 데이터로 실행 → 앱 등록 2개·로그인 → 연결로 Azure 읽기

## 연동 — `integrations/` ([표준 양식 12절](integrations/_template.md))

- [integrations/README.md](integrations/README.md) — 연동 목록·읽는 순서·문서 규칙
- [_template.md](integrations/_template.md) — 연동 문서 양식
- Azure: [overview.md](integrations/azure/overview.md) (방식 고르기) · [sso.md](integrations/azure/sso.md) (로그인·앱 역할) · [connect-tenant.md](integrations/azure/connect-tenant.md) (홈·고객 서비스 주체·Lighthouse·페더레이션) · [permissions.md](integrations/azure/permissions.md) (권한 표) · [aks.md](integrations/azure/aks.md) (클러스터 안 읽기·RBAC) · [data-collected.md](integrations/azure/data-collected.md) · [verify.md](integrations/azure/verify.md) · [troubleshooting.md](integrations/azure/troubleshooting.md) · [lifecycle.md](integrations/azure/lifecycle.md) · [security-faq.md](integrations/azure/security-faq.md)
- 템플릿 [`integrations/azure/templates/`](integrations/azure/templates/) — `aks/`(코드에서 생성한 RBAC·서비스 계정) · `lighthouse/` · `service-principal/`(onboard·roles·FIC)

## 배포 — `deployment/`

- [container.md](deployment/container.md) — 이미지 하나 · 온프레미스 Docker(작업 PC에서 배포, 서버에 소스 없음 · `audctl`)
- [kubernetes.md](deployment/kubernetes.md) — AKS 클러스터 안 네임스페이스(Helm 차트 · 워크로드 ID · 페더레이션 주체 하나)

## 아키텍처 — `architecture/`

- [GLOSSARY.md](architecture/GLOSSARY.md) — 용어 사전
- [azure-resource-relationships.md](architecture/azure-resource-relationships.md) — 리소스 관계 사전 핵심(코드가 쓰는 행)
- 영역별 관계 사전: [network-core.md](architecture/relationships/network-core.md) · [network-edge.md](architecture/relationships/network-edge.md) · [compute-containers.md](architecture/relationships/compute-containers.md) · [app-integration.md](architecture/relationships/app-integration.md) · [data.md](architecture/relationships/data.md) · [identity-security-monitoring.md](architecture/relationships/identity-security-monitoring.md) (+ `relationships/catalog.json`)

## 관측 — `observability/`

- [observability-instrumentation-guide.md](observability/observability-instrumentation-guide.md) — AKS 메트릭·로그 계측과 수집 경로
- [hubble-guide.md](observability/hubble-guide.md) · [hubble-troubleshooting.md](observability/hubble-troubleshooting.md) — Pod 트래픽(Hubble)
- [vnet-flow-logs.md](observability/vnet-flow-logs.md) — VNet 트래픽(흐름 로그·Traffic Analytics)

## 문제 해결 — `troubleshooting/`

- [error-catalog.md](troubleshooting/error-catalog.md) — 도메인별 오류 `[도메인]-[번호]` (HUB·OBS·AUTH·K8S·FE·SEC·CONN·NET·HEALTH)

## 보관 — `archive/`

더 이상 플랫폼과 맞지 않는 문서: [archive/README.md](archive/README.md) (현재 문서는 보관 문서를 링크하지 않음)

## 문서 규칙

1. **머리(front matter) 필수** — 모든 `.md` 맨 위:
   ```yaml
   ---
   status: current        # current | draft | archived
   owner: platform-auth   # 팀(사람·메일 아님)
   last-verified: 2026-10-22   # 코드와 맞춰 본 날짜
   covers: [apps/api/src/services/hubbleClient.ts]   # 선택 — 설명하는 코드 경로
   ---
   ```
2. **같은 변경에서 갱신** — 동작·환경 변수·라우트·권한을 바꾸면 그 문서를 같은 커밋에서 고치고 `last-verified`를 올립니다. `covers`의 코드가 `last-verified`보다 나중에 바뀌면 테스트가 진단 메시지로 알려 줍니다(실패는 아님).
3. **자리** — `docs/` 바로 아래에는 이 파일만. 종류별 폴더(위 목록), 파일 이름은 kebab-case. 새 문서·이동은 이 목록과 `CLAUDE.md`의 Docs 표를 같은 커밋에서.
4. **보관** — 맞지 않게 된 문서는 지우지 말고 `archive/<연도>/`로 `git mv` + 머리 `status: archived`·`archived`·`reason`·`replaced-by` + 맨 위 보관 배너, [archive/README.md](archive/README.md)에 한 줄. 내용이 같은 복사본은 보관하지 않고 삭제.
5. **실데이터 금지** — 실제 테넌트·구독·리소스 ID와 이름은 자리표시자(`<HOME_TENANT_ID>`). 실환경 그림·메모는 `*.local.md` 또는 `.secrets/`(gitignore).
6. **오류** — `troubleshooting/error-catalog.md`에 `[도메인]-[번호]`, 자세한 진단은 그 영역 폴더의 `*-troubleshooting.md`.
7. 언어: 한국어(코드·명령·제품 이름은 영어).
