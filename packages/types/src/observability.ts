import type { ConnectCause } from "./common.js";

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
  /** null = the pod list was not read (never 0) */
  podCount: number | null;
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
  /** Loki only — what Grafana's log details show. The line's exact timestamp (ns, as text): the anchor of "context" */
  tsNs?: string;
  /** The level Loki detected or the line states (error · warn · info · unknown) */
  level?: "error" | "warn" | "info" | "unknown";
  /** Indexed labels of the stream (namespace · pod · container · job …) */
  labels?: Record<string, string>;
  /** Structured metadata of the line (detected_level · level · trace_id …) — not indexed */
  metadata?: Record<string, string>;
  /** The trace ID in the line (their Spring pattern `[service,traceId,spanId,…]`) */
  traceId?: string;
};

/** The lines around one line of the same pod (Grafana's "show context") — oldest first on both sides */
export type LogContextResponse = {
  clusterId: string;
  generatedAt: string;
  state: LokiState;
  cause?: ConnectCause;
  message?: string;
  retryAt?: string;
  before: PodLogEntry[];
  after: PodLogEntry[];
  redactions: number;
};

/** Where pod logs can come from, in the order the API tries them (services/podLogSources.ts) */
export type PodLogSource = "loki" | "kubelet" | "containerInsights";
/** pastRange = the source reads only up to now (kubelet tails the live log) — skipped for a range in the past */
/** lokiOnly = a whole workload's lines are read from Loki only (kubelet and Container Insights answer per pod) */
export type PodLogAttemptState = "ok" | "empty" | "notConfigured" | "denied" | "forbidden" | "unreachable" | "busy" | "failed" | "pastRange" | "lokiOnly";
/** One source the API tried for these logs — the page says which answered and why the others did not */
export type PodLogAttempt = { source: PodLogSource; state: PodLogAttemptState; message?: string; cause?: ConnectCause };

export type ObservabilityLogsResponse = {
  clusterId: string;
  generatedAt: string;
  /** The window's end when it is not now (the time picker moved back) */
  at?: string;
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
  /** What was read: one pod, or every pod of a workload (Loki only) */
  scope?: { kind: "pod" | "workload"; name: string };
  /** The level filter the API applied — server side, with the log insights' rules (lokiLogs ERROR_LINE · WARN_LINE) */
  level?: "error" | "warn" | null;
  /** The minutes read (a level filter reads at most 6 h — less than asked when the range is longer) */
  windowMinutes?: number;
  /**
   * The scope's ERROR and WARN lines in the whole window — counted by Loki with the insights' rules (null = not
   * counted: not Loki, over 6 h or the count failed — never 0)
   */
  counts?: { error: number | null; warn: number | null } | null;
  /**
   * How much of the window the lines cover: complete = every matching line of the window is here; else the newest
   * `limit` lines, the oldest at `from` (2026-11-16: 300 lines of a busy pod were 25 of 60 minutes, unsaid)
   */
  coverage?: { complete: boolean; from: string | null };
  /** Loki, window ending now: it ends this many seconds ago — Loki is still taking the newest lines (lokiLogs SETTLE_MS) */
  settledSeconds?: number;
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
  | "lokiIngest" | "tempoSpans" | "tempoDiscarded" | "targetsDown" | "ksmAge" | "ciliumUnreachable"
  /** Ready pods / pods (kube-state-metrics kube_pod_status_ready) · profiles the sender dropped */
  | "podsReady" | "profilesDropped";

export type StackCheck = {
  id: StackCheckId;
  state: StackState;
  /** null = no series (not measured) */
  value: number | null;
  unit: "ratio" | "seconds" | "perSecond" | "bytesPerSecond" | "count";
  /** The exact query behind the value (opened in Grafana Explore when configured) */
  promql: string;
  /** The query did not answer this time (timeout / throttled / error) — value null means "not read", not "no series" */
  queryFailed?: true;
};

export type StackComponent = {
  kind: StackComponentKind;
  /** Workload name (e.g. two Alloy deployments: collection and traces) */
  name: string;
  namespace: string | null;
  state: StackState;
  pods: { pod: string; version: string | null }[];
  checks: StackCheck[];
  /**
   * The component's own pods by Kubernetes readiness (kube-state-metrics). How the pods were found: build info /
   * scrape target (they report themselves) · endpoints (the Service the sender writes to, Kubernetes API) ·
   * sameName (the one workload in that namespace named like that Service — when the API is not reachable).
   * Absent = pods not identified: the state then never comes from what a sender sent alone.
   */
  readiness?: {
    basis: "self" | "endpoints" | "sameName";
    ready: number;
    total: number;
    /** Not-ready pods; since = the last time the pod was Ready ended (null = not Ready in the 7 days read) */
    notReady: { pod: string; since: string | null }[];
  };
  /** Pyroscope: the Service the Alloy sender writes to (host:port from its `endpoint` label) */
  target?: string;
};

export type ObservabilityStackResponse = {
  clusterId: string;
  generatedAt: string;
  windowMinutes: number;
  /** The window's end when it is not now (the time picker moved back) */
  at?: string;
  /** Same states as the Hubble metrics view (workspace / permission / scope) */
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "tooCostly" | "failed";
  message?: string;
  cluster: string | null;
  components: StackComponent[];
  /** Scrape targets per job (`up`) and the ones down now — down null: the down query did not answer */
  targets: { job: string; total: number; down: number | null }[];
  downTargets: { job: string; namespace: string | null; pod: string | null }[];
  /** From the connections file `aks.observability.grafana` — links only, nothing read from Grafana */
  grafana: { endpoint: string; datasources: Partial<Record<"prometheus" | "loki" | "tempo" | "pyroscope", string>> } | null;
  /** Queries that did not answer this time (each has its own time limit and one retry) — the rest is shown as read */
  gaps?: StackQueryGap[];
  /** This refresh failed as a whole: the last complete answer (≤ 15 min old) is shown, with why the refresh failed */
  stale?: { failedAt: string; state: ObservabilityStackResponse["metricsState"]; message?: string };
};
export type StackQueryGap = { query: string; reason: "timeout" | "throttled" | "tooCostly" | "failed" };

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

/**
 * cpuNow = a lens, not a verdict: the last 15 minutes' average CPU / request (the customer's Grafana container map
 * tile) — coloured on its own view and in the table, never in the overall level or the red-flag strip (the CPU verdict
 * stays `cpu`: window p95 + pressure)
 */
export type HeatMetric = "ready" | "memory" | "cpu" | "cpuNow" | "restarts" | "oldGen" | "jvmHeadroom" | "http5xx" | "logErrors" | "poolUsage" | "poolPending";

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
  /**
   * Why the cell has this level: noLimit / noRequest (no ratio) · noNodes / scaledToZero / noPods (nothing to run) ·
   * jvmHeadroom configDeficit (a full heap crosses the limit by more than the band) / imminent (short, and memory,
   * Old Gen or an OOM in the window says it is happening) / marginal (inside the band) · cpu belowFloor (over the
   * request but under 100m — no verdict) / warmingUp (only started containers in the window) · http5xx lowTraffic ·
   * oldGen noMajorGc (live data is 0 until the first major GC — no ratio, not 0 %) ·
   * queryFailed (a query this signal needs did not answer this time — `gaps`; not "not measured", not OK)
   */
  code?: "noLimit" | "noRequest" | "noNodes" | "scaledToZero" | "noPods" | "configDeficit" | "imminent" | "marginal" | "belowFloor" | "warmingUp" | "lowTraffic" | "queryFailed" | "noMajorGc";
  /** Memory: working-set bytes · CPU: p95 cores — of the pod that set the value (or the busiest pod when there is no ratio) */
  abs?: number;
  /**
   * jvmHeadroom (value = limit − (heapMax + nonheapCommitted + direct + native), bytes) — what is left when the heap
   * grows to its max beside the memory outside the heap. native = RSS − heap committed − non-heap committed − direct
   * (thread stacks, malloc arenas, JIT, GC tables), never below 0; null fields = no series (`partial`). The value
   * uses the larger of native now and `nativePeak` (glibc hands arenas back, so "now" can sit below what the pod reached)
   */
  jvm?: {
    limit: number; heapMax: number; nonheapUsed: number | null;
    heapCommitted: number | null; nonheapCommitted: number | null; direct: number | null; rss: number | null; native: number | null;
    /** The pod's highest native memory over the last 24 h (5-minute steps) — null = no series */
    nativePeak?: number | null;
    /** Hours of history behind nativePeak (the pod's age, at most 24) — a pod deployed minutes ago has not peaked yet */
    observedHours?: number | null;
    /** max(100Mi, 10% of the limit) — the margin native memory grows into under load */
    band: number;
    partial?: boolean;
  };
  /**
   * cpu (value = p95 / request): the pod's CPU over the window in cores — now = the last 5 minutes, p95 / avg / max of
   * the 5-minute rate across the window (containers in their first 10 minutes left out) · psi = p95 share of time
   * runnable but waiting for a CPU · throttle = share of CFS periods throttled (CPU limit only) — null = no series
   */
  cpu?: { now: number | null; p95: number | null; avg: number | null; max: number | null; request: number | null; psi: number | null; throttle: number | null };
  /**
   * CPU 지금 (cores): the 15-minute average (the cell's value / request), the 5-minute rate, the request, and how many
   * minutes of the window the 5-minute rate stayed over the request (null = not measured) — repeated bursts a "now"
   * value alone hides
   */
  cpuNow?: { avg15: number; now5: number | null; request: number | null; overMinutes: number | null; windowMinutes: number };
  /** http5xx: requests in the window (the share is not judged under the minimum) */
  requests?: number;
  /** memory: the worst pod's highest working set over the window (ratio to the limit, bytes) — the level stays on now */
  peak?: { ratio: number | null; bytes: number };
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
  /**
   * AKS runs it (workload label kubernetes.azure.com/managedby=aks or addonmanager.kubernetes.io/mode — never the image
   * registry: our own hubble-ui is an mcr.microsoft.com image). Its CPU / memory are shown but leave the flag strip:
   * nothing to change on our side. Absent = not AKS-managed or not known (`managedState`)
   */
  managed?: true;
  pods: {
    pod: string; ready: boolean | null; restarts: number | null; memory: number | null; cpu: number | null; oom: boolean;
    /** Working-set bytes / CPU cores (null = no series) — shown when there is no limit / request ratio */
    memBytes?: number | null; cpuCores?: number | null;
    /** CPU 지금: the last 15 minutes' average / request (null = no request) */
    cpuNow?: number | null;
  }[];
};

export type WorkloadHeatmapResponse = {
  clusterId: string;
  generatedAt: string;
  windowMinutes: number;
  /** The window's end when it is not now (the time picker moved back) — every query was evaluated at this time */
  at?: string;
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "tooCostly" | "failed";
  message?: string;
  cluster: string | null;
  thresholds: Record<HeatMetric, { warn: number; danger: number }>;
  /** Workloads at danger per metric — null = the metric is not measured in this workspace */
  flags: { metric: HeatMetric; count: number | null }[];
  workloads: HeatWorkload[];
  missing: HeatMetric[];
  /** Queries that did not answer this time (timeout, throttled, failed) — the signals that need them say queryFailed */
  gaps?: StackQueryGap[];
  /** Whether `managed` could be read (Kubernetes workload list, best effort): unknown = not in time / no access */
  managedState?: "ok" | "unknown";
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
  /** Who reported it — kubelet · default-scheduler · horizontal-pod-autoscaler … (kubectl's SOURCE) */
  component?: string;
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
  /** Matching events before the `limit` (events.length can be smaller) */
  total?: number;
  /** The cluster had more Warning events than we read (4 pages of 500) — the list is not all of them */
  truncated?: boolean;
};

// ── Workload logs (services/lokiLogs.ts) — the cluster's Loki, read in-cluster with the pod-log gate ──

/**
 * unreachable = no connection (refused / no route / DNS / connect timeout — usually a network policy); busy = Loki
 * answers (/ready) but the query ran out of time or came back 499 / 5xx — overloaded (2026-11-05: alert queries filled
 * its querier and every timed-out read showed the network-policy fix)
 */
export type LokiState = "ok" | "notConfigured" | "unreachable" | "busy" | "failed";

export type LogLine = {
  time: string;
  level: "error" | "warn" | "info" | "unknown";
  text: string;
  pod?: string;
  traceId?: string;
};

export type WorkloadLogsResponse = {
  /** busy: the next read waits until then (the dashboard does not add load to an overloaded Loki) */
  retryAt?: string;
  /** unreachable: why the connection was not made (absent = the error did not say) */
  cause?: ConnectCause;
  clusterId: string;
  generatedAt: string;
  /** The window's end when it is not now (the time picker moved back) */
  at?: string;
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
  /** unreachable: why the connection was not made */
  cause?: ConnectCause;
  /** The window's end when it is a past range (the drops of that span — Loki keeps days, the agents minutes) */
  at?: string;
  state: LokiState;
  message?: string;
  /** busy: the next read waits until then (the dashboard does not add load to an overloaded Loki) */
  retryAt?: string;
  windowMinutes: number;
  drops: { source: string; destination: string; port: number; protocol: string; reason: string; count: number; lastSeen: string }[];
  flowLines: number;
  /** relay `node_status` NODE_ERROR lines in the window — the exporter's own health */
  relayErrors: number;
  /** AMW hubble_drop_total rose but Loki holds no flow lines → the exporter pipeline is broken */
  pipelineBroken: boolean | null;
  /** Only the newest lines were read (the read limit) — the counts are a floor */
  truncated?: boolean;
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

// ── Node maintenance (services/nodeMaintenance.ts) — /api/observability/node-maintenance ──

/** ok · empty (read, nothing in range) · forbidden · failed · notConfigured (no Azure Monitor workspace for metrics) */
export type NodeMaintSourceState = "ok" | "empty" | "forbidden" | "failed" | "notConfigured";

/** One AKS planned-maintenance window (`maintenanceConfigurations`), in its own UTC offset */
export type NodeMaintWindow = {
  /** aksManagedNodeOSUpgradeSchedule · aksManagedAutoUpgradeSchedule · default · … */
  name: string;
  schedule: { kind: "weekly" | "absoluteMonthly" | "relativeMonthly" | "daily" | "other"; interval: number; dayOfWeek?: string; dayOfMonth?: number; weekIndex?: string };
  startTime: string | null;
  durationHours: number | null;
  utcOffset: string | null;
  /** Next start (ISO) computed from the schedule; null = not computable */
  next: string | null;
};

export type NodeMaintNode = {
  node: string;
  /** From the AKS node name `aks-<pool>-<n>-vmss…` (display only) */
  pool: string | null;
  /** A node that appeared and left inside the episode (the upgrade's surge node) */
  surge?: { created: string; removed: string | null };
  /** First start → last end of the spans inside the episode; times = how many spans */
  cordoned?: { start: string; end: string | null; times: number };
  notReady?: { start: string; end: string | null; times: number };
  /** The Node object registered again (kube_node_created changed) — a reimage keeps the name */
  reRegistered?: string;
  kernel?: { from: string; to: string };
  /** kubelet version changed (kube_node_info) — a Kubernetes upgrade reached this node */
  kubelet?: { from: string; to: string };
};

export type NodeMaintEpisode = {
  id: string;
  /** nodeImageUpgrade = agentPools/upgradeNodeImageVersion · kubernetesUpgrade = node kubelet versions changed · clusterUpdate = managedClusters/agentPools write ·
   *  nodeChange = only node facts from metrics (no Azure operation read for it) */
  kind: "nodeImageUpgrade" | "kubernetesUpgrade" | "clusterUpdate" | "nodeChange";
  start: string;
  /** null = still running */
  end: string | null;
  status: "succeeded" | "failed" | "inProgress" | "unknown";
  /** aks = AKS itself (caller Microsoft.ContainerService — auto-upgrade) · user · app (a service principal) · unknown */
  initiator: "aks" | "user" | "app" | "unknown";
  /** The planned-maintenance window the start falls in (name); null = outside every window; absent = no windows read */
  inWindow?: string | null;
  pools: string[];
  /** Azure operations, condensed (Activity Log): first time, short name, status, target, count */
  operations: { time: string; op: string; status: string; target: string; count: number }[];
  /** Sub-operations that failed (e.g. a VMSS instance write — the upgrade can still succeed) */
  failedOps: number;
  /** Resource Health events on the node scale sets in the episode */
  resourceHealth: number;
  nodes: NodeMaintNode[];
  /** Pods that started inside the episode and still existed 30 min after it (kube_pod_start_time); null = not measured */
  podsRestarted: number | null;
  basis: ("activityLog" | "metrics")[];
};

export type NodeMaintenanceResponse = {
  clusterId: string;
  generatedAt: string;
  days: number;
  /** The range's end when it is not now (the time picker moved back) */
  at?: string;
  /** Node facts' resolution (the range step), minutes */
  stepMinutes: number;
  sources: { config: NodeMaintSourceState; activityLog: NodeMaintSourceState; metrics: NodeMaintSourceState };
  /** Some Activity Log chunk hit its page cap — older operations of that chunk may be missing */
  activityLogPartial?: boolean;
  config: {
    upgradeChannel: string | null;
    nodeOSUpgradeChannel: string | null;
    pools: { name: string; mode: string | null; count: number | null; nodeImageVersion: string | null; maxSurge: string | null; maxUnavailable: string | null; drainTimeoutMinutes: number | null; undrainableNodeBehavior: string | null }[];
    windows: NodeMaintWindow[];
  } | null;
  /** Newest first */
  episodes: NodeMaintEpisode[];
  /** Node NotReady spans outside every episode — not maintenance this page can name */
  unplanned: { node: string; start: string; end: string | null }[];
};

// ── Service SLO / SLI (services/workloadSlo.ts) ──
// Request SLIs from Micrometer `http_server_requests_seconds` (Spring) in the cluster's Azure Monitor workspace —
// availability = not 5xx, latency = finished within a histogram bucket boundary (never interpolated). Targets come
// from the connection file (`aks.observability.slo`) or are the marked defaults; burn-rate alerts follow the Google
// SRE Workbook's multiwindow table. The customer's spanmetrics are not used (their counter resets inflate rates).

export type SloKind = "availability" | "latency";
/**
 * exhausted = the window's bad events used the whole budget · fastBurn = a page-level burn (1 h & 5 m over 14.4× or
 * 6 h & 30 m over 6×) · slowBurn = a ticket-level burn (3 d & 6 h over 1×) · atRisk = 75 %+ of the budget used ·
 * lowTraffic = one bad request would use the whole budget (a ratio SLO says little) · noData = no series
 */
export type SloState = "ok" | "atRisk" | "slowBurn" | "fastBurn" | "exhausted" | "lowTraffic" | "noData" | "queryFailed";
export type SloBurnWindow = "5m" | "30m" | "1h" | "6h" | "3d";
export type SloAlert = {
  id: "page1h" | "page6h" | "ticket3d";
  factor: number;
  long: SloBurnWindow;
  short: SloBurnWindow;
  /** null = not judged (fewer than SLO_MIN_BURN_EVENTS requests in the long window, or a query failed) */
  firing: boolean | null;
};
export type SloBadSource = { uri: string; method: string; bad: number; events: number };
export type SloSli = {
  kind: SloKind;
  /** 0.999 = 99.9 % */
  target: number;
  /** platform = set on the SLO screen (AKS 모니터링 › SLO › 설정) · config = the connection file · default = SLO_DEFAULTS */
  targetSource: "platform" | "config" | "default";
  /** Latency: the asked threshold and the bucket boundary actually counted (≤ the asked one); null = no bucket at or under it */
  thresholdMs?: number;
  effectiveMs?: number | null;
  /** Over the SLO window: requests counted, bad ones, SLI = good / events (null = not measured) */
  events: number | null;
  bad: number | null;
  sli: number | null;
  /** bad / ((1 − target) × events): 1 = the whole budget used (can exceed 1) */
  budgetUsed: number | null;
  /** Burn rate per window = (bad / events) / (1 − target); events = the window's requests */
  burn: { window: SloBurnWindow; rate: number | null; events: number | null }[];
  alerts: SloAlert[];
  state: SloState;
  /** The highest standard target (SLO_TIERS) the window met — a reference for setting one, not a verdict */
  achievable: number | null;
  /** The URIs with the most bad requests in the window (5xx or over the threshold), up to 3 */
  topBad: SloBadSource[];
  /** The PromQL of this value (one service, the SLO window) — to run in Grafana Explore */
  expr: string;
};
export type SloAdvice = {
  id: "exhausted" | "fastBurn" | "slowBurn" | "atRisk" | "partialData" | "lowTraffic" | "noHistogram"
    | "thresholdNotBucket" | "topBad" | "noApplication";
  sli?: SloKind;
  params?: Record<string, string | number>;
};
export type SloService = {
  namespace: string;
  /** Micrometer's `application` tag ("" = series without it) */
  application: string;
  /** A Deployment / StatefulSet of that exact name in the namespace (null = none — the tag names something else) */
  workload: string | null;
  slis: SloSli[];
  /** The worse SLI's state */
  state: SloState;
  /** Hours of the window with series (a service younger than the window is judged on fewer days) */
  coverage: { hours: number; windowHours: number } | null;
  advice: SloAdvice[];
  /** The error budget was reset (counted from `at`, not the whole window) — scope `all` = the cluster-wide reset */
  reset?: SloBudgetResetApplied;
};
export type SloBudgetResetApplied = {
  id: string; at: string; scope: "service" | "all"; by?: string; reason?: string; windowHours: number;
  /** not a reset: the service's own window (shorter than the cluster's) starts here */
  window?: boolean;
};
export type WorkloadSloResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "tooCostly" | "failed";
  message?: string;
  cluster: string | null;
  windowDays: number;
  /** Whether the connection file or the platform settings set targets (else every target is the marked default) */
  configured: boolean;
  /** The platform settings' version this result was computed with (the SLO screen's settings) */
  settingsVersion?: number;
  /** Where the window length came from */
  windowSource?: "platform" | "config" | "default";
  defaults: { availability: number; latency: { thresholdMs: number; target: number } };
  /** Bucket boundaries found (seconds) — the latency thresholds that can be counted exactly */
  buckets: number[];
  /** Whether Micrometer HTTP series exist at all in this cluster's scope */
  instrumented: boolean;
  services: SloService[];
  /** Deployments / StatefulSets (replicas > 0) in namespaces with SLIs whose name no `application` tag matches */
  uninstrumented: { namespace: string; name: string; kind: "Deployment" | "StatefulSet" }[];
  gaps?: StackQueryGap[];
  grafana: { endpoint: string; datasources: Partial<Record<"prometheus" | "loki" | "tempo" | "pyroscope", string>> } | null;
};

// ── SLO settings on the platform (AKS 모니터링 › SLO › 설정, services/sloSettingsStore.ts) ──
// The same shape as the connection file's `aks.observability.slo`, kept per cluster on the platform. Per field the
// most specific wins: a service's platform value › the service's file value › the cluster's platform value › the
// file's top level › the defaults. Excluded URIs add up. Error-budget resets: the budget is counted from the reset
// (never before the window's start) — the burn-rate alerts are about now and are not reset.

export type SloTargetsSetting = { availability?: number; latency?: { thresholdMs: number; target: number }; excludeUris?: string[] };
export type SloSettings = SloTargetsSetting & {
  windowDays?: 7 | 14 | 28 | 30;
  /** per service: its targets, and (2026-11-19) its own window (≤ the cluster's) and core endpoints (only these URIs count) */
  services?: Record<string, SloTargetsSetting & { exclude?: boolean; windowDays?: 7 | 14 | 28 | 30; onlyUris?: string[] }>;
};
export type SloBudgetReset = {
  /** a service window's start, made by the API (never stored) — counted like a reset, said as the window */
  window?: boolean;
  id: string;
  /** "<namespace>/<application>" or "*" (every service of the cluster) */
  service: string;
  /** Counted from this time */
  at: string;
  reason: string;
  by?: string;
  createdAt: string;
};
export type SloSettingsChange = { at: string; by?: string; action: "settings" | "reset" | "undoReset"; detail?: string };
export type SloSettingsResponse = {
  clusterId: string;
  /** The platform's settings (only what was set here) */
  settings: SloSettings;
  /** The connection file's settings for this cluster (read-only here — changed in the file / Helm values) */
  file: SloSettings | null;
  defaults: { windowDays: number; availability: number; latency: { thresholdMs: number; target: number } };
  resets: SloBudgetReset[];
  history: SloSettingsChange[];
  /** The settings' revision (a save names the one it edited — 409 when another save came first) */
  rev: number;
  /** Changes with any write (settings or resets) — part of the SLO result's cache key */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  /** false = kept in memory only (no AUD_ARRANGEMENT_DIR) — gone after a restart */
  durable: boolean;
  canWrite: boolean;
};

// ── Log insights (AKS 모니터링 › 로그 — services/lokiLogs.ts getLogInsights) ──
// Counts of a namespace's log lines from the cluster's Loki (LogQL count_over_time — no line leaves Loki for these):
// ERROR / FATAL and WARN lines, per workload (the pod's controller, from the pod name), the exception classes named in
// error-ish lines, and ERROR lines over time. A part that did not answer is null and named in `gaps` — never 0.

export type LogInsightsResponse = {
  clusterId: string;
  generatedAt: string;
  /** unreachable: why the connection was not made */
  cause?: ConnectCause;
  /** The window's end when it is a past range */
  at?: string;
  state: LokiState;
  message?: string;
  retryAt?: string;
  namespace: string;
  /** One workload only (the filter), else every workload of the namespace */
  workload?: string;
  windowMinutes: number;
  /** ERROR / FATAL lines in the window (null = that query failed) */
  errors: number | null;
  warns: number | null;
  /** Workloads with ERROR or WARN lines, most errors first */
  services: { workload: string; errors: number; warns: number }[];
  /** Exception classes named in error-ish lines, per workload — most first (top 15) */
  exceptions: { workload: string; cls: string; count: number }[] | null;
  /** Distinct exception classes (over every workload) */
  exceptionClasses: number | null;
  /** ERROR lines per bucket, oldest first; `byWorkload` = the same per workload (top 6 by total) */
  timeline: { start: string; stepSeconds: number; buckets: number[]; byWorkload: { workload: string; buckets: number[] }[] } | null;
  gaps: ("errors" | "warns" | "exceptions" | "timeline")[];
};

// ── Application kinds and their representative metrics (services/appRuntimes.ts — 조립식 표) ──
// What each workload runs (JVM · Node.js · Python · Go · .NET · NGINX · Redis · PostgreSQL) and that kind's values.
// basis (strongest first, never a guess): metrics = its detection metric is in the workspace · telemetry = the
// OpenTelemetry SDK reports its language (target_info) · spec = the manifest declares it (the executable, a variable
// only that runtime reads, the Operator's inject annotation) · scan = Defender's image scan found that language's
// packages in the image · image = a Docker Hub official image · config = the image's own configuration read from
// the registry (Env JAVA_VERSION … · Entrypoint) — it also gives the version to a kind the metrics named without one.

export type AppRuntimeKind = "jvm" | "nodejs" | "python" | "go" | "dotnet" | "nginx" | "redis" | "postgres";
export type AppColumnId =
  | "nodeEventLoopLag" | "nodeHeapUsed" | "pyRss" | "goGoroutines" | "goHeapInuse" | "dotnetMemory"
  | "nginxConnections" | "nginxRequests" | "redisClients" | "redisMemory" | "pgConnections" | "openFds";
/** measured = series exist · absent = the metric is not in the workspace · queryFailed = the query did not answer */
export type AppMetricState = "measured" | "absent" | "queryFailed";
export type AppRuntimeBasis = "metrics" | "telemetry" | "config" | "spec" | "scan" | "image";
export type AppRuntimeEvidence = {
  kind: AppRuntimeKind; basis: AppRuntimeBasis;
  /** The runtime's version as it reports it (metrics · telemetry only) */
  version?: string;
  /** What said so: "command: java" · "env: NODE_OPTIONS" · "scan: java" … (names only, never a value) */
  evidence?: string;
};
export type AppMetricsResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  metricsState: WorkloadHeatmapResponse["metricsState"];
  message?: string;
  runtimes: { kind: AppRuntimeKind; state: AppMetricState; /** workloads whose metrics say so */ workloads: number; /** workloads known by other evidence only (telemetry · spec · scan · official image) */ hinted: number }[];
  columns: { id: AppColumnId; runtime: AppRuntimeKind | "any"; unit: "ms" | "bytes" | "count" | "perSec" | "ratio"; state: AppMetricState; workloads: number }[];
  workloads: { namespace: string; workload: string; kinds: AppRuntimeEvidence[]; values: Partial<Record<AppColumnId, number>> }[];
  gaps?: StackQueryGap[];
  /** The non-metric sources this answer could use: spec (Kubernetes API) · scan (Defender; empty = no scanned image matched) */
  evidence?: {
    spec: "ok" | "unavailable"; scan: "ok" | "empty" | "unavailable";
    /** Image configs from the registry: off = the connection did not opt in · none = no registry image · forbidden = no AcrPull */
    imageConfig?: { state: "ok" | "off" | "forbidden" | "unreachable" | "failed" | "none"; read: number; pending: number };
  };
};

/**
 * AKS 모니터링 › SLO › RED (트레이스) — requests · errors · duration per service from the trace pipeline's spanmetrics
 * (`traces_spanmetrics_calls_total`, `traces_spanmetrics_duration_seconds_bucket`): server spans only, /actuator
 * apart. Duration is a bucket boundary ("≤ 0.5 s"), never interpolated.
 */
export type RedWindow = 5 | 15 | 60 | 360 | 1440;
/** A quantile as the bucket that holds it: `le` = its upper boundary in seconds; null `le` = above the last boundary */
export type RedQuantile = { le: number | null };
export type RedEndpoint = {
  /** the span name (method + route template, as the app's instrumentation names it) */
  name: string;
  requests: number;
  errors: number;
  p95: RedQuantile | null;
};
export type RedService = {
  /** the OpenTelemetry service.name */
  service: string;
  /** The workload of exactly that name (one only) — otherwise null + how many had the name */
  workload: { namespace: string; name: string; kind: "Deployment" | "StatefulSet" | "DaemonSet" } | null;
  sameName: number;
  /** requests in the window (server spans, /actuator excluded) and per second */
  requests: number;
  rate: number;
  /** server spans with status ERROR (on an HTTP server span: 5xx or an exception while handling — not 4xx) */
  errors: number;
  /** null when there were no requests */
  errorRate: number | null;
  p50: RedQuantile | null; p95: RedQuantile | null; p99: RedQuantile | null;
  /** /actuator requests per second, apart */
  actuatorRate: number;
  /** busiest span names first — every one with requests in the window (≤ RED_TOP_ENDPOINTS) */
  endpoints: RedEndpoint[];
  /** under RED_MIN_REQUESTS in the window — the ratios are shown, not judged */
  lowTraffic: boolean;
  /** the same window a week earlier (null = not read, or no series then) — a fact to compare with, not a baseline model */
  weekAgo?: { requests: number; rate: number; errors: number; errorRate: number | null; p95: RedQuantile | null } | null;
  /**
   * The same service's errors from other sources (2026-11-19 — a workflow failure answered as HTTP 424 and logged as
   * ERROR from an executor thread had no ERROR span, so `errors` was 0): Micrometer HTTP server answers 4xx / 5xx and
   * log ERROR / FATAL events of the application named exactly like the service. null = that source has no series for
   * this application (not instrumented) or was not read — never 0 for "unknown".
   */
  other?: { http4xx: number | null; http5xx: number | null; logErrors: number | null };
};
export type WorkloadRedResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowMinutes: RedWindow;
  /** the other error sources of `RedService.other`: read · no series in this cluster · the query failed */
  otherSources?: { http: "ok" | "none" | "failed"; log: "ok" | "none" | "failed" };
  metricsState: "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "tooCostly" | "failed";
  message?: string;
  /** whether spanmetrics exist at all in this cluster's scope */
  instrumented: boolean;
  /** the histogram's boundaries (seconds) */
  buckets: number[];
  /** counter resets in the window over all calls series — > 0 = the rates can be inflated (two writers per series); null = not read */
  resets: number | null;
  /** services with no workload of the same name are still listed (workload null) */
  services: RedService[];
  gaps?: StackQueryGap[];
};

/**
 * AKS 모니터링 › 서비스 (APM) › 서비스 맵 — who calls whom, from the trace pipeline's service graph
 * (`traces_service_graph_request_total` · `_failed_total` · `_server_seconds_bucket` — OpenTelemetry Collector / Grafana
 * Alloy `servicegraph` connector, Tempo metrics-generator: the same names on any cloud). An edge = a client span matched
 * with its server span. Requests include the failed ones; duration is the server side, as the bucket holding the quantile.
 */
export type ServiceGraphEdgeKind = "direct" | "virtual" | "messaging" | "database" | "other";
export type ServiceGraphEdge = {
  client: string;
  server: string;
  /** connection_type: "" = both sides instrumented · virtual_node = one side is not (an uninstrumented caller or peer) */
  kind: ServiceGraphEdgeKind;
  requests: number;
  rate: number;
  failed: number;
  /** null without requests */
  errorRate: number | null;
  p95: RedQuantile | null;
  p99: RedQuantile | null;
  /** under RED_MIN_REQUESTS in the window — shown, not judged */
  lowTraffic: boolean;
};
export type ServiceGraphNode = {
  service: string;
  /** "user" / "unknown": the client side of a root span — callers outside the traced services */
  entry: boolean;
  /** the namespace the pipeline put on the server side (server_k8s_namespace_name), when it did */
  namespace: string | null;
  /** The workload of exactly that name (in `namespace` when known, else one only) — otherwise null */
  workload: { namespace: string; name: string; kind: "Deployment" | "StatefulSet" | "DaemonSet" } | null;
  inbound: { requests: number; failed: number; errorRate: number | null };
  outbound: { requests: number; failed: number };
};
export type ServiceGraphResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowMinutes: RedWindow;
  metricsState: WorkloadRedResponse["metricsState"];
  message?: string;
  /** whether service-graph series exist at all in this cluster's scope */
  instrumented: boolean;
  /** counter resets in the window over the request series — said beside the numbers; null = not read */
  resets: number | null;
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  /** the server histogram's boundaries (seconds) */
  buckets: number[];
  /** the PromQL behind the numbers (the window's increase), for "how was this measured" */
  queries: Record<string, string>;
  gaps?: StackQueryGap[];
};

/**
 * 서비스 (APM) › 의존성 — what each application calls outside the traced services and what it waits on, from the
 * application's own Micrometer metrics (vendor-neutral names): outbound HTTP (`http_client_requests_seconds` — both the
 * classic `client_name`/`status`/`outcome` tags and the Observation convention `clientname`/`http_status_code`/`error`),
 * JDBC pools (`hikaricp_*`), Kafka consumers (`kafka_consumer_fetch_manager_records_lag_max`). Timers here carry no
 * histogram: latency is average (sum / count) and the window's maximum — never a percentile.
 */
export type OutboundCall = {
  /** the target host / client name as the app tags it ("" = not tagged) */
  target: string;
  /** which tag set the app uses */
  convention: "micrometer" | "observation";
  requests: number;
  rate: number;
  /** 5xx, an I/O error with no response, or an exception tag — not 4xx */
  failed: number;
  errorRate: number | null;
  /** seconds; null when not read */
  avg: number | null;
  max: number | null;
  /** requests by status as tagged ("" = untagged) — the busiest first, ≤ 6 */
  statuses: Array<{ status: string; requests: number }>;
};
export type DbPool = {
  pool: string;
  /** now */
  active: number | null;
  max: number | null;
  pending: number | null;
  /** the window's highest pending (threads waiting for a connection) */
  pendingPeak: number | null;
  /** connection acquisitions that timed out in the window */
  timeouts: number | null;
  /** average wait to get a connection in the window (seconds) */
  acquireAvg: number | null;
};
export type KafkaConsumer = {
  topic: string;
  /** records behind (max over the app's consumers of the topic): now and the window's peak */
  lag: number | null;
  lagPeak: number | null;
};
export type AppDependencies = {
  application: string;
  namespace: string | null;
  /** the service-map node of exactly that name (the trace service.name), when there is one */
  inServiceMap: boolean;
  outbound: OutboundCall[];
  pools: DbPool[];
  consumers: KafkaConsumer[];
};
export type AppDependenciesResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowMinutes: RedWindow;
  metricsState: WorkloadRedResponse["metricsState"];
  message?: string;
  /** whether any of the three families exist in this cluster's scope */
  instrumented: boolean;
  apps: AppDependencies[];
  queries: Record<string, string>;
  gaps?: StackQueryGap[];
};


/**
 * AKS 모니터링 › 경고 신호 — Microsoft's recommended Kubernetes alert rules (Azure/prometheus-collector, verbatim) evaluated
 * in this cluster's workspace with each metric family's scope: firing now (held for the rule's "for"), clear, or cannot
 * fire here (a metric it reads is not in the workspace).
 */
export type RecommendedAlertFiring = {
  /** the labels that name the object (namespace, controller, pod, node, persistentvolumeclaim, …) */
  object: Record<string, string>;
  value: number;
};
export type RecommendedAlertRule = {
  alert: string;
  group: "cluster" | "node" | "pod";
  /** Azure Monitor severity as the template sets it (0 critical … 4 verbose) */
  severity: number;
  forMinutes: number;
  state: "firing" | "clear" | "noData" | "ambiguous" | "failed";
  /** noData: the required metrics not in the workspace · ambiguous: metrics written for several clusters */
  missing?: string[];
  reason?: string;
  /** required metrics */
  metrics: string[];
  firing: RecommendedAlertFiring[];
  /** Microsoft's expression, and the one run here (job matchers replaced by this cluster's scope) */
  original: string;
  expression?: string;
  /**
   * A `job="…"` in Microsoft's expression that no series of that metric has here (stg 2026-11-16: kubelet series are
   * job "prometheus.scrape.kubelet", not "kubelet") — deployed as shipped, the rule matches nothing
   */
  jobMismatch?: Array<{ metric: string; expected: string; actual: string[] }>;
  /** This dashboard's correction (not Microsoft's), evaluated here like the original */
  fix?: {
    why: "metricMissing" | "duplicateMatch";
    original: string;
    expression: string;
    state: "firing" | "clear" | "failed" | "noData";
    firing: RecommendedAlertFiring[];
  };
};
/** An ARM template of rule groups for this cluster: every rule that evaluates here, corrected where needed */
export type RecommendedAlertsTemplate = {
  json: string;
  /** rules as Microsoft wrote them (job matchers set to this workspace's scope) */
  included: string[];
  /** rules replaced by this dashboard's correction */
  fixed: string[];
  /** rules left out and why (a metric not in the workspace, an expression that errors, several clusters) */
  excluded: Array<{ alert: string; reason: "noData" | "failed" | "ambiguous"; missing?: string[] }>;
};
export type RecommendedAlertsResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  metricsState: WorkloadRedResponse["metricsState"];
  message?: string;
  source: string;
  rules: RecommendedAlertRule[];
  template?: RecommendedAlertsTemplate;
  gaps?: StackQueryGap[];
};


/**
 * 서비스 (APM) › 오류 — error events per application from the apps' own logging metrics (`log4j2_events_total` — Log4j2
 * Micrometer binder; `logback_events_total` when an app uses Logback): the window's ERROR / FATAL / WARN counts and an
 * hourly 7-day series (first and last error hour, the days' totals, "new in the last 24 h"). The metric carries no
 * exception class — which exception: the logs tab's insights (Loki, ≤ 6 h).
 */
export type AppErrorSeries = {
  application: string;
  namespace: string | null;
  workload: { namespace: string; name: string; kind: "Deployment" | "StatefulSet" | "DaemonSet" } | null;
  /** the window's events by level (null = not read) */
  error: number | null;
  fatal: number | null;
  warn: number | null;
  /** ERROR + FATAL per day, oldest first (7 days ending at the read time) */
  daily: Array<{ day: string; errors: number }>;
  /** first / last hour with an ERROR or FATAL event in the 7 days (ISO), null = none */
  firstSeen: string | null;
  lastSeen: string | null;
  /** errors in the last 24 h and none in the 6 days before */
  newIn24h: boolean;
};
export type AppErrorsResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowMinutes: RedWindow;
  metricsState: WorkloadRedResponse["metricsState"];
  message?: string;
  /** which logging metric answered (null = neither exists) */
  metric: "log4j2_events_total" | "logback_events_total" | null;
  apps: AppErrorSeries[];
  queries: Record<string, string>;
  gaps?: StackQueryGap[];
};

/**
 * 서비스 (APM) › 배포 — rollouts (a new ReplicaSet of a Deployment, kube-state-metrics) with the image before and after
 * and the same-name service's server spans 30 minutes before vs after (Datadog deployment tracking, Dynatrace release
 * comparison). A rollback to an existing ReplicaSet creates none — not shown.
 */
export type RolloutRed = { requests: number; errors: number; errorRate: number | null; p95: RedQuantile | null };
export type Rollout = {
  namespace: string;
  deployment: string;
  replicaset: string;
  /** the new ReplicaSet's creation time (ISO) */
  at: string;
  /** container → image of the new ReplicaSet's pods now (empty when none run) and of the Deployment's pods a minute before */
  images: Array<{ container: string; image: string }>;
  previousImages: Array<{ container: string; image: string }> | null;
  /** "rollout" = `images` were read 3 minutes after the rollout (its pods are gone now — replaced since) */
  imagesAt?: "rollout";
  /** the trace service of exactly the Deployment's name, when there is one */
  service: string | null;
  before: RolloutRed | null;
  after: RolloutRed | null;
  /** minutes the "after" covers (< 30 when the rollout is recent) */
  afterMinutes: number;
};
export type RolloutsResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowDays: 1 | 7;
  metricsState: WorkloadRedResponse["metricsState"];
  message?: string;
  rollouts: Rollout[];
  /** rollouts in the window beyond the ones compared (most recent first are compared) */
  more: number;
  buckets: number[];
  queries: Record<string, string>;
  gaps?: StackQueryGap[];
};
// ── 서비스 (APM) › 트레이스 — Tempo through the customer's Azure Managed Grafana (services/grafanaTraces.ts) ──

/**
 * Why a trace read gave nothing: notConfigured (no Grafana / Tempo datasource / `traces` opt-in on the connection) ·
 * forbidden (the connection's identity has no Grafana role — Grafana Viewer) · unsupportedMode (delegated or
 * Lighthouse connection: no app token for Grafana) · notFound (trace ID not in Tempo — retention or sampling) · failed
 */
export type TraceState = "ok" | "notConfigured" | "forbidden" | "unsupportedMode" | "notFound" | "failed";

export type TraceSearchQuery = {
  service?: string;
  namespace?: string;
  /** span name, e.g. "GET /orders/{id}" */
  name?: string;
  errorsOnly?: boolean;
  minDurationMs?: number;
};

export type TraceSummary = {
  traceId: string;
  rootService: string | null;
  rootName: string | null;
  start: string;
  durationMs: number | null;
  /** per service: spans and error spans of the whole trace (Tempo serviceStats) */
  services: Array<{ name: string; spans: number; errors: number }>;
  /** spans of this trace that matched the query (Tempo `matched`) */
  matched: number;
};

export type TraceSearchResponse = {
  clusterId: string;
  generatedAt: string;
  state: TraceState;
  message?: string;
  /** the TraceQL the dashboard sent — run it in Grafana to compare */
  traceql: string;
  from: string;
  to: string;
  traces: TraceSummary[];
  /** Tempo answered from part of its blocks (completedJobs < totalJobs) — more traces may exist */
  partial: boolean;
  limit: number;
  /** the window's start (epoch s) — later pages keep it */
  since: number;
  /** the next page's end (epoch s): pass `before` = this and `since` — null = this was the last page */
  next: number | null;
  exploreUrl?: string;
};

export type TraceSpan = {
  spanId: string;
  parentId: string | null;
  service: string | null;
  namespace: string | null;
  pod: string | null;
  name: string;
  kind: "server" | "client" | "internal" | "producer" | "consumer" | "unspecified";
  /** ms since the trace's first span */
  offsetMs: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
  statusMessage?: string;
  attributes: Array<{ key: string; value: string }>;
  events: Array<{ name: string; offsetMs: number; attributes: Array<{ key: string; value: string }> }>;
};

export type TraceDetailResponse = {
  clusterId: string;
  generatedAt: string;
  state: TraceState;
  message?: string;
  traceId: string;
  start?: string;
  durationMs?: number;
  spans: TraceSpan[];
  /** more spans than the dashboard shows (cap) */
  truncated?: number;
  /** values masked by the log redaction rules (tokens, keys …) */
  redacted: number;
  exploreUrl?: string;
};

// ── 모니터링 › 프로필 (Pyroscope through the customer's Grafana — services/grafanaProfiles.ts) ──

export type ProfileState = "ok" | "notConfigured" | "unsupportedMode" | "forbidden" | "notFound" | "failed";
/** What a profile type measures (Datadog's per-language names map onto these — web lib/profileView.ts) */
export type ProfileKind =
  | "cpu" | "wall" | "allocBytes" | "allocCount" | "heapBytes" | "heapCount"
  | "lockTime" | "lockCount" | "blockTime" | "blockCount" | "goroutines" | "exceptions" | "other";
export type ProfileTypeInfo = {
  /** Pyroscope's ID <name>:<sample type>:<unit>:<period type>:<period unit> */
  id: string;
  name: string;
  sampleType: string;
  unit: string;
  kind: ProfileKind;
};
export type ProfileServiceRow = {
  service: string;
  namespace: string | null;
  /** pyroscope_spy (javaspy, gospy, pyspy …) and the language it means (null = an unknown spy) */
  spy: string | null;
  language: string | null;
  /** the types this service sent in the window, with the window's total (unit of the type) */
  types: Array<{ id: string; total: number }>;
};
export type ProfileCatalogResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  windowMinutes: number;
  state: ProfileState;
  message?: string;
  types: ProfileTypeInfo[];
  services: ProfileServiceRow[];
  /** the label names of the profiles — a thread timeline needs a thread label (and per-sample times) */
  labels: string[];
};
/** A profile as Pyroscope merges it: a nested set (depth-first rows) — level, total, self and a name index per node */
export type ProfileTree = { level: number[]; value: number[]; self: number[]; label: number[]; names: string[] };
export type ProfileResponse = {
  clusterId: string;
  generatedAt: string;
  state: ProfileState;
  message?: string;
  service: string;
  typeId: string;
  unit: string;
  /** the window read (ISO) */
  from: string;
  to: string;
  tree: ProfileTree | null;
  /** the root's value — the whole window in the type's unit */
  total: number | null;
  /** the service's series of this type over the page's range (one point per step) — the timeline to pick a window on */
  series: Array<{ t: number; v: number }> | null;
  stepSeconds: number | null;
  /** the comparison window's tree (same service and type) — `compareFrom` / `compareTo` */
  compare?: { from: string; to: string; tree: ProfileTree | null; total: number | null };
};

// ── SLO › 서비스 상세 (Datadog suite SLO: the SLO over its window, the global uptime bar, primary contributors) ──

/** One bucket of the uptime bar: requests, failed (5xx) and its state against the target — noData = no request */
export type SloUptimeBucket = { t: number; total: number; bad: number; sli: number | null; state: "ok" | "error" | "noData" };
export type SloContributor = { method: string; uri: string; bad: number; total: number; share: number };
export type SloUptimeResponse = {
  clusterId: string;
  generatedAt: string;
  at?: string;
  metricsState: WorkloadSloResponse["metricsState"];
  message?: string;
  namespace: string;
  application: string;
  /** the availability target and where it came from */
  target: number;
  targetSource: "platform" | "config" | "default";
  /** the service's window (its own, else the cluster's) — counted from a later budget reset when there is one */
  windowDays: number;
  windowSource: "service" | "cluster";
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: SloUptimeBucket[];
  totals: { total: number; bad: number; sli: number | null; allowed: number; budgetUsed: number | null; uptime: number | null };
  /** the endpoints that spent the error budget — failed requests, share of all failed */
  contributors: SloContributor[];
  /** how many endpoints failed at least once */
  consumedBy: number;
  /** URIs counted: only these (core endpoints) / all but these */
  only: string[];
  excluded: string[];
  reset?: { at: string; reason?: string };
  queries: { total: string; bad: string; byUri: string };
};
