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
};

// ── Service Dependency Map ──

/** Cilium reserved identity 또는 워크로드 유형 */
export type HubbleServiceType = "workload" | "world" | "host" | "dns" | "init" | "unmanaged" | "kube-apiserver" | "remote-node";

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
};

// ── Flows (raw flow table) ──

export type HubbleFlowsResponse = {
  clusterId: string;
  generatedAt: string;
  flows: HubbleFlow[];
  totalReturned: number;
  hasMore: boolean;
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
  identityFlows: {
    sourceIdentity: number;
    sourceLabel: string;
    destIdentity: number;
    destLabel: string;
    allowed: number;
    denied: number;
  }[];
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
  message: string;
};
