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
