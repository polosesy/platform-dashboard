# Azure 연결 설정 — 홈 · 고객 서비스 주체 · Lighthouse

> **대상**: 플랫폼 관리자(A·연결 등록), 고객 테넌트 관리자(B·C) · **소요 시간**: 연결당 15–30분 · **필요 권한**: 고객 구독의 Owner 또는 User Access Administrator(역할 부여), 앱 등록 권한(B)

## 1. 개요

연결(connection) = **테넌트 + 자격 증명 + 구독 범위 + (선택) Log Analytics 작업 영역 + 쓸 수 있는 플랫폼 역할**. 플랫폼은 요청된 구독이 속한 연결의 자격 증명으로만 Azure를 읽습니다.

| | A. 홈 (`platform`) | B. 고객 서비스 주체 (`servicePrincipal`) | C. Lighthouse (`lighthouse`) |
|---|---|---|---|
| 자격 증명 | `aud-api`의 서비스 주체 | 고객 테넌트의 고객 앱 | 홈 자격 증명 재사용 |
| 새 비밀 값 | 없음(기존 `AZURE_AD_CLIENT_SECRET` 또는 인증서) | 연결당 1개(환경 변수) 또는 인증서 | **없음** |
| 고객이 하는 일 | — | 앱 등록 + 역할 부여 + 자격 증명 전달 | 위임 템플릿 배포 |
| 철회 | — | 앱 삭제 / 역할 제거 | 위임 삭제 |

> **5살 비유**: A는 우리 집 열쇠, B는 친구네가 만들어 맡긴 열쇠, C는 친구네가 "이 관리인 아저씨는 들어와도 돼요"라고 문에 이름을 붙여 준 것(열쇠가 새로 생기지 않아요). 어떤 경우든 **보기만 하는 열쇠**예요.

## 2. 동작 방식

- 연결 목록은 `AUD_CONNECTIONS_FILE`(JSON, 커밋 금지)에서 읽습니다. 없으면 홈 연결 하나(`AZURE_SUBSCRIPTION_IDS`)입니다.
- 파일에는 **ID·이름·참조만** 들어갑니다. `clientSecret` 같은 키나 PEM 내용이 있으면 API가 시작하지 않습니다.
- 요청의 구독(URL·Resource Graph 본문·리소스 ID) → 연결 → 그 연결의 자격 증명 → Azure. 여러 연결에 걸친 Resource Graph 조회는 자격 증명별로 나눠 보내고 합칩니다.
- 발급된 토큰의 테넌트가 연결의 테넌트와 다르면 `connection_tenant_mismatch`로 막습니다(설정 실수로 다른 테넌트를 읽지 않게).

## 3. 준비물

| 값 | 어디서 | 예 |
|---|---|---|
| 연결 키 | 직접 정함 (`a-z 0-9 -`, 2–32자) | `custa` |
| 고객 테넌트 ID | 고객 | `<CUSTOMER_TENANT_ID>` |
| 구독 ID 목록 | 고객 | `<CUSTOMER_SUBSCRIPTION_ID>` |
| (B) 고객 앱 클라이언트 ID | 고객 | `<CUSTOMER_APP_ID>` |
| (B) 비밀 값 또는 인증서 | 고객 → 안전한 채널(Key Vault 공유, 암호화 전달) | 문서·메일·채팅 금지 |
| (C) 플랫폼 서비스 주체 개체 ID | 플랫폼 관리자: `az ad sp show --id <AUD_API_APP_ID> --query id -o tsv` | `<PLATFORM_SP_OBJECT_ID>` |

## 4. 설정 — 자동

### A. 홈 연결 (`platform`)

1. `aud-api` 서비스 주체에 홈 구독의 읽기 역할을 줍니다([permissions.md](./permissions.md)).

   ```bash
   SP=$(az ad sp show --id <AUD_API_APP_ID> --query id -o tsv)
   for ROLE in Reader "Monitoring Reader" "Log Analytics Reader" "Security Reader" "Cost Management Reader"; do
     az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
       --role "$ROLE" --scope /subscriptions/<HOME_SUBSCRIPTION_ID>
   done
   ```

2. 자격 증명: 인증서를 권장합니다 — `AUD_PLATFORM_CERT_PATH=/절대/경로/aud-api.pem`(인증서+개인 키 PEM). 없으면 `AZURE_AD_CLIENT_SECRET`을 씁니다.
3. 연결 파일이 없으면 이것으로 끝입니다. 사용자별 OBO로 되돌리려면 `AUD_HOME_CONNECTION_MODE=delegated`.

### B. 고객 서비스 주체 (`servicePrincipal`) — 고객 테넌트 관리자가 실행

[`templates/service-principal/onboard.sh`](./templates/service-principal/onboard.sh) — 앱 등록, 서비스 주체, 읽기 역할 부여를 한 번에 하고 **플랫폼에 전달할 값의 이름만** 출력합니다.

```bash
az login --tenant <CUSTOMER_TENANT_ID>
bash onboard.sh <CUSTOMER_SUBSCRIPTION_ID> custa          # 구독, 연결 키
# → clientId 출력, 비밀 값은 화면에 한 번만 표시: 안전한 채널로 플랫폼 관리자에게 전달
```

역할만 Bicep으로 배포하려면 [`templates/service-principal/roles.bicep`](./templates/service-principal/roles.bicep) (구독 범위 배포).

플랫폼 관리자는 받은 비밀 값을 **환경 변수**에 넣습니다(파일·저장소 금지):

```bash
AUD_CONN_CUSTA_SECRET=<받은 비밀 값>      # 이름 규칙: AUD_CONN_<KEY 대문자>_SECRET
```

### C. Lighthouse (`lighthouse`) — 고객 테넌트 관리자가 배포

[`templates/lighthouse/aud-delegation.json`](./templates/lighthouse/aud-delegation.json) + 매개변수 예시. `principalId`는 **플랫폼 서비스 주체 개체 ID**입니다(사용자 그룹이 아님 — 사용자는 Azure 권한이 필요 없습니다).

```bash
az login --tenant <CUSTOMER_TENANT_ID>
az account set -s <CUSTOMER_SUBSCRIPTION_ID>
az deployment sub create --location koreacentral \
  --template-file aud-delegation.json --parameters @aud-delegation.parameters.json
```

> 홈 연결이 `delegated`이면 Lighthouse 연결도 사용자 OBO로 읽습니다. 그때는 `principalId`에 운영자 그룹을 넣습니다.

### 연결 등록 (플랫폼 관리자)

`config/connections.json`(커밋 금지, `.gitignore` 처리됨) — [`config/connections.example.json`](../../../config/connections.example.json):

```json
{
  "connections": [
    { "key": "home", "displayName": "EMRO", "tenantId": "<HOME_TENANT_ID>", "mode": "platform", "subscriptions": [] },
    { "key": "custa", "displayName": "Customer A", "tenantId": "<CUSTOMER_A_TENANT_ID>", "mode": "lighthouse",
      "subscriptions": ["<CUSTOMER_A_SUBSCRIPTION_ID>"] },
    { "key": "custb", "displayName": "Customer B", "tenantId": "<CUSTOMER_B_TENANT_ID>", "mode": "servicePrincipal",
      "subscriptions": ["<CUSTOMER_B_SUBSCRIPTION_ID>"], "clientId": "<CUSTOMER_B_APP_ID>", "secretEnv": "AUD_CONN_CUSTB_SECRET",
      "roles": ["operator", "admin"], "logAnalyticsWorkspaces": ["<CUSTOMER_B_WORKSPACE_GUID>"] }
  ]
}
```

| 필드 | 필수 | 뜻 |
|---|---|---|
| `key` · `displayName` · `tenantId` · `mode` | 예 | 홈은 정확히 하나(`tenantId` = `AZURE_AD_TENANT_ID`, `mode` = `platform` 또는 `delegated`) |
| `subscriptions` | 예 | 이 연결로 읽는 구독. 구독은 한 연결에만. 홈이 비어 있으면 `AZURE_SUBSCRIPTION_IDS` |
| `clientId` + (`secretEnv` 또는 `certificatePath`) | B만 | 비밀 값 **이름**(`AUD_CONN_<KEY>_SECRET`) 또는 인증서 **절대 경로** |
| `roles` | 아니요 | 이 연결을 쓸 수 있는 플랫폼 역할(기본 전부). 관리자는 항상 포함 |
| `logAnalyticsWorkspaces` | 아니요 | 이 연결로 쿼리할 작업 영역(customer ID). 목록에 없는 작업 영역은 홈 연결이 읽음 |

`.env`: `AUD_CONNECTIONS_FILE=config/connections.json` → API 재시작. 시작 로그에 `[auth] … Azure connections: home:platform, custa:lighthouse, custb:servicePrincipal`이 나옵니다. 예전 `AUD_TENANTS_FILE`(`tenants` + `access`)도 그대로 읽힙니다.

## 5. 설정 — 수동 (Portal)

**B (고객 테넌트)**

1. Entra ID → 앱 등록 → 새 등록: 이름 `aud-reader-<회사>`, 단일 테넌트.
2. 인증서 및 비밀 → 인증서 업로드(권장) 또는 새 클라이언트 비밀(만료 6–12개월).
3. 구독 → 액세스 제어(IAM) → 역할 할당 추가: [permissions.md](./permissions.md)의 역할을 이 앱에 부여.
4. 개요의 **애플리케이션(클라이언트) ID**, **디렉터리(테넌트) ID**와 비밀 값/인증서를 안전한 채널로 전달.

**C (고객 테넌트)**

1. 고객 테넌트로 로그인한 포털 → **사용자 지정 템플릿 배포** → **편집기에서 사용자 고유의 템플릿 빌드** → `aud-delegation.json` 붙여넣기 → 매개변수 입력 → 구독 선택 → 만들기.
2. 배포 후 고객 포털의 **서비스 공급자 → 위임**에 `AUD operations (read-only)`가 보이면 완료(플랫폼 쪽은 **내 고객**에 보임).

## 6. 권한

[permissions.md](./permissions.md).

## 7. 수집하는 데이터

[data-collected.md](./data-collected.md).

## 8. 확인

[verify.md](./verify.md) — 설정 › Azure 연결 › **점검**: 토큰 발급, 보이는 구독 수, 기능별 권한, 과도한 권한 경고, 작업 영역 쿼리.

## 9. 문제 해결

[troubleshooting.md](./troubleshooting.md).

## 10–11. 교체·해제

[lifecycle.md](./lifecycle.md).

## 12. 보안·FAQ

[security-faq.md](./security-faq.md).
