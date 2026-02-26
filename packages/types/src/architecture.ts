import type { NetworkFlowPair } from "./network";

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
