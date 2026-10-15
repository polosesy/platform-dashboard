# 애플리케이션·통합 — Azure 리소스 관계 사전

> **대상**: 이 영역의 리소스를 그리는 다이어그램 코드 작성자, 보안 검토자, Azure를 처음 배우는 운영자. 다루는 서비스는 App Service·Functions·Logic Apps·Static Web Apps·API Management·Service Bus·Event Hubs·Event Grid·Relay·App Configuration·AI 서비스(Cognitive Services/Azure OpenAI/Foundry)·Machine Learning·AI Search·SignalR/Web PubSub입니다.
> **근거**: Azure REST API 최신 스펙(파일별 최신 stable, stable이 없으면 최신 preview) + providers API + 실제 테넌트 교차 검증 (2026-10-15)

## 1. 한눈에 보기

이 영역의 리소스는 대부분 **서브넷 안에 들어가지 않는 PaaS**입니다. 네트워크와는 방향이 정해진 세 가지 방식으로만 이어집니다.
- **인바운드 사설 접근**: Private Endpoint(PE)를 씁니다.
- **아웃바운드**: VNet 통합(통합 서브넷)이나 공유 프라이빗 링크를 씁니다.
- **필터**: 방화벽 규칙(서비스 엔드포인트 서브넷·IP)을 씁니다.

예외로 "주입"되는 리소스는 서브넷 안에 그립니다. App Service Environment, API Management의 클래식·Premium v2 VNet 주입, Foundry 에이전트 서브넷이 여기에 해당합니다.

앱 호스팅의 뼈대는 **App Service 플랜 ⊃ 사이트(앱·Functions·Logic Apps Standard)** 입니다.

메시징 리소스 사이의 관계는 대부분 ARM 속성으로 표현됩니다.
- Event Grid: 구독의 `destination`
- Event Hubs: Capture의 Storage
- API Management: 백엔드·로거

반대로 앱이 Service Bus나 Key Vault를 **실제로 호출하는지**는 ARM 속성에 없습니다. 연결 문자열·앱 설정·코드 안에만 있으므로 관측(Application Insights 의존성·접근 로그)으로만 확인할 수 있습니다.

```mermaid
flowchart LR
  subgraph VNET["VNet"]
    INTSUB["통합 서브넷<br/>(위임 Microsoft.Web/serverFarms)"]
    PESUB["PE 서브넷"]
    APIMSUB["APIM 주입 서브넷"]
    AGSUB["에이전트 서브넷<br/>(위임 Microsoft.App/environments)"]
  end
  PLAN["App Service 플랜"] -->|APP-01 포함| SITE["사이트 (Web/Functions/Logic Std)"]
  SITE -.->|PAAS-01 아웃바운드만| INTSUB
  INTSUB -.->|APP-03 SAL 역참조| PLAN
  PESUB -->|PL-01 인바운드만| SITE
  SITE -.->|APP-07 모니터링| AI["Application Insights"] -->|LOG-02| LAW["Log Analytics"]
  SITE -.->|APP-08 TCP host:port| RELAY["Relay 하이브리드 연결"]
  APIM["API Management"] -->|APP-15 주입| APIMSUB
  APIM -->|APP-18 백엔드| SITE
  APIM -.->|APP-20 로거| AI
  SRC["Storage 등 Azure 리소스"] -->|APP-27 source| ST["Event Grid 시스템 토픽"]
  ST -->|APP-28 구독 destination| SB["Service Bus"]
  ST -->|APP-28| FUNC["Function"]
  EH["Event Hubs"] -->|APP-25 Capture| STG["Storage"]
  AIS["AI 서비스 계정"] -->|APP-34 networkInjections| AGSUB
  AIS -.->|APP-35 BYOS| STG
  MLW["ML 작업 영역"] -.->|APP-36| STG
  SRCH["AI Search / SignalR"] -->|APP-40 공유 프라이빗 링크<br/>(서비스 쪽 PE)| STG
```

**5살 비유**: Azure는 커다란 아파트 단지예요. VNet은 단지, 서브넷은 동이에요. 앱은 단지 옆 상가 건물(App Service 플랜)에 있는 가게예요. 같은 건물에 있는 가게들은 전기와 엘리베이터를 함께 써요. VNet 통합은 가게에서 단지 쪽으로 "밖으로만 열리는 뒷문"이에요. Private Endpoint는 단지에서 이웃 가게로 들어가는 "전용 쪽문"이에요. Service Bus는 편지를 모아 두는 단지 우체통이고, Event Grid는 "택배 왔어요!" 하고 알려 주는 단지 안내 방송이에요. Event Hubs는 물건이 줄줄이 지나가는 컨베이어 벨트예요. Capture는 그 벨트 끝에서 물건을 창고(Storage)에 쌓아 두는 일이에요. (비유 대응표: 핵심 사전 입문 7)

## 2. 리소스 유형

| 유형 (ARM type) | 범위 | 한 줄 설명 | 문서 |
|---|---|---|---|
| `microsoft.web/serverfarms` | 리전 | App Service 플랜. VM 인스턴스 집합이며 OS·리전·인스턴스 수를 정함 | https://learn.microsoft.com/azure/app-service/overview-hosting-plans |
| `microsoft.web/sites` | 리전 | 웹앱·Function 앱·Logic Apps Standard(모두 같은 유형이고 `kind`로 구분) | https://learn.microsoft.com/azure/app-service/overview-hosting-plans |
| `microsoft.web/sites/slots` | 자식 (리전) | 배포 슬롯. PE·VNet 통합을 슬롯마다 따로 설정 | https://learn.microsoft.com/en-us/azure/app-service/overview-private-endpoint |
| `microsoft.web/sites/virtualnetworkconnections` | 자식 | 사이트의 VNet 연결(게이트웨이 필요 방식) | https://learn.microsoft.com/en-us/azure/app-service/configure-gateway-required-vnet-integration |
| `microsoft.web/sites/hybridconnection` | 자식 | 사이트에 붙인 Relay 하이브리드 연결 | https://learn.microsoft.com/en-us/azure/app-service/app-service-hybrid-connections |
| `microsoft.web/certificates` | 리전 | App Service TLS 인증서(Key Vault에서 가져올 수 있음) | https://learn.microsoft.com/azure/app-service/configure-ssl-certificate |
| `microsoft.web/hostingenvironments` | 리전 | App Service Environment v3. 전용 위임 서브넷에 주입됨 | https://learn.microsoft.com/en-us/azure/app-service/environment/networking |
| `microsoft.web/staticsites` | 글로벌 서비스 (ARM `location`은 관리·API 리전, providers API는 regional로 표기) | Static Web Apps. `/api`를 연결된 백엔드로 프록시. 리전 박스가 아니라 글로벌 레인에 그린다. 근거: reliability/regions-nonregional-services가 Static Web Apps를 Global로 분류 | https://learn.microsoft.com/azure/static-web-apps/apis-overview |
| `microsoft.web/staticsites/linkedbackends` | 자식 | Static Web Apps에 연결된 백엔드(BYO API) | https://learn.microsoft.com/azure/static-web-apps/apis-overview |
| `microsoft.web/connections` | 리전 | Logic Apps 관리형 커넥터 연결(API 연결) | https://learn.microsoft.com/en-us/azure/logic-apps/secure-single-tenant-workflow-virtual-network-private-endpoint |
| `microsoft.insights/components` | 리전 | Application Insights(작업 영역 기반은 LOG-02) | https://learn.microsoft.com/en-us/azure/azure-monitor/app/azure-web-apps-net |
| `microsoft.apimanagement/service` | 리전 | API Management 인스턴스(게이트웨이·관리 평면·포털) | https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts |
| `microsoft.apimanagement/service/backends` | 자식 | APIM 백엔드(단일 또는 풀) | https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/backends |
| `microsoft.apimanagement/service/loggers` | 자식 | APIM 로그 대상(App Insights·Event Hub·Azure Monitor) | https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/loggers |
| `microsoft.apimanagement/gateways` | 리전 | 작업 영역 게이트웨이 | https://learn.microsoft.com/en-us/azure/api-management/virtual-network-workspaces-resources |
| `microsoft.servicebus/namespaces` | 리전 | Service Bus 네임스페이스(큐·토픽) | https://learn.microsoft.com/en-us/azure/service-bus-messaging/network-security |
| `microsoft.servicebus/namespaces/networkrulesets` | 자식 (이름 `default`) | IP·VNet 규칙. 사이 다이제스트(관계 추출 데이터)에는 없음 | https://learn.microsoft.com/en-us/azure/templates/microsoft.servicebus/namespaces/networkrulesets |
| `microsoft.eventhub/namespaces` | 리전 | Event Hubs 네임스페이스 | https://learn.microsoft.com/azure/event-hubs/network-security |
| `microsoft.eventhub/namespaces/eventhubs` | 자식 | 이벤트 허브(Capture 설정 보유) | https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-capture-overview |
| `microsoft.eventhub/clusters` | 리전 | Event Hubs Dedicated 클러스터 | https://learn.microsoft.com/en-us/rest/api/eventhub/namespaces/get |
| `microsoft.relay/namespaces` (+`/hybridconnections`) | 리전 / 자식 | Relay. App Service 하이브리드 연결의 중계 | https://learn.microsoft.com/en-us/azure/app-service/app-service-hybrid-connections |
| `microsoft.eventgrid/topics` | 리전 | 사용자 지정 토픽 | https://learn.microsoft.com/azure/event-grid/event-handlers |
| `microsoft.eventgrid/systemtopics` | 혼합 | Azure 서비스가 발행하는 이벤트의 토픽(구독·RG 원본은 `global`) | https://learn.microsoft.com/en-us/azure/event-grid/system-topics |
| `microsoft.eventgrid/eventsubscriptions` (+`topics/…`, `systemtopics/…`) | 확장 (providers API는 regional로 표기) / 자식 | 이벤트 구독. 대상(destination) 보유 | https://learn.microsoft.com/en-us/azure/templates/microsoft.eventgrid/eventsubscriptions |
| `microsoft.eventgrid/domains` | 리전 | 이벤트 도메인(다중 토픽) | https://learn.microsoft.com/azure/event-grid/event-handlers |
| `microsoft.eventgrid/namespaces` | 리전 | Event Grid 네임스페이스(MQTT·풀 전달) | https://learn.microsoft.com/azure/event-grid/mqtt-routing |
| `microsoft.logic/workflows` | 리전 | Logic Apps 소비(Consumption) 워크플로 | https://learn.microsoft.com/en-us/azure/logic-apps/enterprise-integration/create-integration-account |
| `microsoft.logic/integrationaccounts` | 리전 | B2B 통합 계정(스키마·맵·파트너) | https://learn.microsoft.com/en-us/azure/logic-apps/enterprise-integration/create-integration-account |
| `microsoft.logic/integrationserviceenvironments` | 리전 (**퇴역**) | ISE. 2024-08-31 퇴역 | https://learn.microsoft.com/en-us/azure/logic-apps/connect-virtual-network-vnet-isolated-environment-overview |
| `microsoft.appconfiguration/configurationstores` | 리전 | 구성 저장소(키-값·Key Vault 참조) | https://learn.microsoft.com/en-us/azure/azure-app-configuration/use-key-vault-references-dotnet-core |
| `microsoft.cognitiveservices/accounts` | 혼합 | AI 서비스·Azure OpenAI·Foundry 계정 | https://learn.microsoft.com/en-us/azure/foundry/how-to/managed-virtual-network |
| `microsoft.cognitiveservices/accounts/deployments` | 자식 | 모델 배포 | https://learn.microsoft.com/en-us/azure/foundry/how-to/managed-virtual-network |
| `microsoft.machinelearningservices/workspaces` | 리전 | ML 작업 영역(Storage·Key Vault·App Insights·ACR에 연결) | https://learn.microsoft.com/en-us/azure/machine-learning/concept-workspace |
| `microsoft.machinelearningservices/workspaces/computes` | 리전 (자식) | 관리형 컴퓨팅 또는 연결(attach)된 외부 컴퓨팅 | https://learn.microsoft.com/en-us/azure/templates/microsoft.machinelearningservices/workspaces/computes |
| `microsoft.search/searchservices` (+`/sharedprivatelinkresources`) | 리전 / 자식 | AI Search와 아웃바운드 공유 프라이빗 링크 | https://learn.microsoft.com/en-us/azure/search/search-indexer-howto-access-private |
| `microsoft.signalrservice/signalr` · `/webpubsub` (+`/sharedprivatelinkresources`) | 리전 / 리전 | SignalR·Web PubSub와 공유 프라이빗 링크 | https://learn.microsoft.com/en-us/azure/azure-signalr/howto-shared-private-endpoints |

## 3. 관계 표

관계 하나에 주인 페이지 하나: 신원·키·로그 전송은 IDM, 배치·네트워크는 서비스 페이지. 다른 페이지에는 '→ <ID> 참고' 한 줄만 둔다. 핵심 사전 행을 다시 쓰는 행은 새 ID 없이 메모로 둔다.

**핵심 사전 행(여기서는 반복하지 않음)**:
- PAAS-01: App Service·Functions → 통합 서브넷, `virtualNetworkSubnetId`, 아웃바운드만
- PAAS-07: Container Apps 환경 → 인프라 서브넷
- PL-01: PE → 대상. 사이트·Service Bus·Event Hubs·APIM·App Configuration·AI 계정·Search 공통
  - 메모(이 영역의 대상 groupId): 사이트 `sites`(슬롯은 `sites-<슬롯>`) · API Management `Gateway` · Service Bus·Event Hubs `namespace` · App Configuration `configurationStores` 등
- PL-03, PL-05
- LOG-01: 진단 설정
- LOG-02: App Insights → Log Analytics
- AGW-05: AGW 백엔드 FQDN → App Service `defaultHostName`
- EDGE-04: Front Door → 오리진
- CT-08: 서브넷 위임
- SEC-05: 서비스 엔드포인트
- REG-01

근거 칸 표기:
- `spec:id-string`: 스펙에서 속성 이름이나 설명으로 찾은 문자열 ID입니다. `arm-id` 형식 선언이 없어서 대상 유형은 문서로 확인했습니다.
- `docs`: 이 사이 다이제스트에 경로가 **없는** 항목입니다. 공식 문서(템플릿 참조)에서 확인한 속성 이름을 함께 적었습니다.

| ID | 관계 (source → target) | 의미·방향 | ARM 속성 경로 | 근거 | 다이어그램 표현 | 출처 |
|---|---|---|---|---|---|---|
| APP-01 | 사이트 → App Service 플랜 | 호스팅(포함). 같은 플랜의 앱은 같은 VM 인스턴스를 나눠 쓰고 함께 확장됨 | `sites`: `serverFarmId` | spec+tenant (id-string ✓) | absorb: 플랜 타일에 '앱 n'. 플랜이 같으면 확장·장애를 함께 겪기 때문 | https://learn.microsoft.com/azure/app-service/overview-hosting-plans — "an app always runs in an App Service plan" |
| APP-02 | 슬롯 → 사이트 / 플랜 | 슬롯은 사이트의 자식이며 자기 `serverFarmId`·VNet 통합·PE를 따로 가짐. PE 하위 리소스는 `sites-<슬롯>` | `sites/slots`: `serverFarmId`, `virtualNetworkSubnetId` (ID `…/sites/{n}/slots/{s}`) | spec:id-string | absorb: 사이트 카드에 칩 '슬롯 n'. 슬롯의 PE·통합은 슬롯 이름으로 표시 | https://learn.microsoft.com/en-us/azure/app-service/overview-private-endpoint — "The subresource name of a slot is sites-<slot-name>" |
| APP-03 | 통합 서브넷 → App Service 플랜 (SAL) | 통합 서브넷의 서비스 연결 링크(`serviceAssociationLinks`, 읽기 전용) → App Service 플랜. VNet 통합 시 Azure가 만들며 앱을 지워도 남을 수 있음. 제약: 통합 서브넷은 App Service 플랜 하나만 쓸 수 있다(overview-vnet-integration). 이 행이 NET-02의 주인이다 | VNet 쪽: `subnets[].serviceAssociationLinks[].link` → `microsoft.web/serverfarms` (설정은 사이트 쪽 PAAS-01) | tenant | panel: 서브넷 '사용 중: 플랜 x'. 사이트가 없는 SAL은 '정리 필요' | https://learn.microsoft.com/en-us/azure/app-service/overview-vnet-integration — "a Service Association Link (SAL) is created" |
| APP-04 | 사이트·플랜 → VNet (게이트웨이 필요 방식) ⚠ | 옛 P2S VPN 방식의 아웃바운드 연결(Windows 전용). 지역 VNet 통합(PAAS-01)이 이 목록에도 나오는지는 **미확인** | `sites/virtualnetworkconnections`·`serverfarms/virtualnetworkconnections`: `vnetResourceId` (`routes[]`는 읽기 전용) | spec:id-string ⚠ | line-dashed + 칩 '게이트웨이 방식(퇴역 예정)'. 퇴역일 2027-03-31은 중국 미러 문서 기준이며 en-us 문서로는 미확인 | https://learn.microsoft.com/en-us/azure/app-service/configure-gateway-required-vnet-integration |
| APP-05 | 사이트 ← 허용 서브넷 (접근 제한) | **인바운드 필터**. `Microsoft.Web` 서비스 엔드포인트가 켜진 서브넷에서 오는 요청만 허용(트래픽 경로 아님) | `sites`: `siteConfig.ipSecurityRestrictions[].vnetSubnetResourceId`, `siteConfig.scmIpSecurityRestrictions[].vnetSubnetResourceId` | spec:id-string | chip: 앱에 '허용 서브넷 n'(+SCM). 경로가 아니므로 선은 긋지 않음 | https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions · overview-vnet-integration — "To control inbound traffic to your app, use the access restrictions feature" |
| APP-07 | 사이트 → Application Insights | 원격 분석 전송. 실제 연결은 앱 설정 `APPLICATIONINSIGHTS_CONNECTION_STRING`(데이터 평면이며 ARM 속성 아님). 태그는 포털이 남기는 표식이라 실제와 다를 수 있음 | `sites`: `tags["hidden-link: /app-insights-resource-id"]` → `microsoft.insights/components` | tenant (+docs: 앱 설정) | line-dashed: 모니터링 레이어(기본 끔). 태그만 있으면 '태그 기준' 표시 | https://learn.microsoft.com/en-us/azure/azure-monitor/app/azure-web-apps-net |
| APP-08 | 사이트 → Relay 하이브리드 연결 → 온프레미스 `host:port` | **아웃바운드 TCP만**. 앱으로 들어오는 새 경로는 만들지 않음. 온프레미스의 HCM(Hybrid Connection Manager)이 Relay로 443 아웃바운드 | docs: 사이트 쪽 `sites/hybridconnection`(다이제스트에 참조 없음), `sites/networkfeatures`의 `hybridConnectionsV2[]`(읽기 전용), Relay 쪽 `hybridConnections.userMetadata`(endpoint `host:port`) | docs | line-dashed: 앱 → Relay → 외부 노드 '온프레미스 host:port' | https://learn.microsoft.com/en-us/azure/app-service/app-service-hybrid-connections — "Hybrid Connections provides access from your app to a TCP endpoint." |
| APP-09 | 사이트 → Key Vault (Key Vault 참조 앱 설정) | 앱 ID(관리 ID)로 비밀을 읽음. Key Vault가 공용 접근을 막으면 VNet 통합으로 읽음 | docs: 앱 설정 값 `@Microsoft.KeyVault(...)` (ARM 속성 아님 — `config/appsettings` 목록 권한 필요) | docs | panel: '비밀 참조 n(Key Vault)'. 실제 접근은 PL-05 관측으로만 선 | https://learn.microsoft.com/en-us/azure/app-service/overview-vnet-integration — "an attempt is made to get the secrets through the virtual network integration" |
| APP-10 | → IDM-20 참고 (App Service 인증서 → Key Vault). | | | | | |
| APP-11 | Function 앱(Flex Consumption) → 배포 Storage 인증용 사용자 할당 ID | 배포 패키지 Blob 컨테이너를 읽을 때 쓰는 신원. Storage 컨테이너 URL 자체는 다이제스트에 없음 | `sites`: `functionAppConfig.deployment.storage.authentication.userAssignedIdentityResourceId` → `microsoft.managedidentity/userassignedidentities` (이름 기반 추론) | spec:id-string | chip: 신원 'UAMI x'. Storage 선은 URL 일치(fqdnMatch)로만 | https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan |
| APP-12 | 사이트 → Container Apps 환경 ⚠ | 옛 'Functions on Container Apps' 모델(`Microsoft.Web/sites`). **현재 문서는 `Microsoft.App/containerApps` + `kind=functionapp`** | `sites`: `managedEnvironmentId` | spec:id-string ⚠ | contain(PAAS-07 환경 박스) + 칩 '구 모델'. 신규는 Container Apps 사전(CMP) 기준 | https://learn.microsoft.com/en-us/azure/container-apps/functions-overview — "using the Microsoft.App resource provider and setting kind=functionapp" |
| APP-13 | App Service Environment v3 → 전용 서브넷, 사이트 → ASE | ASE는 비어 있는 단일 서브넷에 주입되고 서브넷은 `Microsoft.Web/hostingEnvironments`에 위임됨. 그 안의 앱은 VNet 통합이 따로 필요 없음 | docs: ASE `virtualNetwork.id`, 사이트 `hostingEnvironmentProfile.id` (다이제스트 미수록 — ASE의 typed-ref 2개는 파서 오탐) | docs | contain: 서브넷 ⊃ ASE ⊃ 플랜 ⊃ 앱 | https://learn.microsoft.com/en-us/azure/app-service/environment/networking |
| APP-14 | Static Web Apps → 연결된 백엔드 | `/api` 요청을 백엔드로 프록시(Standard 플랜, 환경당 백엔드 1종) | `staticsites/linkedbackends`·`builds/linkedbackends`: `backendResourceId`. `staticsites/userprovidedfunctionapps`: `functionAppResourceId` | spec:id-string | line: SWA → 백엔드, 라벨 '/api' | https://learn.microsoft.com/azure/static-web-apps/apis-overview — "existing APIs hosted in Azure Functions, API Management, App Service, or Container Apps" |
| APP-15 | API Management → 주입 서브넷 (클래식 Developer/Premium) | 인스턴스가 서브넷 안에 주입됨. `virtualNetworkType`이 `External`이면 공용 LB로, `Internal`이면 내부 LB로 VNet 안에서만 접근 | `service`: `virtualNetworkConfiguration.subnetResourceId`, `additionalLocations[].virtualNetworkConfiguration.subnetResourceId` (모드는 문서의 `virtualNetworkType`). 클래식(stv2) VNet 주입: `virtualNetworkConfiguration.subnetResourceId` + `publicIpAddressId`(Standard 공용 IP 필수, docs — 파서가 놓침) | spec:id-string + docs | contain + 칩 '외부'/'내부'. 추가 리전은 리전마다 별도 박스 | https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts — "accessible only from within the virtual network via an internal load balancer" |
| APP-16 | API Management v2 → 서브넷 (Standard v2·Premium v2 통합 / Premium v2 주입) | 같은 `virtualNetworkConfiguration.subnetResourceId`를 v2 계층에서 두 방식으로 쓴다: ① VNet 통합(Standard v2·Premium v2, 아웃바운드만, 서브넷 위임 `Microsoft.Web/serverFarms` — Learn integrate-vnet-outbound 'The subnet needs to be delegated to the Microsoft.Web/serverFarms service') → 아웃바운드 선 / ② VNet 주입(Premium v2만, 위임 `Microsoft.Web/hostingEnvironments` — Learn inject-vnet-v2) → contain. 두 방식 모두 전용 서브넷이고 같은 리전·구독이다. 통합에서는 게이트웨이·포털이 공용으로 남고, 주입은 게이트웨이까지 사설 | `service`: `virtualNetworkConfiguration.subnetResourceId`. `virtualNetworkType` 값(External/Internal)과 두 방식의 대응은 **미검증**(템플릿 참조로 확인하기 전까지) | docs | ① 통합: vnetIntegration 선(PAAS-01과 같은 문법, 포함 아님) ② 주입: contain. 두 방식은 서브넷 위임으로 구분 | https://learn.microsoft.com/en-us/azure/api-management/integrate-vnet-outbound — "The subnet needs to be delegated to the Microsoft.Web/serverFarms service." · https://learn.microsoft.com/azure/api-management/inject-vnet-v2 |
| APP-18 | APIM 백엔드 → Azure 리소스 | `resourceId`는 **관리 링크**(Logic Apps·Functions·API Apps)이고, 실제 런타임 주소는 `url`(문서) | `service/backends`·`workspaces/backends`: `resourceId` | spec:id-string | line: `resourceId`가 있으면 cfg, 없으면 `url` 호스트 정확 일치(AGW-05와 같은 fqdnMatch) | https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/backends — "This URL can be the Arm Resource Id of Logic Apps, Function Apps or API Apps." |
| APP-19 | APIM 백엔드 풀 → 백엔드 | 부하 분산 풀의 멤버(우선순위·가중치) | `service/backends`: `pool.services[].id` | spec:arm-id | absorb: 풀 패널에 멤버 목록. 멤버 선은 APP-18로 | https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/backends — "The unique ARM id of the backend entity."  |
| APP-20 | APIM 로거 → App Insights / Event Hub. 진단 → 로거 | 로그 전송 | `service/loggers`: `resourceId`. `service/diagnostics`·`apis/diagnostics`: `loggerId` | spec:id-string | line-dashed: 로그 레이어(LOG-01과 같게 기본 끔) | https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/loggers — "either Azure Event Hub resource or Azure Application Insights resource" |
| APP-21 | APIM 작업 영역 → 작업 영역 게이트웨이 | 작업 영역의 API를 서비스하는 게이트웨이 연결 | `service/workspacelinks`: `workspaceId`, `gateways[].id`. `gateways/configconnections`: `sourceId` | spec:arm-id | panel: 작업 영역 ↔ 게이트웨이 | https://learn.microsoft.com/en-us/azure/api-management/virtual-network-workspaces-resources |
| APP-22 | Service Bus 네임스페이스 ← 허용 서브넷 | **인바운드 필터**(서비스 엔드포인트 `Microsoft.ServiceBus` + VNet 규칙). VNet·Networking 탭은 Premium만 | docs: `namespaces/networkRuleSets` (이름 `default`): `virtualNetworkRules[].subnet.id`, `ipRules[]`, `defaultAction`, `publicNetworkAccess` (다이제스트에 유형 자체가 없음) | docs | chip: '허용 서브넷 n · IP n · 기본 Deny/Allow'. 선 아님 | https://learn.microsoft.com/en-us/azure/templates/microsoft.servicebus/namespaces/networkrulesets — "Resource ID of Virtual Network Subnet" |
| APP-23 | Event Hubs 네임스페이스 ← 허용 서브넷 | APP-22와 같은 방식(`Microsoft.EventHub` 엔드포인트). Basic 계층은 미지원. 규칙이 없으면 액세스 키로 공용 접근 가능 | docs: 네트워크 규칙 집합의 `virtualNetworkRules`·`ipRules` (경로는 Service Bus와 같은 모양으로 **추정**, Event Hubs 템플릿은 미확인) | docs | chip(APP-22와 같음) | https://learn.microsoft.com/azure/event-hubs/network-security |
| APP-25 | 이벤트 허브 → Storage (Capture) | 스트림을 Blob 또는 ADLS Gen2에 Avro로 저장. 다른 리전도 가능. 관리 ID가 없으면 같은 구독만 가능 | `namespaces/eventhubs`: `captureDescription.destination.storageAccountResourceId` | spec:id-string | line-dashed: 데이터 내보내기 '캡처'. 리전을 넘는 선 허용 | https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-capture-overview — "can reside in the same region as your event hub or in another region" |
| APP-26 | Event Hubs 네임스페이스 → Dedicated 클러스터 | 네임스페이스가 전용 클러스터 위에서 실행됨. 지리 복제 위치마다 클러스터를 지정할 수 있음 | `namespaces`: `clusterArmId`, `geoDataReplication.locations[].clusterArmId` → `microsoft.eventhub/clusters`(문서) | spec:id-string | contain: 클러스터 박스 ⊃ 네임스페이스 | https://learn.microsoft.com/en-us/rest/api/eventhub/namespaces/get |
| APP-27 | 시스템 토픽 → 원본 리소스 | Azure 서비스가 이 토픽으로 이벤트를 발행. 원본마다 시스템 토픽은 하나. 위치는 원본과 같고 구독·RG 원본은 `global` | docs: `systemTopics`의 `source`, `topicType` (다이제스트 미수록 — `metricResourceId`만 역참조) | docs | absorb: 원본 카드에 칩 '이벤트 구독 n'. 펼치면 APP-28 선 | https://learn.microsoft.com/en-us/azure/event-grid/system-topics — "allows only one system topic per source" |
| APP-28 | 이벤트 구독 → 대상 (+ 배달 못 한 이벤트 → Storage) | 이벤트 **푸시** 방향. `endpointType`은 AzureFunction·EventHub·HybridConnection·NamespaceTopic·PartnerDestination·ServiceBusQueue·ServiceBusTopic·StorageQueue·WebHook·MonitorAlert | docs: `destination.properties.resourceId`(WebHook은 `endpointUrl` — 비밀 값, MonitorAlert는 `actionGroups[]`), `deliveryWithResourceIdentity.destination`, `deadLetterDestination.properties.{resourceId, blobContainerName}` (다형 스키마라 다이제스트 미수록) | docs | line: 토픽 → 핸들러(cfg). WebHook은 호스트 정확 일치만, 아니면 '외부 웹훅'. 배달 못 한 이벤트는 line-dashed | https://learn.microsoft.com/en-us/azure/templates/microsoft.eventgrid/eventsubscriptions — "The Azure Resource Id that represents the endpoint of an Event Hub destination" |
| APP-29 | Event Grid 네임스페이스(MQTT) → 라우팅 토픽 ⚠ | MQTT 메시지를 토픽으로 라우팅. 문서 예시의 대상은 **사용자 지정 토픽(`Microsoft.EventGrid/topics`)** 이며 같은 리전이어야 함. 네임스페이스 토픽 ID를 넣을 수 있는지는 미확인 | `namespaces`: `topicSpacesConfiguration.routeTopicResourceId` | spec:id-string ⚠ | line: 네임스페이스 → 토픽 '라우팅' | https://learn.microsoft.com/azure/event-grid/mqtt-routing · 템플릿 2023-12-15-preview — "This topic should reside in the same region where namespace is located." |
| APP-30 | 소비 워크플로 → 통합 계정 | B2B 아티팩트(스키마·맵) 사용. Consumption은 연결이 필수, Standard는 연결 대신 커넥터 연결 | `workflows`·`workflows/versions`: `integrationAccount` (`{id}`, 대상은 문서로 확인한 `microsoft.logic/integrationaccounts`) | spec:subresource | chip: 워크플로에 '통합 계정 x' | https://learn.microsoft.com/en-us/azure/logic-apps/enterprise-integration/create-integration-account — "link your logic app resource to your integration account" |
| APP-31 | 워크플로·통합 계정 → ISE, ISE → 서브넷 (**퇴역**) | 2024-08-31 퇴역. 남은 참조는 정리 대상 | `workflows`·`integrationaccounts`: `integrationServiceEnvironment`. ISE: `networkConfiguration.subnets[]`(서브넷, 이름 추론), `encryptionConfiguration.encryptionKeyReference.keyVault` | spec:subresource | badge '퇴역(ISE)'. 선은 긋지 않음 | https://learn.microsoft.com/en-us/azure/logic-apps/connect-virtual-network-vnet-isolated-environment-overview — "the ISE resource will retire" |
| APP-32 | Logic Apps Standard = `microsoft.web/sites` | 단일 테넌트 호스팅. 인바운드는 PE(PL-01), 아웃바운드는 VNet 통합(PAAS-01), 워크플로는 `sites/workflows` 자식 | `kind`에 `workflowapp` (테넌트 미확인), 이후는 사이트 행과 같음 | docs | 사이트와 같은 카드 + 칩 'Logic Apps'. 관리형 커넥터 연결은 리전 커넥터 IP로 나감 | https://learn.microsoft.com/en-us/azure/logic-apps/secure-single-tenant-workflow-virtual-network-private-endpoint — "Standard workflows support using private endpoints for inbound traffic" |
| APP-33 | App Configuration 키 → Key Vault 비밀 (참조) | 저장소는 비밀의 **URI만** 보관하고, 앱이 두 서비스에 각각 인증해 직접 읽음 | 없음 — 데이터 평면 키-값(content type Key Vault 참조). ARM 속성 아님 | docs | none(데이터 평면). 앱 → Key Vault 접근은 관측(PL-05)으로만 | https://learn.microsoft.com/en-us/azure/azure-app-configuration/use-key-vault-references-dotnet-core — "The two services don't communicate directly." |
| APP-34 | AI 서비스(Foundry) 계정 → 에이전트 서브넷 | Agent Service의 실행 환경을 고객 서브넷에 주입. **생성할 때만** 설정 가능. 계정 자체의 인바운드는 PE. 고객 서브넷은 `Microsoft.App/environments` 위임, /27 이상, Foundry 리소스마다 전용(Learn: 'The agent subnet can't be shared by multiple Foundry resources'), 같은 리전 | `cognitiveservices/accounts`: `networkInjections[]`의 `{scenario:"agent", subnetArmId, useMicrosoftManagedNetwork}` | spec:arm-id | line: vnetIntegration 문법(계정은 서브넷 밖). 서브넷에 위임 배지(CT-08). `subnetArmId`가 비어 있거나 `useMicrosoftManagedNetwork=true`면 선을 긋지 않는다(관리형 VNet) | https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks (2026-10-15 확인) |
| APP-35 | AI 서비스 계정 → 고객 소유 Storage (BYOS) | Speech·Language 산출물을 고객 Storage에 저장(시스템 관리 ID + 신뢰할 수 있는 서비스). 생성 후 변경 불가, Storage를 지우면 기능이 멈춤 | `accounts`: `userOwnedStorage[].resourceId` | spec:id-string | line-dashed: 데이터 의존 '저장소(BYOS)' | https://learn.microsoft.com/en-us/azure/foundry/how-to/bring-your-own-azure-storage-foundry |
| APP-36 | ML 작업 영역 → Storage · Key Vault · App Insights · ACR | 작업 영역의 기본 의존 리소스. Storage·Key Vault는 생성 후 변경 불가, ACR은 선택 사항 | docs: `workspaces`의 `storageAccount`, `keyVault`, `applicationInsights`, `containerRegistry` (**다이제스트 미수록** — 파서 누락, 문서 설명 "ARM id of …") | docs | panel '연결된 리소스 4' + line-dashed(의존, 기본 끔) | https://learn.microsoft.com/en-us/azure/templates/microsoft.machinelearningservices/workspaces — "ARM id of the storage account associated with this workspace." |
| APP-37 | ML 작업 영역 → Key Vault (CMK) | 고객 관리 키 암호화 | `workspaces`: `encryption.keyVaultProperties.keyVaultArmId` | spec:id-string | chip 'CMK: Key Vault x' | https://learn.microsoft.com/en-us/azure/machine-learning/concept-workspace |
| APP-38 | ML 작업 영역 → 서버리스 컴퓨팅 서브넷 | 서버리스 컴퓨팅 노드를 사용자 지정 VNet 서브넷에 배치(관리형 VNet 권장) | `workspaces`: `serverlessComputeSettings.serverlessComputeCustomSubnet` | spec:arm-id | line: vnetIntegration 문법(작업 영역은 서브넷 밖) | https://learn.microsoft.com/en-us/python/api/azure-ai-ml/azure.ai.ml.entities.serverlesscomputesettings — "ARM ID of the subnet to use for serverless compute(s)" |
| APP-39 | ML 컴퓨팅 → 연결된 외부 컴퓨팅 | AKS·VM·Databricks 등 기존 컴퓨팅을 작업 영역에 연결(attach) | `workspaces/computes`: `resourceId` | spec:id-string | line-dashed: 작업 영역 → 컴퓨팅 '연결됨' | https://learn.microsoft.com/en-us/azure/templates/microsoft.machinelearningservices/workspaces/computes — "ARM resource id of the underlying compute" |
| APP-40 | AI Search / SignalR / Web PubSub / Foundry 계정 / ML 작업 영역 → 대상 (공유 프라이빗 링크·관리형 PE) | **서비스 쪽에서 나가는** 관리형 PE. 고객 VNet·서브넷에는 **나타나지 않음**. 대상 소유자가 승인해야 함. 관리형 PE 공통 규칙: 관리형 PE·공유 프라이빗 링크는 고객 쪽 NIC를 만들지 않는다 — Learn: 'Managed private endpoints … don't create customer-visible network interfaces' (foundry/how-to/managed-virtual-network). 서비스 → 대상 선으로 그리고 서브넷 안에 두지 않는다. 승인 상태는 대상의 `privateEndpointConnections`에서 읽는다 | `searchservices/sharedprivatelinkresources`·`signalr/sharedprivatelinkresources`·`webpubsub/sharedprivatelinkresources`(+`replicas/…`): `privateLinkResourceId`. Foundry·ML 현재 방식: `accounts/managedNetworks/outboundRules`의 `destination.serviceResourceId`(+`subresourceTarget`), 유형 PrivateEndpoint (docs). ML 작업 영역은 `managedNetwork.outboundRules{}.destination.serviceResourceId` (docs). 작업 영역의 `sharedPrivateLinkResources[].privateLinkResourceId`는 레거시 | spec:id-string + docs | line: 서비스 → 대상, 라벨 '공유 PL(아웃바운드)'. PE 서브넷 안에 그리지 않음 | https://learn.microsoft.com/en-us/azure/azure-signalr/howto-shared-private-endpoints — "created inside the SignalR Service execution environment" · https://learn.microsoft.com/en-us/azure/search/search-indexer-howto-access-private · https://learn.microsoft.com/en-us/azure/foundry/how-to/managed-virtual-network |
| APP-41 | Function 앱 → Storage (`AzureWebJobsStorage`) | 런타임 필수 의존성 | 앱 설정(데이터 평면, `config/appsettings/list` 필요): `AzureWebJobsStorage__accountName` 또는 연결 문자열 | docs, fqdnMatch | line(후보가 정확히 1개일 때만), 아니면 패널 '미확인' | https://learn.microsoft.com/azure/azure-functions/storage-considerations |
| APP-42 | Front Door → App Service 잠금 | 오리진을 Front Door만 받게 제한 | `siteConfig.ipSecurityRestrictions[]`: `tag=ServiceTag`, `ipAddress=AzureFrontDoor.Backend`, `headers.x-azure-fdid` | docs | chip 'Front Door 전용'(`x-azure-fdid` 없으면 '다른 Front Door도 허용' 경고) | https://learn.microsoft.com/azure/frontdoor/origin-security |
| APP-43 | APIM → Key Vault | 명명된 값·인증서의 비밀 | `namedValues.keyVault.secretIdentifier`, `certificates.keyVault.secretIdentifier` (URI) | docs, fqdnMatch(`vaultUri`) | line-dashed(키) — 신원 근거는 IDM | https://learn.microsoft.com/azure/api-management/api-management-howto-properties |
| APP-44 | App Service·Function → 컨테이너 레지스트리 | 이미지 pull | `siteConfig.linuxFxVersion` = `DOCKER\|<acr>.azurecr.io/…`, `acrUseManagedIdentityCreds` | docs, fqdnMatch(`loginServer`) | line-dashed | https://learn.microsoft.com/azure/app-service/configure-custom-container |

**스펙에 있지만 의미를 확인하지 못해 행으로 만들지 않은 속성**:
- `serverfarms.network.virtualNetworkSubnetId`: 플랜 단위 통합으로 보이나 문서를 찾지 못함
- `cognitiveservices/accounts.amlWorkspace.resourceId`, `raiMonitorConfig.adxStorageResourceId`
- `accounts/deployments.model.sourceAccount`·`routing.models[].sourceAccount`
- `eventhub` 이외의 네트워크 보안 경계(NSP) 구성 행: `servicebus/namespaces/networksecurityperimeterconfigurations.networkSecurityPerimeter.id`는 NSP 쪽 연결의 반영으로 추정되며, IDM/NET 사전에서 다룰 예정
- `botservice/botservices.msaAppMSIResourceId`
- `communication/communicationservices.linkedDomains[]`: 테넌트 관측 → 이메일 도메인

## 4. 자주 하는 오해

- **"VNet 통합을 하면 앱이 VNet 안에 들어가서 사설로 접근할 수 있다"** → 거짓입니다. 통합은 앱이 **밖으로 나가는** 경로일 뿐이고, 들어오는 사설 접근은 PE로만 됩니다. 그래서 통합 서브넷 NSG의 인바운드 규칙은 앱에 적용되지 않습니다. 근거는 overview-vnet-integration — "used only to make outbound calls from your app into your virtual network". 다이어그램에서는 PAAS-01을 포함이 아니라 선으로 그립니다.
- **"PE를 달면 앱의 아웃바운드도 PE로 나간다"** → 거짓입니다. "The private endpoint is only used for incoming traffic to your app."(overview-private-endpoint) 또한 PE 트래픽에는 접근 제한 규칙(APP-05)이 적용되지 않습니다.
- **"APIM Standard v2를 VNet에 통합하면 내부(Internal) 모드가 된다"** → 거짓입니다. v2 통합은 아웃바운드 전용이고 "gateway, management plane, and developer portal remain publicly accessible"입니다(virtual-network-concepts). 게이트웨이까지 사설로 하려면 클래식 Internal 주입, Premium v2 주입, 또는 인바운드 PE가 필요합니다.
- **"App Configuration이 Key Vault에서 비밀을 꺼내 앱에 준다"** → 거짓입니다. 앱이 두 서비스에 각각 인증해 직접 읽습니다. "The two services don't communicate directly." 따라서 App Configuration → Key Vault 선은 없습니다.
- **"Search·SignalR의 공유 프라이빗 링크는 내 VNet의 Private Endpoint다"** → 거짓입니다. 서비스 실행 환경 안에 만들어지는 아웃바운드 PE라서, 고객 서브넷에 NIC가 생기지 않고 대상 리소스 쪽에서 승인만 합니다(APP-40).
- **"Functions on Container Apps는 `Microsoft.Web/sites` + `managedEnvironmentId`다"** → 지금은 거짓입니다. 현재 문서는 `Microsoft.App/containerApps`에 `kind=functionapp`을 씁니다. `sites.managedEnvironmentId`는 옛 모델의 흔적입니다(APP-12 ⚠).
- **"Event Grid MQTT 라우팅 대상은 같은 네임스페이스의 토픽이다"** → 문서의 ARM 예시는 **사용자 지정 토픽**(`Microsoft.EventGrid/topics`, 같은 리전)입니다. 네임스페이스 토픽은 포털 라우팅 튜토리얼에만 나오고, ARM 속성에 넣을 수 있는지는 미확인입니다(APP-29 ⚠).
- **"App Service 인증서를 Key Vault에서 가져오려면 앱의 관리 ID에 권한을 주면 된다"** → 거짓입니다. 읽는 주체는 App Service 리소스 공급자 서비스 주체입니다(IDM-20, configure-ssl-certificate).

## 5. 이 플랫폼 반영 상태

**이미 그리는 것**:

| 관계 | 구현 |
|---|---|
| PAAS-01 사이트 → 통합 서브넷 (vnetIntegration 선) | `azure.ts` `relEdge("PAAS-01")` |
| PL-01 PE → 사이트·Service Bus·Event Hubs 등 | `relEdge("PL-01")` |
| LOG-02 App Insights → Log Analytics | `relEdge("LOG-02")` |
| LOG-01 진단 설정 | `relEdge("LOG-01")` |
| AGW-05 AGW → App Service FQDN | `azure.ts` |
| Service Bus·Event Hubs·AI 계정의 엔드포인트 호스트 | `azureEndpoints.ts` — 정책 인사이트 DNS 매칭 |

- App Insights 의존성 관측은 `appInsightsDependencyCollector.ts`가, 추정 연결은 `dependencyInference.ts`(점선)가 담당합니다.
- API Management·Event Grid·Logic Apps·App Configuration·AI 서비스·ML은 아직 종류(kind) 매핑이 없어 일반 리소스로만 보입니다.

**다음에 추가할 것 (우선순위순)**:

1. **APP-01 플랜 흡수** (`sites.serverFarmId`, 테넌트 ✓). 비용이 가장 낮고 효과가 큽니다. 같은 플랜의 앱이 함께 확장·장애를 겪는다는 사실, 그리고 통합 서브넷은 플랜 하나만 쓸 수 있다는 제약(APP-03)을 보여 줍니다. 구성도 타일 '앱 n'과 라이브 카드 칩으로 표시합니다.
2. **APP-15/16 APIM 네트워크 모드**. `virtualNetworkConfiguration.subnetResourceId`에 SKU와 `virtualNetworkType`을 함께 읽어 처리합니다.
   - 클래식·Premium v2 주입은 contain으로 그립니다.
   - v2 통합은 PAAS-01과 같은 선으로 그립니다.
   - 통합을 포함으로 그리면 "APIM이 사설이다"라는 오해를 만듭니다.
   - v2의 통합과 주입은 같은 속성을 쓰므로 서브넷 위임(`Microsoft.Web/serverFarms` / `Microsoft.Web/hostingEnvironments`)으로 구분합니다. `virtualNetworkType` 값과 두 방식의 대응은 아직 미검증입니다.
3. **APP-28 Event Grid 구독 선**. 토픽·시스템 토픽 → 핸들러(Function·Service Bus·Event Hubs·Storage 큐)를 그립니다. 이벤트 흐름은 이 영역에서 가장 중요한 실제 데이터 경로입니다.
   - `destination.properties.resourceId`는 다형 스키마라 스펙 파서가 놓쳤습니다. 이 경로를 파서 허용 목록에 넣어야 합니다.
   - 이벤트 구독은 확장 리소스입니다. Resource Graph로 조회할 수 있는지는 **미확인**이므로 ARM 목록 호출이 필요할 수 있습니다.
4. **APP-25 Event Hubs Capture → Storage** (점선, 데이터 내보내기). 리전을 넘는 데이터 이동을 보여 줘 보안 검토에 쓸모가 있습니다.
5. **APP-22/23 Service Bus·Event Hubs 네트워크 규칙 칩**: 허용 서브넷 수·IP 수·`defaultAction`·`publicNetworkAccess`. SEC-05(서비스 엔드포인트)와 짝을 이룹니다. 다이제스트에는 `networkRuleSets` 유형 자체가 없으므로 수집 경로를 추가해야 합니다.
6. **APP-40 공유 프라이빗 링크**. 서브넷 밖에서 서비스 → 대상으로 선을 긋습니다. 지금 PE 규칙(PL-01·CT-06)으로 처리하면 고객 서브넷에 없는 PE를 그리는 오류가 납니다.
7. **APP-36 ML 의존 리소스 패널**과 **APP-34/38 주입 서브넷 선**. ML 의존 속성(`storageAccount`·`keyVault`·`applicationInsights`·`containerRegistry`)은 스펙에 "ARM id of …" 설명이 있는데도 파서가 놓쳤습니다. 파서가 설명 문구 "ARM id"를 인식하도록 고치면 다른 영역의 누락도 함께 줄어듭니다.
8. **APP-05 접근 제한 칩**, **슬롯별 PE 표시**(PL-01, groupId `sites-<슬롯>`), **APP-31 ISE 퇴역 배지**: 보안·정리 신호용입니다.

**파서(사이 다이제스트) 개선이 필요한 누락**: 이 페이지에서 `docs`로 표시한 행입니다.
- Event Grid `destination`·`deadLetterDestination`, `systemTopics.source`
- Service Bus·Event Hubs `networkRuleSets`
- ML 작업 영역 의존 속성 4개
- ASE `virtualNetwork.id`, 사이트 `hostingEnvironmentProfile.id`

모두 공식 템플릿 참조에 있는 구성 참조입니다.
