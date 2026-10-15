import type { NetworkFlowPair } from "./network.js";

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
  /** Application Gateway for Containers (microsoft.servicenetworking/trafficcontrollers) */
  | "agc"
  /** VPN / ExpressRoute virtual network gateway (dedicated GatewaySubnet) */
  | "vnetGateway"
  /** Azure Bastion (dedicated AzureBastionSubnet) */
  | "bastion"
  /** A PaaS resource a Private Endpoint targets that has no kind of its own here (ACR, AI services, …) — metadata.armType */
  | "paas"
  | "natGateway"
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
  | "bound-to"    // NIC → VM (compute-to-network binding)
  | "member-of"   // Flexible-mode VM → its scale set (membership, not containment)
  | "hybrid";     // VNet gateway → on-premises site (S2S connection / local network gateway)

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
    /** Peering: this side's (source) and the other side's (target) state; peeringState is the worse of the two */
    stateA?: string;
    stateB?: string;
    /** Catalog row (docs/architecture/azure-resource-relationships.md), e.g. "AGW-04" */
    rel?: string;
    /** Backend membership: how the pool names the member — NIC ip configuration, IP address, FQDN, VMSS model */
    via?: "nic" | "ip" | "fqdn" | "vmssModel";
    /** Backend pool name */
    pool?: string;
    /** Member address (IP / FQDN) — also the metric dimension value (BackendServer / BackendIPAddress) */
    address?: string;
    /** AGW: backend ports of the rules that use this pool (BackendServer = "ip:port") */
    ports?: number[];
    /** cfg = a configuration reference · ipMatch / fqdnMatch = the current holder of the address */
    evidence?: "cfg" | "ipMatch" | "fqdnMatch" | "nodeRg" | "sameVnet";
    direction?: "inbound" | "outbound";
    /** Front Door: the origin (and its group in `pool`) a line comes from */
    origin?: string;
    /** Front Door Private Link origin: approval state */
    status?: string;
  };
};

/**
 * Can the Internet open a connection to an instance-level public IP (a NIC ip configuration with a public IP)?
 * Computed from configuration only (`basis: "cfg"`) — subnet NSG then NIC NSG, both must allow (catalog PIP-04).
 * open = some port allowed from any Internet address · scoped = only from listed ranges / service tags ·
 * closed = nothing allowed · noNsg = Standard SKU with no NSG (closed by default) · unknown = a rule or input
 * could not be read (`reasons`) — never colored as a risk.
 */
export type InboundExposure = {
  state: "open" | "scoped" | "closed" | "noNsg" | "unknown";
  /** Ports reachable from the Internet ("22", "8000-8100", "*", "53/udp") — wide ones for open, else scoped */
  ports: string[];
  /** Who may connect: any Internet address · listed ranges · service tags · nobody */
  sources: "any" | "ranges" | "tags" | "none";
  /** Number of distinct scoped source prefixes / tags (CIDR text is not carried) */
  rangeCount: number;
  /** A scoped source is the AzureCloud tag (every Azure public IP, other customers included) */
  azureCloud?: boolean;
  /** NSGs that were evaluated */
  nsgs: Array<"subnet" | "nic">;
  /** Why the state is unknown (or a caveat): nsgUnreadable · asgUnknown · ruleUnparsed · vnetTagWidened · avnm */
  reasons: string[];
  basis: "cfg";
};

export type ArchitectureGraph = {
  generatedAt: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  /** Resource types in the subscriptions that no diagram draws (count per lower-case ARM type) */
  undrawnTypes?: Array<{ type: string; count: number }>;
  /** "mock" when Azure could not be read and sample data is served */
  source?: "azure" | "mock";
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
