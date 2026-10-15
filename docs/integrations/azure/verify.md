# 연결 확인

> **대상**: 플랫폼 관리자 · **소요 시간**: 2분 · **필요 권한**: 플랫폼 역할 `AUD.Admin`

## 8. 확인

### 화면 (권장)

**설정 › Azure 연결 › 점검** — 연결 자신의 자격 증명으로(사용자 권한이 아님) 다음을 읽기 전용으로 확인합니다.

| 단계 | 정상 | 실패 시 |
|---|---|---|
| 1. 토큰 발급 | `토큰 발급 성공` | `토큰 발급 실패: <코드>` → [troubleshooting.md](./troubleshooting.md) |
| 2. 보이는 구독 | `선언 n · 보임 n · 누락 0` | 누락 > 0: 역할 미부여·위임 미완료·구독 ID 오타 |
| 3. 기능별 권한 (구독마다) | 필요한 기능이 `가능` | `권한 없음` = 그 기능 화면이 비어 보임 / `리소스 범위 확인` = 리소스에 직접 부여하는 역할이라 구독에서는 판단 불가 |
| 4. 과도한 권한 | 경고 없음 | `모든 작업(*)`·`쓰기·삭제`·`역할 할당`·`클러스터 관리자 자격 증명` → 읽기 역할로 줄이기 |
| 5. 작업 영역 쿼리 (`logAnalyticsWorkspaces`) | `쿼리 가능` | Log Analytics Reader 누락, 작업 영역 ID 오타 |

결과는 `정상` / `확인 필요`(경고·권한 없음) / `실패`(도달 불가·누락)로 요약되고, 마지막 점검 시각이 목록에 남습니다(API 재시작 시 초기화).

API로: `GET /api/azure/connections/<key>/check` (관리자 토큰).

### 셸

연결의 신원으로 로그인한 뒤 [`scripts/verify-tenant.sh`](../../../scripts/verify-tenant.sh) — 출력은 개수·상태만(본문·키·토큰 없음).

```bash
az login --service-principal -u <APP_ID> --tenant <TENANT_ID> --certificate <PEM_PATH>   # 또는 -p (비밀 값: 셸 기록에 남지 않게 주의)
scripts/verify-tenant.sh <TENANT_ID> <SUBSCRIPTION_ID> [<WORKSPACE_GUID>]
```

### 데이터까지

- 연결된 구독을 고른 뒤 **인프라 구성도**가 실데이터(예시 데이터 배너 없음)로 그려지면 `inventory`가 동작합니다.
- **VNet 트래픽 › 수집 범위**에서 흐름 로그·Traffic Analytics 상태를 확인합니다 — [vnet-flow-logs.md](../../observability/vnet-flow-logs.md).

> **5살 비유**: 맡긴 열쇠로 창고 문을 실제로 열어 보고(토큰), 방이 몇 개 보이는지 세고(구독), 방마다 들어갈 수 있는지 확인해요(기능). 열쇠가 너무 많은 문을 열면 "열쇠가 너무 세요!"라고 알려 줘요.
