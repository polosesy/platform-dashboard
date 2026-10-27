// ─────────────────────────────────────────────────────────────
// Cilium Hubble Types
// Covers: Service Dependency Map, Network Monitoring,
//         Application Monitoring, Security Observability
// ─────────────────────────────────────────────────────────────

// ── Flow primitives ──

export type HubbleFlowVerdict = "FORWARDED" | "DROPPED" | "AUDIT" | "ERROR" | "REDIRECTED";
export type HubbleFlowType = "L3_L4" | "L7" | "UNKNOWN";
export type HubbleL7Type = "HTTP" | "DNS" | "KAFKA" | "UNKNOWN";

export type HubbleEndpoint = {
  namespace: string;
  podName: string;
  labels: Record<string, string>;
  identity: number;
  workloadName: string;
};

export type HubbleFlow = {
  time: string;
  source: HubbleEndpoint;
  destination: HubbleEndpoint;
  verdict: HubbleFlowVerdict;
  type: HubbleFlowType;
  l4Protocol: "TCP" | "UDP" | "ICMP" | "UNKNOWN";
  sourcePort: number;
  destinationPort: number;
  l7?: {
    type: HubbleL7Type;
    http?: {
      code: number;
      method: string;
      url: string;
      protocol: string;
      latencyNs: number;
    };
    dns?: {
      query: string;
      rcode: number;
      responseIps: string[];
    };
  };
  trafficDirection: "INGRESS" | "EGRESS" | "UNKNOWN";
  dropReasonDesc: string;
  isReply: boolean;
  nodeName: string;
  summary: string;
  /** Packet identity used to collapse the same packet seen at several observation points */
  sourceIp?: string;
  destinationIp?: string;
  tcpFlags?: string;
  /** Hubble event kind (`event_type.type`: 1 drop · 4 trace · 5 policy-verdict · 129 l7) */
  eventKind?: HubbleEventKind;
  /** policy-verdict events: Cilium's policy match type (1 L3 · 2 L3+L4 · 3 L4 · 4 all/wildcard …) */
  policyMatch?: number;
  /** policy-verdict events (Cilium ≥ 1.15): the rules that allowed it, in the flow's direction */
  allowedBy?: HubblePolicyRef[];
  /** Names the DNS proxy saw for the destination IP (toFQDNs) */
  destinationNames?: string[];
};

export type HubbleEventKind = "trace" | "drop" | "policy-verdict" | "l7" | "other";

/** One entry of `egress_allowed_by` / `ingress_allowed_by`: a named policy, or a rule Cilium derived itself */
export type HubblePolicyRef = {
  name?: string;
  namespace?: string;
  kind?: string;
  /** `io.cilium.policy.derived-from` of a synthetic rule (allow-any-egress, allow-localhost-ingress …) */
  derivedFrom?: string;
};

/**
 * What a connection's policy-verdict says about enforcing (services/hubbleAudit.ts):
 * policy = a named policy allows it · auditOnly = passed only by the allow-any rule an audit policy
 * (`enableDefaultDeny: false`) or no policy leaves — blocked once a default-deny policy selects it ·
 * default = a rule Cilium always keeps (kubelet probes) · dropped = dropped by policy now · unknown
 */
export type HubbleJudgementKind = "policy" | "auditOnly" | "default" | "dropped" | "unknown";
export type HubblePolicyJudgement = {
  kind: HubbleJudgementKind;
  /** `namespace/name` of the allowing policies (`cluster/name` for clusterwide) */
  policies: string[];
  /** allowedBy = Cilium's own record · verdict = the event verdict · estimate = match type only (Cilium < 1.15) */
  basis: "allowedBy" | "verdict" | "estimate" | "none";
};

/** Connections that would be blocked when the policy is enforced, from policy-verdict events */
export type HubbleEnforceReadiness = {
  /** policy-verdict events (one per new connection) still in the agents' buffers */
  verdictEvents: number;
  /** Time span of those events — connections older than this, or long-lived ones, are not in it */
  oldest: string | null;
  newest: string | null;
  /** The agents report allowed-by (Cilium ≥ 1.15) — otherwise the counts are estimates from the match type */
  allowedBySupported: boolean;
  counts: Record<HubbleJudgementKind, number>;
  byPolicy: { policy: string; count: number }[];
  wouldDrop: {
    direction: "INGRESS" | "EGRESS" | "UNKNOWN";
    /** The selected workload (`namespace/workload`) */
    subject: string;
    /** The other side: DNS names, workload, reserved identity or IP */
    peer: string;
    peerNames: string[];
    peerIdentity: number;
    port: number;
    protocol: string;
    count: number;
    lastSeen: string;
  }[];
};

// ── Collection coverage ──

/** One cilium agent's ring buffer as read for this response. */
export type HubbleNodeCoverage = {
  nodeName: string;
  podName: string;
  /** Events returned by this agent before de-duplication */
  events: number;
  oldest: string | null;
  newest: string | null;
  /** Agent returned as many events as requested — older history was cut off */
  bufferFull: boolean;
  error?: string;
};

/**
 * What the flows behind a response actually cover. Hubble keeps a small
 * per-node ring buffer, so "last N minutes" is only as long as the busiest
 * node's buffer lasts.
 */
export type HubbleCoverage = {
  source: "agents" | "relay" | "api-proxy" | "flow-logs" | "hubble-ui";
  nodesObserved: number;
  nodesTotal: number;
  nodes: HubbleNodeCoverage[];
  /** Start of the span every observed node covers (null when nothing was read) */
  commonSince: string | null;
  newest: string | null;
  /** Minutes in which all observed nodes have complete data */
  commonWindowMinutes: number;
  /** Raw events read from all nodes, and how many were the same packet seen twice */
  rawEvents: number;
  duplicatesRemoved: number;
};

export type HubbleFlowSet = {
  flows: HubbleFlow[];
  coverage: HubbleCoverage;
};

// ── Service Dependency Map ──

/** Cilium reserved identity 또는 워크로드 유형 */
export type HubbleServiceType = "workload" | "world" | "host" | "health" | "dns" | "init" | "unmanaged" | "kube-apiserver" | "remote-node";

/** K8s Service에 연결된 Pod 엔드포인트 */
export type HubbleEndpointPod = {
  podName: string;
  podIP: string;
  ready: boolean;
  nodeName: string;
};

/** K8s Service 메타데이터 */
export type HubbleK8sService = {
  serviceName: string;
  clusterIP: string;
  type: "ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName";
  ports: { port: number; targetPort: number | string; protocol: string; name?: string }[];
  selector: Record<string, string>;
  endpoints: HubbleEndpointPod[];
};

export type HubbleServiceNode = {
  id: string;                     // `${namespace}/${workloadName}`
  namespace: string;
  workloadName: string;
  identity: number;
  /** 이 워크로드에서 관찰된 Pod 수 */
  podCount: number;
  /** 서비스 유형 (Cilium reserved identity 기반) */
  serviceType: HubbleServiceType;
  /** 주요 라벨 (필터/표시용) */
  labels: Record<string, string>;
  /** 이 노드에 연결된 노드 ID 목록 */
  connectedTo: string[];
  /** 이 워크로드에 매핑된 K8s Service 목록 */
  k8sServices?: HubbleK8sService[];
  metrics: {
    totalFlows: number;
    forwardedFlows: number;
    droppedFlows: number;
    httpRequestsTotal: number;
    httpErrorCount: number;
    avgLatencyMs: number | null;
    /** DNS 쿼리 수 (DNS 노드용) */
    dnsQueryCount: number;
    /** DNS 에러 수 */
    dnsErrorCount: number;
  };
};

export type HubbleServiceEdge = {
  id: string;                     // `${sourceId}->${destId}:${port}`
  sourceId: string;
  destinationId: string;
  /** 주요 프로토콜 */
  protocol: string;
  port: number;
  /** 양방향 트래픽 여부 */
  bidirectional: boolean;
  metrics: {
    flowCount: number;
    droppedCount: number;
    httpRequestCount: number;
    httpErrorRate: number;        // 0-1
    avgLatencyMs: number | null;
    /** 초당 플로우 (rate) */
    flowsPerSecond: number | null;
  };
  /** 대표 verdict */
  verdict: HubbleFlowVerdict;
  /** L7 상세 (HTTP methods, DNS queries 등) */
  l7Summary?: {
    httpMethods?: string[];
    topUrls?: string[];
    dnsQueries?: string[];
  };
};

export type HubbleServiceMapResponse = {
  clusterId: string;
  generatedAt: string;
  timeWindowMinutes: number;
  nodes: HubbleServiceNode[];
  edges: HubbleServiceEdge[];
  totalFlowsAnalyzed: number;
  /** 관측된 네임스페이스 목록 */
  namespaces: string[];
  coverage: HubbleCoverage;
};

// ── Flows (raw flow table) ──

export type HubbleFlowsResponse = {
  clusterId: string;
  generatedAt: string;
  flows: HubbleFlow[];
  totalReturned: number;
  hasMore: boolean;
  coverage: HubbleCoverage;
};

// ── Network Monitoring ──

export type HubbleNetworkSummary = {
  clusterId: string;
  generatedAt: string;
  timeWindowMinutes: number;
  totalFlows: number;
  forwardedFlows: number;
  droppedFlows: number;
  topDropped: {
    source: string;
    destination: string;
    count: number;
    dropReason: string;
  }[];
  dnsErrors: {
    query: string;
    rcode: number;
    count: number;
  }[];
  /** 프로토콜별 분포 */
  protocolBreakdown: {
    protocol: string;
    count: number;
  }[];
  /** 네임스페이스별 트래픽 */
  namespaceTraffic: {
    namespace: string;
    inbound: number;
    outbound: number;
    dropped: number;
  }[];
  coverage: HubbleCoverage;
};

// ── Security Observability ──

export type HubbleSecuritySummary = {
  clusterId: string;
  generatedAt: string;
  timeWindowMinutes: number;
  policyVerdicts: {
    allowed: number;
    denied: number;
    audit: number;
  };
  topDenied: {
    source: string;
    destination: string;
    port: number;
    protocol: string;
    count: number;
    direction: "INGRESS" | "EGRESS" | "UNKNOWN";
  }[];
  /** identity 기반 플로우 매트릭스 */
  /** From policy-verdict events: what enforcing would block (absent when no verdict events were read) */
  enforceReadiness?: HubbleEnforceReadiness;
  identityFlows: {
    sourceIdentity: number;
    sourceLabel: string;
    destIdentity: number;
    destLabel: string;
    allowed: number;
    denied: number;
  }[];
  coverage: HubbleCoverage;
};

// ── Hubble Status ──

export type HubbleStatusResponse = {
  clusterId: string;
  generatedAt: string;
  available: boolean;
  version: string;
  numFlows: number;
  maxFlows: number;
  uptimeNs: number;
  nodeCount: number;
  /** cilium agents found in the cluster (nodeCount = agents that answered) */
  nodesTotal: number;
  message: string;
};

// ── Sources without Hubble exec (services/hubbleSources.ts) ──

/**
 * Where the Hubble views read from: exec on the agents · ACNS flow logs (Log Analytics) · the cluster's Hubble UI
 * (a live sample of the relay through its backend — services/hubbleUiSource.ts) · Hubble metrics (Managed Prometheus)
 */
export type HubbleDataSource = "exec" | "flowLogs" | "hubbleUi" | "metrics" | "none";
export type HubbleUiState = "ok" | "notConfigured" | "unreachable" | "unsupported" | "failed";

export type HubbleMetricsState = "ok" | "noWorkspace" | "noHubbleMetrics" | "ambiguousCluster" | "forbidden" | "throttled" | "failed";
export type HubbleLogsState = "ok" | "notEnabled" | "forbidden" | "failed";

export type HubbleSourcesResponse = {
  clusterId: string;
  generatedAt: string;
  selected: HubbleDataSource;
  exec: { allowed: boolean; reason?: "deployment" | "connection" };
  /** ContainerNetworkLogs rows for this cluster in the last hour (resource-centric query) */
  flowLogs: { state: HubbleLogsState; rows1h: number | null; newest: string | null };
  /** The cluster's Hubble UI backend (connections file `aks.observability.hubbleUi`) */
  hubbleUi: { state: HubbleUiState; message?: string };
  metrics: { state: HubbleMetricsState; message?: string };
};

/** A pod resolved to its workload: owner metrics (kube_pod_owner → ReplicaSet → Deployment) or the name pattern */
export type HubbleWorkloadRef = { namespace: string; workload: string; kind: string | null; basis: "owner" | "pattern" };

/** Per workload, counted in the window (Hubble events — not connections). null = the metric family is not collected */
export type HubbleMetricsWorkload = HubbleWorkloadRef & {
  pods: number;
  /** Events the workload sent (series with `source`) / received (series with `destination`) */
  egressEvents: number;
  ingressEvents: number;
  drops: number | null;
  policyDenied: number | null;
  dnsErrors: number | null;
};

export type HubbleMetricsSummary = {
  clusterId: string;
  generatedAt: string;
  windowMinutes: number;
  state: HubbleMetricsState;
  message?: string;
  /** How the series were scoped to this cluster: exact `cluster` label, a sole other value (alias) or no label */
  /** `collector`: set when two collectors write the same series (Alloy relabels KSM / node-exporter to the
   *  ama-metrics job names, so only this label tells them apart) — one is counted, never both */
  scope: { cluster: string | null; job: string | null; collector?: string | null; basis: "exact" | "alias" | "unscoped" } | null;
  /** Metric families absent from the workspace — their fields are null, never 0 */
  missing: string[];
  /** hubble_lost_events_total in the window — > 0 means the counts are understated */
  lostEvents: number | null;
  workloads: HubbleMetricsWorkload[];
  /** Events not attributed to a workload, kept so totals add up: the label is not a pod (IP, reserved identity) /
   *  the series names neither side (host, world — most of the trace events) */
  unattributed: { egressEvents: number; ingressEvents: number; unlabelledEvents: number };
  byVerdict: { forwarded: number; dropped: number; redirected: number; error: number };
  protocols: { protocol: string; events: number }[];
  dropsByReason: { reason: string; count: number }[];
  /** policy_denied drops per workload and side */
  policyDenied: (HubbleWorkloadRef & { direction: "EGRESS" | "INGRESS"; count: number })[];
  /** type="policyverdict" events — no match / allowed-by labels, so they cannot tell what enforcing would block */
  policyVerdictEvents: { forwarded: number; dropped: number; redirected: number };
  /** DNS responses that were not "No Error", by the pod the series names (CoreDNS = the server side) */
  dnsErrors: { rcode: string; namespace: string; workload: string; side: "server" | "client"; count: number }[];
  /** Series cut at the row limit */
  truncated: boolean;
};
