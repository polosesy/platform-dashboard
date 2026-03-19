// ─────────────────────────────────────────────────────────────
// Observability / APM Types
// Covers: Kubernetes workloads, container resources, JVM, Nginx/Tomcat, Browser RUM
// ─────────────────────────────────────────────────────────────

export type ObservabilityDataSourceStatus = {
  containerInsights: boolean;
  prometheus: boolean;
  appInsights: boolean;
};

// ── Node-level resource summary ──

export type NodeResourceSummary = {
  name: string;
  status: "Ready" | "NotReady" | "Unknown";
  cpuUsagePct: number | null;      // 0-100
  memoryUsagePct: number | null;   // 0-100
  cpuCapacityMillicores: number | null;
  memoryCapacityMiB: number | null;
  podCount: number;
  conditions: NodeConditionSummary[];
};

export type NodeConditionSummary = {
  type: string;   // Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable
  status: "True" | "False" | "Unknown";
};

// ── Workload (Deployment / StatefulSet / DaemonSet) ──

export type WorkloadHealth = {
  name: string;
  namespace: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet";
  pods: {
    total: number;
    running: number;
    pending: number;
    failed: number;
    restarts: number;
  };
  cpu: ResourceUsage | null;
  memory: ResourceUsage | null;
  apm: ApmMetrics | null;
  jvm: JvmMetrics | null;
};

export type ResourceUsage = {
  usagePct: number;       // 0-100
  usageRaw: number;       // millicores (CPU) or MiB (mem)
  limitRaw: number | null;
  requestRaw: number | null;
};

// ── APM metrics (Node.js / Java requests) ──

export type ApmMetrics = {
  requestsPerSec: number | null;
  errorRate: number | null;      // 0-1
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  activeAlerts: number;
  source: "appInsights" | "prometheus" | "none";
};

// ── JVM metrics (Java Spring Boot) ──

export type JvmMetrics = {
  heapUsedMiB: number | null;
  heapMaxMiB: number | null;
  heapUsedPct: number | null;    // 0-100
  gcTimeMs: number | null;       // GC pause time last minute
  gcCount: number | null;        // GC count last minute
  threadCount: number | null;
  threadBlocked: number | null;
  classesLoaded: number | null;
};

// ── Middleware (Nginx / Tomcat) ──

export type MiddlewareMetrics = {
  name: string;
  namespace: string;
  kind: "nginx" | "tomcat";
  activeConnections: number | null;
  requestsPerSec: number | null;
  errorRate: number | null;       // 0-1 (4xx+5xx / total)
  upstreamResponseMs: number | null;  // nginx upstream avg
  activeSessionsRatio: number | null; // tomcat sessions/max (0-1)
  source: "prometheus" | "none";
};

// ── Browser RUM ──

export type RumMetrics = {
  fcp: number | null;         // First Contentful Paint (ms)
  lcp: number | null;         // Largest Contentful Paint (ms)
  cls: number | null;         // Cumulative Layout Shift (unitless)
  jsErrorRate: number | null; // JS errors per session
  sessionCount: number | null;
  pageViewsPerMin: number | null;
  source: "appInsights" | "none";
};

// ── Top-level snapshot ──

export type ObservabilityOverview = {
  clusterId: string;
  clusterName: string;
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  nodeSummary: {
    total: number;
    ready: number;
    notReady: number;
  };
  podSummary: {
    total: number;
    running: number;
    pending: number;
    failed: number;
  };
  topAlertingWorkloads: WorkloadHealth[];  // sorted by error rate desc, max 5
};

export type ObservabilityWorkloadsResponse = {
  clusterId: string;
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  workloads: WorkloadHealth[];
};

export type ObservabilityNodesResponse = {
  clusterId: string;
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  nodes: NodeResourceSummary[];
};

export type ObservabilityMiddlewareResponse = {
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  middleware: MiddlewareMetrics[];
};

export type ObservabilityRumResponse = {
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  rum: RumMetrics;
};

export type ObservabilityStatusResponse = {
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  workspaceId: string | null;
  prometheusEndpoint: string | null;
  appInsightsConfigured: boolean;
};
