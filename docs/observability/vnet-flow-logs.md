# VNet 트래픽 (Flow Log) — VNet 흐름 로그 + Traffic Analytics

> **대상**: 운영자, 플랫폼 관리자 · 화면: **네트워크 › VNet 트래픽 (Flow Log)** (`/network`)

## 1. 이 화면이 답하는 질문

| 질문 | 탭 |
|---|---|
| 정해진 기간에 VNet에서 얼마나 오갔나, 언제 몰렸나 | **개요** — 합계·시간별 막대(바이트)+선(거부)·흐름 유형별 |
| 누가 누구와 가장 많이 통신했나 (서브넷·VM·IP), 어느 포트로 | **상위 통신** — 인터넷에서 허용된 관리 포트(22·3389·445·1433·3306·5432·5985·5986) 강조 |
| NSG(관리 규칙)가 무엇을 막았나 | **차단** — 규칙·방향·포트별 거부 흐름, 주요 출발지, 마지막 발생 |
| 인터넷의 누가 들어오고, 어디로 나갔나 — 악성 IP가 있었나 | **인터넷·위협** — 공용 IP별 기록, Traffic Analytics 위협 정보(악성 먼저) → 위협 탐지 화면 링크 |
| 애초에 수집되고 있나 | **수집 범위** — VNet마다 VNet 흐름 로그/일부/NSG만/없음, Traffic Analytics·간격·작업 영역·보존 |

다른 화면과의 차이: **라이브 다이어그램**은 VNet 1개의 지금(1분 메트릭)을 그림으로, **인프라 구성도**는 구성을, **Pod 트래픽(Hubble)** 은 클러스터 안 Pod 흐름을 봅니다. 이 화면은 **기간을 정해 흐름 로그를 감사**합니다(그림 없음).

> **5살 비유**: 동네(VNet) 입구에 큰 공책(VNet 흐름 로그)을 두고, 우체국 아저씨(Traffic Analytics)가 10분이나 1시간마다 공책을 정리해 줘요. 이 화면은 그 정리된 공책이에요. 공책이 없으면 "아무도 안 왔어요"라고 지어내지 않고 "공책이 없어서 몰라요"라고 말해요.

## 2. 데이터 원천

- `NTANetAnalytics` (`AZURE_LOG_ANALYTICS_TABLE`, 기본) — VNet 흐름 로그의 Traffic Analytics 결과. 열: `FlowType`·`FlowDirection`·`FlowStatus`·`SrcSubnet`/`DestSubnet`(`구독/RG/VNet/서브넷`)·`SrcVm`·`DestPort`·`L4Protocol`·`Allowed/DeniedIn/OutFlows`·`BytesSrcToDest`/`BytesDestToSrc`·`SrcPublicIps`/`DestPublicIps`·`NsgList`·`NsgRule`·`AclRule`·`Country` …
- `NTAIpDetails` — 공용 IP의 `ThreatType`·`ThreatDescription`·`Location`.
- Resource Graph — `microsoft.network/networkwatchers/flowlogs`(대상·활성·TA·간격·작업 영역·보존), VNet·서브넷·NSG, 작업 영역.
- 범위: 선택한 구독(필수)과 VNet(선택, `rg/vnet`). 작업 영역은 하나(`AZURE_LOG_ANALYTICS_WORKSPACE_ID`). 여러 작업 영역은 후속.

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

- 구독: **Reader** (흐름 로그 리소스는 보통 `NetworkWatcherRG`에 있음)
- 작업 영역: **Log Analytics Reader**
- 자세히: [permissions.md](../integrations/azure/permissions.md)

## 5. 상태 (숫자를 지어내지 않음)

| 상태 | 뜻 | 화면 |
|---|---|---|
| `ok` | 기록 있음 | 표·그래프 |
| `empty` | 기간 안에 기록 없음 — TA 처리 간격(10/60분)만큼 늦을 수 있음, 또는 흐름 로그·TA 꺼짐 | 빈 상태 + 간격 안내 + '수집 범위 확인' |
| `disabled` | 작업 영역 미설정 | 빈 상태 |
| `noAccess` | 작업 영역 읽기 권한 없음 | 경고 |
| `noTable` | 작업 영역에 Traffic Analytics 테이블 없음 | 빈 상태 + '수집 범위 확인' |
| 미측정 | 위협 정보 등 일부만 실패 | '미측정: …' 경고, 나머지는 표시 |

로그인하지 않으면 **예시 데이터**(문서용 IP 대역 203.0.113.x·198.51.100.x)를 보여 줍니다. **로그인한 사용자에게는 예시 데이터를 절대 보여 주지 않습니다** — 실패는 오류 코드 문장, 없음은 상태로 보입니다.

## 6. API

| 경로 | 설명 |
|---|---|
| `GET /api/network/flows?subscriptionId=&section=overview\|talkers\|blocked\|internet&range=60\|360\|1440\|10080&top=5–50&dim=subnet\|vm\|ip\|port&dir=in\|out&vnet=<rg>/<vnet>` | 열린 탭 하나만 조회. 캐시 `AZURE_LOG_ANALYTICS_CACHE_TTL_MS`, 같은 요청 병합 |
| `GET /api/network/coverage?subscriptionId=` | 수집 범위. 캐시 `AZURE_NETWORK_COVERAGE_TTL_MS`(기본 5분) |
| `GET /api/network/summary` | 예전 요약(인프라 구성도 흐름 오버레이용) |

응답에는 구독 GUID가 없습니다(라벨은 `rg/vnet/subnet`, 나머지 GUID는 가림).

## 7. 알려진 불확실성

- `SubType` 값과 `AclGroup` 열은 실측 데이터로 확인하지 못해 `column_ifexists`로 읽습니다(열이 없으면 빈 값).
- `SrcSubnet` 형식이 `구독/RG/VNet/서브넷`이 아닌 환경이 있으면 VNet 범위 필터가 비게 됩니다 — 그 경우 '전체 VNet'으로 보세요.
- `*PublicIps`는 `IP|카운터…` 묶음이 공백으로 이어진 형식으로 가정합니다.

## 8. 문제 해결

| 증상 | 확인 | 카탈로그 |
|---|---|---|
| 모든 탭이 '기록 없음' | 수집 범위 탭: VNet 흐름 로그+TA가 켜진 VNet이 있는지, 작업 영역이 같은지(`≠` 배지), 마지막 수신 시각 | NET-002, NET-003 |
| '작업 영역을 읽을 권한이 없습니다' | 연결에 Log Analytics Reader | NET-001 |
| NSG만 있는 VNet | VNet 흐름 로그로 이전 | NET-002 |
