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

export type NetSection = "overview" | "talkers" | "blocked" | "internet";
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
};

/** vnet = VNet flow log on the VNet · partial = on some subnets · nsgOnly = only (retiring) NSG flow logs · none */
export type NetCoverageKind = "vnet" | "partial" | "nsgOnly" | "none";
export type NetVnetCoverage = {
  /** rg/vnet — the scope key used by /api/network/flows?vnet= */
  key: string;
  name: string;
  region: string;
  kind: NetCoverageKind;
  trafficAnalytics: boolean;
  intervalMin: number | null;
  /** Workspace name (never its id) */
  workspace?: string;
  /** The flow logs send to the configured workspace (null = unknown) */
  workspaceMatches: boolean | null;
  retentionDays: number | null;
  /** NSG flow logs on this VNet's subnet NSGs (to migrate) */
  nsgLegacy: number;
  disabledLogs: number;
};
export type NetCoverageResponse = {
  generatedAt: string;
  source: "live" | "mock";
  note?: string;
  vnets: NetVnetCoverage[];
  unmappedFlowLogs: number;
  workspace: { state: NetSectionState; lastRow: string | null; rows7d: number | null; legacyFlowRows7d: number | null };
  gaps: NetGap[];
};
