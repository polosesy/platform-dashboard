import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  LiveNode,
  LiveEdge,
  LiveAlert,
  AlertRuleInfo,
  EdgeTrafficLevel,
  PowerState,
  SubResource,
} from "@aud/types";

// ────────────────────────────────────────────
// Mock Diagram Spec — Network-Centric Architecture (Azure Official)
//
// Layout:
// ┌── VNet: prod-vnet (10.0.0.0/16) ────────────────────────────────────────────────────┐
// │ ┌── gw-subnet (10.0.0.0/24) ────┐ ┌── app-subnet (10.0.1.0/24) ──────────────────┐ │
// │ │ [App Gateway]                  │ │ [AKS NodePool]     [Functions]                │ │
// │ │   └ nic-appgw (chip)           │ │   └ nic-nodepool     └ nic-func (chip)        │ │
// │ └────────────────────────────────┘ │ [PE-sql]            [PE-redis]                │ │
// │                                    └───────────────────────────────────────────────┘ │
// └──────────────────────────────────────────────────────────────────────────────────────┘
//
// [AKS Control Plane] ──Manages──> [AKS NodePool]  (control plane is Azure-managed, external)
// [SQL Database] ──privateLink── PE-sql      [Redis Cache] ──privateLink── PE-redis
// [Blob Storage]   (no PE, general placement)
// ────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 80;
const NODE_H_SUB = 102; // node height with sub-resource chip row
const SUBNET_PAD = 30;
const SUBNET_HEAD = 44;
const VNET_PAD = 30;
const VNET_HEAD = 48;
const GAP = 16;

// Subnet sizes
// gw-subnet: AppGW (with NIC chip)
const GW_SUB_W = NODE_W + 2 * SUBNET_PAD;
const GW_SUB_H = SUBNET_HEAD + NODE_H_SUB + SUBNET_PAD;

// app-subnet: 2 compute nodes (with NIC chips) + 2 PE nodes
const APP_SUB_W = 2 * NODE_W + 2 * SUBNET_PAD + GAP;
const APP_SUB_H = SUBNET_HEAD + NODE_H_SUB + GAP + NODE_H + SUBNET_PAD;

// VNet size
const VNET_W = VNET_PAD + GW_SUB_W + 24 + APP_SUB_W + VNET_PAD;
const VNET_H = VNET_HEAD + Math.max(GW_SUB_H, APP_SUB_H) + VNET_PAD + 10;

// PaaS positions (below VNet, aligned near app-subnet where PEs live)
const PAAS_Y = 40 + VNET_H + 40;
const APP_SUBNET_ABS_X = 40 + VNET_PAD + GW_SUB_W + 24; // Absolute X of app-subnet

export const mockDiagramSpec: DiagramSpec = {
  version: "1.0",
  id: "prod-infra",
  name: "Production Infrastructure",
  createdAt: "2026-02-23T00:00:00Z",
  updatedAt: "2026-02-23T00:00:00Z",
  nodes: [
    // ── VNet (group) ──
    {
      id: "prod-vnet",
      label: "prod-vnet",
      icon: "vnet",
      nodeType: "group",
      width: VNET_W,
      height: VNET_H,
      endpoint: "10.0.0.0/16",
      position: { x: 40, y: 40 },
      bindings: {},
      metadata: { addressSpace: "10.0.0.0/16" },
    },
    // ── Gateway Subnet (group, inside VNet) ──
    {
      id: "gw-subnet",
      label: "gw-subnet",
      icon: "subnet",
      nodeType: "group",
      parentId: "prod-vnet",
      width: GW_SUB_W,
      height: GW_SUB_H,
      endpoint: "10.0.0.0/24",
      position: { x: VNET_PAD, y: VNET_HEAD },
      bindings: {},
      metadata: { prefix: "10.0.0.0/24" },
    },
    // ── App Subnet (group, inside VNet) ──
    {
      id: "app-subnet",
      label: "app-subnet",
      icon: "subnet",
      nodeType: "group",
      parentId: "prod-vnet",
      width: APP_SUB_W,
      height: APP_SUB_H,
      endpoint: "10.0.1.0/24",
      position: { x: VNET_PAD + GW_SUB_W + 24, y: VNET_HEAD },
      bindings: {},
      metadata: { prefix: "10.0.1.0/24" },
    },
    // ── App Gateway (inside gw-subnet, with NIC + Frontend IP as subResources) ──
    {
      id: "appgw",
      label: "Application Gateway",
      icon: "appGateway",
      groupId: "ingress",
      parentId: "gw-subnet",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/applicationGateways/appgw-prod",
      endpoint: "10.0.0.4",
      position: { x: SUBNET_PAD, y: SUBNET_HEAD },
      bindings: {
        rps: { source: "monitor", metric: "Throughput", aggregation: "total" },
        latency: { source: "monitor", metric: "BackendLastByteResponseTime", aggregation: "p95" },
        health: { source: "composite", rules: [
          { metric: "rps", op: ">", threshold: 0, weight: 0.5 },
          { metric: "latency", op: "<", threshold: 500, weight: 0.5 },
        ]},
      },
      metadata: { privateIP: "10.0.0.4" },
      subResources: [
        {
          id: "nic-appgw",
          label: "nic-appgw-prod",
          kind: "nic",
          endpoint: "10.0.0.4",
          azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/nic-appgw",
        },
        {
          id: "feip-appgw",
          label: "Frontend IP",
          kind: "frontendIP",
          endpoint: "20.0.0.1",
        },
      ] as SubResource[],
    },
    // ── AKS Control Plane (Azure-managed, OUTSIDE VNet — official Azure architecture) ──
    {
      id: "aks",
      label: "AKS Control Plane",
      icon: "aks",
      groupId: "compute",
      // No parentId — control plane is managed by Azure, external to user VNet
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod",
      endpoint: "aks-prod.hcp.koreacentral.azmk8s.io",
      position: { x: APP_SUBNET_ABS_X + 2 * (NODE_W + 36), y: PAAS_Y },
      bindings: {
        cpu: { source: "monitor", metric: "node_cpu_usage_percentage", aggregation: "avg" },
        memory: { source: "monitor", metric: "node_memory_rss_percentage", aggregation: "avg" },
        pods: { source: "monitor", metric: "kube_pod_status_ready", aggregation: "avg" },
        health: { source: "composite", rules: [
          { metric: "cpu", op: "<", threshold: 80, weight: 0.4 },
          { metric: "memory", op: "<", threshold: 85, weight: 0.3 },
          { metric: "pods", op: ">", threshold: 10, weight: 0.3 },
        ]},
      },
      metadata: { dnsName: "aks-prod.hcp.koreacentral.azmk8s.io" },
    },
    // ── AKS NodePool / VMSS (inside app-subnet — worker nodes in user VNet) ──
    {
      id: "aks-nodepool",
      label: "AKS NodePool",
      icon: "vmss",
      groupId: "compute",
      parentId: "app-subnet",
      azureResourceId: "/subscriptions/mock/resourceGroups/MC_rg-prod_aks-prod_koreacentral/providers/Microsoft.Compute/virtualMachineScaleSets/aks-nodepool1",
      endpoint: "10.0.1.10",
      position: { x: SUBNET_PAD, y: SUBNET_HEAD },
      bindings: {
        health: { source: "composite", rules: [] },
      },
      metadata: { privateIP: "10.0.1.10" },
      subResources: [
        {
          id: "nic-aks-nodepool",
          label: "nic-nodepool-prod",
          kind: "nic",
          endpoint: "10.0.1.10",
          azureResourceId: "/subscriptions/mock/resourceGroups/MC_rg-prod_aks-prod_koreacentral/providers/Microsoft.Network/networkInterfaces/nic-aks-nodepool",
        },
      ] as SubResource[],
    },
    // ── Functions (inside app-subnet, with NIC as subResource) ──
    {
      id: "func",
      label: "Functions",
      icon: "functionApp",
      groupId: "compute",
      parentId: "app-subnet",
      endpoint: "func-prod.azurewebsites.net",
      position: { x: SUBNET_PAD + NODE_W + GAP, y: SUBNET_HEAD },
      bindings: {
        executions: { source: "monitor", metric: "FunctionExecutionCount", aggregation: "total" },
        errors: { source: "monitor", metric: "FunctionExecutionUnits", aggregation: "total" },
        health: { source: "composite", rules: [
          { metric: "executions", op: ">", threshold: 0, weight: 0.6 },
          { metric: "errors", op: "<", threshold: 100, weight: 0.4 },
        ]},
      },
      subResources: [
        {
          id: "nic-func",
          label: "nic-func-prod",
          kind: "nic",
          endpoint: "10.0.1.20",
          azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/networkInterfaces/nic-func",
        },
      ] as SubResource[],
    },
    // ── Private Endpoints (inside app-subnet) ──
    {
      id: "pe-sql",
      label: "PE-sql-prod",
      icon: "privateEndpoint",
      groupId: "data",
      parentId: "app-subnet",
      endpoint: "10.0.1.50",
      position: { x: SUBNET_PAD, y: SUBNET_HEAD + NODE_H_SUB + GAP },
      bindings: { health: { source: "composite", rules: [] } },
      metadata: { privateIP: "10.0.1.50" },
    },
    {
      id: "pe-redis",
      label: "PE-redis-prod",
      icon: "privateEndpoint",
      groupId: "data",
      parentId: "app-subnet",
      endpoint: "10.0.1.51",
      position: { x: SUBNET_PAD + NODE_W + GAP, y: SUBNET_HEAD + NODE_H_SUB + GAP },
      bindings: { health: { source: "composite", rules: [] } },
      metadata: { privateIP: "10.0.1.51" },
    },
    // ── PaaS resources (outside VNet, positioned near app-subnet PEs) ──
    {
      id: "sql",
      label: "SQL Database",
      icon: "sql",
      groupId: "data",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Sql/servers/sql-prod/databases/orders",
      endpoint: "sql-prod.database.windows.net",
      position: { x: APP_SUBNET_ABS_X, y: PAAS_Y },
      bindings: {
        dtu: { source: "monitor", metric: "dtu_consumption_percent", aggregation: "avg" },
        connections: { source: "monitor", metric: "connection_successful", aggregation: "total" },
        health: { source: "composite", rules: [
          { metric: "dtu", op: "<", threshold: 90, weight: 0.6 },
          { metric: "connections", op: ">", threshold: 0, weight: 0.4 },
        ]},
      },
    },
    {
      id: "redis",
      label: "Redis Cache",
      icon: "redis",
      groupId: "data",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Cache/redis/redis-prod",
      endpoint: "redis-prod.redis.cache.windows.net",
      position: { x: APP_SUBNET_ABS_X + NODE_W + 36, y: PAAS_Y },
      bindings: {
        cpu: { source: "monitor", metric: "percentProcessorTime", aggregation: "avg" },
        memory: { source: "monitor", metric: "usedmemorypercentage", aggregation: "avg" },
        health: { source: "composite", rules: [
          { metric: "cpu", op: "<", threshold: 70, weight: 0.5 },
          { metric: "memory", op: "<", threshold: 80, weight: 0.5 },
        ]},
      },
    },
    {
      id: "storage",
      label: "Blob Storage",
      icon: "storage",
      groupId: "data",
      endpoint: "stprod.blob.core.windows.net",
      position: { x: 40, y: PAAS_Y },
      bindings: {
        transactions: { source: "monitor", metric: "Transactions", aggregation: "total" },
        health: { source: "composite", rules: [
          { metric: "transactions", op: ">", threshold: 0, weight: 1.0 },
        ]},
      },
    },
  ],
  edges: [
    {
      id: "appgw->aks",
      source: "appgw",
      target: "aks",
      label: "HTTPS",
      protocol: "HTTPS",
      bindings: {
        throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" },
        latency: { source: "monitor", metric: "BackendConnectTime", aggregation: "avg" },
        errorRate: { source: "appInsights", metric: "requests/failed", aggregation: "rate" },
      },
      animation: "flow",
      alerts: [{ condition: "errorRate > 5", severity: "critical" }],
    },
    {
      id: "appgw->func",
      source: "appgw",
      target: "func",
      label: "HTTPS",
      protocol: "HTTPS",
      bindings: {
        throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" },
      },
      animation: "flow",
    },
    // ── Private Link edges: PE → PaaS target ──
    {
      id: "pe-sql->sql",
      source: "pe-sql",
      target: "sql",
      label: "Private Link",
      edgeKind: "privateLink",
      bindings: {},
      animation: "dash",
    },
    {
      id: "pe-redis->redis",
      source: "pe-redis",
      target: "redis",
      label: "Private Link",
      edgeKind: "privateLink",
      bindings: {},
      animation: "dash",
    },
    // ── AKS Control Plane → NodePool (Manages relationship) ──
    {
      id: "aks->aks-nodepool",
      source: "aks",
      target: "aks-nodepool",
      label: "Manages",
      edgeKind: "network",
      bindings: {},
      animation: "dash",
    },
    // ── Service edges: compute → data (from nodepool pods) ──
    {
      id: "aks-nodepool->pe-sql",
      source: "aks-nodepool",
      target: "pe-sql",
      label: "10.0.1.10 → PE-sql",
      protocol: "TCP",
      edgeKind: "network",
      bindings: {
        throughput: { source: "monitor", metric: "BytesSent", aggregation: "total" },
        latency: { source: "appInsights", metric: "dependencies/duration", aggregation: "p95" },
      },
      animation: "flow",
      alerts: [{ condition: "latency > 500", severity: "warning" }],
    },
    {
      id: "aks-nodepool->pe-redis",
      source: "aks-nodepool",
      target: "pe-redis",
      label: "10.0.1.10 → PE-redis",
      protocol: "TCP",
      edgeKind: "network",
      bindings: {
        throughput: { source: "monitor", metric: "BytesSent", aggregation: "total" },
      },
      animation: "flow",
    },
    {
      id: "func->storage",
      source: "func",
      target: "storage",
      label: "HTTPS",
      protocol: "HTTPS",
      bindings: {
        throughput: { source: "monitor", metric: "Transactions", aggregation: "total" },
      },
      animation: "flow",
    },
    {
      id: "func->pe-sql",
      source: "func",
      target: "pe-sql",
      label: "func-prod → PE-sql",
      protocol: "TCP",
      edgeKind: "network",
      bindings: {},
      animation: "dash",
    },
  ],
  groups: [
    { id: "network", label: "Networking", layout: "row" },
    { id: "ingress", label: "Ingress", layout: "row" },
    { id: "compute", label: "Compute", layout: "column" },
    { id: "data", label: "Data", layout: "column" },
  ],
  settings: {
    refreshIntervalSec: 30,
    defaultTimeRange: "5m",
    layout: "manual",
  },
};

// ────────────────────────────────────────────
// Mock Live Snapshot Generator (randomized)
// ────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function mockTrafficLevel(throughput: number): EdgeTrafficLevel {
  if (throughput > 20_000_000) return "burst";
  if (throughput > 10_000_000) return "high";
  if (throughput > 2_000_000) return "medium";
  if (throughput > 0) return "low";
  return "none";
}

export function generateMockSnapshot(): LiveDiagramSnapshot {
  const aksHealth = rand(0, 100) > 20;
  const sqlLatencySpike = rand(0, 100) > 85;

  const nodes: LiveNode[] = [
    {
      id: "appgw",
      health: "ok",
      healthScore: 0.92,
      metrics: { rps: rand(800, 1500), latency: rand(20, 80) },
      activeAlertIds: [],
      powerState: "running" as PowerState,
    },
    {
      id: "aks",
      health: aksHealth ? "ok" : "warning",
      healthScore: aksHealth ? rand(0.7, 0.95) : rand(0.4, 0.65),
      metrics: {
        cpu: aksHealth ? rand(30, 65) : rand(72, 92),
        memory: aksHealth ? rand(40, 70) : rand(78, 94),
        pods: rand(18, 30),
      },
      activeAlertIds: aksHealth ? [] : ["alert-001"],
      powerState: "running" as PowerState,
    },
    {
      id: "aks-nodepool",
      health: aksHealth ? "ok" : "warning",
      healthScore: aksHealth ? rand(0.75, 0.98) : rand(0.4, 0.65),
      metrics: {},
      activeAlertIds: aksHealth ? [] : ["alert-001"],
      powerState: "running" as PowerState,
    },
    {
      id: "func",
      health: "ok",
      healthScore: 0.82,
      metrics: { executions: rand(100, 800), errors: rand(0, 15) },
      activeAlertIds: [],
      powerState: "running" as PowerState,
    },
    {
      id: "pe-sql",
      health: "ok",
      healthScore: 0.95,
      metrics: {},
      activeAlertIds: [],
    },
    {
      id: "pe-redis",
      health: "ok",
      healthScore: 0.95,
      metrics: {},
      activeAlertIds: [],
    },
    {
      id: "sql",
      health: sqlLatencySpike ? "critical" : "ok",
      healthScore: sqlLatencySpike ? 0.25 : rand(0.75, 0.95),
      metrics: {
        dtu: sqlLatencySpike ? rand(88, 99) : rand(20, 55),
        connections: rand(80, 200),
      },
      activeAlertIds: sqlLatencySpike ? ["alert-002"] : [],
      powerState: sqlLatencySpike ? "stopped" as PowerState : "running" as PowerState,
    },
    {
      id: "redis",
      health: "ok",
      healthScore: 0.88,
      metrics: { cpu: rand(10, 35), memory: rand(30, 55) },
      activeAlertIds: [],
      powerState: "running" as PowerState,
    },
    {
      id: "storage",
      health: "ok",
      healthScore: 0.95,
      metrics: { transactions: rand(500, 3000) },
      activeAlertIds: [],
      powerState: "running" as PowerState,
    },
  ];

  const appgwAksThroughput = rand(8_000_000, 25_000_000);
  const aksPeSqlThroughput = rand(2_000_000, 12_000_000);
  const aksPeRedisThroughput = rand(4_000_000, 18_000_000);
  const funcStorageThroughput = rand(1_000_000, 5_000_000);
  const appgwFuncThroughput = rand(500_000, 4_000_000);

  const edges: LiveEdge[] = [
    {
      id: "appgw->aks",
      status: "normal",
      metrics: { throughputBps: appgwAksThroughput, latencyMs: rand(5, 30), errorRate: rand(0, 2) },
      trafficLevel: mockTrafficLevel(appgwAksThroughput),
      activeAlertIds: [],
    },
    {
      id: "appgw->func",
      status: "normal",
      metrics: { throughputBps: appgwFuncThroughput, latencyMs: rand(15, 60) },
      trafficLevel: mockTrafficLevel(appgwFuncThroughput),
      activeAlertIds: [],
    },
    {
      id: "pe-sql->sql",
      status: sqlLatencySpike ? "degraded" : "normal",
      metrics: { throughputBps: 0 },
      trafficLevel: "low",
      activeAlertIds: [],
    },
    {
      id: "pe-redis->redis",
      status: "normal",
      metrics: { throughputBps: 0 },
      trafficLevel: "low",
      activeAlertIds: [],
    },
    {
      id: "aks->aks-nodepool",
      status: aksHealth ? "normal" : "degraded",
      metrics: { throughputBps: 0 },
      trafficLevel: "low",
      activeAlertIds: aksHealth ? [] : ["alert-001"],
    },
    {
      id: "aks-nodepool->pe-sql",
      status: sqlLatencySpike ? "degraded" : "normal",
      metrics: {
        throughputBps: aksPeSqlThroughput,
        latencyMs: sqlLatencySpike ? rand(400, 1200) : rand(10, 50),
        errorRate: sqlLatencySpike ? rand(8, 18) : rand(0, 1),
      },
      trafficLevel: mockTrafficLevel(aksPeSqlThroughput),
      activeAlertIds: sqlLatencySpike ? ["alert-002"] : [],
    },
    {
      id: "aks-nodepool->pe-redis",
      status: "normal",
      metrics: { throughputBps: aksPeRedisThroughput, latencyMs: rand(1, 5) },
      trafficLevel: mockTrafficLevel(aksPeRedisThroughput),
      activeAlertIds: [],
    },
    {
      id: "func->storage",
      status: "normal",
      metrics: { throughputBps: funcStorageThroughput, latencyMs: rand(20, 80) },
      trafficLevel: mockTrafficLevel(funcStorageThroughput),
      activeAlertIds: [],
    },
    {
      id: "func->pe-sql",
      status: "idle",
      metrics: { throughputBps: 0 },
      trafficLevel: "none",
      activeAlertIds: [],
    },
  ];

  const alerts: LiveAlert[] = [];
  if (!aksHealth) {
    alerts.push({
      id: "alert-001",
      severity: "warning",
      title: "AKS CPU usage elevated",
      resourceId: "/subscriptions/mock/.../aks-prod",
      firedAt: new Date(Date.now() - 180_000).toISOString(),
      summary: "Node CPU usage has exceeded 80% for 3+ minutes. Consider scaling node pool.",
      rootCauseCandidates: ["High pod density", "Memory pressure causing swap"],
      affectedNodeIds: ["aks", "aks-nodepool"],
      affectedEdgeIds: ["appgw->aks", "aks->aks-nodepool", "aks-nodepool->pe-sql", "aks-nodepool->pe-redis"],
    });
  }
  if (sqlLatencySpike) {
    alerts.push({
      id: "alert-002",
      severity: "critical",
      title: "SQL Database latency spike",
      resourceId: "/subscriptions/mock/.../sql-prod",
      firedAt: new Date(Date.now() - 60_000).toISOString(),
      summary: "P95 query latency exceeded 500ms. DTU usage at 95%. Possible deadlock on orders table.",
      rootCauseCandidates: ["DTU saturation", "Long-running query on orders table", "Missing index on orders.created_at"],
      affectedNodeIds: ["sql", "pe-sql"],
      affectedEdgeIds: ["aks-nodepool->pe-sql", "pe-sql->sql", "func->pe-sql"],
    });
  }

  // ── Mock Alert Rules (configured rule definitions) ──
  const alertRules: AlertRuleInfo[] = [
    {
      id: "/subscriptions/mock/providers/Microsoft.Insights/metricAlerts/aks-cpu-alert",
      name: "AKS CPU > 80%",
      severity: 2,
      signalType: "Metric",
      condition: "Percentage CPU >= 80",
      targetResourceId: "/subscriptions/mock/.../aks-prod",
      targetResourceType: "Microsoft.ContainerService/managedClusters",
      enabled: true,
      affectedNodeIds: ["aks"],
    },
    {
      id: "/subscriptions/mock/providers/Microsoft.AlertsManagement/smartDetectorAlertRules/failure-anomalies",
      name: "Failure Anomalies - appinsights-prod",
      severity: 3,
      signalType: "Smart Detection",
      condition: "Detects an unusual rise in the rate of failed HTTP requests or dependency calls",
      targetResourceId: "/subscriptions/mock/.../appinsights-prod",
      targetResourceType: "Microsoft.Insights/components",
      enabled: true,
      affectedNodeIds: ["aks"],
    },
    {
      id: "/subscriptions/mock/providers/Microsoft.Insights/metricAlerts/sql-dtu-alert",
      name: "SQL DTU > 90%",
      severity: 1,
      signalType: "Metric",
      condition: "dtu_consumption_percent >= 90",
      targetResourceId: "/subscriptions/mock/.../sql-prod",
      targetResourceType: "Microsoft.Sql/servers/databases",
      enabled: true,
      affectedNodeIds: ["sql"],
    },
    {
      id: "/subscriptions/mock/providers/Microsoft.Insights/scheduledQueryRules/redis-conn-alert",
      name: "Redis connection spike",
      severity: 3,
      signalType: "Log",
      condition: "connectedclients >= 500",
      targetResourceId: "/subscriptions/mock/.../redis-prod",
      targetResourceType: "Microsoft.Cache/Redis",
      enabled: true,
      affectedNodeIds: ["redis"],
    },
    {
      id: "/subscriptions/mock/providers/Microsoft.Insights/metricAlerts/appgw-unhealthy",
      name: "AppGW Unhealthy Backend",
      severity: 2,
      signalType: "Metric",
      condition: "UnhealthyHostCount >= 1",
      targetResourceId: "/subscriptions/mock/.../appgw-prod",
      targetResourceType: "Microsoft.Network/applicationGateways",
      enabled: true,
      affectedNodeIds: ["appgw"],
    },
  ];

  return {
    diagramId: "prod-infra",
    generatedAt: new Date().toISOString(),
    refreshIntervalSec: 30,
    nodes,
    edges,
    alerts,
    alertRules,
    topology: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      resolvedBindings: 0,
      failedBindings: 0,
    },
  };
}
