// VNet traffic page — tabs, ranges and the "management port open to the Internet" rule. Pure; tested from
// apps/api/test/networkQueries.test.ts.
import type { NetTalkerRow } from "@aud/types";

export const NET_TABS = ["overview", "talkers", "blocked", "internet", "coverage"] as const;
export type NetTab = (typeof NET_TABS)[number];

export const TALKER_DIMS = ["subnet", "vm", "ip", "port"] as const;
export const DIRECTIONS = ["in", "out"] as const;
export const RANGES = [
  { min: 60, label: "1h" },
  { min: 360, label: "6h" },
  { min: 1440, label: "24h" },
  { min: 10080, label: "7d" },
] as const;
export const TOPS = [10, 20, 50] as const;

/** Remote administration / database ports that should never be reachable from the Internet */
export const MGMT_PORTS = [22, 3389, 445, 1433, 3306, 5432, 5985, 5986];

export const isRiskyPort = (row: NetTalkerRow) => (row.publicInAllowed ?? 0) > 0 && row.port != null && MGMT_PORTS.includes(row.port);
