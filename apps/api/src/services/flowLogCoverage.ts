// Which VNets have flow logs, and do they reach the workspace this page reads? Pure; unit-tested from
// apps/api/test/flowLogCoverage.test.ts.
//
//   vnet     a VNet flow log on the VNet itself
//   partial  VNet flow logs on some of its subnets
//   nsgOnly  only NSG flow logs on its subnets' NSGs — retiring (no new ones since 2025-06-30, retired 2027-09-30);
//            their Traffic Analytics rows go to the legacy table this page does not read
//   none     nothing
// Only enabled logs count; disabled ones are counted apart. Strings are masked; no output carries /subscriptions/.
import type { NetCoverageKind, NetVnetCoverage } from "@aud/types";
import { maskGuids } from "../infra/requestParams.js";

export type FlowLogRow = {
  t: string;
  location?: string;
  enabled?: boolean | null;
  ta?: boolean | null;
  interval?: number | null;
  ws?: string | null;
  retention?: number | null;
  retentionOn?: boolean | null;
};
export type VnetRow = { vnet: string; name: string; resourceGroup: string; location?: string; subnet?: string; nsg?: string };
export type WorkspaceRow = { id: string; name: string; customerId?: string };

const RANK: Record<NetCoverageKind, number> = { none: 0, nsgOnly: 1, partial: 2, vnet: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildFlowCoverage(input: {
  flowLogs: FlowLogRow[];
  vnetRows: VnetRow[];
  workspaces: WorkspaceRow[];
  configuredWorkspaceId?: string;
}): { vnets: NetVnetCoverage[]; unmappedFlowLogs: number } {
  const logs = input.flowLogs.map((l) => ({ ...l, t: (l.t ?? "").toLowerCase(), ws: (l.ws ?? "").toLowerCase() }));
  const wsById = new Map(input.workspaces.map((w) => [w.id.toLowerCase(), w]));
  const configured = (input.configuredWorkspaceId ?? "").toLowerCase();

  // VNet → its subnets and the NSGs on them
  const vnets = new Map<string, { row: VnetRow; subnets: Set<string>; nsgs: Set<string> }>();
  for (const r of input.vnetRows) {
    const id = r.vnet.toLowerCase();
    const v = vnets.get(id) ?? { row: r, subnets: new Set<string>(), nsgs: new Set<string>() };
    if (r.subnet) v.subnets.add(r.subnet.toLowerCase());
    if (r.nsg) v.nsgs.add(r.nsg.toLowerCase());
    vnets.set(id, v);
  }

  const used = new Set<number>();
  const out: NetVnetCoverage[] = [];
  for (const [id, v] of vnets) {
    const onVnet: number[] = [], onSubnet: number[] = [], onNsg: number[] = [];
    logs.forEach((l, i) => {
      if (l.t === id) onVnet.push(i);
      else if (l.t.startsWith(`${id}/subnets/`)) onSubnet.push(i);
      else if (v.nsgs.has(l.t)) onNsg.push(i);
    });
    [...onVnet, ...onSubnet, ...onNsg].forEach((i) => used.add(i));
    const enabled = (ix: number[]) => ix.filter((i) => logs[i]!.enabled !== false);
    const vnetSide = [...enabled(onVnet), ...enabled(onSubnet)].map((i) => logs[i]!);
    const kind: NetCoverageKind = enabled(onVnet).length ? "vnet" : enabled(onSubnet).length ? "partial" : enabled(onNsg).length ? "nsgOnly" : "none";
    const ta = vnetSide.filter((l) => l.ta === true);
    const intervals = ta.map((l) => l.interval).filter((n): n is number => typeof n === "number" && n > 0);
    const wsIds = [...new Set(ta.map((l) => l.ws).filter(Boolean))];
    const ws = wsIds.length ? wsById.get(wsIds[0]!) : undefined;
    let workspaceMatches: boolean | null = null;
    if (wsIds.length && configured) {
      const ids = wsIds.map((w) => wsById.get(w)?.customerId?.toLowerCase());
      workspaceMatches = ids.some((c) => c === undefined) ? (ids.includes(configured) ? true : null) : ids.includes(configured);
    }
    const retentions = vnetSide.map((l) => (l.retentionOn === false ? 0 : l.retention)).filter((n): n is number => typeof n === "number");
    out.push({
      key: `${v.row.resourceGroup}/${v.row.name}`,
      name: maskGuids(v.row.name),
      region: v.row.location ?? "",
      kind,
      trafficAnalytics: ta.length > 0,
      intervalMin: intervals.length ? Math.max(...intervals) : null,
      ...(ws ? { workspace: maskGuids(ws.name) } : wsIds.length ? { workspace: maskGuids(wsIds[0]!.split("/").pop() ?? "") } : {}),
      workspaceMatches,
      retentionDays: retentions.length ? Math.max(...retentions) : null,
      nsgLegacy: enabled(onNsg).length,
      disabledLogs: [...onVnet, ...onSubnet, ...onNsg].filter((i) => logs[i]!.enabled === false).length,
    });
  }
  out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || cmp(a.name, b.name));
  return { vnets: out, unmappedFlowLogs: logs.length - used.size };
}
