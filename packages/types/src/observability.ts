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

/** Where pod logs can come from, in the order the API tries them (services/podLogSources.ts) */
export type PodLogSource = "loki" | "kubelet" | "containerInsights";
export type PodLogAttemptState = "ok" | "empty" | "notConfigured" | "denied" | "forbidden" | "unreachable" | "failed";
/** One source the API tried for these logs — the page says which answered and why the others did not */
export type PodLogAttempt = { source: PodLogSource; state: PodLogAttemptState; message?: string };

export type ObservabilityLogsResponse = {
  clusterId: string;
  generatedAt: string;
  logs: PodLogEntry[];
  podName: string;
  namespace: string;
  hasMore: boolean;         // 추가 로그 존재 여부
  /** The source the lines came from (null = none answered) */
  source?: PodLogSource | null;
  /** Every source tried, in order */
  attempts?: PodLogAttempt[];
  /** Lines whose secrets were masked (logRedaction.ts) */
  redactions?: number;
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
  /** Namespaces whose pod logs this connection may read (`aks.podLogNamespaces`); null = every namespace */
  logNamespaces?: string[] | null;
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

// ── Observability stack (services/observabilityStack.ts): the customer's own collection pipeline ──
// Alloy (metrics/logs/profiles), alloy-traces (OTLP → Tempo, span metrics), Loki, Tempo, Pyroscope, kube-state-metrics,
// node-exporter, Hubble — all read from metrics already in the cluster's Azure Monitor workspace. Never a number
// that was not measured: a check without series is "unknown", a component without series "notDetected".

export type StackState = "ok" | "degraded" | "down" | "stale" | "notDetected" | "unknown";

export type StackComponentKind = "alloy" | "loki" | "tempo" | "pyroscope" | "kubeStateMetrics" | "nodeExporter" | "hubble" | "amaMetrics";

export type StackCheckId =
  | "remoteWriteFailed" | "remoteWriteLag" | "remoteWritePending" | "componentsUnhealthy" | "configLoad"
  | "logsSent" | "logsDropped" | "spansAccepted" | "spansRefused" | "spansExportFailed" | "profilesSent"
  | "lokiIngest" | "tempoSpans" | "tempoDiscarded" | "targetsDown" | "ksmAge" | "ciliumUnreachable";

export type StackCheck = {
  id: StackCheckId;
  state: StackState;
  /** null = no series (not measured) */
  value: number | null;
  unit: "ratio" | "seconds" | "perSecond" | "bytesPerSecond" | "count";
  /** The exact query behind the value (opened in Grafana Explore when configured) */
  promql: string;
};

export type StackComponent = {
  kind: StackComponentKind;
  /** Workload name (e.g. two Alloy deployments: collection and traces) */
  name: string;
  namespace: string | null;
  state: StackState;
  pods: { pod: string; version: string | null }[];
  checks: StackCheck[];
};

export type ObservabilityStackResponse = {
  clusterId: string;
  generatedAt: string;
  windowMinutes: number;
  /** Same states as the Hubble metrics view (workspace / permission / scope) */
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "failed";
  message?: string;
  cluster: string | null;
  components: StackComponent[];
  /** Scrape targets per job (`up`) and the ones down now */
  targets: { job: string; total: number; down: number }[];
  downTargets: { job: string; namespace: string | null; pod: string | null }[];
  /** From the connections file `aks.observability.grafana` — links only, nothing read from Grafana */
  grafana: { endpoint: string; datasources: Partial<Record<"prometheus" | "loki" | "tempo" | "pyroscope", string>> } | null;
};

// ── Data sources (services/observabilitySources.ts) — what the dashboard reads vs only links to ──

export type ObservabilitySourceKind = "loki" | "tempo" | "pyroscope" | "grafana";
/** read = the dashboard reads it now · link = Grafana Explore link only · blocked = configured, refused/timed out · error = reached, not ready · off = not set up */
export type ObservabilitySourceState = "read" | "link" | "blocked" | "error" | "off";
export type ObservabilitySource = {
  kind: ObservabilitySourceKind;
  state: ObservabilitySourceState;
  /** Shipping seen in the workspace metrics (관측 스택) — null: not known */
  pipeline: "seen" | "notSeen" | null;
  /** Grafana Explore for the datasource, or Grafana itself — links only */
  href?: string;
  /** error only: "HTTP 503" — never a response body */
  detail?: string;
};
export type ObservabilitySourcesResponse = { clusterId: string; generatedAt: string; lokiCheckedAt: string | null; sources: ObservabilitySource[] };

// ── Workload heatmap (services/workloadHeatmap.ts) — the customer's Grafana "container map" as one map ──

export type HeatMetric = "ready" | "memory" | "cpu" | "restarts" | "oldGen" | "jvmHeadroom" | "http5xx" | "logErrors" | "poolUsage" | "poolPending";

/**
 * stopped = nothing to run (code: scaledToZero 0/0 replicas · noNodes a DaemonSet no node matches · noPods its other
 * cells) · noBaseline = usage measured but no limit / request to judge it by (value null, `abs` holds the usage) ·
 * noTraffic = 5xx with no requests · notInstrumented = this workload does not expose the metric (not Java/Spring) ·
 * notMeasured = the family is absent from the workspace, or no series for this workload
 */
export type HeatLevel = "ok" | "warn" | "danger" | "noBaseline" | "stopped" | "noTraffic" | "notInstrumented" | "notMeasured";

export type HeatCell = {
  value: number | null;
  level: HeatLevel;
  /** The pod (or connection pool) that set the value — worst first */
  worstPod?: string;
  pool?: string;
  /** Last container termination was OOMKilled */
  oom?: boolean;
  code?: "noLimit" | "noRequest" | "noNodes" | "scaledToZero" | "noPods";
  /** Memory: working-set bytes · CPU: cores — of the pod that set the value (or the busiest pod when there is no ratio) */
  abs?: number;
  /** jvmHeadroom (value = limit − heapMax, bytes): the pod's container memory limit, JVM max heap, non-heap in use */
  jvm?: { limit: number; heapMax: number; nonheapUsed: number | null };
};

export type HeatWorkload = {
  namespace: string;
  workload: string;
  kind: string | null;
  basis: "owner" | "pattern";
  replicas: { ready: number | null; desired: number | null };
  /** Worst level over the measured cells */
  worst: HeatLevel;
  cells: Record<HeatMetric, HeatCell>;
  pods: {
    pod: string; ready: boolean | null; restarts: number | null; memory: number | null; cpu: number | null; oom: boolean;
    /** Working-set bytes / CPU cores (null = no series) — shown when there is no limit / request ratio */
    memBytes?: number | null; cpuCores?: number | null;
  }[];
};

export type WorkloadHeatmapResponse = {
  clusterId: string;
  generatedAt: string;
  windowMinutes: number;
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "failed";
  message?: string;
  cluster: string | null;
  thresholds: Record<HeatMetric, { warn: number; danger: number }>;
  /** Workloads at danger per metric — null = the metric is not measured in this workspace */
  flags: { metric: HeatMetric; count: number | null }[];
  workloads: HeatWorkload[];
  missing: HeatMetric[];
  grafana: { endpoint: string; datasources: Partial<Record<"prometheus" | "loki" | "tempo" | "pyroscope", string>> } | null;
};

// ── Kube events (services/kubeEvents.ts) ──

export type KubeEvent = {
  /** Last occurrence — the ~1 h TTL counts from here, so a recurring event never expires */
  time: string;
  /** First occurrence: `count` accumulates from here (can be days earlier than `time`) */
  firstTime?: string;
  type: "Warning" | "Normal";
  reason: string;
  kind: string;
  namespace: string;
  name: string;
  count: number;
  /** Operators only, redacted (probe bodies, secret names can appear) */
  message?: string;
};

export type KubeEventsResponse = {
  clusterId: string;
  generatedAt: string;
  /** k8sApi: live events (AKS keeps about an hour) */
  source: "k8sApi";
  events: KubeEvent[];
  messages: boolean;
};

// ── Workload logs (services/lokiLogs.ts) — the cluster's Loki, read in-cluster with the pod-log gate ──

export type LokiState = "ok" | "notConfigured" | "unreachable" | "failed";

export type LogLine = {
  time: string;
  level: "error" | "warn" | "info" | "unknown";
  text: string;
  pod?: string;
  traceId?: string;
};

export type WorkloadLogsResponse = {
  clusterId: string;
  generatedAt: string;
  state: LokiState;
  message?: string;
  lines: LogLine[];
  /** Exception classes in the window (Loki-side count) */
  exceptions: { cls: string; count: number }[];
  truncated: boolean;
  /** Values replaced by redaction (tokens, keys, passwords) */
  redactions: number;
  windowMinutes: number;
};

/** Hubble drops from Loki (hubble-flow-exporter → `{job="hubble-flows"}`) */
export type LokiDropsResponse = {
  clusterId: string;
  generatedAt: string;
  state: LokiState;
  message?: string;
  windowMinutes: number;
  drops: { source: string; destination: string; port: number; protocol: string; reason: string; count: number; lastSeen: string }[];
  flowLines: number;
  /** relay `node_status` NODE_ERROR lines in the window — the exporter's own health */
  relayErrors: number;
  /** AMW hubble_drop_total rose but Loki holds no flow lines → the exporter pipeline is broken */
  pipelineBroken: boolean | null;
};

// ── VPA recommendations for a workload (services/workloadVpa.ts) — Kubernetes API, recommendation vs current ──

/** cpu = cores · memory = bytes · null = not set */
export type ResourcePair = { cpu: number | null; memory: number | null };

export type VpaContainer = {
  name: string;
  /** The workload's pod template now */
  request: ResourcePair;
  limit: ResourcePair;
  /** VPA status.recommendation (null = no recommendation for this container yet) */
  target: ResourcePair | null;
  lower: ResourcePair | null;
  upper: ResourcePair | null;
  uncapped: ResourcePair | null;
  /**
   * VPA's own semantics only: targetOverLimit = the recommendation is above the limit · belowLower = the request is
   * below VPA's lower bound (under-provisioned) · aboveUpper = the request is above the upper bound (over-provisioned)
   */
  notes: Array<{ resource: "cpu" | "memory"; kind: "targetOverLimit" | "belowLower" | "aboveUpper" }>;
};

export type WorkloadVpa = {
  name: string;
  /** spec.updatePolicy.updateMode — Off = recommend only, Initial / Recreate / Auto / InPlaceOrRecreate apply it */
  mode: string | null;
  containers: VpaContainer[];
  /** status.conditions RecommendationProvided */
  recommending: boolean | null;
};

export type WorkloadVpaResponse = {
  clusterId: string;
  generatedAt: string;
  /** ok · none = no VPA targets this workload · noCrd = the VPA CRD is not installed */
  state: "ok" | "none" | "noCrd";
  vpas: WorkloadVpa[];
};
