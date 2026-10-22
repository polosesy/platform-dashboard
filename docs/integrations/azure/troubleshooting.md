---
status: current
owner: platform-auth
last-verified: 2026-10-15
---
# 문제 해결 — 로그인·연결 오류 코드

> **대상**: 플랫폼 관리자 · 모든 코드는 화면에서 현재 언어의 문장으로 보입니다(원문 AAD 메시지·추적 ID는 보이지 않음).

## 9. 문제 해결

| 코드 (HTTP) | 화면 문장 | 원인 | 조치 | 카탈로그 |
|---|---|---|---|---|
| `signin_required` (401) | 로그인이 필요합니다 / 예시 데이터 | 로그인 안 함 | 로그인 | AUTH-007 |
| `invalid_token` · `token_expired` (401) | 다시 로그인하세요 | 토큰 위조·만료 | 다시 로그인 | AUTH-006 |
| `no_platform_role` (403) | 플랫폼 역할이 없습니다 | 앱 역할 미할당 | [sso.md](./sso.md) 역할 할당 | AUTH-011 |
| `role_required` (403) | 내 플랫폼 역할로는 사용할 수 없습니다 | 조회자가 운영자·관리자 기능 호출 | 역할 상향 | AUTH-012 |
| `connection_forbidden` (403) | 내 플랫폼 역할로는 사용할 수 없습니다 | 연결의 `roles`에 내 역할이 없음 | 연결 파일 `roles` 조정 | CONN-001 |
| `connection_unconfigured` (503) | Azure 연결에 문제가 있습니다 | `secretEnv`가 가리키는 환경 변수 없음, 인증서 경로 없음, 플랫폼 비밀 값·인증서 없음 | 메시지에 나온 **변수 이름**을 설정 후 재시작 | CONN-002 |
| `connection_credential_invalid` (503) | 〃 | 비밀 값 틀림·만료(AADSTS7000215/7000222), 인증서 불일치(700027) | [lifecycle.md](./lifecycle.md) 교체 | CONN-003 |
| `connection_not_consented` (403) | 〃 | 앱이 그 테넌트에 없음(AADSTS700016) — 고객 앱 ID·테넌트 오타 | 연결 파일 `clientId`·`tenantId` 확인 | CONN-004 |
| `connection_tenant_mismatch` (502) | 〃 | 토큰이 다른 테넌트에서 발급됨, 테넌트 없음(AADSTS90002) | `tenantId` 확인 | CONN-005 |
| `connection_timeout` (504) | 〃 | 토큰 발급 10초 초과 | 네트워크·프록시 확인 후 재시도 | CONN-006 |
| `connection_failed` (502) | 〃 | 그 밖의 토큰 실패(메시지는 가려짐) | API 로그(`AUD_DEBUG=true`) | CONN-007 |
| `ARM 403: AuthorizationFailed` (화면: 일부 데이터 / 권한 없음) | — | 연결에 역할 없음 | [permissions.md](./permissions.md), [verify.md](./verify.md) 점검 | CONN-008 |
| `consent_required` · `interaction_required` · `access_blocked` | 사용자 위임(OBO) 연결 … | `delegated` 연결 전용: 관리자 동의 없음(AADSTS65001), MFA, 조건부 액세스 | 위임 권한 관리자 동의 / 다시 로그인 | AUTH-001, AUTH-008 |

전체 카탈로그: [error-catalog.md](../../troubleshooting/error-catalog.md).

## 자주 겪는 상황

- **로그인했는데 '예시 데이터'가 보임** → 브라우저가 토큰 없이 호출 중. 상단 역할 배지가 있는지, 개발자 도구에서 `/api/me`가 `anonymous:false`인지 확인.
- **연결을 추가했는데 구독 목록에 없음** → 연결 파일 경로(`AUD_CONNECTIONS_FILE`)와 API 재시작, 내 역할이 그 연결의 `roles`에 있는지.
- **예전 `/network` 화면의 AADSTS65001** → 사용자 OBO(Log Analytics `Data.Read` 위임 동의 없음) 때문이었습니다. 이제 기본은 플랫폼 연결이라 사용자 동의가 필요 없습니다. 같은 오류가 보이면 `AUD_HOME_CONNECTION_MODE=delegated`인지 확인하세요.

> **5살 비유**: 문이 안 열리면 쪽지에 적힌 번호(코드)를 보고 이 표에서 찾아요. 쪽지에는 열쇠 번호나 주소 같은 비밀은 적혀 있지 않아요.
