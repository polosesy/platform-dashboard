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

// ── VNet traffic (flow logs + Traffic Analytics) — /api/network/flows and /api/network/coverage ──

export type NetSection = "map" | "overview" | "talkers" | "blocked" | "internet";
export type NetTalkerDim = "subnet" | "vm" | "ip" | "port";
export type NetDir = "in" | "out";
/** ok = rows · empty = no flows in range · disabled = no workspace configured · noAccess = no read permission · noTable = no flow-log table */
export type NetSectionState = "ok" | "empty" | "disabled" | "noAccess" | "noTable";
export type NetGap = { part: "threatIntel" | "flowLogs" | "vnets" | "workspaces" | "freshness"; reason: "noAccess" | "noTable" | "failed" };

export type NetOverview = {
  totals: { bytes: number; allowedFlows: number; deniedFlows: number; records: number };
  series: { t: string; bytes: number; allowedFlows: number; deniedFlows: number }[];
  byFlowType: { flowType: string; bytes: number; allowedFlows: number; deniedFlows: number; records: number }[];
};
export type NetTalkerRow = {
  src?: string;
  dest?: string;
  port?: number | null;
  protocol?: string | null;
  bytes: number;
  allowedFlows: number;
  deniedFlows: number;
  /** port dim: records allowed inbound from the Internet to this port */
  publicInAllowed?: number;
};
export type NetBlockedRow = {
  group: string;
  rule: string;
  direction: NetDir | null;
  port: number | null;
  protocol: string | null;
  deniedFlows: number;
  records: number;
  sources: string[];
  lastSeen: string | null;
};
export type NetInternetRow = {
  ip: string;
  direction: NetDir;
  flowTypes: string[];
  malicious: boolean;
  country?: string;
  threat?: string;
  threatDetail?: string;
  targets: string[];
  ports: number[];
  records: number;
  allowedRecords: number;
  deniedRecords: number;
};

export type NetFlowsResponse = {
  generatedAt: string;
  source: "live" | "mock";
  note?: string;
  section: NetSection;
  state: NetSectionState;
  lookbackMinutes: number;
  binMinutes?: number;
  gaps: NetGap[];
  overview?: NetOverview;
  talkers?: { dim: NetTalkerDim; rows: NetTalkerRow[] };
  blocked?: NetBlockedRow[];
  internet?: { direction: NetDir; rows: NetInternetRow[] };
  map?: NetMapData;
};

/**
 * Where the other end of a flow is when Traffic Analytics names no subnet for it — from its FlowType:
 * internet = ExternalPublic / MaliciousFlow · azure = AzurePublic (Microsoft service addresses) · onprem = S2S / P2S /
 * ExpressRoute · private = UnknownPrivate / Inter- or IntraVNet without a subnet · unknown = FlowType Unknown
 * (stg: AKS pod-overlay addresses — about half of the rows)
 */
export type NetExternal = "internet" | "azure" | "onprem" | "private" | "unknown";
/** One end of a map line: a subnet ("rg/vnet/subnet", lowercase) or an address class outside the VNets ("@internet" …) */
export type NetMapEdge = {
  src: string;
  dst: string;
  bytes: number;
  allowedFlows: number;
  deniedFlows: number;
  records: number;
  /** Records Traffic Analytics flagged MaliciousFlow (its threat intelligence) */
  maliciousRecords: number;
  last: string | null;
  /** Destination ports, most bytes first (at most 8) — and every port that saw a denied flow */
  ports: { port: number | null; proto: string | null; bytes: number; allowedFlows: number; deniedFlows: number }[];
  deniedPorts: number[];
};
export type NetMapData = {
  edges: NetMapEdge[];
  /** Lines left out after the top N by bytes (lines with denied or malicious flows are always kept) */
  omitted: number;
  /** Flows with no subnet on either end (both outside the VNets — stg: pod overlay ↔ pod overlay): not drawable */
  unplaced: { bytes: number; records: number };
};

/**
 * vnet = VNet flow log on the VNet · partial = on some subnets · nsgOnly = only (retiring) NSG flow logs · none ·
 * unknown = the flow-log settings are not visible to this connection (Network Watcher's resource group is not readable)
 * and no Traffic Analytics rows arrived for it — never shown as "none"
 */
export type NetCoverageKind = "vnet" | "partial" | "nsgOnly" | "none" | "unknown";
export type NetVnetCoverage = {
  /** rg/vnet — the scope key used by /api/network/flows?vnet= */
  key: string;
  name: string;
  region: string;
  kind: NetCoverageKind;
  /** read = the flow-log settings were read · hidden = not visible to this connection (kind/interval/retention from rows only) */
  config: "read" | "hidden";
  /** true also when only rows prove it (config hidden) */
  trafficAnalytics: boolean;
  intervalMin: number | null;
  /** Workspace name (never its id) */
  workspace?: string;
  /** The Traffic Analytics workspace is one this page reads (null = unknown) */
  workspaceMatches: boolean | null;
  retentionDays: number | null;
  /** NSG flow logs on this VNet's subnet NSGs (to migrate) */
  nsgLegacy: number;
  disabledLogs: number;
  /** Traffic Analytics rows of this VNet's flow log in the workspaces read (7 days); null = not queried */
  observed: { rows7d: number; lastRow: string | null } | null;
};
/** Where a workspace this page reads came from: a readable flow log's TA settings · the connection file · AZURE_LOG_ANALYTICS_WORKSPACE_ID */
export type NetWorkspaceVia = "flowLog" | "connection" | "env";
export type NetCoverageResponse = {
  generatedAt: string;
  source: "live" | "mock";
  note?: string;
  vnets: NetVnetCoverage[];
  unmappedFlowLogs: number;
  workspace: {
    state: NetSectionState;
    lastRow: string | null;
    rows7d: number | null;
    legacyFlowRows7d: number | null;
    /** Workspaces read for this subscription (names only); empty = none configured */
    read?: { name: string; via: NetWorkspaceVia; rows7d: number | null }[];
    /** Flow logs send Traffic Analytics here, but this subscription's connection does not list it — not read */
    unlisted?: string[];
  };
  gaps: NetGap[];
};
