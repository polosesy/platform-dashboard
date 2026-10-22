---
status: current
owner: platform-auth
last-verified: 2026-10-15
covers: [apps/api/src/infra/tokenVerifier.ts, apps/api/src/infra/platformAccess.ts]
---
# 플랫폼 로그인 (SSO) — Entra ID + 앱 역할

> **대상**: 플랫폼 관리자 · **소요 시간**: 15분 · **필요 권한**: 홈 테넌트의 Application Administrator(앱 역할 정의) + 엔터프라이즈 앱 사용자 할당 권한

## 1. 개요

사용자는 Entra ID 계정으로 플랫폼에 로그인하고, **앱 역할**로 플랫폼 안에서 할 수 있는 일이 정해집니다. 로그인은 Azure 데이터 권한을 주지 않습니다 — Azure는 [연결](./connect-tenant.md)이 읽습니다.

| 역할 (앱 역할 값) | 화면 표시 | 할 수 있는 일 |
|---|---|---|
| `AUD.Viewer` | 조회자 | 모든 대시보드 조회, 라이브 다이어그램 생성(본인 소유) |
| `AUD.Operator` | 운영자 | 조회자 + **Pod 로그** 조회 |
| `AUD.Admin` | 관리자 | 운영자 + **Azure 연결 점검**, 역할 제한이 걸린 연결 포함 모든 연결 |
| (없음) | 역할 없음 | `403 no_platform_role` — `/api/me`만 응답 |

역할이 여러 개면 가장 높은 역할이 적용됩니다. 연결마다 쓸 수 있는 역할을 줄일 수 있습니다(연결 파일의 `roles`).

> **5살 비유**: 정문에서 이름표를 확인하고(로그인) 팔찌 색을 정해 줘요(역할). 초록 팔찌는 구경, 파랑 팔찌는 기구 조작, 금색 팔찌는 관리실 출입. 팔찌가 없으면 정문까지만 들어와요.

## 2. 동작 방식

- 웹(`aud-web`)이 MSAL로 로그인해 **`api://<aud-api>/Azure.Read.All`** 범위의 액세스 토큰을 받습니다.
- 사용자(또는 그룹)에 할당된 `aud-api`의 앱 역할이 토큰의 `roles` 클레임에 들어갑니다.
- API는 토큰을 검증한 뒤 `roles`만 보고 역할을 정합니다. 요청 헤더 등 다른 곳의 역할 정보는 무시합니다.
- 앱 역할을 아직 할당하지 않은 개발 환경을 위해 `AUD_DEFAULT_ROLE`이 있습니다(개발 기본 `viewer`, **프로덕션은 `none`만 허용** — 다른 값이면 API가 시작하지 않습니다).

## 3. 준비물

- 앱 등록 `aud-api`(API)와 `aud-web`(SPA)가 있고 로그인이 동작하는 상태 — [setup-guide](../../getting-started/setup-guide.md)
- 그룹으로 할당하려면 Entra ID P1 이상(중첩 그룹은 앱 역할 할당에 반영되지 않음)

## 4. 설정 — 자동 (az CLI)

`aud-api`에 앱 역할 3개를 정의합니다. 기존 앱 역할이 있으면 덮어쓰므로 먼저 확인하세요.

```bash
API_APP_ID=<AUD_API_APP_ID>
az ad app show --id $API_APP_ID --query appRoles      # 기존 역할 확인

cat > roles.json <<'JSON'
[
  { "allowedMemberTypes": ["User"], "displayName": "AUD Viewer",   "value": "AUD.Viewer",   "id": "<NEW_GUID_1>", "isEnabled": true, "description": "Read dashboards" },
  { "allowedMemberTypes": ["User"], "displayName": "AUD Operator", "value": "AUD.Operator", "id": "<NEW_GUID_2>", "isEnabled": true, "description": "Read dashboards and pod logs" },
  { "allowedMemberTypes": ["User"], "displayName": "AUD Admin",    "value": "AUD.Admin",    "id": "<NEW_GUID_3>", "isEnabled": true, "description": "Everything, including Azure connection checks" }
]
JSON
# <NEW_GUID_n>: uuidgen 등으로 새로 만든 값
az ad app update --id $API_APP_ID --app-roles @roles.json

# 사용자(또는 그룹)에게 역할 할당 — 엔터프라이즈 앱(서비스 주체) 기준
SP_ID=$(az ad sp show --id $API_APP_ID --query id -o tsv)
ROLE_ID=$(az ad app show --id $API_APP_ID --query "appRoles[?value=='AUD.Viewer'].id" -o tsv)
az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
  --body "{\"principalId\":\"<USER_OR_GROUP_OBJECT_ID>\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$ROLE_ID\"}"
```

## 5. 설정 — 수동 (Portal)

1. **Entra ID → 앱 등록 → aud-api → 앱 역할 → 앱 역할 만들기**를 세 번: 표시 이름 `AUD Viewer` / 값 `AUD.Viewer`, `AUD Operator` / `AUD.Operator`, `AUD Admin` / `AUD.Admin`. 허용되는 멤버 유형 = **사용자/그룹**.
2. **Entra ID → 엔터프라이즈 애플리케이션 → aud-api → 사용자 및 그룹 → 사용자/그룹 추가** → 사용자(또는 그룹)와 역할 선택.
3. (권장) **엔터프라이즈 애플리케이션 → aud-api → 속성 → 할당 필요 = 예**: 역할이 없는 사람은 토큰 자체를 받지 못합니다(로그인 후 API 호출 시 `AADSTS501051`).
4. 사용자는 **로그아웃 → 다시 로그인**해야 새 역할이 토큰에 들어갑니다.

## 6. 권한

로그인 자체에 Azure 권한은 필요 없습니다. Azure 권한은 [permissions.md](./permissions.md)(연결의 서비스 주체에 부여).

## 7. 수집하는 데이터

토큰에서 `tid`·`oid`·`name`·`roles`·`scp`만 읽습니다. 저장하지 않으며, 감사 로그에는 `oid` 마지막 4자리만 남깁니다(`AUD_AUDIT_LOG=stdout`).

## 8. 확인

- 상단 바 사용자 이름 옆의 **역할 배지**(조회자·운영자·관리자). `*`가 붙으면 앱 역할이 없어 `AUD_DEFAULT_ROLE`로 동작 중입니다.
- `GET /api/me` → `{ "role": "viewer", "connections": [...] }`

## 9. 문제 해결

| 증상 / 코드 | 원인 | 조치 |
|---|---|---|
| `403 no_platform_role` · "플랫폼 역할이 없습니다" | 앱 역할 미할당, 프로덕션(`AUD_DEFAULT_ROLE=none`) | 4·5절대로 역할 할당 후 다시 로그인 |
| `403 role_required` · "내 플랫폼 역할로는 사용할 수 없습니다" | 운영자·관리자 기능을 조회자가 호출 | 역할 상향 |
| `AADSTS501051` | 할당 필요 = 예인데 할당 없음 | 사용자·그룹 할당 |
| 역할 배지에 `*` | 앱 역할 없음, 개발 기본 역할 | 앱 역할 할당 (개발은 그대로 둬도 됨) |
| 그룹에 넣었는데 역할이 없음 | 중첩 그룹, 또는 Entra ID Free | 그룹을 직접 할당 / P1 |

## 10. 자격 증명 교체

해당 없음(사용자 로그인). API 자체의 자격 증명은 [lifecycle.md](./lifecycle.md).

## 11. 연동 해제

엔터프라이즈 앱에서 사용자·그룹 할당을 제거하면 다음 토큰부터 역할이 사라집니다(이미 발급된 토큰은 만료까지 유효, 보통 1시간 이내).

## 12. 보안·FAQ

- **왜 개인에게 Azure 역할을 주지 않나요?** 퇴사·부서 이동 때 권한이 남고, 넓은 권한이 여러 사람에게 퍼지기 때문입니다. 연결 하나에만 최소 읽기 권한을 주고, 누가 무엇을 봤는지는 플랫폼 감사 로그에 남깁니다.
- **역할을 헤더로 바꿔 보내면?** 무시됩니다. 서명 검증된 토큰의 `roles`만 씁니다.
- **다른 테넌트 사용자의 로그인(B2B 게스트)은?** 게스트로 초대된 사용자는 홈 테넌트에서 역할을 받으면 됩니다. 고객 테넌트 계정의 직접 로그인은 후속입니다.
