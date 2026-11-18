---
status: current
owner: platform-observability
last-verified: 2026-11-18
covers: [apps/api/src/services/grafanaAlertPull.ts, apps/api/src/services/notifyChannels.ts, apps/api/src/services/notifyCheck.ts, deploy/helm/aud-dashboard/templates/deployment.yaml, apps/web/src/app/notifications/Channels.tsx, apps/api/src/services/alertPayloads.ts, apps/api/src/services/notifyStore.ts, apps/api/src/services/notifyRelay.ts, apps/api/src/routes/notify.ts, apps/web/src/lib/notifyView.ts, apps/web/src/app/notifications/page.tsx, apps/web/src/components/NotificationBell.tsx]
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
| `flow` | **flowLabs BOT 웹훅** — 사내에 직접 구축한 중계 서버(Flow 공식 제품 아님), 템플릿형 수신기 `{{json.path}}` | Azure 일반 경고 스키마 경로(`data.essentials.*`·`data.alertContext.*`) **+** 완성된 `title`·`message` — 기존 Azure 템플릿과 `{{title}}`/`{{message}}` 템플릿이 둘 다 그대로 동작 |
| `flowWebhook` | **Flow 공식 수신 웹훅**(OPEN API 센터 › 웹훅 관리, 베타) — flowLabs 없이 Flow 서버로 직접 | `{title, text}` — Flow는 `text`만 **봇 이름으로** 방에 올림(제목이 첫 줄). 토큰은 `tokenEnv`(`AUD_NOTIFY_AUTH_*`) → 헤더 `x-flow-webhook-token` |
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

**확인**: 알림 센터 › 연동 설정 › '보내는 곳' — 채널마다 세 단계:
1. **보낼 내용 미리 보기**(Grafana·Azure 시험 알림으로) — 받는 쪽 템플릿이 읽을 경로가 있는지
2. **연결 확인**(2026-11-18) — 이름 → TCP → TLS 핸드셰이크까지만 하고 끊음. **HTTP 요청을 보내지 않으므로 방에 아무것도 가지 않음**(`services/notifyCheck.ts`, 테스트가 받는 쪽에 요청 줄·경로·토큰이 한 바이트도 안 가는지 실제 소켓으로 확인). 결과: 연결됨 + 인증서 발급자·남은 날(14일 미만이면 경고) · 사설 주소 여부 · 실패 원인 `dns`(이름 없음) · `refused`(거부) · `timeout`(응답 없음 — 방화벽·NSG·정책 또는 **받는 쪽 출발지 IP 허용 목록**) · `noRoute` · `tls`(인증서 거부 + 코드, 예: `CERT_HAS_EXPIRED`). API가 프록시로 나가면(`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`, `NO_PROXY` 밖) 직접 확인은 다른 길이라 '시험 전송으로 확인'
3. **시험 전송** — 실제로 방에 글이 올라감(응답 코드·시간·시도 수, 연결 실패면 위 원인)

전송 결과(알림 상세 '보낸 곳')에도 실패 원인이 남습니다(`deliveries[].cause`). 주소 변수가 없는 채널은 **API 시작 로그**에 `[notify] channel "<키>" has no usable URL — set <변수>`가 찍히고 화면은 '주소 없음 — <변수>'.

#### 쿠버네티스(Helm) — 채널과 주소 넣기

주소는 비밀이라 값 파일에 쓰지 않습니다. 차트 `notify`(2026-11-18):

```yaml
notify:
  channels:                     # → AUD_NOTIFY_CHANNELS (위 JSON과 같은 항목)
    - { key: flow-test, name: "Flow 시험방", format: flow, urlEnv: AUD_NOTIFY_URL_FLOW_TEST, minSeverity: sev4, prefix: "[STG-TEST] ", lang: ko }
  urlSecret: aud-notify-urls    # 키 = 각 채널의 urlEnv(·authHeaderEnv) 이름
```
```bash
kubectl -n aud-dashboard create secret generic aud-notify-urls   --from-literal=AUD_NOTIFY_URL_FLOW_TEST='<Flow BOT 웹훅 주소>'      # GitOps면 External Secrets·Key Vault CSI로 같은 이름·키
```
- 차트는 채널마다 `secretKeyRef`(optional)로 넣음 — 키가 없어도 파드는 뜨고, 시작 로그·화면이 알려 줌(대시보드 전체를 멈추지 않음)
- `urlEnv`는 `AUD_NOTIFY_URL_*`, `authHeaderEnv`는 `AUD_NOTIFY_AUTH_*`만 — 다른 이름이면 렌더 실패(Secret에서 `AZURE_CLIENT_ID` 같은 다른 설정을 덮어쓰지 못하게)
- 예전처럼 `api.extraEnv`에 `AUD_NOTIFY_CHANNELS`를 넣었다면 `notify.channels`로 옮기기(둘 다 두면 뒤의 `extraEnv`가 이김)

#### flowLabs 대신 Flow 공식 웹훅으로 (`flowWebhook`, 2026-11-18)

flowLabs는 Flow가 공식 지원하지 않아 사내에 직접 구축한 중계 서버입니다(공개 주소·주소 안 토큰뿐인 인증·Flow 업그레이드 때 깨질 위험). 대시보드는 이미 메시지를 완성해 보내므로, Flow 서버에 **공식 수신 웹훅**이 있으면 중계 서버 없이 바로 보낼 수 있습니다.

- 근거: Flow OPEN API 문서(https://api.flow.team/docs/webhook — 클라우드판 기준, **베타**: 사양 변경 가능, 엔드포인트는 만든 뒤 수정 불가, 연동 코드 복사는 고객센터 문의). 주소 `https://<Flow 서버>/webhook/{hookId}/{service}`(알 수 없는 서비스 = `default`), 토큰은 헤더 `x-flow-webhook-token`, 본문에 `text`가 있으면 그 값만 올림
- **온프렘(서버설치형)에도 있는지는 공개 자료로 확인되지 않음** — 사내 Flow 서버는 `/webhook…` 경로에만 다르게 답함(2026-11-18 GET 확인: 그 경로 200, 같은 모양의 다른 경로는 오류 페이지)이라 정황은 있음. Flow 관리자 화면에 'OPEN API · 봇 관리 · 웹훅 관리'가 있는지가 결정
- 절차: ① Flow 관리자 › OPEN API › **봇 관리** — 봇 만들기(방에 글을 쓰는 이름) ② **웹훅 관리** — 이름·봇·Action **채팅**·Target = 시험방 **연동 코드**(ID 아님) → 'Copy URL', 토큰 ③ Secret 키 둘: `AUD_NOTIFY_URL_FLOW_TEST`(주소)·`AUD_NOTIFY_AUTH_FLOW_TEST`(토큰) ④ 채널 `{"key":"flow-test","name":"Flow 시험방","format":"flowWebhook","urlEnv":"AUD_NOTIFY_URL_FLOW_TEST","tokenEnv":"AUD_NOTIFY_AUTH_FLOW_TEST","minSeverity":"sev4","prefix":"[STG-TEST] "}` ⑤ 연결 확인 → 시험 전송 → 방에 봇 이름으로 글
- 확인 화면: 토큰 변수가 비면 '토큰 없음 — <변수>' 배지·시작 로그 경고(헤더 없이 보냄 — Flow 토큰은 선택이라 받을 수도, 거절할 수도)
- 같은 Flow 서버로 보내는 Azure 액션 그룹(flowLabs 직결)은 이 채널과 별개 — 대시보드 수신(§3.1)으로 옮기면 한 경로가 됨

#### Flow 방(모바일·PC)까지 — 끝까지 닿는 조건

전달은 한 줄로 이어진 사슬입니다. 어느 한 칸이 비면 방에 아무것도 오지 않고, 대부분 **조용히** 비어 있습니다. 칸마다 객관적으로 확인하는 방법이 있습니다.

| # | 칸 | 필요한 것 | 누가 | 확인(통과 기준) |
|---|---|---|---|---|
| 1 | 알림이 대시보드에 들어옴 | 사설 클러스터: Grafana 가져오기(§3.5) — `AUD_NOTIFY_PULL_*` + 연결 신원에 **Grafana Viewer** / 공개 주소: 웹훅 수신 | 플랫폼 관리자 · 고객(역할) | 연동 설정 '상태' = 정상·마지막 읽은 시각 1분 안 · 받은 알림에 그 Grafana 알림(`gf:` ID) |
| 2 | 채널 규칙이 그 알림을 원함 | `minSeverity`·`categories`·`teams`·`statuses` | 플랫폼 관리자 | 알림 상세 '보낸 곳'에 채널 키가 있음(없으면 규칙이 거른 것) |
| 3 | 주소가 파드에 있음 | `AUD_NOTIFY_URL_*` — Helm `notify.urlSecret`의 키 | 플랫폼 관리자 | '주소 없음' 배지 없음 · 시작 로그에 `[notify] … no usable URL` 없음 |
| 4 | API 파드 → 웹훅 호스트 길 | 송신(NAT·방화벽 FQDN/IP 규칙) · CNP 강제면 `networkPolicy.extraFqdns`에 호스트 · 받는 쪽이 출발지 IP를 제한하면 **송신 공용 IP**(NAT 게이트웨이) 허용 · Flow 서버가 **사내망(사설 주소)** 이면 클러스터 → 사내망 경로(VPN·ExpressRoute)와 사내 이름 DNS 전달, 온프렘 Docker는 같은 망이면 그대로·프록시면 `NO_PROXY` | 고객 네트워크 | **연결 확인 = 연결됨** |
| 5 | 인증서 | 공인 인증서(예: Let's Encrypt — 90일마다 받는 쪽이 갱신) 또는 사내 CA = API에 `NODE_EXTRA_CA_CERTS` · 사내 http만 있으면 채널 `allowHttp: true` | Flow 운영 · 플랫폼 관리자 | 연결 확인의 인증서 줄(남은 날) |
| 6 | 받는 쪽이 받아 그림 | `flow`(flowLabs): **방마다 BOT 웹훅 하나**(웹훅 1개 = 템플릿 1개), 템플릿 `{{title}}`/`{{message}}`(또는 기존 Azure 템플릿) / `flowWebhook`(Flow 공식): 봇 + 웹훅 엔드포인트(Action 채팅, Target = 방의 **연동 코드**), 토큰 | Flow 방 관리자 · Flow 관리자 | **시험 전송 = 응답 2xx** + 방에 `[STG-TEST] …` 글(공식 웹훅이면 봇 이름) |
| 7 | 방 → 구성원의 모바일·PC | 시험방 구성원 · 방 알림 켜짐(BOT 글 포함)·방해 금지 아님 · 모바일 앱 알림 권한 · Flow 서버의 푸시 발송(Flow 운영 쪽) | Flow 운영 · 구성원 | 구성원 휴대폰·PC에 도착 — **대시보드가 알 수 없는 칸**(사람이 확인) |
| 8 | 실제 알림으로 끝까지 | 1~7 | — | Grafana 규칙이 울릴 때(E2E: 시험 파드 로그 주입) 같은 알림이 Google Chat·Flow 둘 다, 해소도 · '보낸 곳' 정상 |

**stg 시험 배포 현황**(2026-11-18 확인 — 읽기만): 1 Grafana Viewer 할당·가져오기 설정 있음 · 2 채널 'Flow 시험방'(sev4 이상 전부) · **3 비어 있음**(채널 정의만 있고 `AUD_NOTIFY_URL_FLOW_TEST`도 Secret도 없음 → 들어온 알림은 기록만, 전송 `notConfigured`) · 4 송신 = NAT 게이트웨이, CNP 관찰 모드, 받는 쪽은 공개 주소 · 5 공인 인증서(Let's Encrypt, 2027-01까지) · 6·7 시험방 BOT 웹훅을 만들어야 함. 남은 순서: 시험방 BOT 웹훅 → Secret → 값 파일 `notify.*` → 배포 → 연결 확인 → 시험 전송 → 실제 알림.

### 3.4 네트워크
- Azure 액션 그룹·Azure Managed Grafana는 **공용 인터넷**에서 보냄 → 공개 주소(Front Door·AGC)에 `/hooks/alerts/*` 경로만 열기. 가능하면 WAF·방화벽에서 출발지를 서비스 태그 `ActionGroup`·Grafana 송신 IP로 제한
- 클러스터 시험 배포(포트 포워딩)처럼 공개 주소가 없으면 외부 알림은 못 받음 — 화면 '시험 알림' 버튼으로 확인. **사설 클러스터는 3.5 'Grafana에서 가져오기'**

### 3.5 Grafana에서 가져오기 — 사설 클러스터 (웹훅 없이)

> **5살 비유**: 우체부(Grafana)가 우리 집(사설 클러스터) 골목에 못 들어와요. 그래서 우리가 우체국에 가서 "나한테 온 편지 있어요?" 하고 1분마다 물어봐요. 우체부는 원래 하던 대로 구글챗 집에도 똑같이 편지를 배달해요.

**왜**: Azure Managed Grafana의 연락처 웹훅은 **공용 인터넷**에서 나갑니다(관리형 PE는 데이터 소스 전용). 사설 AKS 안의 `/hooks/alerts/grafana`에는 닿지 않고, 공개 주소를 여는 것은 고객 인프라 변경입니다. 대시보드가 **밖으로 나가서** Grafana의 활성 알림을 읽으면 공개 주소도, Grafana 연락처 변경도 필요 없습니다.

**동작**(`services/grafanaAlertPull.ts`):
- `GET <grafana>/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false` — 무음·억제된 알림 제외(Grafana도 Google Chat에 안 보냄)
- **연락처 필터** `AUD_NOTIFY_PULL_RECEIVERS` — 그 연락처로 가는 알림만(예: stg Google Chat 긴급·정보 연락처 = Google Chat이 받는 것과 같은 알림). 비우면 전체
- 새로 활성 = 발생, 목록에서 빠짐 = 해소(그 시각). **읽기 실패 때는 아무것도 해소하지 않음**
- 웹훅과 같은 해석기·같은 ID(`gf:` + fingerprint) → 받은 알림 한 항목, 보내는 곳(Flow 등)으로는 **새 발생·해소만** 채널마다 한 번
- 시작 직후 첫 읽기: 시작 전부터 울리던 알림은 **기록만**(Google Chat은 이미 받았음 — 재시작마다 Flow로 다시 보내지 않음), 시작 뒤 울린 것은 보냄
- 인증: `*.grafana.azure.com` = **Grafana가 있는 테넌트의 Azure 연결**(`AUD_NOTIFY_PULL_CONNECTION`, 기본 홈) 신원의 Entra 토큰(대상 Azure Managed Grafana 앱, 연결의 테넌트 검사 그대로) — Grafana 리소스에 **Grafana Viewer** 역할, 비밀 없음. delegated 연결은 불가(백그라운드엔 로그인 사용자가 없음, 시작 실패). 다른 신원으로 폴백하지 않음 / 그 밖 Grafana = Viewer 서비스 계정 토큰 `AUD_NOTIFY_PULL_GRAFANA_TOKEN`(비밀)
- 10초 제한·리디렉션 안 따라감·응답 본문은 저장·출력 안 함. 상태(정상·실패 이유·지금 활성 수·마지막 읽은 시각)는 연동 설정 '상태'

```bash
AUD_NOTIFY_PULL_GRAFANA_URL=https://<grafana-name>.<region>.grafana.azure.com
AUD_NOTIFY_PULL_RECEIVERS=<긴급 연락처>,<정보 연락처>
AUD_NOTIFY_PULL_INTERVAL_SEC=60          # 15–600
AUD_NOTIFY_PULL_CONNECTION=<연결 키>      # Grafana가 있는 테넌트의 연결 (기본 홈)
az role assignment create --assignee <그 연결의 client id> --role "Grafana Viewer" --scope <grafana-resource-id>
# 쿠버네티스 송신: 차트 networkPolicy.extraFqdns 에 Grafana 호스트, 그리고 보내는 곳(Flow) 호스트
```

#### 시험: 같은 알림을 Google Chat과 Flow에 동시에

| 단계 | 하는 일 | 바뀌는 것 |
|---|---|---|
| 1 | Flow에 시험용 BOT 웹훅(템플릿 `{{title}}`/`{{message}}`) | Flow — 새 웹훅 하나 |
| 2 | 고객 테넌트 연결의 신원에 Grafana Viewer 역할 | Azure RBAC 읽기 역할 하나 |
| 3 | API 환경: `AUD_NOTIFY_PULL_*` + `AUD_NOTIFY_CHANNELS`(형식 `flow`, 머리말 `[STG-TEST] `) + `AUD_NOTIFY_URL_*`(Secret) | 대시보드만 |
| 4 | 연동 설정 › 보내는 곳 '시험 전송' → Flow 도착 확인 | — |
| 5 | Grafana 규칙이 울릴 때(또는 기존 E2E 방법 — 시험 파드로 로그 주입) Google Chat·Flow 둘 다 도착 확인, 해소도 | — |
| 되돌리기 | `AUD_NOTIFY_PULL_GRAFANA_URL` 지우기 | Google Chat 경로는 처음부터 그대로 |

**Grafana 연락처에 웹훅을 하나 더 붙이는 방법**(같은 연락처에 googlechat + webhook)도 '동시'가 되지만 ① 공개 주소가 필요하고 ② Terraform으로 관리되는 연락처를 바꾸며(웹훅 변수 누락 = 연락처 삭제 위험 — 고객 문서의 주의) ③ 그 연락처를 쓰는 모든 규칙이 바뀝니다. 공개 주소가 있는 환경에서, 시험이 끝난 뒤의 운영 방식으로 검토합니다.

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
