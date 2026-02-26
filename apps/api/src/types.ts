export type GraphNodeKind =
  | "subscription"
  | "resourceGroup"
  | "vnet"
  | "subnet"
  | "nsg"
  | "nic"
  | "vm"
  | "lb"
  | "appGateway"
  | "aks"
  | "privateEndpoint"
  | "storage"
  | "sql"
  | "unknown";

export type ArchitectureNode = {
  id: string;
  kind: GraphNodeKind;
  name: string;
  azureId?: string;
  location?: string;
  tags?: Record<string, string>;
  health?: "ok" | "warning" | "critical" | "unknown";
  metrics?: Record<string, number>;
};

export type ArchitectureEdge = {
  id: string;
  source: string;
  target: string;
  kind: "contains" | "routes" | "connects";
};

export type ArchitectureGraph = {
  generatedAt: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
};

export type AzureSubscriptionOption = {
  subscriptionId: string;
  name?: string;
};

export type AzureSubscriptionsResponse = {
  generatedAt: string;
  subscriptions: AzureSubscriptionOption[];
  note?: string;
};

export type ArgoAppSummary = {
  name: string;
  namespace?: string;
  project?: string;
  health?: string;
  sync?: string;
  repo?: string;
  revision?: string;
  lastDeployedAt?: string;
};

export type NetworkFlowPair = {
  src: string;
  dest: string;
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
};

export type NetworkPortSummary = {
  destPort: number | null;
  protocol: string | null;
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
};

export type NetworkTotals = {
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
};

export type NetworkSummary = {
  generatedAt: string;
  lookbackMinutes: number;
  table: string;
  totals: NetworkTotals;
  topSubnetPairs: NetworkFlowPair[];
  topIpPairs: NetworkFlowPair[];
  topPorts: NetworkPortSummary[];
  note?: string;
};

export type ArchitectureFlowEdgeMetric = {
  source: string;
  target: string;
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
};

export type ArchitectureFlowOverlayResponse = {
  generatedAt: string;
  lookbackMinutes: number;
  level: "subnet";
  edges: ArchitectureFlowEdgeMetric[];
  unmatchedPairs: NetworkFlowPair[];
  note?: string;
};

export type ReservationUtilizationRow = {
  reservationId?: string;
  reservationOrderId?: string;
  skuName?: string;
  usedHours: number;
  reservedHours: number;
  utilizedPercentage?: number;
};

export type SubscriptionReservationUtilization = {
  subscriptionId: string;
  grain: "daily" | "monthly";
  utilizedPercentage: number;
  usedHours: number;
  reservedHours: number;
  topReservations: ReservationUtilizationRow[];
};

export type ReservationUtilizationResponse = {
  generatedAt: string;
  grain: "daily" | "monthly";
  utilizedPercentage: number;
  usedHours: number;
  reservedHours: number;
  subscriptions: SubscriptionReservationUtilization[];
  note?: string;
};
