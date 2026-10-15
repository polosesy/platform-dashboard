# 연동 (Integrations)

이 플랫폼이 외부 시스템과 연결되는 방법을 한곳에 모은 문서입니다. 모든 연동 문서는 같은 양식([`_template.md`](./_template.md))을 따릅니다.
Datadog·Grafana·Argo CD의 연동 문서처럼 **개요 → 동작 방식 → 준비물 → 설정(자동·수동) → 권한 → 수집 데이터 → 확인 → 문제 해결 → 자격 증명 교체 → 연동 해제 → 보안·FAQ** 순서입니다.

## 목록

| 연동 | 무엇을 하나 | 문서 |
|------|------------|------|
| **플랫폼 로그인 (SSO)** | Entra ID로 플랫폼에 로그인하고 역할(조회자·운영자·관리자)을 받습니다 | [azure/sso.md](./azure/sso.md) |
| **Azure 연결** | 플랫폼이 고객의 테넌트·구독을 읽을 수 있게 연결합니다 (플랫폼 ID · Lighthouse · 고객 서비스 주체 · 사용자 위임) | [azure/overview.md](./azure/overview.md) → [azure/connect-tenant.md](./azure/connect-tenant.md) |
| 권한 표 | 기능별로 필요한 Azure 역할과 범위 | [azure/permissions.md](./azure/permissions.md) |
| 수집 데이터 | 무엇을 읽고, 어디에 얼마나 머무는지 | [azure/data-collected.md](./azure/data-collected.md) |
| 연결 확인 | 화면의 '점검' 버튼과 셸 스크립트 | [azure/verify.md](./azure/verify.md) |
| 문제 해결 | 오류 코드별 원인과 조치 | [azure/troubleshooting.md](./azure/troubleshooting.md) |
| 수명 주기 | 자격 증명 교체, 연결 해제 | [azure/lifecycle.md](./azure/lifecycle.md) |
| 보안·FAQ | 격리, 감사, 익명·개발 모드 | [azure/security-faq.md](./azure/security-faq.md) |
| VNet 흐름 로그 | `/network` 화면의 데이터 원천(VNet 흐름 로그 + Traffic Analytics) | [../observability/vnet-flow-logs.md](../observability/vnet-flow-logs.md) |

## 읽는 순서

1. 처음 설치: [sso.md](./azure/sso.md)(로그인·역할) → [connect-tenant.md](./azure/connect-tenant.md) A(홈 연결) → [verify.md](./azure/verify.md)
2. 고객 테넌트 추가: [overview.md](./azure/overview.md)에서 방식 고르기 → [connect-tenant.md](./azure/connect-tenant.md) B 또는 C → [permissions.md](./azure/permissions.md) → [verify.md](./azure/verify.md)
3. 문제가 생기면: 화면의 오류 코드 → [troubleshooting.md](./azure/troubleshooting.md)

> **5살 비유**: 이 폴더는 "다른 집과 친구 맺는 방법" 설명서 모음이에요. 설명서는 모두 같은 순서로 써 있어서, 하나를 읽으면 나머지도 쉽게 읽을 수 있어요.

## 문서 규칙

- 한국어 본문, 제품·역할·환경 변수·오류 코드는 영어 그대로.
- 실제 테넌트·구독·앱 ID는 쓰지 않습니다(`<HOME_TENANT_ID>` 같은 자리표시자). Microsoft 기본 제공 역할·API의 공개 ID만 예외입니다.
- 비밀 값(secret·인증서 키)은 문서·저장소·연결 파일 어디에도 적지 않습니다.
