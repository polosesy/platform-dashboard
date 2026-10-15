import type { ArchitectureGraph } from "@aud/types";
import { relEdge } from "./services/relationships.js";
import type {
  CostSummary, CostTrendResponse, BudgetsResponse,
  SecureScoreSummary, SecurityAlertsResponse, SecurityPostureResponse,
  HealthSummary,
  GlobalStatusResponse,
  ServiceHealthEventsResponse,
  RegionalStatusResponse,
} from "@aud/types";

// ---------- Architecture example (signed-out view) ----------
// Shaped like the real graph (ARM ids under the all-zero sample subscription, so assertArmResourceId answers
// signin_required) and placed by the catalog's rules (docs/architecture/azure-resource-relationships.md):
// regional services carry their region; only Front Door and DNS zones are non-regional ("global").
//   VNet › snet-agw (Application Gateway, public + private frontend) › snet-aks (AKS + its internal LB)
//         › snet-pe (Private Endpoint → SQL) › snet-db (PostgreSQL Flexible, delegated subnet)
//   region PaaS lane: SQL logical server, Key Vault · global: Front Door, private DNS zone
const SAMPLE_SUB = "00000000-0000-0000-0000-000000000000";
const SAMPLE_RG = `/subscriptions/${SAMPLE_SUB}/resourcegroups/rg-sample`;
const SAMPLE_NODE_RG = `/subscriptions/${SAMPLE_SUB}/resourcegroups/mc_rg-sample_aks-sample_koreacentral`;
const arm = (rg: string, type: string, name: string) => `${rg}/providers/${type}/${name}`;
const VNET = arm(SAMPLE_RG, "microsoft.network/virtualnetworks", "vnet-sample");
const SNET = (name: string) => `${VNET}/subnets/${name}`;
const AGW = arm(SAMPLE_RG, "microsoft.network/applicationgateways", "agw-sample");
const PIP_AGW = arm(SAMPLE_RG, "microsoft.network/publicipaddresses", "pip-agw-sample");
const AKS = arm(SAMPLE_RG, "microsoft.containerservice/managedclusters", "aks-sample");
const AKS_VMSS = arm(SAMPLE_NODE_RG, "microsoft.compute/virtualmachinescalesets", "aks-nodepool1-vmss");
const AKS_ILB = arm(SAMPLE_NODE_RG, "microsoft.network/loadbalancers", "kubernetes-internal");
const SQL = arm(SAMPLE_RG, "microsoft.sql/servers", "sql-orders");
const PE_SQL = arm(SAMPLE_RG, "microsoft.network/privateendpoints", "pe-sql-orders");
const PG = arm(SAMPLE_RG, "microsoft.dbforpostgresql/flexibleservers", "pg-orders");
const KV = arm(SAMPLE_RG, "microsoft.keyvault/vaults", "kv-sample");
const FD = arm(SAMPLE_RG, "microsoft.cdn/profiles", "fd-sample");
const DNS = arm(SAMPLE_RG, "microsoft.network/privatednszones", "privatelink.database.windows.net");
const LOC = "koreacentral";

export const mockArchitectureGraph: ArchitectureGraph = {
  generatedAt: new Date().toISOString(),
  nodes: [
    { id: `sub:${SAMPLE_SUB}`, kind: "subscription", name: "sample-subscription", health: "unknown" },
    { id: SAMPLE_RG, kind: "resourceGroup", name: "rg-sample", azureId: SAMPLE_RG, location: LOC, health: "unknown" },
    { id: VNET, kind: "vnet", name: "vnet-sample", azureId: VNET, location: LOC, endpoint: "10.20.0.0/16", resourceGroup: "rg-sample", health: "ok" },
    { id: SNET("snet-agw"), kind: "subnet", name: "snet-agw", azureId: SNET("snet-agw"), location: LOC, endpoint: "10.20.0.0/24", resourceGroup: "rg-sample" },
    { id: SNET("snet-aks"), kind: "subnet", name: "snet-aks", azureId: SNET("snet-aks"), location: LOC, endpoint: "10.20.1.0/24", resourceGroup: "rg-sample" },
    { id: SNET("snet-pe"), kind: "subnet", name: "snet-pe", azureId: SNET("snet-pe"), location: LOC, endpoint: "10.20.2.0/24", resourceGroup: "rg-sample" },
    { id: SNET("snet-db"), kind: "subnet", name: "snet-db", azureId: SNET("snet-db"), location: LOC, endpoint: "10.20.3.0/24", resourceGroup: "rg-sample", metadata: { delegations: ["Microsoft.DBforPostgreSQL/flexibleServers"] } },
    {
      id: AGW, kind: "appGateway", name: "agw-sample", azureId: AGW, location: LOC, endpoint: "10.20.0.10", resourceGroup: "rg-sample", health: "ok",
      metrics: { p99LatencyMs: 240, rps: 85 },
      metadata: {
        inboundRules: 1, privateListeners: 0,
        frontends: [
          { name: "fe-public", kind: "public", ip: "203.0.113.20", publicIpId: PIP_AGW, listeners: ["listener-https"], ruleBound: true },
          { name: "fe-private", kind: "private", ip: "10.20.0.10", listeners: [], ruleBound: false },
        ],
      },
    },
    { id: PIP_AGW, kind: "publicIP", name: "pip-agw-sample", azureId: PIP_AGW, location: LOC, endpoint: "203.0.113.20", resourceGroup: "rg-sample", metadata: { absorbed: true, attachedTo: AGW } },
    {
      id: AKS, kind: "aks", name: "aks-sample", azureId: AKS, location: LOC, resourceGroup: "rg-sample", health: "warning",
      metrics: { cpuUtil: 62, podRestarts: 3 },
      metadata: { nodeResourceGroup: "MC_rg-sample_aks-sample_koreacentral", agentPoolProfiles: [{ name: "nodepool1", mode: "System", count: 3, vnetSubnetId: SNET("snet-aks") }] },
    },
    { id: AKS_VMSS, kind: "vmss", name: "aks-nodepool1-vmss", azureId: AKS_VMSS, location: LOC, resourceGroup: "MC_rg-sample_aks-sample_koreacentral", metadata: { orchestrationMode: "Uniform", capacity: 3, managedBy: "aks" } },
    { id: AKS_ILB, kind: "lb", name: "kubernetes-internal", azureId: AKS_ILB, location: LOC, endpoint: "10.20.1.100", resourceGroup: "MC_rg-sample_aks-sample_koreacentral", metadata: { inboundRules: 1, managedBy: "aks" } },
    { id: SQL, kind: "sql", name: "sql-orders", azureId: SQL, location: LOC, resourceGroup: "rg-sample", health: "ok", metrics: { dtus: 38 } },
    { id: PE_SQL, kind: "privateEndpoint", name: "pe-sql-orders", azureId: PE_SQL, location: LOC, endpoint: "10.20.2.4", resourceGroup: "rg-sample" },
    { id: PG, kind: "postgres", name: "pg-orders", azureId: PG, location: LOC, resourceGroup: "rg-sample", health: "ok" },
    { id: KV, kind: "keyVault", name: "kv-sample", azureId: KV, location: LOC, resourceGroup: "rg-sample" },
    {
      id: FD, kind: "frontDoor", name: "fd-sample", azureId: FD, location: "global", resourceGroup: "rg-sample",
      // Sample WAF coverage (EDGE-10): one domain blocks, one only detects — example.com names only
      metadata: {
        waf: {
          state: "partial", counts: { served: 2, prevent: 1, detect: 1, disabled: 0, none: 0, unknown: 0 },
          policies: [
            { name: "wafsampleprevent", sku: "Premium_AzureFrontDoor", mode: "Prevention", enabled: true, managed: [{ type: "Microsoft_DefaultRuleSet", version: "2.1", action: "Block" }], customRules: 2, domains: ["www.example.com"] },
            { name: "wafsampledetect", sku: "Premium_AzureFrontDoor", mode: "Detection", enabled: true, managed: [{ type: "Microsoft_DefaultRuleSet", version: "2.1", action: "Block" }], customRules: 0, domains: ["api.example.com"] },
          ],
          domains: [
            { host: "api.example.com", kind: "custom", policy: "wafsampledetect", state: "detect" },
            { host: "www.example.com", kind: "custom", policy: "wafsampleprevent", state: "prevent" },
          ],
          unserved: [],
        },
      },
    },
    { id: DNS, kind: "dns", name: "privatelink.database.windows.net", azureId: DNS, location: "global", resourceGroup: "rg-sample" },
  ],
  edges: [
    relEdge("HIER-01", "e:sample:sub-rg", `sub:${SAMPLE_SUB}`, SAMPLE_RG),
    ...[VNET, AGW, PIP_AGW, AKS, SQL, PE_SQL, PG, KV, FD, DNS].map((id, i) => relEdge("HIER-02", `e:sample:rg-${i}`, SAMPLE_RG, id)),
    ...["snet-agw", "snet-aks", "snet-pe", "snet-db"].map((s) => relEdge("CT-01", `e:sample:vnet-${s}`, VNET, SNET(s))),
    relEdge("CT-04", "e:sample:agw-subnet", SNET("snet-agw"), AGW),
    relEdge("AKS-01", "e:sample:aks-subnet", SNET("snet-aks"), AKS),
    relEdge("AKS-02", "e:sample:aks-vmss", AKS, AKS_VMSS),
    relEdge("CT-05", "e:sample:ilb-subnet", SNET("snet-aks"), AKS_ILB),
    // App Gateway backend pool names the AKS internal LB by IP (AGW-04); the LB serves the node pool (LB-02)
    relEdge("AGW-04", "e:sample:agw-ilb", AGW, AKS_ILB, { via: "ip", pool: "pool-aks", address: "10.20.1.100", ports: [80], evidence: "ipMatch", direction: "inbound" }),
    relEdge("LB-02", "e:sample:ilb-vmss", AKS_ILB, AKS_VMSS, { via: "nic", pool: "kubernetes", evidence: "cfg", direction: "inbound", protocol: "TCP" }),
    relEdge("CT-06", "e:sample:pe-subnet", SNET("snet-pe"), PE_SQL),
    relEdge("PL-01", "e:sample:pe-sql", PE_SQL, SQL),
    relEdge("PAAS-02", "e:sample:pg-subnet", SNET("snet-db"), PG),
  ],
};

// ---------- Cost Mock Data ----------

function mockDailyTrend(): CostTrendResponse["data"] {
  const now = new Date();
  const data: CostTrendResponse["data"] = [];
  for (let i = 30; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    data.push({
      date: d.toISOString().slice(0, 10),
      cost: Math.round((800 + Math.random() * 600) * 100) / 100,
      currency: "USD",
    });
  }
  return data;
}

export const mockCostSummary: CostSummary = {
  generatedAt: new Date().toISOString(),
  currency: "USD",
  currentMonthTotal: 12_450.82,
  previousMonthTotal: 11_230.50,
  changePercentage: 10.9,
  forecastedTotal: 14_120.00,
  budgetTotal: 15_000,
  budgetUsedPercentage: 83.0,
  note: "mock data",
};

export const mockCostTrend: CostTrendResponse = {
  generatedAt: new Date().toISOString(),
  granularity: "daily",
  data: mockDailyTrend(),
  note: "mock data",
};

export const mockBudgets: BudgetsResponse = {
  generatedAt: new Date().toISOString(),
  budgets: [
    {
      budgetName: "Production Monthly",
      amount: 15_000,
      currentSpend: 12_450.82,
      forecastedSpend: 14_120.00,
      currency: "USD",
      timeGrain: "Monthly",
      usedPercentage: 83.0,
    },
    {
      budgetName: "Dev/Test Quarterly",
      amount: 5_000,
      currentSpend: 2_180.30,
      forecastedSpend: 3_200.00,
      currency: "USD",
      timeGrain: "Quarterly",
      usedPercentage: 43.6,
    },
  ],
  note: "mock data",
};

// ---------- Security Mock Data ----------

export const mockSecureScore: SecureScoreSummary = {
  generatedAt: new Date().toISOString(),
  currentScore: 72,
  maxScore: 100,
  percentage: 72.0,
  controlScores: [
    { controlName: "Enable MFA", currentScore: 10, maxScore: 10, weight: 5, healthyResourceCount: 24, unhealthyResourceCount: 0 },
    { controlName: "Secure management ports", currentScore: 4, maxScore: 8, weight: 4, healthyResourceCount: 12, unhealthyResourceCount: 6 },
    { controlName: "Apply system updates", currentScore: 6, maxScore: 10, weight: 3, healthyResourceCount: 18, unhealthyResourceCount: 4 },
    { controlName: "Encrypt data in transit", currentScore: 8, maxScore: 8, weight: 4, healthyResourceCount: 22, unhealthyResourceCount: 0 },
    { controlName: "Restrict network access", currentScore: 5, maxScore: 10, weight: 5, healthyResourceCount: 14, unhealthyResourceCount: 8 },
    { controlName: "Enable endpoint protection", currentScore: 7, maxScore: 10, weight: 3, healthyResourceCount: 16, unhealthyResourceCount: 3 },
    { controlName: "Enable auditing & logging", currentScore: 9, maxScore: 10, weight: 2, healthyResourceCount: 20, unhealthyResourceCount: 1 },
    { controlName: "Manage access & permissions", currentScore: 6, maxScore: 8, weight: 4, healthyResourceCount: 15, unhealthyResourceCount: 3 },
  ],
  note: "mock data",
};

export const mockSecurityAlerts: SecurityAlertsResponse = {
  generatedAt: new Date().toISOString(),
  totalActive: 5,
  bySeverity: { high: 1, medium: 2, low: 1, informational: 1 },
  alerts: [
    {
      id: "sa-001",
      alertName: "Suspicious sign-in from anonymous IP",
      severity: "High",
      status: "Active",
      compromisedEntity: "user@contoso.com",
      description: "A sign-in attempt from an anonymous IP address was detected. This may indicate a credential theft attack.",
      detectedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      tactics: ["InitialAccess"],
    },
    {
      id: "sa-002",
      alertName: "Unusual resource deployment in subscription",
      severity: "Medium",
      status: "Active",
      compromisedEntity: "sub-prod-01",
      description: "An unusual number of resources were deployed in the subscription. Review the recent deployments.",
      detectedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      tactics: ["Execution"],
    },
    {
      id: "sa-003",
      alertName: "SQL injection attempt detected",
      severity: "Medium",
      status: "Active",
      compromisedEntity: "sql-orders",
      description: "Potential SQL injection pattern detected in Application Gateway logs for sql-orders database endpoint.",
      detectedAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
      tactics: ["InitialAccess", "Execution"],
    },
    {
      id: "sa-004",
      alertName: "Network Security Group rule modified",
      severity: "Low",
      status: "Active",
      compromisedEntity: "nsg-app-subnet",
      description: "An NSG rule allowing inbound traffic from 0.0.0.0/0 was added. Verify this is intentional.",
      detectedAt: new Date(Date.now() - 12 * 3600_000).toISOString(),
      tactics: ["DefenseEvasion"],
    },
    {
      id: "sa-005",
      alertName: "Key Vault access from unusual location",
      severity: "Informational",
      status: "Active",
      compromisedEntity: "kv-prod-secrets",
      description: "Key Vault secrets were accessed from an unusual geographic location. Verify the accessing identity.",
      detectedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
      tactics: ["CredentialAccess"],
    },
  ],
  note: "mock data",
};

export const mockSecurityPosture: SecurityPostureResponse = {
  generatedAt: new Date().toISOString(),
  source: "mock",
  score: { current: 26.4, max: 43, percentage: 61.4 },
  controls: mockSecureScore.controlScores,
  recommendations: [
    {
      key: "mock-priv-roles", title: "Privileged roles should not have permanent access at the subscription and resource group level",
      severity: "High", domain: "identity", threats: ["AccountBreach", "ElevationOfPrivilege"], unhealthy: 6, healthy: 2,
      samples: [{ name: "sub-prod-01", type: "subscription", resourceGroup: "" }], portalUrl: "https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade",
      remediation: "Use Entra PIM to make privileged role assignments eligible instead of permanent.",
    },
    {
      key: "mock-mgmt-ports", title: "Management ports should be closed on your virtual machines",
      severity: "Medium", domain: "network", threats: ["ThreatResistance"], unhealthy: 4, healthy: 12,
      samples: [{ name: "vm-jump-01", type: "virtualMachines", resourceGroup: "rg-core" }], portalUrl: "https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade",
    },
    {
      key: "mock-storage-public", title: "Storage accounts should restrict network access",
      severity: "Medium", domain: "data", threats: ["DataExfiltration", "DataSpillage"], unhealthy: 3, healthy: 5,
      samples: [{ name: "stlogs01", type: "storageAccounts", resourceGroup: "rg-data" }], portalUrl: "https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade",
    },
    {
      key: "mock-host-encryption", title: "Virtual machines and virtual machine scale sets should have encryption at host enabled",
      severity: "Medium", domain: "compute", threats: ["DataSpillage"], unhealthy: 8, healthy: 0,
      samples: [{ name: "vm-app-01", type: "virtualMachines", resourceGroup: "rg-app" }], portalUrl: "https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade",
    },
    {
      key: "mock-aks-rbac", title: "Azure Kubernetes Service clusters should have Defender profile enabled",
      severity: "High", domain: "container", threats: ["MissingCoverage"], unhealthy: 1, healthy: 0,
      samples: [{ name: "aks-platform", type: "managedClusters", resourceGroup: "rg-aks" }], portalUrl: "https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade",
    },
  ],
  compliance: [
    { name: "Microsoft-cloud-security-benchmark", state: "Failed", passed: 38, failed: 24, skipped: 0 },
    { name: "SOC-2", state: "Failed", passed: 33, failed: 14, skipped: 0 },
  ],
  plans: [
    { name: "CloudPosture", tier: "Standard" },
    { name: "Containers", tier: "Free" },
    { name: "VirtualMachines", tier: "Free" },
  ],
  alerts: mockSecurityAlerts.alerts.map((a) => ({
    id: a.id, title: a.alertName, severity: a.severity, status: a.status, intent: a.tactics[0], detectedAt: a.detectedAt,
    description: a.description, resources: [{ name: a.compromisedEntity, type: "resource", resourceGroup: "" }],
  })),
  gaps: [],
  note: "mock data",
};

// ---------- Health Mock Data ----------

export const mockHealthSummary: HealthSummary = {
  generatedAt: new Date().toISOString(),
  available: 9,
  degraded: 2,
  unavailable: 1,
  unknown: 2,
  subscriptions: ["00000000-0000-0000-0000-000000000000"],
  resources: [
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-web-01", resourceName: "vm-web-01", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-web-02", resourceName: "vm-web-02", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod", resourceName: "aks-prod", resourceType: "Microsoft.ContainerService/managedClusters", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Degraded", summary: "Cluster node pool experiencing intermittent network timeouts", reasonType: "Unplanned", reasonChronicity: "Persistent" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Sql/servers/sql-prod/databases/orders", resourceName: "orders", resourceType: "Microsoft.Sql/servers/databases", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Cache/redis/redis-prod", resourceName: "redis-prod", resourceType: "Microsoft.Cache/redis", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/applicationGateways/appgw-prod", resourceName: "appgw-prod", resourceType: "Microsoft.Network/applicationGateways", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/stprodblob01", resourceName: "stprodblob01", resourceType: "Microsoft.Storage/storageAccounts", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Web/sites/func-notifications", resourceName: "func-notifications", resourceType: "Microsoft.Web/sites", resourceGroup: "rg-prod", subscriptionId: "mock", location: "germanywestcentral", availabilityState: "Unavailable", summary: "Function App experiencing runtime errors. Last healthy check: 15 min ago.", reasonType: "Unplanned", reasonChronicity: "Transient" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod", resourceName: "vnet-prod", resourceType: "Microsoft.Network/virtualNetworks", resourceGroup: "rg-prod", subscriptionId: "mock", location: "koreacentral", availabilityState: "Available" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-staging/providers/Microsoft.ContainerService/managedClusters/aks-staging", resourceName: "aks-staging", resourceType: "Microsoft.ContainerService/managedClusters", resourceGroup: "rg-staging", subscriptionId: "mock", location: "koreacentral", availabilityState: "Degraded", summary: "Pending system node pool update", reasonType: "Planned", reasonChronicity: "Transient" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-staging/providers/Microsoft.Sql/servers/sql-staging/databases/staging-db", resourceName: "staging-db", resourceType: "Microsoft.Sql/servers/databases", resourceGroup: "rg-staging", subscriptionId: "mock", location: "eastus2", availabilityState: "Unknown" },
    { resourceId: "/subscriptions/mock/resourceGroups/rg-dev/providers/Microsoft.Compute/virtualMachines/vm-dev-01", resourceName: "vm-dev-01", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-dev", subscriptionId: "mock", location: "westeurope", availabilityState: "Unknown" },
  ],
  note: "mock data",
};

// ---------- Health — Global Status Mock ----------

export const mockGlobalStatus: GlobalStatusResponse = {
  generatedAt: new Date().toISOString(),
  activeIncidents: 0,
  incidents: [],
  note: "mock data — no active incidents",
};

// ---------- Health — Service Health Events Mock ----------

export const mockServiceHealthEvents: ServiceHealthEventsResponse = {
  generatedAt: new Date().toISOString(),
  totalEvents: 3,
  byType: { serviceIssue: 1, plannedMaintenance: 1, healthAdvisory: 1, securityAdvisory: 0 },
  events: [
    {
      id: "mock-evt-001",
      eventType: "ServiceIssue",
      title: "Azure Kubernetes Service — Connectivity Issue in Korea Central",
      summary: "Some customers using AKS in Korea Central may experience intermittent connectivity issues. Engineering teams are actively investigating the root cause.",
      status: "Active",
      level: "Error",
      impactStartTime: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      lastUpdateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
      affectedServices: ["Azure Kubernetes Service"],
      affectedRegions: ["Korea Central"],
      isResolved: false,
    },
    {
      id: "mock-evt-002",
      eventType: "PlannedMaintenance",
      title: "Azure SQL Database — Planned Maintenance Window",
      summary: "Routine maintenance for Azure SQL Database in East US 2. Expected duration: 2 hours. Minimal impact is anticipated with automatic failover enabled.",
      status: "Active",
      level: "Informational",
      impactStartTime: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      impactMitigationTime: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      lastUpdateTime: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      affectedServices: ["Azure SQL Database"],
      affectedRegions: ["East US 2"],
      isResolved: false,
    },
    {
      id: "mock-evt-003",
      eventType: "HealthAdvisory",
      title: "Azure App Service — Managed Certificate Rotation Advisory",
      summary: "Managed SSL certificates for Azure App Service will undergo routine rotation. Action required for customers using certificate pinning in their applications.",
      status: "Active",
      level: "Warning",
      impactStartTime: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      lastUpdateTime: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      affectedServices: ["Azure App Service"],
      affectedRegions: ["Korea Central", "East US", "West Europe"],
      isResolved: false,
    },
  ],
  note: "mock data",
  tenantId: "00000000-0000-0000-0000-000000000001",
};

// ---------- Health — Regional Status Mock ----------
// Matches mock resources: koreacentral, eastus2, westeurope, germanywestcentral

export const mockRegionalStatus: RegionalStatusResponse = {
  generatedAt: new Date().toISOString(),
  totalAffected: 2,
  regions: [
    {
      name: "koreacentral",
      displayName: "Korea Central",
      hasActiveIssues: true,
      serviceIssueCount: 1,
      maintenanceCount: 0,
      affectedServices: ["Azure Kubernetes Service"],
      events: [
        {
          id: "mock-evt-001",
          eventType: "ServiceIssue",
          title: "Azure Kubernetes Service — Connectivity Issue in Korea Central",
          summary: "Some customers using AKS in Korea Central may experience intermittent connectivity issues.",
          status: "Active",
          level: "Error",
          impactStartTime: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          lastUpdateTime: new Date(Date.now() - 30 * 60_000).toISOString(),
          affectedServices: ["Azure Kubernetes Service"],
          affectedRegions: ["Korea Central"],
          isResolved: false,
        },
      ],
    },
    {
      name: "eastus2",
      displayName: "East US 2",
      hasActiveIssues: true,
      serviceIssueCount: 0,
      maintenanceCount: 1,
      affectedServices: ["Azure SQL Database"],
      events: [
        {
          id: "mock-evt-002",
          eventType: "PlannedMaintenance",
          title: "Azure SQL Database — Planned Maintenance Window",
          summary: "Routine maintenance for Azure SQL Database in East US 2.",
          status: "Active",
          level: "Informational",
          impactStartTime: new Date(Date.now() + 24 * 3_600_000).toISOString(),
          impactMitigationTime: new Date(Date.now() + 26 * 3_600_000).toISOString(),
          lastUpdateTime: new Date(Date.now() - 12 * 3_600_000).toISOString(),
          affectedServices: ["Azure SQL Database"],
          affectedRegions: ["East US 2"],
          isResolved: false,
        },
      ],
    },
    {
      name: "westeurope",
      displayName: "West Europe",
      hasActiveIssues: false,
      serviceIssueCount: 0,
      maintenanceCount: 0,
      affectedServices: [],
      events: [],
    },
    {
      name: "germanywestcentral",
      displayName: "Germany West Central",
      hasActiveIssues: false,
      serviceIssueCount: 0,
      maintenanceCount: 0,
      affectedServices: [],
      events: [],
    },
  ],
  note: "mock data — configure AZURE_AD_* and AZURE_SUBSCRIPTION_IDS for real data",
};
