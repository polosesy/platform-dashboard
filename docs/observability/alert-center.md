---
status: current
owner: platform-observability
last-verified: 2026-11-02
covers: [apps/api/src/services/notifyChannels.ts, apps/web/src/app/notifications/Channels.tsx, apps/api/src/services/alertPayloads.ts, apps/api/src/services/notifyStore.ts, apps/api/src/services/notifyRelay.ts, apps/api/src/routes/notify.ts, apps/web/src/lib/notifyView.ts, apps/web/src/app/notifications/page.tsx, apps/web/src/components/NotificationBell.tsx]
---
# 알림 센터 — Azure Monitor · Grafana 알림을 대시보드가 직접 받기

> **5살 비유**: 우리 반 우체통이에요. 바깥 우체국(슬랙·팀즈·구글챗)을 못 쓰니까, 학교 안에 우체통(대시보드)을 하나 두고 Azure 우체부와 Grafana 우체부가 **같은 우체통**에 편지를 넣어요. 편지 모양이 달라도 우체통이 알아서 읽고, '불났어요(장애)·도둑(보안)·체온(모니터링)·공사(변경)' 칸에 나눠 꽂아 둬요. 선생님(운영자)은 읽었다고 도장(확인)을 찍어요.

## 1. 왜 이렇게 만들었나

| 문제 | 결정 |
|---|---|
| 사내에서 메신저 웹훅(Slack·Teams·Google Chat)을 쓸 수 없음 — 라이선스·중앙 통제(보안 거버넌스) | **대시보드가 수신·보관·표시**한다. 볼 수 있는 사람 = SSO 로그인 + 플랫폼 역할 + Azure 연결 접근(구독이 붙은 알림), 확인 = 운영자. 밖으로 보내는 것은 **관리자가 정한 사내 주소 하나만**(선택) |
| Azure 공용 알림 스키마와 Grafana 웹훅 JSON 모양이 다름 — 한 형식만 읽는 수신기는 다른 형식을 **빈칸**으로 보여 줌 | 수신기 하나가 모양으로 판별: `data.essentials` = Azure, `alerts[]` = Grafana(`orgId`·`values`) / Alertmanager |
| Azure Portal 알림 링크는 알림 읽기 RBAC가 없으면 401 | 알림마다 **대시보드 화면 링크**(리소스 상태·AKS 모니터링·위협 탐지·정책 시뮬레이션) + Grafana 딥링크 + Portal |
| 등급·분류가 소스마다 다름 | **sev1~4**(Grafana 알림 표준과 같음) + 분류 4개(장애·보안·모니터링·변경), 분류 근거를 같이 보여 줌 |

## 2. 흐름

```
Azure Monitor 알림 규칙 ─ 액션 그룹(웹훅, 일반 경고 스키마) ─┐
Grafana Alerting 규칙 ── 연락처(Webhook, Bearer) ─────────────┼─→ POST /hooks/alerts/{azure|grafana|auto}
Alertmanager ─────────── webhook_configs ───────────────────────┘        (토큰 확인 · 형식 판별 · 정규화)
                                                                              ↓
                                       알림 저장소(alerts.json) — 같은 알림은 한 항목, 재발·해소 기록
                                                                              ↓
              알림 센터(/notifications) · 상단 종(미확인 수) · 데스크톱 알림(SEV1·2) · [선택] 사내 전달 주소
```

## 3. 설정 (관리자)

| 환경 변수 | 뜻 |
|---|---|
| `AUD_ALERT_RECEIVER_TOKEN` | 수신 토큰(32자 이상). 없으면 수신 주소는 404. Azure는 URL `?token=`, Grafana는 `Authorization: Bearer` |
| `AUD_NOTIFY_DIR` | 저장 폴더(없으면 `<AUD_ARRANGEMENT_DIR>/notifications`, 둘 다 없으면 메모리 — 재시작하면 사라짐) |
| `AUD_NOTIFY_RETENTION_DAYS` | 해소된 알림 보관 일수(기본 30). 진행 중인 알림은 항상 보관, 최대 3,000개 |
| `AUD_NOTIFY_CHANNELS` · `AUD_NOTIFY_URL_*` | **보내는 곳(채팅 채널)** — §3.3. 채널 정의(JSON, 비밀 없음)와 채널마다 웹훅 주소 변수(비밀) |
| `AUD_NOTIFY_RELAY_URL` · `AUD_NOTIFY_RELAY_MIN_SEVERITY` | (옛 설정, 계속 읽음) 형식 `json` 채널 하나(`relay`)로 바뀜 |

토큰은 비밀 값입니다 — Key Vault·Kubernetes Secret·`api.env`(gitignore)에만, 화면·로그·응답에 나오지 않습니다(화면은 끝 4자리만).

### 3.1 Azure Monitor
1. Monitor → 경고 → 액션 그룹 → 작업 추가 → **웹후크**, URI = `https://<대시보드>/hooks/alerts/azure?token=<토큰>`, **일반 경고 스키마 사용 = 예**
2. 알림 규칙(메트릭·로그 검색·관리형 Prometheus 규칙 그룹·활동 로그·Service Health·Resource Health)의 액션에 이 액션 그룹을 연결
3. 액션 그룹 **테스트**를 보내면 알림 센터에 바로 나타남

```hcl
webhook_receiver {
  name                    = "aud-dashboard"
  service_uri             = var.aud_receiver_url   # ?token= 포함 — 민감 변수
  use_common_alert_schema = true
}
```

### 3.2 Grafana Alerting
1. Alerting → Contact points → **Webhook**, URL = `https://<대시보드>/hooks/alerts/grafana`, POST
2. Authorization 헤더: 방식 `Bearer`, 자격 증명 = 토큰
3. 규칙은 기존 표준 그대로 읽힘 — `labels.severity = sev1~4`, `annotations.summary`(무엇)·`description`(조치)·`dashboard`(딥링크). 분류를 정하고 싶으면 `labels.category = incident|security|monitoring|change`

```hcl
resource "grafana_contact_point" "aud_dashboard" {
  name = "aud-dashboard"
  webhook {
    url                       = "https://<dashboard>/hooks/alerts/grafana"
    http_method               = "POST"
    authorization_scheme      = "Bearer"
    authorization_credentials = var.aud_alert_receiver_token   # sensitive
  }
}
```

### 3.3 보내는 곳 — Flow(마드라스체크)·Slack·Google Chat·Teams (대시보드 = 중계 서버)

받은 알림(Azure 일반 경고 스키마·Grafana·Alertmanager)을 **채팅 도구가 읽는 모양으로 바꿔** 보냅니다. 받는 형식과 보내는 형식이 따로라, Grafana 알림을 Azure 형식으로 보내는 것도 됩니다(예전 Flow 템플릿이 빈칸이던 문제를 어댑터 없이 해결).

| 형식 `format` | 받는 곳 | 보내는 모양 |
|---|---|---|
| `flow` | **Flow(마드라스체크) BOT 웹훅**(flowLabs, 템플릿형 수신기 `{{json.path}}`) | Azure 일반 경고 스키마 경로(`data.essentials.*`·`data.alertContext.*`) **+** 완성된 `title`·`message` — 기존 Azure 템플릿과 `{{title}}`/`{{message}}` 템플릿이 둘 다 그대로 동작 |
| `azureCommon` | 액션 그룹용으로 만든 수신기 | Azure 일반 경고 스키마 |
| `grafana` | Grafana 연락처용으로 만든 수신기 | Grafana 웹훅 모양(`alerts[]`·`title`·`message`) |
| `slack` | Slack incoming webhook | `text` + Block Kit(머리·본문·링크 버튼) |
| `googleChat` | Google Chat incoming webhook | `text`(굵게·`<url|이름>` 링크) |
| `teams` | Teams **Workflows** 웹훅(옛 Office 365 커넥터 아님) | Adaptive Card 1.4 메시지 |
| `json` | 그 밖 사내 수신기 | `{title, message, status, severity, category, target, links}` |

메시지(모든 형식 공통): `[STG] 🟠 [SEV2·중대][발생] 알림 이름 — ns/pod` · 📋 요약 · 💡 조치 · 대상·발생(UTC · KST)·분류·팀 · 🔗 대시보드·Grafana·런북 링크(대시보드 링크는 공개 주소가 https일 때만).

```bash
# API 환경 (api.env · Helm api.extraEnv — 주소는 Secret/Key Vault에서)
AUD_NOTIFY_CHANNELS='[
  {"key":"flow-ops","name":"Flow ops room","format":"flow","urlEnv":"AUD_NOTIFY_URL_FLOW_OPS",
   "minSeverity":"sev3","categories":["incident","security","monitoring"],"prefix":"[STG] ","lang":"ko"},
  {"key":"slack-sec","name":"Slack #security","format":"slack","urlEnv":"AUD_NOTIFY_URL_SLACK_SEC",
   "minSeverity":"sev2","categories":["security"],"statuses":["firing"]}
]'
AUD_NOTIFY_URL_FLOW_OPS=<Flow BOT 웹훅 주소 — 비밀>
AUD_NOTIFY_URL_SLACK_SEC=<Slack 웹훅 주소 — 비밀>
```

| 채널 항목 | 뜻 (기본값) |
|---|---|
| `key` · `name` · `format` | 식별자(소문자) · 화면 이름 · 위 표 |
| `urlEnv` | 웹훅 주소를 담은 변수 이름 — `AUD_NOTIFY_URL_` 로 시작해야 함(다른 비밀 변수를 읽지 못하게) |
| `authHeaderEnv` | (선택) `Authorization` 헤더 값을 담은 변수 — `AUD_NOTIFY_AUTH_` 로 시작 |
| `minSeverity` · `categories` · `teams` · `statuses` | 이 등급 이상(sev3) · 분류만(전체) · 팀만(전체, `"none"` = 팀 없음) · 발생·해소(둘 다) |
| `prefix` · `lang` | 제목 앞 글자(공유 방에서 환경 구분, 없음) · 문장 언어(ko) |
| `allowHttp` · `enabled` | 사내 http 서버 허용(false — 기본 https만) · 끄기(true) |

**규칙**: 새 알림과 발생 ↔ 해소 변화만 채널마다 한 번(같은 알림 반복은 안 보냄). 5초·5xx/429/네트워크 오류 1번 재시도·**리디렉션 따라가지 않음**. 결과는 알림 상세 '보낸 곳'에 채널별로 남음. 정의가 틀리면 API가 시작하지 않음(조용히 알림을 버리지 않게). 화면에는 주소의 **호스트만** — 경로의 토큰은 나가지 않음.

**확인**: 알림 센터 › 연동 설정 › '보내는 곳' — 채널마다 **보낼 내용 미리 보기**(Grafana·Azure 시험 알림으로)와 **시험 전송**(응답 코드·시간·시도 수). 실패 문구: 응답 n = 받는 쪽 거부(주소·템플릿) · 5초 안에 응답 없음 · 연결 안 됨(주소·방화벽·사내 인증서 — `NODE_EXTRA_CA_CERTS`).

**Flow(온프렘)**: Flow 관리 화면에서 BOT 웹훅을 만들고 템플릿을 `{{title}}`/`{{message}}`로 두거나 기존 Azure 템플릿(`{{data.essentials.alertRule}}` …)을 그대로 씁니다. 대시보드(API 파드)에서 Flow 서버 주소로 나가는 길이 있어야 합니다 — 쿠버네티스는 차트 `networkPolicy.extraFqdns`에 Flow 호스트(443), 온프렘 Docker는 같은 사내망이면 그대로·프록시를 쓰면 `NO_PROXY`.

### 3.4 네트워크
- Azure 액션 그룹·Azure Managed Grafana는 **공용 인터넷**에서 보냄 → 공개 주소(Front Door·AGC)에 `/hooks/alerts/*` 경로만 열기. 가능하면 WAF·방화벽에서 출발지를 서비스 태그 `ActionGroup`·Grafana 송신 IP로 제한
- 클러스터 시험 배포(포트 포워딩)처럼 공개 주소가 없으면 외부 알림은 못 받음 — 화면 '시험 알림' 버튼으로 확인

## 4. 받은 알림 화면 (알림 센터 › 받은 알림)

- 위 숫자: 진행 중(미확인 n) · 긴급(SEV1·2) · 분류별 진행 중
- 필터: 분류 · 상태(진행 중 기본) · 심각도 · 팀(연결 파일 `owners`) · 미확인만 · 검색
- 줄: 등급 막대·배지 · 제목 · 대상(ns/pod, 워크로드, 노드, Azure 리소스) · 요약 · 분류·팀·출처 · ×받은 횟수 · 상태 · 확인자
- 펼치면: 요약·설명(조치)·측정값 · 링크(대시보드 화면 → / Grafana·런북·무음·Portal ↗) · 대상·규칙·보낸 곳·**분류(근거)**·발생→해소·받은 횟수·재발·사내 전달 결과 · 라벨 · 기록 · **확인**(메모, 운영자) / 확인 취소
- 같은 알림이 다시 오면 한 항목의 '받은 횟수'만 늘어남. 해소 뒤 다시 발생하면 **재발** +1, 확인이 지워짐(새로 봐야 함)
- 상단 종: 진행 중 미확인 수(빨강 = SEV1·2 포함), 60초마다(보이는 탭만). **데스크톱 알림**(이 브라우저에서 켜기) = 새 SEV1·2를 시스템 알림으로 — 대시보드가 열려 있을 때만

## 5. 기능별 매핑 (알림 센터 › 기능별 매핑)

| 분류 | 연결할 것 | 알림을 누르면 |
|---|---|---|
| 장애 | Service Health 알림 · Resource Health 활동 로그 알림 · (라벨 없는) SEV1 | 리소스 상태 · 라이브 다이어그램 |
| 보안 | 활동 로그 Security(= Defender for Cloud 경고) · Policy · Grafana Cilium 정책 드롭 · 이름/라벨이 보안 | 위협 탐지 · 보안 권고 · AKS 보안 점검 · Pod 트래픽 · 정책 시뮬레이션 |
| 모니터링 | Azure 메트릭·로그 검색·관리형 Prometheus · Grafana 규칙(로그·메트릭·트레이스) | AKS 모니터링 · 라이브 다이어그램 |
| 변경·유지보수 | 활동 로그 Administrative·Autoscale · 노드 예정 작업(maintenance·upgrade·scheduled) | AKS 모니터링 · 리소스 상태 |

**분류 규칙**(먼저 맞는 것): 라벨 `category`(또는 `aud_category`) → Azure 보낸 서비스(`monitoringService`) → 알림 이름의 보안·유지보수 단어 → SEV1 = 장애 → 모니터링.
**심각도**: Azure Sev0→SEV1, Sev1→SEV2, Sev2→SEV3, Sev3·4→SEV4. 라벨 `severity`(Prometheus 규칙 그룹·Grafana)가 있으면 그것이 우선 — sev1~4 그대로, critical→SEV1, error→SEV2, warning→SEV3, info→SEV4.

## 6. 보안

- 토큰 비교는 상수 시간, 없거나 틀리면 401(이유 없음), 분당 600건 넘으면 429, 본문 1MB
- 받은 값은 믿지 않음: 문자열 길이 제한, 라벨은 허용 목록(alertname·severity·category·team·namespace·pod·node·cluster·service_name …), 링크는 http(s)만 + 사용자:암호 제거 + `token·code·sig·key·secret` 같은 쿼리 제거, Portal 링크는 portal.azure.com만
- 보는 사람: 로그인 사용자. 구독이 붙은 Azure 알림은 그 구독의 Azure 연결을 쓸 수 있는 역할만(관리자는 전부), 구독 없는 Grafana 알림은 로그인 사용자 모두. 응답의 구독 ID는 가시성 판단용
- 여러 API 복제본은 저장소를 공유하지 않음(파일·메모리) — 쿠버네티스에서 복제본이 둘 이상이면 같은 쓰기 볼륨이나 복제본 1개로. 공유 저장소(Azure Table 등)는 다음 단계

## 7. 문제 해결

[error-catalog §10](../troubleshooting/error-catalog.md#10-알림-센터) — NOTIFY-001~004.

## 8. 다음 단계

- 대시보드가 스스로 만드는 알림(통합 위험 감시 질문·관측 스택 저하·노드 유지 보수·긴급 취약점 KEV) — 현재는 각 화면에서만
- 사내 메일 릴레이(SMTP) 채널 — 거버넌스 승인 후
- 채널을 화면에서 추가·수정(지금은 관리자가 환경 변수로) · 같은 알림 묶어 보내기(그룹·대기 시간)
- Azure 액션 그룹 **보안 웹후크**(Entra 토큰) 검증 — 공유 토큰 대신
- 공유 저장소(여러 복제본)·알림 무음(규칙별 기간)
