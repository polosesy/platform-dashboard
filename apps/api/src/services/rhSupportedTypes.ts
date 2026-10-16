// Resource types Azure Resource Health supports — a snapshot of Microsoft Learn "Supported Resource Types through
// Azure Resource Health" (ms.date 2026-03-11). Used to say, before anyone asks, which resources have no status and
// why: not on the list, or on the list but Azure returned nothing. Lower-case ARM types.
// The page writes two types in the singular — "Microsoft.CDN/profile", "Microsoft.NotificationHubs/namespace"; the
// ARM types are microsoft.cdn/profiles and microsoft.notificationhubs/namespaces (the only types of those names).

export const RH_DOC = {
  url: "https://learn.microsoft.com/azure/service-health/resource-health-checks-resource-types",
  date: "2026-03-11",
};

export const RH_SUPPORTED_TYPES = new Set([
  "microsoft.alertsmanagement/prometheusrulegroups", "microsoft.analysisservices/servers", "microsoft.apimanagement/service",
  "microsoft.appplatform/spring", "microsoft.avs/privateclouds", "microsoft.classiccompute/virtualmachines",
  "microsoft.azurefleet/fleets", "microsoft.fluidrelay/fluidrelayservers", "microsoft.batch/batchaccounts", "microsoft.cache/redis",
  "microsoft.cdn/profiles", "microsoft.classiccompute/domainnames", "microsoft.cognitiveservices/accounts",
  "microsoft.compute/hostgroups/hosts", "microsoft.compute/virtualmachines", "microsoft.compute/virtualmachinescalesets",
  "microsoft.containerservice/managedclusters", "microsoft.dashboard/grafana", "microsoft.datafactory/factories",
  "microsoft.datalakeanalytics/accounts", "microsoft.datalakestore/accounts", "microsoft.datamigration/services",
  "microsoft.datashare/accounts", "microsoft.dbformariadb/servers", "microsoft.dbforpostgresql/flexibleservers",
  "microsoft.dbformysql/servers", "microsoft.dbforpostgresql/servers", "microsoft.dbforpostgresql/servergroupsv2",
  "microsoft.devices/iothubs", "microsoft.digitaltwins/digitaltwinsinstances", "microsoft.documentdb/databaseaccounts",
  "microsoft.easm/workspaces", "microsoft.eventhub/namespaces", "microsoft.extendedlocation/customlocations",
  "microsoft.hdinsight/clusters", "microsoft.healthcareapis/workspaces/dicomservices", "microsoft.hybridcompute/machines",
  "microsoft.hybridnetwork/devices", "microsoft.hybridnetwork/networkfunctions", "microsoft.iotcentral/iotapps",
  "microsoft.insights/scheduledqueryrules", "microsoft.keyvault/vaults", "microsoft.kubernetes/connectedclusters",
  "microsoft.kusto/clusters", "microsoft.machinelearning/webservices", "microsoft.media/mediaservices",
  "microsoft.mobilenetwork/packetcorecontrolplanes", "microsoft.monitor/accounts", "microsoft.network/applicationgateways",
  "microsoft.network/azurefirewalls", "microsoft.network/bastionhosts", "microsoft.network/connections",
  "microsoft.network/dnsresolvers", "microsoft.network/dnsresolvers/inboundendpoints", "microsoft.network/dnsresolvers/outboundendpoints",
  "microsoft.network/dnszones", "microsoft.network/expressroutecircuits", "microsoft.network/expressroutegateways",
  "microsoft.network/frontdoors", "microsoft.network/loadbalancers", "microsoft.network/natgateways",
  "microsoft.network/p2svpngateways", "microsoft.network/trafficmanagerprofiles", "microsoft.network/virtualhubs",
  "microsoft.network/virtualnetworkgateways", "microsoft.network/vpngateways", "microsoft.network/vpngateways/vpnconnections",
  "microsoft.network/vpngateways/vpnconnections/vpnlinkconnections", "microsoft.networkcloud/baremetalmachines",
  "microsoft.networkcloud/clustermanagers", "microsoft.networkcloud/clusters", "microsoft.networkcloud/storageappliances",
  "microsoft.notificationhubs/namespaces", "microsoft.onlineexperimentation/workspaces", "microsoft.operationalinsights/workspaces",
  "microsoft.orbital/contactprofiles", "microsoft.orbital/spacecrafts", "microsoft.powerbidedicated/capacities",
  "microsoft.purview/accounts", "microsoft.redhatopenshift/openshiftclusters", "microsoft.resourceconnector/appliances",
  "microsoft.scom/managedinstances", "microsoft.search/searchservices", "microsoft.servicebus/namespaces",
  "microsoft.servicefabric/clusters", "microsoft.servicefabric/managedclusters", "microsoft.signalrservice/signalr",
  "microsoft.signalrservice/signalr/replicas", "microsoft.signalrservice/webpubsub", "microsoft.storagemover/storagemovers",
  "microsoft.sql/managedinstances", "microsoft.sql/managedinstances/databases", "microsoft.sql/servers/databases",
  "microsoft.storage/storageaccounts", "microsoft.storagecache/caches", "microsoft.streamanalytics/streamingjobs",
  "microsoft.synapse/workspaces", "microsoft.videoindexer/accounts", "microsoft.web/serverfarms", "microsoft.web/sites",
  "microsoft.workloads/monitors", "microsoft.recoveryservices/vaults", "microsoft.voiceservices/communicationsgateway",
]);

// Several types share one generic list on the page
const SERVER_EN = ["Is the server up and running?", "Has the server run out of memory?", "Is the server starting up?", "Is the server recovering?"];
const SERVER_KO = ["서버가 실행 중인가요?", "서버에 메모리가 부족한가요?", "서버가 시작되었나요?", "서버가 복구 중인가요?"];
const VM_EN = ["Is the server hosting this virtual machine up and running?", "Is the virtual machine container provisioned and powered up?", "Is there network connectivity between the host and the storage account?", "Is there ongoing planned maintenance?", "Are there heartbeats between Guest and host agent (if Guest extension is installed)?"];
const VM_KO = ["가상 머신을 호스팅하는 서버가 실행 중인가요?", "가상 머신 컨테이너가 프로비전되고 전원이 공급되나요?", "호스트와 스토리지 계정 간에 네트워크 연결이 되어 있나요?", "진행 중인 계획된 유지 관리가 있나요?", "게스트와 호스트 에이전트 간에 하트비트가 있나요 (게스트 확장이 설치된 경우)?"];
const PG_EN = ["Is the server unavailable due to maintenance?", "Is the server unavailable due to reconfiguration?"];
const PG_KO = ["유지 관리로 인해 서버를 사용할 수 없나요?", "재구성으로 인해 서버를 사용할 수 없나요?"];

/**
 * "Executed Checks" from the same page (en, and the ko-kr page) — only for the types these tenants have; others link
 * to the page. The ko-kr page is machine-translated: its Load Balancer line inverts the English ("…사용할 수 없나요?"
 * for "…available?") — the English is the source, so that one line follows it.
 */
export const RH_CHECKS: Record<string, { en: string[]; ko: string[] }> = {
  "microsoft.alertsmanagement/prometheusrulegroups": { en: SERVER_EN, ko: SERVER_KO },
  "microsoft.cache/redis": {
    en: ["Are all the Cache nodes up and running?", "Can the Cache be reached from within the datacenter?", "Has the Cache reached the maximum number of connections?", "Has the cache exhausted its available memory?", "Is the Cache experiencing a high number of page faults?", "Is the Cache under heavy load?"],
    ko: ["모든 캐시 노드가 실행 중인가요?", "데이터 센터 내에서 캐시에 도달할 수 있나요?", "캐시가 최대 연결 수에 도달했나요?", "캐시가 사용 가능한 메모리를 모두 소모했나요?", "캐시에 많은 수의 페이지 폴트가 있나요?", "캐시에 부하가 큰가요?"],
  },
  "microsoft.cdn/profiles": {
    en: ["Is the supplemental portal accessible for CDN configuration operations?", "Are there ongoing delivery issues with the CDN endpoints?", "Can users change the configuration of their CDN resources?", "Are configuration changes propagating at the expected rate?", "Can users manage the CDN configuration using the Azure portal, PowerShell, or the API?"],
    ko: ["CDN 구성 작업을 위해 보조 포털에 액세스할 수 있나요?", "CDN 엔드포인트에서 진행 중인 배달 문제가 있나요?", "사용자가 CDN 리소스의 구성을 변경할 수 있나요?", "구성 변경 내용이 예상된 속도로 전파되나요?", "사용자가 Azure Portal, PowerShell 또는 API를 사용하여 CDN 구성을 관리할 수 있나요?"],
  },
  "microsoft.cognitiveservices/accounts": {
    en: ["Can the account be reached from within the datacenter?", "Is the Azure AI services resource provider available?", "Is the Cognitive Service available in the appropriate region?", "Can read operations be performed on the storage account holding the resource metadata?", "Has the API call quota been reached?", "Has the API call read-limit been reached?"],
    ko: ["데이터 센터 내에서 계정에 도달할 수 있나요?", "Azure AI 서비스 리소스 공급자를 사용할 수 있나요?", "해당 지역에서 Cognitive Service를 사용할 수 있나요?", "리소스 메타데이터가 있는 스토리지 계정에서 읽기 작업을 수행할 수 있나요?", "API 호출 할당량에 도달했나요?", "API 호출 읽기 제한에 도달했나요?"],
  },
  "microsoft.compute/virtualmachines": { en: VM_EN, ko: VM_KO },
  "microsoft.compute/virtualmachinescalesets": { en: VM_EN, ko: VM_KO },
  "microsoft.containerservice/managedclusters": {
    en: ["Is the cluster up and running?", "Are core services available on the cluster?", "Are all cluster nodes ready?", "Is the service principal current and valid?"],
    ko: ["클러스터가 실행 중인가요?", "클러스터에서 핵심 서비스를 사용할 수 있나요?", "모든 클러스터 노드가 준비되었나요?", "서비스 주체가 최신 상태이고 유효한가요?"],
  },
  "microsoft.dashboard/grafana": { en: SERVER_EN, ko: SERVER_KO },
  "microsoft.dbforpostgresql/flexibleservers": { en: PG_EN, ko: PG_KO },
  "microsoft.eventhub/namespaces": {
    en: ["Is the Event Hubs namespace experiencing user generated errors?", "Is the Event Hubs namespace currently being upgraded?"],
    ko: ["Event Hubs 네임스페이스에 사용자 생성 오류가 발생했나요?", "Event Hubs 네임스페이스가 현재 업그레이드되고 있나요?"],
  },
  "microsoft.insights/scheduledqueryrules": {
    en: ["Is this log search alert rule currently disabled?", "Does this rule runs less frequently than every 15 minutes?", "Is there a semantic, syntax, or validation error in the query?", "Can the target Log Analytics/Application Insights workspace for this alert rule be found?", "Is the alert rule query failing because of throttling (Error 429)?", "Does the query have the correct permissions?"],
    ko: ["이 로그 검색 경고 규칙이 현재 사용하지 않도록 설정되어 있나요?", "이 규칙은 15분 간격보다 덜 자주 실행되나요?", "쿼리에 의미 체계, 구문 또는 유효성 검사 오류가 있나요?", "이 경고 규칙에 대한 대상 Log Analytics/Application Insights 작업 영역을 찾을 수 있나요?", "제한(오류 429)으로 인해 경고 규칙 쿼리가 실패하나요?", "쿼리에 올바른 권한이 있나요?"],
  },
  "microsoft.keyvault/vaults": {
    en: ["Are requests to key vault failing due to Azure KeyVault platform issues?", "Are requests to key vault being throttled due to too many requests made by customer?"],
    ko: ["Azure KeyVault 플랫폼 문제로 인해 키 자격 증명 모음에 대한 요청이 실패하나요?", "고객의 요청이 너무 많아서 키 자격 증명 모음에 대한 요청이 스로틀되나요?"],
  },
  "microsoft.monitor/accounts": { en: SERVER_EN, ko: SERVER_KO },
  "microsoft.network/applicationgateways": {
    en: ["Is performance of the Application Gateway degraded?", "Is the Application Gateway available?"],
    ko: ["Application Gateway 성능이 저하되나요?", "Application Gateway를 사용할 수 있나요?"],
  },
  "microsoft.network/bastionhosts": { en: ["Is the Bastion Host up and running?"], ko: ["베스천 호스트가 실행 중인가요?"] },
  "microsoft.network/connections": {
    en: ["Is the VPN tunnel connected?", "Are there configuration conflicts in the connection?", "Are the pre-shared keys properly configured?", "Is the VPN on-premises device reachable?", "Are there mismatches in the IPSec/IKE security policy?", "Is the S2S VPN connection properly provisioned or in a failed state?", "Is the VNET-to-VNET connection properly provisioned or in a failed state?"],
    ko: ["VPN 터널이 연결되어 있나요?", "연결에 구성 충돌이 있나요?", "미리 공유한 키를 적절히 구성하였나요?", "VPN 온-프레미스 디바이스에 연결할 수 있나요?", "IPSec/IKE 보안 정책에 일치하지 않는 사항이 있나요?", "S2S VPN 연결이 적절히 프로비전되었는가 아니면 실패한 상태인가요?", "VNET-VNET 연결이 적절히 프로비전되었는가 아니면 실패한 상태인가요?"],
  },
  "microsoft.network/dnszones": { en: SERVER_EN, ko: SERVER_KO },
  "microsoft.network/loadbalancers": { en: ["Are the load balancing endpoints available?"], ko: ["부하 분산 엔드포인트를 사용할 수 있나요?"] },
  "microsoft.network/natgateways": { en: ["Are the NAT gateway endpoints available?"], ko: ["NAT Gateway 엔드포인트를 사용할 수 있나요?"] },
  "microsoft.network/virtualnetworkgateways": {
    en: ["Is the VPN gateway reachable from the internet?", "Is the VPN Gateway in standby mode?", "Is the VPN service running on the gateway?"],
    ko: ["인터넷에서 VPN Gateway에 연결할 수 있나요?", "VPN Gateway가 대기 모드인가요?", "VPN 서비스가 게이트웨이에서 실행 중인가요?"],
  },
  "microsoft.operationalinsights/workspaces": { en: ["Are there ingestion delays in the workspace?"], ko: ["작업 영역에 수집 지연이 있나요?"] },
  "microsoft.recoveryservices/vaults": {
    en: ["Are any Backup operations on Backup Items configured in this vault failing due to causes beyond user control?", "Are any Restore operations on Backup Items configured in this vault failing due to causes beyond user control?"],
    ko: ["사용자가 제어할 수 없는 원인으로 인해 이 자격 증명 모음에 구성된 백업 항목에 대한 백업 작업이 실패하나요?", "사용자가 제어할 수 없는 원인으로 인해 이 자격 증명 모음에 구성된 백업 항목에 대한 복원 작업이 실패하나요?"],
  },
  "microsoft.servicebus/namespaces": {
    en: ["Are customers experiencing user generated Service Bus errors?", "Are users experiencing an increase in transient errors due to a Service Bus namespace upgrade?"],
    ko: ["고객에게 사용자가 생성한 Service Bus 오류가 발생하나요?", "Service Bus 네임스페이스 업그레이드로 인해 사용자에게 일시적인 오류가 증가하고 있나요?"],
  },
  "microsoft.storage/storageaccounts": {
    en: ["Are requests to read data from the Storage account failing due to Azure Storage platform issues?", "Are requests to write data to the Storage account failing due to Azure Storage platform issues?", "Is the Storage cluster where the Storage account resides unavailable?"],
    ko: ["Azure Storage 플랫폼 문제로 인해 스토리지 계정에서 데이터를 읽는 요청이 실패하나요?", "Azure Storage 플랫폼 문제로 인해 스토리지 계정에 데이터를 쓰는 요청이 실패하나요?", "스토리지 계정이 있는 스토리지 클러스터를 사용할 수 없나요?"],
  },
  "microsoft.web/serverfarms": {
    en: ["Is the host server up and running?", "Is Internet Information Services running?", "Is the Load balancer running?", "Can the App Service Plan be reached from within the datacenter?", "Is the storage account hosting the sites content for the serverFarm available?"],
    ko: ["호스트 서버가 실행 중인가요?", "인터넷 정보 서비스를 실행 중인가요?", "부하 분산 장치를 실행 중인가요?", "데이터 센터 내에서 App Service 계획에 도달할 수 있나요?", "serverFarm에 대한 사이트 콘텐츠를 호스팅하는 스토리지 계정이 제공되나요?"],
  },
  "microsoft.web/sites": {
    en: ["Is the host server up and running?", "Is Internet Information server running?", "Is the Load balancer running?", "Can the Web App be reached from within the datacenter?", "Is the storage account hosting the site content available?"],
    ko: ["호스트 서버가 실행 중인가요?", "인터넷 정보 서버를 실행 중인가요?", "부하 분산 장치를 실행 중인가요?", "데이터 센터 내에서 Web App에 도달할 수 있나요?", "사이트 콘텐츠를 호스팅하는 스토리지 계정이 제공되나요?"],
  },
};
