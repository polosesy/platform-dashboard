// ═══════════════════════════════════════════════════════════════════
// Live Diagram — Hybrid Model Types
//
// Layer 1: DSL/JSON topology (infra engineer owns)
// Layer 2: Figma design tokens (product/UI designer owns)
// Layer 3: Azure runtime bindings (aggregator resolves)
// ═══════════════════════════════════════════════════════════════════

import type { InboundExposure } from "./architecture.js";

// ────────────────────────────────────────────
// 1. Diagram Spec (저장 단위, 정적 정의)
// ────────────────────────────────────────────

export type DiagramSpec = {
  $schema?: string;
  version: string;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  nodes: DiagramNodeSpec[];
  edges: DiagramEdgeSpec[];
  groups: DiagramGroupSpec[];
  settings: DiagramSettings;
};

export type DiagramNodeSpec = {
  id: string;
  label: string;
  icon: DiagramIconKind;
  groupId?: string;
  azureResourceId?: string;
  endpoint?: string;           // IP address or FQDN (e.g., "10.0.1.4" or "myapp.azurewebsites.net")
  position?: { x: number; y: number };
  parentId?: string;           // ReactFlow parent node (for VNet/Subnet containment)
  nodeType?: "group" | "default"; // "group" = container node (VNet/Subnet)
  width?: number;              // Explicit width for group nodes
  height?: number;             // Explicit height for group nodes
  bindings: Record<string, MetricBinding>;
  metadata?: Record<string, string>;  // Extensible: addressSpace, prefix, privateIP, etc.
  resourceKind?: string;       // Original resource type (e.g., "aks", "vm", "sql")
  location?: string;           // Azure region (e.g., "eastus")
  resourceGroup?: string;      // Parent resource group name
  tags?: Record<string, string>; // Azure resource tags
  subResources?: SubResource[];  // Embedded child objects (NICs in VM, Frontend IPs in AppGW)
};

export type SubResourceKind = "nic" | "frontendIP" | "publicIP" | "apiEndpoint";

export type SubResource = {
  id: string;
  label: string;
  kind: SubResourceKind;
  endpoint?: string;
  azureResourceId?: string;
  health?: HealthStatus;
};

// ── Architecture metadata types ──
export type DiagramFlowType =
  | "ingress"
  | "egress"
  | "east-west"
  | "control"
  | "dependency";

export type ArchRole =
  | "aks-cluster" | "aks-nodepool" | "aks-vmss"
  | "aks-ingress" | "aks-egress"
  | "aks-control-plane" | "aks-nat-gateway"
  | "nat-gateway"
  | "vm" | "vmss" | "db" | "cache"
  | "private-endpoint" | "gateway" | "load-balancer"
  | "firewall" | "waf" | "messaging"
  | "compute" | "storage" | "function" | "app-service"
  | "generic";

export type DiagramEdgeKind =
  | "network"
  | "hybrid"          // VPN gateway → on-premises site (S2S connection, catalog EDGE-09)
  | "peering"
  | "privateLink"
  | "routes"
  | "logging"
  | "inferred"
  | "attached-to"        // Subnet → NIC
  | "bound-to"           // NIC → VM
  | "outbound-internet"  // Resource → Internet (NAT GW / LB SNAT / PIP / default)
  | "natgw-association"  // Subnet → NAT GW (visible when NAT GW card is expanded)
  | "privateLinkUsage";  // Workload → Private Endpoint, observed in access / flow logs (web-only, never in a stored spec)

export type DiagramEdgeSpec = {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
  edgeKind?: DiagramEdgeKind;
  confidence?: number;         // 0-1, for inferred edges
  /** Where the link comes from: Azure configuration, or a guess from naming / grouping (never drawn as fact).
   *  Older saved specs omit it — treat `edgeKind === "inferred"` as inferred. */
  /** configured = Azure configuration · inferred = a guess (off by default) · observed = seen in logs */
  evidence?: "configured" | "inferred" | "observed";
  /** Inferred links only: the signals that produced the guess (same RG, same region, env tag, …) */
  inferenceReasons?: string[];
  /** i18n keys of what the measured value may include or miss (shown in the edge panel) */
  caveats?: string[];
  flowType?: DiagramFlowType;   // network flow semantics (ingress/egress/east-west/control/dependency)
  /** LB / App Gateway → backend member: how the pool names it (catalog AGW-03..05, LB-02/03, VMSS-04) */
  backend?: {
    via: "nic" | "ip" | "fqdn" | "vmssModel";
    pool?: string;
    /** Member address — the BackendServer / BackendIPAddress metric dimension */
    address?: string;
    /** AGW backend ports (BackendServer = "ip:port") */
    ports?: number[];
    /** cfg = configuration reference · ipMatch / fqdnMatch = current holder of the address */
    evidence?: "cfg" | "ipMatch" | "fqdnMatch";
  };
  /** AGC → AKS (AGC-04): nodeRg = the AGC sits in that cluster's node resource group · sameVnet = the only
   *  cluster in the association's VNet (a rule — drawn dashed) */
  rule?: "nodeRg" | "sameVnet";
  /** VNet peering line (EDGE-02): the worse of the two sides' states, and whether gateway transit is set up both ways */
  peeringState?: string;
  peeringTransit?: boolean;
  /** Front Door → origin resource (EDGE-04..07): the origin, its group and how it was matched */
  origin?: { name: string; group: string; evidence: "cfg" | "ipMatch" | "fqdnMatch"; status?: string };
  /** Internet → VM through an instance-level public IP: the NSG verdict the line is drawn from (PIP-04) */
  exposure?: InboundExposure;
  bindings: Record<string, MetricBinding>;
  animation: EdgeAnimationKind;
  alerts?: AlertCondition[];
};

/**
 * Front Door WAF coverage (catalog EDGE-10 / EDGE-11) — Front Door node metadata `wafState`. Per served domain:
 * prevent / detect / disabled (policy off) / none (read, no WAF) / unknown. Profile: all prevent, all none, all
 * detect, a mix with a gap (partial), only prevent + unknown (unknown), the security policies unreadable, or no
 * domain served. Configuration only — never the card status or fault impact.
 */
export type AfdWafDomainState = "prevent" | "detect" | "disabled" | "none" | "unknown";
export type AfdWafState = "prevent" | "detect" | "partial" | "none" | "unknown" | "unreadable" | "noDomains";

/**
 * One peering of a VNet, its own side (VNet metadata.peerings, JSON). `id` = the remote VNet's diagram node when
 * the graph has it (no remote ARM id is sent — it may be another subscription / tenant). Unknown flags are null.
 * `other` = the remote side when the graph sees it. `transit`: this VNet uses the remote gateway ("uses") / lets
 * the remote use its gateway ("provides") — only when both flags and both states agree (catalog EDGE-02).
 */
export type LivePeering = {
  key: string;
  link: string;
  id: string | null;
  name: string;
  state: string;
  sync: string | null;
  provisioning: string | null;
  access: boolean | null;
  forwarded: boolean | null;
  gatewayTransit: boolean | null;
  useRemoteGateways: boolean | null;
  remoteSpace: string[];
  remoteCurrentSpace: string[] | null;
  complete: boolean | null;
  localSubnets?: string[];
  remoteSubnets?: string[];
  other?: { state: string; sync: string | null; access: boolean | null; forwarded: boolean | null; gatewayTransit: boolean | null; useRemoteGateways: boolean | null };
  transit: "uses" | "provides" | null;
};

export type DiagramGroupSpec = {
  id: string;
  label: string;
  layout: "row" | "column" | "grid";
  parentGroupId?: string;
};

export type DiagramSettings = {
  refreshIntervalSec: number;
  defaultTimeRange: string;
  layout: DiagramLayoutKind;
  theme?: string;  // Figma token theme name
};

// ────────────────────────────────────────────
// 2. Metric Binding (DSL → Runtime 매핑)
// ────────────────────────────────────────────

export type MetricBinding = {
  source: MetricSourceKind;
  metric?: string;
  aggregation?: MetricAggregation;
  kql?: string;               // logAnalytics source only
  rules?: HealthRule[];        // composite source only
  /** "complement": the value shown is 100 − the metric (VM "Available Memory Percentage" → memory used %) */
  transform?: "complement";
  /** Azure Monitor `$filter` (dimension), server-authored only — e.g. "Direction eq 'In'" */
  filter?: string;
  /** Multiplier applied after aggregation and complement: 8/60 bytes per minute → bit/s, 1000 s → ms, 100 0..1 → % */
  scale?: number;
  /** Edges only: which end's Azure resource is queried (default: the source) */
  node?: "source" | "target";
  /** Read one bucket over this window instead of the latest 1-minute value (activity over an hour, NAT data path
   *  averaged over 15 minutes as Azure recommends) */
  window?: "PT15M" | "PT1H";
  /** Edges only: read the queried VM's instance-level public IP(s) instead of the node itself (server-derived) */
  on?: "publicIp";
  /**
   * `source: "derived"`: from two other bindings of the node. share = a/(a+b)×100, ratio = a/b×100, sum = a+b;
   * null when an operand is missing or the denominator is under `minDenominator` (default 1)
   */
  derive?: { op: "share" | "ratio" | "sum"; of: [string, string]; minDenominator?: number };
  /**
   * Not every resource of the kind has this metric (newer platform metric, SKU-dependent). Azure Monitor rejects
   * the whole request for an unknown name, so an optional metric that fails is dropped instead of the others.
   */
  optional?: boolean;
};

export type MetricSourceKind =
  | "monitor"
  | "logAnalytics"
  | "appInsights"
  | "serviceHealth"
  | "composite"
  /** Computed from two other bindings of the same node (`derive`) — e.g. App Gateway healthy share of backends */
  | "derived";

export type MetricAggregation = "avg" | "max" | "min" | "total" | "p50" | "p95" | "p99" | "rate" | "count";

export type HealthRule = {
  metric: string;
  op: "<" | ">" | "<=" | ">=" | "==";
  threshold: number;
  weight: number;
  /**
   * Hard threshold written as a pass condition: when it fails the resource is at least this level. Leveled rules
   * are never weighted and never treated as "activity" rules.
   */
  level?: "warning" | "critical";
  /** Judge only when another metric reaches a minimum (low-sample guard, e.g. requests ≥ 20 before an error rate) */
  when?: { metric: string; atLeast: number };
};

export type AlertCondition = {
  condition: string;
  severity: AlertSeverity;
};

// ────────────────────────────────────────────
// 3. Figma Design Tokens (Layer 2)
// ────────────────────────────────────────────

export type DesignTokenSet = {
  version: string;
  generatedAt: string;
  source: "figma" | "manual";
  figmaFileKey?: string;
  colors: {
    node: Record<HealthStatus, NodeColorToken>;
    edge: Record<EdgeStatus, EdgeColorToken>;
    alert: Record<AlertSeverity, string>;
    background: string;
    border: string;
  };
  animation: {
    particleDuration: Record<EdgeTrafficLevel, number>;
    particleCount: Record<EdgeTrafficLevel, number>;
    pulseFrequency: Record<HealthStatus, number>;
    transitionDuration: number;
  };
  dimensions: {
    nodeWidth: number;
    nodeHeight: number;
    edgeWidthRange: [number, number];
    particleRadius: Record<EdgeTrafficLevel, number>;
    healthRingRadius: number;
    healthRingStroke: number;
  };
  typography: {
    nodeLabel: { fontSize: number; fontWeight: number };
    nodeMetric: { fontSize: number; fontWeight: number };
    edgeLabel: { fontSize: number; fontWeight: number };
  };
};

export type NodeColorToken = {
  fill: string;
  border: string;
  shadow: string;
  ringStroke: string;
  text: string;
};

export type EdgeColorToken = {
  stroke: string;
  particle: string;
  glow?: string;
};

// ────────────────────────────────────────────
// 4. Live State (런타임 스냅샷)
// ────────────────────────────────────────────

export type LiveDiagramSnapshot = {
  diagramId: string;
  generatedAt: string;
  refreshIntervalSec: number;
  nodes: LiveNode[];
  edges: LiveEdge[];
  alerts: LiveAlert[];
  alertRules?: AlertRuleInfo[];
  topology?: {
    nodeCount: number;
    edgeCount: number;
    resolvedBindings: number;
    failedBindings: number;
  };
  faultImpacts?: FaultImpact[];
  /** "mock" = sample data (not real Azure resources or traffic); "azure" = read from Azure, possibly partly empty */
  dataSource?: "azure" | "mock";
  /** How much of the picture is measured — shown so an empty or static diagram is never read as "no traffic" */
  coverage?: LiveCoverage;
};

export type LiveSourceState = "ok" | "empty" | "signin" | "disabled" | "failed";

export type LiveCoverage = {
  /** Resource nodes with at least one metric value / resource nodes that have metric bindings */
  nodesWithMetrics: number;
  nodesWithBindings: number;
  /** Edges with measured traffic (throughput / requests / latency) / configured edges */
  edgesWithTraffic: number;
  configuredEdges: number;
  sources: {
    metrics: LiveSourceState;
    traffic: LiveSourceState;
    alerts: LiveSourceState;
  };
};

export type LiveNode = {
  id: string;
  health: HealthStatus;
  healthScore: number;
  metrics: Record<string, number | null>;
  activeAlertIds: string[];
  sparkline?: number[];  // last N metric values for mini chart
  sparklines?: Record<string, SparklineData>;
  powerState?: PowerState;
  /**
   * What the card's state rests on (services/healthEvidence.ts). `health` stays the risk axis; this says why it is
   * ok / unknown: metric = quality rules · resourceHealth = Azure Resource Health Available · observed = traffic seen
   * both ways in the window (inferred normal — not counted as ok) · configured = provisioned and approved, nothing
   * observed · notApplicable = Azure defines no state for it (NSG) · none = no evidence
   */
  basis?: "metric" | "resourceHealth" | "observed" | "configured" | "notApplicable" | "none";
  /** i18n keys of the evidence (ld.ev.*) shown in the panel */
  reasons?: string[];
};

export type LiveEdge = {
  id: string;
  status: EdgeStatus;
  metrics: {
    throughputBps?: number;
    latencyMs?: number;
    errorRate?: number;
    requestsPerSec?: number;
    /** AGW → backend member: responses per minute (BackendResponseStatus by BackendServer) */
    responsesPerMin?: number;
    /** AGW → backend member: TCP connect time (BackendConnectTime) */
    connectMs?: number;
    /** LB → backend member: health-probe availability % (DipAvailability by BackendIPAddress) */
    probePct?: number;
    /** Internet → AGW: bytes received on ALL listeners (bit/s) — context for the public-listener value */
    gatewayTotalBps?: number;
    /** Internet → VM public IP: inbound SYN packets per minute (SynCount, Direction In) — not a status input */
    synInPerMin?: number;
    /** Internet → VM public IP: bytes received (bit/s). Drives particles only when replies cannot be in it */
    bytesInBps?: number;
    /** VPN gateway → on-premises site (S2S connection): bit/s from the site into Azure / from Azure to the site */
    siteInBps?: number;
    siteOutBps?: number;
  };
  trafficLevel: EdgeTrafficLevel;
  activeAlertIds: string[];
  /** Set only when the metrics come from a real source (Traffic Analytics, NSG flow logs, App Insights, Monitor) */
  metricsSource?: "measured";
};

export type LiveAlert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  resourceId: string;
  firedAt: string;
  summary: string;
  rootCauseCandidates?: string[];
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
};

export type AlertRuleInfo = {
  id: string;
  name: string;
  severity: number; // Azure Sev0–Sev4
  signalType: string; // "Metric" | "Log" | "Activity Log" | "Smart Detection" | "Advisor"
  condition?: string; // human-readable condition string
  targetResourceId: string;
  targetResourceType?: string;
  enabled: boolean;
  affectedNodeIds: string[];
};

// ────────────────────────────────────────────
// 5. Enums / Shared Literals
// ────────────────────────────────────────────

export type HealthStatus = "ok" | "warning" | "critical" | "unknown";
export type PowerState = "running" | "stopped" | "deallocated" | "starting" | "stopping" | "unknown";
export type EdgeStatus = "normal" | "degraded" | "down" | "idle";
export type EdgeTrafficLevel = "none" | "low" | "medium" | "high" | "burst";
export type AlertSeverity = "info" | "warning" | "critical";
export type EdgeAnimationKind = "flow" | "pulse" | "dash" | "none";
export type DiagramLayoutKind = "dagre" | "elk" | "manual" | "force";

export type DiagramIconKind =
  | "subscription" | "resourceGroup"
  | "vnet" | "subnet" | "nsg" | "nic"
  | "vm" | "vmss" | "aks" | "containerApp"
  | "appGateway" | "frontDoor" | "lb" | "trafficManager"
  | "storage" | "sql" | "cosmosDb" | "redis" | "postgres"
  | "keyVault" | "appInsights" | "logAnalytics"
  | "privateEndpoint" | "dns" | "firewall" | "waf"
  | "functionApp" | "appService" | "serviceBus" | "eventHub"
  | "publicIP"
  | "natGateway"
  | "agc" | "vnetGateway" | "bastion" | "paas" | "onPremSite"
  | "internet"
  | "custom";

// ────────────────────────────────────────────
// 6. API Response Wrappers
// ────────────────────────────────────────────

export type DiagramSpecListResponse = {
  diagrams: Array<{ id: string; name: string; updatedAt: string }>;
};

export type DiagramSpecResponse = {
  diagram: DiagramSpec;
};

export type LiveSnapshotResponse = LiveDiagramSnapshot;

// ────────────────────────────────────────────
// 7. Visualization Data Types
// ────────────────────────────────────────────

export type SparklineData = {
  values: number[];
  timestamps: string[];
  metric: string;
};

/** A failing resource and the resources one configured hop away from it (impact is possible, not confirmed) */
export type FaultImpact = {
  sourceNodeId: string;
  severity: AlertSeverity;
  /** What started it: metric health critical, or an active critical Azure Monitor alert */
  trigger: "metric" | "alert";
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
};

// ────────────────────────────────────────────
// 9. Edge Network Detail (엣지 클릭 시 on-demand fetch)
// ────────────────────────────────────────────

export type NicEndpointInfo = {
  name: string;
  privateIp?: string;
  publicIp?: string;
};

export type NsgRuleEntry = {
  name: string;
  priority: number;
  direction: "Inbound" | "Outbound";
  access: "Allow" | "Deny";
  protocol: string;
  sourcePortRange: string;
  destinationPortRange: string;
  sourceAddressPrefix: string;
  destinationAddressPrefix: string;
};

export type NsgInfo = {
  name: string;
  resourceId?: string;
  effectiveRules: NsgRuleEntry[];
};

export type UdrRoute = {
  name: string;
  addressPrefix: string;
  nextHopType: "VirtualNetworkGateway" | "VnetLocal" | "Internet" | "VirtualAppliance" | "None";
  nextHopIpAddress?: string;
};

export type UdrInfo = {
  name: string;
  routes: UdrRoute[];
};

export type NetworkFlowRecord = {
  srcIp: string;
  destIp: string;
  srcPort: number;
  destPort: number;
  protocol: "TCP" | "UDP";
  direction: "Inbound" | "Outbound";
  action: "Allow" | "Deny";
  bytesSrcToDest?: number;
  bytesDestToSrc?: number;
  isExternalSrc: boolean;
  isExternalDest: boolean;
  flowState?: string; // B=Begin C=Continuing E=End D=Denied
};

export type FlowSummary = {
  flowCount: number;
  totalBytesBps: number;
  topPorts: Array<{ port: number; protocol: string; flowCount: number }>;
  externalSourceCount: number;
};

// ────────────────────────────────────────────
// 10. Backend Pool Detail (LB / Application Gateway)
// ────────────────────────────────────────────

export type BackendPoolMember = {
  name: string;
  ipAddress?: string;
  fqdn?: string;
  port?: number;
  state?: "Healthy" | "Unhealthy" | "Unknown";
  provisioningState?: string;
  kind: "vm" | "ip" | "fqdn";
};

export type BackendPoolProbe = {
  name: string;
  protocol: string;
  port: number;
  path?: string;
  intervalSec: number;
  unhealthyThreshold: number;
};

export type BackendPoolInfo = {
  name: string;
  resourceId?: string;
  loadBalancingRules?: string[];
  members: BackendPoolMember[];
  probe?: BackendPoolProbe;
  note?: string;
};

export type EdgeNetworkDetail = {
  edgeId: string;
  generatedAt: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  targetNodeId: string;
  targetNodeLabel: string;
  protocol?: string;
  edgeKind?: DiagramEdgeKind;
  liveMetrics?: {
    throughputBps?: number;
    latencyMs?: number;
    errorRate?: number;
    requestsPerSec?: number;
  };
  sourceNics: NicEndpointInfo[];
  targetNics: NicEndpointInfo[];
  sourceNsg?: NsgInfo;
  targetNsg?: NsgInfo;
  udr?: UdrInfo;
  inboundFlows: NetworkFlowRecord[];
  outboundFlows: NetworkFlowRecord[];
  inboundSummary: FlowSummary;
  outboundSummary: FlowSummary;
  /** false = per-IP flow records are not collected for this edge ("미수집", not "no flows") */
  flowsCollected?: boolean;
  /** "mock" = sample detail for the example diagram */
  note?: string;
};

// ────────────────────────────────────────────
// 11. AKS Plane Detail (접속면 / 실행면 / 노출면)
// ────────────────────────────────────────────

/** 접속면 (Control Plane / API Endpoint) */
export type AksControlPlaneInfo = {
  fqdn: string;
  privateFqdn?: string;
  isPrivateCluster: boolean;
  apiServerEndpoint: string;           // IP or FQDN used for API server access
  authorizedIpRanges?: string[];       // allowed IP ranges (public cluster)
  enablePrivateClusterPublicFqdn?: boolean;
  privateDnsZone?: string;
  /** Connectivity path description */
  accessPath: "internet" | "private-link" | "vnet-integration" | "vpn-er";
};

/** 실행면 — Individual NodePool (Agent Pool) */
export type AksNodePoolInfo = {
  name: string;
  mode: "System" | "User";
  vmSize: string;
  nodeCount: number;
  minCount?: number;
  maxCount?: number;
  enableAutoScaling: boolean;
  osType: string;
  osSKU?: string;
  orchestratorVersion?: string;
  nodeImageVersion?: string;       // e.g. "AKSUbuntu-2204gen2containerd-202402.12.0"
  powerState: string;              // "Running" | "Stopped"
  provisioningState: string;
  availabilityZones?: string[];
  vnetSubnetId?: string;
  /** Backing VMSS info (expanded on demand) */
  vmssResourceId?: string;
  vmssInstances?: AksVmssInstance[];
};

/** Kubernetes node condition (from K8s Node API) */
export type AksNodeCondition = {
  type: string;                    // "Ready" | "MemoryPressure" | "DiskPressure" | "PIDPressure" | "NetworkUnavailable"
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
};

/** VMSS Instance (실행면 확장 시 표시) */
export type AksVmssInstance = {
  instanceId: string;
  computerName: string;
  provisioningState: string;
  powerState: string;              // "running" | "stopped" | "deallocated"
  privateIp?: string;
  nodePoolName?: string;           // Parent node pool name
  nodeImageVersion?: string;       // From K8s label or parent pool
  conditions?: AksNodeCondition[]; // K8s node conditions (Ready, MemoryPressure, etc.)
  /** Where the conditions come from: the Kubernetes API, or — when the cluster's credentials cannot be fetched —
   *  the AKS platform metric kube_node_status_condition (Ready only, read permission) or Container Insights
   *  (KubeNodeInventory.Status) */
  conditionsSource?: "kubernetes" | "platformMetric" | "containerInsights";
};

/** 노출면 — Ingress / Egress flow path */
export type AksExposurePathInfo = {
  direction: "ingress" | "egress";
  label: string;                     // e.g., "Application Gateway → AKS"
  resources: AksExposureResource[];
};

export type AksExposureResource = {
  role: "lb" | "nat-gateway" | "firewall" | "public-ip" | "app-gateway" | "service" | "ingress-controller";
  name: string;
  azureResourceId?: string;
  endpoint?: string;
  sku?: string;
};

/** Full AKS Plane Detail (on-demand response) */
export type AksPlaneDetail = {
  clusterId: string;
  clusterName: string;
  generatedAt: string;
  controlPlane: AksControlPlaneInfo;
  nodePools: AksNodePoolInfo[];
  exposurePaths: AksExposurePathInfo[];
  networkProfile?: {
    networkPlugin: string;            // "azure" | "kubenet" | "none"
    networkPolicy?: string;           // "calico" | "azure" | "cilium"
    serviceCidr?: string;
    dnsServiceIp?: string;
    podCidr?: string;
    outboundType?: string;            // "loadBalancer" | "userDefinedRouting" | "managedNATGateway"
    loadBalancerSku?: string;
  };
  note?: string;
};

// ────────────────────────────────────────────
// 10. Private Link usage (who uses a Private Endpoint) — GET /api/live/private-link-usage
//
// Observed evidence only: a PaaS access log row (caller IP / identity) or a VNet flow log row (source IP →
// Private Endpoint IP). Nothing is guessed from names. Never part of the shared spec or the 30 s snapshot.
// ────────────────────────────────────────────

/** access = the service's own log saw the caller; flow = packets reached the Private Endpoint IP */
export type PlUsageGrade = "access" | "flow";
export type PlUsageSource = "kvAudit" | "storageLogs" | "redisClients" | "vnetFlow";
export type PlSourceReason =
  | "noDiagSetting" | "notToWorkspace" | "categoryOff"
  | "noFlowLog" | "nsgFlowLogOnly" | "noTrafficAnalytics"
  | "noAccess" | "unsupported";

export type PlEvidence = {
  source: PlUsageSource;
  grade: PlUsageGrade;
  firstSeen?: string;
  lastSeen?: string;
  requests?: number;
  failed?: number;
  clients?: number;
  bytes?: number;
  flows?: number;
  deniedFlows?: number;
  operations?: string[];
  ports?: number[];
};

export type PrivateLinkUsage = {
  /** `plu:${callerNodeId}>${peNodeId}` */
  id: string;
  callerNodeId: string;
  peNodeId: string;
  targetNodeId: string;
  /** RFC 1918 address of the caller (never a public IP) */
  callerIp?: string;
  /** How the caller was found: its NIC IP, the only compute in the source subnet, all candidates being node pools
   *  of one AKS cluster (aksCluster — the pool and pod are unknown), or its managed identity */
  attribution: "nic" | "subnetOwner" | "aksCluster" | "identity";
  /** aksCluster: the node pools that share the source subnet */
  viaNodeIds?: string[];
  /** Resource name owning the managed identity — never an object ID */
  identityName?: string;
  grade: PlUsageGrade;
  lastSeen?: string;
  evidence: PlEvidence[];
};

export type PlEndpoint = {
  peNodeId: string;
  targetNodeId: string;
  connectionState?: "Approved" | "Pending" | "Rejected" | "Disconnected";
  /** used: a usage or PE bytes > 0 · noUseObserved: a source is on and saw nothing · unknown: no evidence either way */
  activity: "used" | "noUseObserved" | "unknown";
};

export type PlUnresolved = {
  targetNodeId: string;
  peNodeId?: string;
  ip?: string;
  reason: "nicNoVm" | "notInDiagram" | "ambiguous" | "peUnconfirmed" | "denied" | "noIp";
  nicName?: string;
  candidates?: string[];
  /** ambiguous: the candidates share the source subnet, or share a managed identity */
  basis?: "subnet" | "identity";
  /** notInDiagram: where the address is, when that is known (never a guessed resource) */
  place?: PlPlace;
  requests?: number;
  deniedFlows?: number;
  lastSeen?: string;
};

/**
 * Where an address outside the diagram's scope lives: a subnet of another VNet in the subscription graph (with its
 * owner when exactly one), several overlapping VNets, private space no known subnet holds (on-premises / an
 * unconnected subscription), or carrier-grade NAT space (100.64.0.0/10)
 */
export type PlPlace =
  | { kind: "otherVnet"; vnetNodeId: string; subnetNodeId: string; ownerNodeId?: string }
  | { kind: "overlap"; matches: number }
  | { kind: "private" }
  | { kind: "cgnat" }
  /** In the address space of exactly one on-premises site (its local network gateway prefixes) — routing
   *  configuration, not an observation (catalog EDGE-09) */
  | { kind: "onPremSite"; siteNodeId: string; prefix: string; basis: "cfg" };

/** Calls over the public path (bypassing the Private Endpoint) — counted, IPs not listed */
export type PlPublicAccess = { targetNodeId: string; requests: number; distinctIps: number; identityNames?: string[]; lastSeen?: string };

export type PlSourceStatus = {
  source: PlUsageSource;
  targetNodeId?: string;
  state: LiveSourceState;
  reason?: PlSourceReason;
  /** Service / category named in the how-to text */
  service?: string;
  category?: string;
  /** Masked workspace name and flow-log interval (minutes) */
  workspaceName?: string;
  intervalMin?: number;
};

export type PrivateLinkUsageResponse = {
  generatedAt: string;
  windowHours: number;
  dataSource: "azure" | "mock";
  endpoints: PlEndpoint[];
  usages: PrivateLinkUsage[];
  unresolved: PlUnresolved[];
  publicAccess: PlPublicAccess[];
  sources: PlSourceStatus[];
};
