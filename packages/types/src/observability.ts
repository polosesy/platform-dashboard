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
  diskUsagePct: number | null;     // 0-100
  diskCapacityGB: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  podCount: number;
  conditions: NodeConditionSummary[];
};

export type NodeConditionSummary = {
  type: string;   // Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable
  status: "True" | "False" | "Unknown";
};

// ── Workload (Deployment / StatefulSet / DaemonSet / standalone Pod) ──

export type WorkloadHealth = {
  name: string;
  namespace: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Pod";
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

// ── Pod Live Logs ──

export type PodLogEntry = {
  timestamp: string;       // ISO 8601
  podName: string;
  containerName: string;
  logMessage: string;
  stream: "stdout" | "stderr" | "unknown";
};

export type ObservabilityLogsResponse = {
  clusterId: string;
  generatedAt: string;
  logs: PodLogEntry[];
  podName: string;
  namespace: string;
  hasMore: boolean;         // 추가 로그 존재 여부
};

// ── Namespace / Pod Discovery (for Logs tab dropdown) ──

export type NamespacePodItem = {
  namespace: string;
  podName: string;
  /** Controller-managed 워크로드명 (standalone Pod이면 podName과 동일) */
  workloadName: string;
  status: string;           // Running, Pending, Failed, Completed …
  /** Pod 내 컨테이너 이름 목록 (multi-container pod 지원) */
  containers?: string[];
};

export type ObservabilityNamespacesResponse = {
  clusterId: string;
  generatedAt: string;
  /** namespace → pod list 매핑용 flat 배열 */
  items: NamespacePodItem[];
};

export type ObservabilityStatusResponse = {
  generatedAt: string;
  dataSourceStatus: ObservabilityDataSourceStatus;
  workspaceId: string | null;
  prometheusEndpoint: string | null;
  appInsightsConfigured: boolean;
};

// ── Workload Detail (per-pod breakdown, services, containers) ──

export type WorkloadContainerDetail = {
  name: string;
  image: string;
  ports: { containerPort: number; protocol: string }[];
  resourceRequests: { cpu?: string; memory?: string } | null;
  resourceLimits: { cpu?: string; memory?: string } | null;
  ready: boolean;
  restartCount: number;
  state: "running" | "waiting" | "terminated" | "unknown";
  stateReason?: string;
};

export type WorkloadPodDetail = {
  name: string;
  namespace: string;
  status: string;            // Running, Pending, Failed, …
  podIP: string;
  nodeName: string;
  startTime: string;         // ISO 8601
  containers: WorkloadContainerDetail[];
};

export type WorkloadServiceInfo = {
  name: string;
  namespace: string;
  type: string;              // ClusterIP, LoadBalancer, NodePort, ExternalName
  clusterIP: string;
  externalIP: string | null;
  ports: { port: number; targetPort: string | number; protocol: string; nodePort?: number }[];
  /** Service selector 라벨 */
  selector: Record<string, string>;
};

export type WorkloadEndpointInfo = {
  serviceName: string;
  addresses: { ip: string; nodeName?: string; podName?: string }[];
  ports: { port: number; protocol: string; name?: string }[];
};

export type WorkloadDetailResponse = {
  clusterId: string;
  generatedAt: string;
  workloadName: string;
  namespace: string;
  kind: string;
  /** 개별 파드 상세 */
  pods: WorkloadPodDetail[];
  /** 워크로드에 연결된 서비스 */
  services: WorkloadServiceInfo[];
  /** 서비스 엔드포인트 */
  endpoints: WorkloadEndpointInfo[];
};
