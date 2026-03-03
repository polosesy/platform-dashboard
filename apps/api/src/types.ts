// Canonical definitions now in @aud/types — re-export for backwards compatibility
export type { GraphNodeKind, EdgeKind, ArchitectureNode, ArchitectureEdge, ArchitectureGraph } from "@aud/types";

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
