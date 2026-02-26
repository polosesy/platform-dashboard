import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  LiveNode,
  LiveEdge,
  LiveAlert,
  EdgeTrafficLevel,
} from "@aud/types";

// ────────────────────────────────────────────
// Mock Diagram Spec — Production Infrastructure
// ────────────────────────────────────────────

export const mockDiagramSpec: DiagramSpec = {
  version: "1.0",
  id: "prod-infra",
  name: "Production Infrastructure",
  createdAt: "2026-02-23T00:00:00Z",
  updatedAt: "2026-02-23T00:00:00Z",
  nodes: [
    {
      id: "appgw",
      label: "Application Gateway",
      icon: "appGateway",
      groupId: "frontend",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Network/applicationGateways/appgw-prod",
      position: { x: 100, y: 200 },
      bindings: {
        rps: { source: "monitor", metric: "Throughput", aggregation: "total" },
        latency: { source: "monitor", metric: "BackendLastByteResponseTime", aggregation: "p95" },
        health: { source: "composite", rules: [
          { metric: "rps", op: ">", threshold: 0, weight: 0.5 },
          { metric: "latency", op: "<", threshold: 500, weight: 0.5 },
        ]},
      },
    },
    {
      id: "aks",
      label: "AKS Platform",
      icon: "aks",
      groupId: "compute",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod",
      position: { x: 400, y: 120 },
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
    },
    {
      id: "sql",
      label: "SQL Database",
      icon: "sql",
      groupId: "data",
      azureResourceId: "/subscriptions/mock/resourceGroups/rg-prod/providers/Microsoft.Sql/servers/sql-prod/databases/orders",
      position: { x: 700, y: 120 },
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
      position: { x: 700, y: 280 },
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
      position: { x: 700, y: 440 },
      bindings: {
        transactions: { source: "monitor", metric: "Transactions", aggregation: "total" },
        health: { source: "composite", rules: [
          { metric: "transactions", op: ">", threshold: 0, weight: 1.0 },
        ]},
      },
    },
    {
      id: "func",
      label: "Functions",
      icon: "functionApp",
      groupId: "compute",
      position: { x: 400, y: 360 },
      bindings: {
        executions: { source: "monitor", metric: "FunctionExecutionCount", aggregation: "total" },
        errors: { source: "monitor", metric: "FunctionExecutionUnits", aggregation: "total" },
        health: { source: "composite", rules: [
          { metric: "executions", op: ">", threshold: 0, weight: 0.6 },
          { metric: "errors", op: "<", threshold: 100, weight: 0.4 },
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
      id: "aks->sql",
      source: "aks",
      target: "sql",
      label: "TCP 1433",
      protocol: "TCP",
      bindings: {
        throughput: { source: "monitor", metric: "BytesSent", aggregation: "total" },
        latency: { source: "appInsights", metric: "dependencies/duration", aggregation: "p95" },
      },
      animation: "flow",
      alerts: [{ condition: "latency > 500", severity: "warning" }],
    },
    {
      id: "aks->redis",
      source: "aks",
      target: "redis",
      label: "TCP 6380",
      protocol: "TCP",
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
    {
      id: "func->sql",
      source: "func",
      target: "sql",
      label: "TCP 1433",
      protocol: "TCP",
      bindings: {},
      animation: "dash",
    },
  ],
  groups: [
    { id: "frontend", label: "Frontend", layout: "row" },
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
  const aksHealth = rand(0, 100) > 20;  // 80% chance healthy
  const sqlLatencySpike = rand(0, 100) > 85; // 15% chance

  const nodes: LiveNode[] = [
    {
      id: "appgw",
      health: "ok",
      healthScore: 0.92,
      metrics: { rps: rand(800, 1500), latency: rand(20, 80) },
      activeAlertIds: [],
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
    },
    {
      id: "redis",
      health: "ok",
      healthScore: 0.88,
      metrics: { cpu: rand(10, 35), memory: rand(30, 55) },
      activeAlertIds: [],
    },
    {
      id: "storage",
      health: "ok",
      healthScore: 0.95,
      metrics: { transactions: rand(500, 3000) },
      activeAlertIds: [],
    },
    {
      id: "func",
      health: "ok",
      healthScore: 0.82,
      metrics: { executions: rand(100, 800), errors: rand(0, 15) },
      activeAlertIds: [],
    },
  ];

  const appgwAksThroughput = rand(8_000_000, 25_000_000);
  const aksSqlThroughput = rand(2_000_000, 12_000_000);
  const aksRedisThroughput = rand(4_000_000, 18_000_000);
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
      id: "aks->sql",
      status: sqlLatencySpike ? "degraded" : "normal",
      metrics: {
        throughputBps: aksSqlThroughput,
        latencyMs: sqlLatencySpike ? rand(400, 1200) : rand(10, 50),
        errorRate: sqlLatencySpike ? rand(8, 18) : rand(0, 1),
      },
      trafficLevel: mockTrafficLevel(aksSqlThroughput),
      activeAlertIds: sqlLatencySpike ? ["alert-002"] : [],
    },
    {
      id: "aks->redis",
      status: "normal",
      metrics: { throughputBps: aksRedisThroughput, latencyMs: rand(1, 5) },
      trafficLevel: mockTrafficLevel(aksRedisThroughput),
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
      id: "appgw->func",
      status: "normal",
      metrics: { throughputBps: appgwFuncThroughput, latencyMs: rand(15, 60) },
      trafficLevel: mockTrafficLevel(appgwFuncThroughput),
      activeAlertIds: [],
    },
    {
      id: "func->sql",
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
      affectedNodeIds: ["aks"],
      affectedEdgeIds: ["appgw->aks", "aks->sql", "aks->redis"],
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
      affectedNodeIds: ["sql"],
      affectedEdgeIds: ["aks->sql", "func->sql"],
    });
  }

  return {
    diagramId: "prod-infra",
    generatedAt: new Date().toISOString(),
    refreshIntervalSec: 30,
    nodes,
    edges,
    alerts,
    topology: {
      nodeCount: 6,
      edgeCount: 6,
      resolvedBindings: 0,
      failedBindings: 0,
    },
  };
}
