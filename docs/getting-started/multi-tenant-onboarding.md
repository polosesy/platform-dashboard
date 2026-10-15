# 멀티 테넌트·멀티 구독 온보딩 → 이동했습니다

이 문서는 **[docs/integrations/azure](../integrations/azure/overview.md)** 로 옮겨졌습니다. 개념이 바뀌었습니다.

| 예전 | 지금 |
|---|---|
| 운영자가 자기 Azure 권한(OBO)으로 고객 구독을 봄 | 사용자는 **로그인(SSO)과 플랫폼 역할**만, Azure는 **연결의 플랫폼 자격 증명**으로 읽음 |
| Lighthouse 위임 대상 = 운영자 그룹 | Lighthouse 위임 대상 = **플랫폼 서비스 주체** (`delegated` 연결일 때만 운영자 그룹) |
| `AUD_TENANTS_FILE` (`tenants`, `access`) | `AUD_CONNECTIONS_FILE` (`connections`, `mode`) — 예전 파일도 그대로 읽힘 |
| `docs/templates/lighthouse/` | `docs/integrations/azure/templates/lighthouse/` |

- 방식 고르기: [overview.md](../integrations/azure/overview.md)
- 로그인·역할: [sso.md](../integrations/azure/sso.md)
- 연결 설정(홈·고객 서비스 주체·Lighthouse): [connect-tenant.md](../integrations/azure/connect-tenant.md)
- 권한 표: [permissions.md](../integrations/azure/permissions.md) · 확인: [verify.md](../integrations/azure/verify.md)
