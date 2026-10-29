---
status: current
owner: platform-observability
last-verified: 2026-10-29
covers: [apps/api/src/services/networkQueries.ts, apps/api/src/services/flowLogCoverage.ts, apps/api/src/services/networkFlows.ts, apps/web/src/lib/vnetFlowMap.ts]
---
# VNet 트래픽 (Flow Log) — VNet 흐름 로그 + Traffic Analytics

> **대상**: 운영자, 플랫폼 관리자 · 화면: **네트워크 › VNet 트래픽 (Flow Log)** (`/network`)

## 1. 이 화면이 답하는 질문

| 질문 | 탭 |
|---|---|
| 어느 서브넷이 어디(다른 서브넷·인터넷·Azure 서비스·온프레미스·다른 사설 주소)와 오갔나, 거부·악성이 어디서 났나 | **트래픽 맵**(기본) — Pod 트래픽 서비스 맵과 같은 문법: 상자 = VNet, 카드 = 서브넷(● 허용만 · ■ 거부·악성), 왼쪽 = 들어오는 쪽, 오른쪽 = 나가는 쪽, 서브넷은 경로 단계 순으로 왼→오, 선 굵기 = 바이트, 빨간 점선 = 거부·악성. 카드를 누르면 받은/보낸/서브넷 안 바이트·허용·거부·연결별 포트 |
| 정해진 기간에 VNet에서 얼마나 오갔나, 언제 몰렸나 | **개요** — 합계·시간별 막대(바이트)+선(거부)·흐름 유형별 |
| 누가 누구와 가장 많이 통신했나 (서브넷·VM·IP), 어느 포트로 | **상위 통신** — 인터넷에서 허용된 관리 포트(22·3389·445·1433·3306·5432·5985·5986) 강조 |
| NSG(관리 규칙)가 무엇을 막았나 | **차단** — 규칙·방향·포트별 거부 흐름, 주요 출발지, 마지막 발생 |
| 인터넷의 누가 들어오고, 어디로 나갔나 — 악성 IP가 있었나 | **인터넷·위협** — 공용 IP별 기록, Traffic Analytics 위협 정보(악성 먼저) → 위협 탐지 화면 링크 |
| 애초에 수집되고 있나 | **수집 범위** — VNet마다 VNet 흐름 로그/일부/NSG만/없음/설정 못 읽음, Traffic Analytics·간격·작업 영역·보존·7일 수신 줄 수, 이 화면이 읽는 작업 영역과 그 출처 |

다른 화면과의 차이: **라이브 다이어그램**은 VNet 1개의 지금(1분 메트릭)을 그림으로, **인프라 구성도**는 구성을, **Pod 트래픽(Hubble)** 은 클러스터 안 Pod 흐름을 봅니다. 이 화면은 **기간을 정해 흐름 로그를 감사**합니다 — 트래픽 맵도 그 기간의 **관측 집계**이지 구성이 아닙니다(실시간 아님: Traffic Analytics 처리 간격만큼 늦음).

**트래픽 맵의 규칙**(`networkQueries.ts` `mapQuery`·`mapMap` → 웹 `lib/vnetFlowMap.ts`):
- 끝점 = 서브넷(`rg/vnet/subnet`, 구독 없음). Traffic Analytics가 서브넷을 적지 않은 쪽은 **흐름 유형으로만** 분류합니다 — ExternalPublic·MaliciousFlow = 인터넷, AzurePublic = Azure 서비스(어느 서비스인지는 기록에 없음), S2S·P2S·ExpressRoute = 온프레미스, UnknownPrivate·서브넷 없는 VNet 내부/간 = 다른 사설 주소(파드 오버레이·피어링·온프레미스 중 무엇인지 정하지 않음), Unknown = 분류 안 됨. 리소스를 추측해 붙이지 않습니다.
- 양쪽 모두 서브넷이 없는 흐름(stg: AKS 파드 오버레이끼리 — 24시간 약 92GB·기록 11,971건)은 그리지 않고 요약 줄에 '맵에 없는 흐름'으로 양을 밝힙니다(상위 통신 › IP 쌍으로 이동).
- 같은 서브넷 안 흐름은 선이 아니라 카드 값('안 n')입니다. 바이트 상위 150개 연결 + 거부·악성이 있는 연결은 모두.
- stg 실측(2026-10-29): VNet 1·서브넷 5·바깥 4종류·연결 15, 질의 0.2–0.5초(1시간·24시간·7일).

> **5살 비유**: 동네(VNet) 입구에 큰 공책(VNet 흐름 로그)을 두고, 우체국 아저씨(Traffic Analytics)가 10분이나 1시간마다 공책을 정리해 줘요. 이 화면은 그 정리된 공책이에요. 공책이 없으면 "아무도 안 왔어요"라고 지어내지 않고 "공책이 없어서 몰라요"라고 말해요.

## 2. 데이터 원천

- `NTANetAnalytics` (`AZURE_LOG_ANALYTICS_TABLE`, 기본) — VNet 흐름 로그의 Traffic Analytics 결과. 열: `TargetResourceId`(`구독/RG/VNet` — 그 줄을 기록한 흐름 로그의 대상)·`FlowType`·`FlowDirection`·`FlowStatus`·`SrcSubnet`/`DestSubnet`(VNet 흐름 로그는 `RG/VNet/서브넷` — **구독 없음**)·`SrcVm`(이름을 모르면 `unknown-rg/unknown-vm`)·`DestPort`·`L4Protocol`·`Allowed/DeniedIn/OutFlows`·`BytesSrcToDest`/`BytesDestToSrc`·`SrcPublicIps`/`DestPublicIps`·`NsgList`·`NsgRule`·`AclRule`·`Country` …
- `NTAIpDetails` — 공용 IP의 `ThreatType`·`ThreatDescription`·`Location`.
- Resource Graph — `microsoft.network/networkwatchers/flowlogs`(대상·활성·TA·간격·작업 영역·보존), VNet·서브넷·NSG, 작업 영역.
- 범위: 선택한 구독(필수)과 VNet(선택, `rg/vnet`) = **그 VNet의 흐름 로그가 기록한 줄**(`TargetResourceId`). 서브넷 열은 범위로 쓰지 않습니다 — VNet 흐름 로그 줄에는 구독이 없고(2026-10-29 stg 실측: 예전 `구독/…` 접두 필터 때문에 하루 23,420줄이 모두 0으로 보였음), 파드 오버레이 통신(FlowType `Unknown`, 약 절반)은 서브넷이 비어 있습니다. 서브넷 형식(구독 있음·없음)은 대상이 VNet·서브넷이 아닌 줄(NIC 흐름 로그)에만 씁니다.
- **작업 영역**: 흐름 로그마다 자기 Traffic Analytics 작업 영역이 있고, 한 구독의 VNet들이 서로 다른 작업 영역에 보내는 일이 흔합니다(예: 허브 작업 영역 ↔ 환경별 작업 영역). 그래서 설정 하나가 아니라 순서대로 모읍니다 — ① 읽을 수 있는 흐름 로그 설정의 TA 작업 영역(그 구독의 연결이 `logAnalyticsWorkspaces`에 적었거나, 홈 연결이고 다른 연결이 적지 않은 것) ② 연결 파일의 `logAnalyticsWorkspaces` ③ 홈 연결의 `AZURE_LOG_ANALYTICS_WORKSPACE_ID`. 각 작업 영역에 이 구독의 7일 기록이 있는지 한 번 확인하고(캐시), 기록이 있는 작업 영역들을 **한 번의 교차 작업 영역 조회**로 읽습니다. 모두 그 구독 연결의 신원으로만 — 다른 연결의 작업 영역은 '읽지 않는 작업 영역'으로 이름만 알려 줍니다.

**흐름 vs 기록**: "흐름"은 `*Flows` 카운터의 합, "기록"은 로그 행 수입니다. 인터넷 탭은 공용 IP 목록을 펼치므로(`mv-expand`) 바이트를 더하지 않고 기록만 셉니다.

## 3. NSG 흐름 로그 → VNet 흐름 로그

Azure는 **2025-06-30부터 새 NSG 흐름 로그 생성을 막고, 2027-09-30에 NSG 흐름 로그를 종료**합니다. NSG 흐름 로그의 Traffic Analytics 결과는 옛 테이블(`AzureNetworkAnalytics_CL`)에 쌓이며 이 화면은 집계하지 않습니다 — **수집 범위** 탭이 `NSG 흐름 로그만` VNet에 `이전 필요` 표시를 하고, 옛 테이블의 7일 행 수만 보여 줍니다.

켜는 명령(자리표시자, 화면에서도 복사만 가능):

```bash
az network watcher flow-log create --location <region> --resource-group <rg> --name <vnet>-flowlog \
  --vnet <vnet> --storage-account <storage> --traffic-analytics true --workspace <workspace> --interval 10
```

이전 도구: Microsoft의 NSG → VNet 흐름 로그 마이그레이션 스크립트(Network Watcher 문서). 같은 대상에 NSG·VNet 흐름 로그를 함께 켜면 중복 기록·비용이 생기므로 VNet 쪽이 확인되면 NSG 쪽을 끕니다.

## 4. 필요한 권한 (연결)

- 흐름 로그 설정: **Reader** — 흐름 로그 리소스는 보통 `NetworkWatcherRG`에 있어 리소스 그룹 몇 개만 읽는 연결에는 **보이지 않습니다**(Resource Graph는 오류 없이 빈 결과). 그때 수집 범위는 '없음'이 아니라 **'설정 못 읽음'**, 작업 영역에 그 VNet의 기록이 들어오고 있으면 그 기록으로 'VNet 흐름 로그 (기록으로 확인)'. 처리 간격·보존 기간은 설정이라 '못 읽음'. 판정: 흐름 로그가 보이거나, 그 리전의 Network Watcher가 보이거나, 구독 범위에 `Microsoft.Network/networkWatchers/flowLogs/read`가 있으면(`Microsoft.Authorization/permissions`) 설정을 읽은 것.
- 작업 영역: **Log Analytics Reader** + 연결 파일 `logAnalyticsWorkspaces`에 그 작업 영역 ID
- 자세히: [permissions.md](../integrations/azure/permissions.md)

## 5. 상태 (숫자를 지어내지 않음)

| 상태 | 뜻 | 화면 |
|---|---|---|
| `ok` | 기록 있음 | 표·그래프 |
| `empty` | 기간 안에 기록 없음 — TA 처리 간격(10/60분)만큼 늦을 수 있음, 또는 흐름 로그·TA 꺼짐 | 빈 상태 + 간격 안내 + '수집 범위 확인' |
| `disabled` | 읽을 작업 영역 없음(흐름 로그 설정·연결 파일·환경 변수 모두 없음) | 빈 상태 + 연결 파일 안내 |
| `noAccess` | 작업 영역 읽기 권한 없음 | 경고 |
| `noTable` | 작업 영역에 Traffic Analytics 테이블 없음 | 빈 상태 + '수집 범위 확인' |
| 미측정 | 위협 정보 등 일부만 실패 | '미측정: …' 경고, 나머지는 표시 |

로그인하지 않으면 **예시 데이터**(문서용 IP 대역 203.0.113.x·198.51.100.x)를 보여 줍니다. **로그인한 사용자에게는 예시 데이터를 절대 보여 주지 않습니다** — 실패는 오류 코드 문장, 없음은 상태로 보입니다.

## 6. API

| 경로 | 설명 |
|---|---|
| `GET /api/network/flows?subscriptionId=&section=map\|overview\|talkers\|blocked\|internet&range=60\|360\|1440\|10080&top=5–50&dim=subnet\|vm\|ip\|port&dir=in\|out&vnet=<rg>/<vnet>` | 열린 탭 하나만 조회. 캐시 `AZURE_LOG_ANALYTICS_CACHE_TTL_MS`, 같은 요청 병합 |
| `GET /api/network/coverage?subscriptionId=` | 수집 범위. 캐시 `AZURE_NETWORK_COVERAGE_TTL_MS`(기본 5분) |
| `GET /api/network/summary` | 예전 요약(인프라 구성도 흐름 오버레이용) |

응답에는 구독 GUID가 없습니다(라벨은 `rg/vnet/subnet`, 나머지 GUID는 가림).

## 7. 알려진 불확실성

- `SubType` 값과 `AclGroup` 열은 실측 데이터로 확인하지 못해 `column_ifexists`로 읽습니다(열이 없으면 빈 값).
- '전체 VNet'은 흐름 로그별 기록의 합입니다 — 두 VNet의 흐름 로그가 같은 VNet 간 흐름을 양쪽에서 기록하면 두 번 셉니다(관측 지점이 둘).
- `*PublicIps`는 `IP|카운터…` 묶음이 공백으로 이어진 형식으로 가정합니다.

## 8. 문제 해결

| 증상 | 확인 | 카탈로그 |
|---|---|---|
| 모든 탭이 '기록 없음' | 수집 범위 탭: VNet 흐름 로그+TA가 켜진 VNet이 있는지, '이 화면이 읽는 작업 영역', 마지막 수신 시각 | NET-002, NET-003 |
| '읽을 흐름 로그 작업 영역이 없습니다' | 연결 파일 `logAnalyticsWorkspaces` | NET-003 |
| 수집 범위가 '설정 못 읽음' | `NetworkWatcherRG`에 Reader | NET-004 |
| '작업 영역을 읽을 권한이 없습니다' | 연결에 Log Analytics Reader | NET-001 |
| NSG만 있는 VNet | VNet 흐름 로그로 이전 | NET-002 |
