// ═══════════════════════════════════════════════════════════════════
// Live Diagram — Hybrid Model Types
//
// Layer 1: DSL/JSON topology (infra engineer owns)
// Layer 2: Figma design tokens (product/UI designer owns)
// Layer 3: Azure runtime bindings (aggregator resolves)
// ═══════════════════════════════════════════════════════════════════

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

export type SubResourceKind = "nic" | "frontendIP" | "publicIP";

export type SubResource = {
  id: string;
  label: string;
  kind: SubResourceKind;
  endpoint?: string;
  azureResourceId?: string;
  health?: HealthStatus;
};

export type DiagramEdgeKind =
  | "network"
  | "peering"
  | "privateLink"
  | "routes"
  | "logging"
  | "inferred"
  | "attached-to"  // Subnet → NIC
  | "bound-to";    // NIC → VM

export type DiagramEdgeSpec = {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
  edgeKind?: DiagramEdgeKind;
  confidence?: number;         // 0-1, for inferred edges
  bindings: Record<string, MetricBinding>;
  animation: EdgeAnimationKind;
  alerts?: AlertCondition[];
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
};

export type MetricSourceKind =
  | "monitor"
  | "logAnalytics"
  | "appInsights"
  | "serviceHealth"
  | "composite";

export type MetricAggregation = "avg" | "max" | "min" | "total" | "p50" | "p95" | "p99" | "rate" | "count";

export type HealthRule = {
  metric: string;
  op: "<" | ">" | "<=" | ">=" | "==";
  threshold: number;
  weight: number;
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
  heatmap?: TrafficHeatmapData;
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
};

export type LiveEdge = {
  id: string;
  status: EdgeStatus;
  metrics: {
    throughputBps?: number;
    latencyMs?: number;
    errorRate?: number;
    requestsPerSec?: number;
  };
  trafficLevel: EdgeTrafficLevel;
  activeAlertIds: string[];
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
export type VisualizationMode = "2d" | "2d-animated" | "3d";

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

export type FaultImpact = {
  sourceNodeId: string;
  severity: AlertSeverity;
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
  rippleRadius: number;
};

export type HeatmapCell = {
  source: string;
  target: string;
  value: number;
  normalizedValue: number;
};

export type TrafficHeatmapData = {
  cells: HeatmapCell[];
  subnets: string[];
  maxValue: number;
};

// ────────────────────────────────────────────
// 8. Extended Design Tokens (Fault / Heatmap / Particle)
// ────────────────────────────────────────────

export type FaultDesignTokens = {
  rippleColor: Record<AlertSeverity, string>;
  cascadeDelayMs: number;
  impactHighlight: string;
  rippleDurationMs: number;
  maxRippleRadius: number;
};

export type HeatmapDesignTokens = {
  colorScaleStart: string;
  colorScaleEnd: string;
  minOpacity: number;
  maxOpacity: number;
};

export type CanvasParticleTokens = {
  sizeRange: [number, number];
  glowRadius: number;
  trailLength: number;
  trailOpacity: number;
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
  note?: string;
};
