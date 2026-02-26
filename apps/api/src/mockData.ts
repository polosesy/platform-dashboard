import type { ArchitectureGraph } from "./types";
import type {
  CostSummary, CostTrendResponse, BudgetsResponse,
  SecureScoreSummary, SecurityAlertsResponse,
  HealthSummary,
} from "@aud/types";

export const mockArchitectureGraph: ArchitectureGraph = {
  generatedAt: new Date().toISOString(),
  nodes: [
    {
      id: "sub:prod",
      kind: "subscription",
      name: "prod-subscription",
      health: "ok"
    },
    {
      id: "rg:core",
      kind: "resourceGroup",
      name: "rg-core",
      health: "ok"
    },
    {
      id: "vnet:core",
      kind: "vnet",
      name: "vnet-core",
      location: "koreacentral",
      health: "ok"
    },
    {
      id: "subnet:app",
      kind: "subnet",
      name: "subnet-app",
      health: "ok"
    },
    {
      id: "aks:platform",
      kind: "aks",
      name: "aks-platform",
      health: "warning",
      metrics: {
        cpuUtil: 62,
        podRestarts: 3
      }
    },
    {
      id: "appgw:edge",
      kind: "appGateway",
      name: "appgw-edge",
      health: "ok",
      metrics: {
        p99LatencyMs: 240,
        rps: 85
      }
    },
    {
      id: "sql:orders",
      kind: "sql",
      name: "sql-orders",
      health: "ok",
      metrics: {
        dtus: 38
      }
    }
  ],
  edges: [
    { id: "e1", source: "sub:prod", target: "rg:core", kind: "contains" },
    { id: "e2", source: "rg:core", target: "vnet:core", kind: "contains" },
    { id: "e3", source: "vnet:core", target: "subnet:app", kind: "contains" },
    { id: "e4", source: "subnet:app", target: "aks:platform", kind: "contains" },
    { id: "e5", source: "subnet:app", target: "appgw:edge", kind: "contains" },
    { id: "e6", source: "aks:platform", target: "sql:orders", kind: "connects" }
  ]
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

// ---------- Health Mock Data ----------

export const mockHealthSummary: HealthSummary = {
  generatedAt: new Date().toISOString(),
  available: 18,
  degraded: 2,
  unavailable: 1,
  unknown: 3,
  resources: [
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-web-01", resourceName: "vm-web-01", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-web-02", resourceName: "vm-web-02", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod", resourceName: "aks-prod", resourceType: "Microsoft.ContainerService/managedClusters", resourceGroup: "rg-prod", availabilityState: "Degraded", summary: "Cluster node pool experiencing intermittent network timeouts" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Sql/servers/sql-prod/databases/orders", resourceName: "orders", resourceType: "Microsoft.Sql/servers/databases", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Cache/redis/redis-prod", resourceName: "redis-prod", resourceType: "Microsoft.Cache/redis", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Network/applicationGateways/appgw-prod", resourceName: "appgw-prod", resourceType: "Microsoft.Network/applicationGateways", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Storage/storageAccounts/stprodblob01", resourceName: "stprodblob01", resourceType: "Microsoft.Storage/storageAccounts", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Web/sites/func-notifications", resourceName: "func-notifications", resourceType: "Microsoft.Web/sites", resourceGroup: "rg-prod", availabilityState: "Unavailable", summary: "Function App experiencing runtime errors. Last healthy check: 15 min ago." },
    { resourceId: "/sub/mock/rg/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod", resourceName: "vnet-prod", resourceType: "Microsoft.Network/virtualNetworks", resourceGroup: "rg-prod", availabilityState: "Available" },
    { resourceId: "/sub/mock/rg/rg-staging/providers/Microsoft.ContainerService/managedClusters/aks-staging", resourceName: "aks-staging", resourceType: "Microsoft.ContainerService/managedClusters", resourceGroup: "rg-staging", availabilityState: "Degraded", summary: "Pending system node pool update" },
    { resourceId: "/sub/mock/rg/rg-staging/providers/Microsoft.Sql/servers/sql-staging/databases/staging-db", resourceName: "staging-db", resourceType: "Microsoft.Sql/servers/databases", resourceGroup: "rg-staging", availabilityState: "Unknown" },
    { resourceId: "/sub/mock/rg/rg-dev/providers/Microsoft.Compute/virtualMachines/vm-dev-01", resourceName: "vm-dev-01", resourceType: "Microsoft.Compute/virtualMachines", resourceGroup: "rg-dev", availabilityState: "Unknown" },
  ],
  note: "mock data",
};
