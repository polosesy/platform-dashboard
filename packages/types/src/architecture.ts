import type { NetworkFlowPair } from "./network";

export type GraphNodeKind =
  | "subscription"
  | "resourceGroup"
  | "vnet"
  | "subnet"
  | "nsg"
  | "nic"
  | "vm"
  | "vmss"
  | "lb"
  | "appGateway"
  | "frontDoor"
  | "trafficManager"
  | "aks"
  | "containerApp"
  | "privateEndpoint"
  | "storage"
  | "sql"
  | "cosmosDb"
  | "redis"
  | "postgres"
  | "keyVault"
  | "appInsights"
  | "logAnalytics"
  | "firewall"
  | "functionApp"
  | "appService"
  | "serviceBus"
  | "eventHub"
  | "dns"
  | "publicIP"
  | "unknown";

export type EdgeKind =
  | "contains"    // hierarchical containment (Sub→RG→VNet→Subnet)
  | "network"     // network connectivity (Subnet↔NIC↔VM, VNet integration)
  | "peering"     // VNet Peering
  | "privateLink" // Private Endpoint → target service
  | "routes"      // AppGW/LB → backend pool targets
  | "logging"     // Diagnostic Settings → Log Analytics / Storage
  | "connects"    // legacy catch-all (backwards compat)
  | "inferred"    // proximity-based implicit dependency
  | "attached-to" // Subnet → NIC (network infrastructure binding)
  | "bound-to";   // NIC → VM (compute-to-network binding)

export type ArchitectureNode = {
  id: string;
  kind: GraphNodeKind;
  name: string;
  azureId?: string;
  location?: string;
  endpoint?: string;
  resourceGroup?: string;
  tags?: Record<string, string>;
  health?: "ok" | "warning" | "critical" | "unknown";
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

export type ArchitectureEdge = {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  confidence?: number;
  metadata?: {
    protocol?: string;
    diagnosticCategory?: string;
    peeringState?: string;
  };
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
