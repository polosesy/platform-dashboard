// Which VNets have flow logs, which workspaces hold their Traffic Analytics rows, and which of those this page reads.
// Pure; unit-tested from apps/api/test/networkQueries.test.ts.
//
//   vnet     a VNet flow log on the VNet itself
//   partial  VNet flow logs on some of its subnets
//   nsgOnly  only NSG flow logs on its subnets' NSGs — retiring (no new ones since 2025-06-30, retired 2027-09-30);
//            their Traffic Analytics rows go to the legacy table this page does not read
//   none     nothing — said only when the flow-log settings are visible to this connection
//   unknown  the settings are not visible (flow logs live in Network Watcher's resource group, which a connection with
//            Reader on a few resource groups cannot read — Resource Graph then returns nothing, not an error) and no
//            Traffic Analytics rows arrived for the VNet. Rows that did arrive prove the flow log ("vnet", config hidden).
// Only enabled logs count; disabled ones are counted apart. Strings are masked; no output carries /subscriptions/.
import type { NetCoverageKind, NetVnetCoverage, NetWorkspaceVia } from "@aud/types";
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
/** Traffic Analytics rows per VNet ("rg/vnet" lowercase) in the workspaces read, 7 days */
export type ObservedVnet = { rows7d: number; lastRow: string | null; vnetLevel: boolean; workspaces: string[] };

const RANK: Record<NetCoverageKind, number> = { none: 0, unknown: 1, nsgOnly: 2, partial: 3, vnet: 4 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const shortId = (id: string) => `…${id.slice(-4)}`;

export type FlowWorkspace = { id: string; name: string; via: NetWorkspaceVia };

/**
 * The workspaces this subscription's flow-log page reads, all with the subscription's connection (no other identity):
 *   1. the Traffic Analytics workspace of a readable, enabled flow log — when that connection lists it (or the connection
 *      is home and no other connection lists it); otherwise named in `unlisted` (a connection-file change, not read)
 *   2. the connection's own `logAnalyticsWorkspaces`
 *   3. AZURE_LOG_ANALYTICS_WORKSPACE_ID — a home setting, only for a subscription home reads
 * Ids are workspace (customer) ids, lowercase; at most 10 (the cross-workspace query limit we keep).
 */
export function pickFlowWorkspaces(input: {
  flowLogs: FlowLogRow[];
  workspaces: WorkspaceRow[];
  listed: string[];
  listedElsewhere: Set<string>;
  homeReads: boolean;
  envWorkspace?: string;
}): { read: FlowWorkspace[]; unlisted: string[] } {
  const byArm = new Map(input.workspaces.map((w) => [w.id.toLowerCase(), w]));
  const byCid = new Map(input.workspaces.filter((w) => w.customerId).map((w) => [w.customerId!.toLowerCase(), w]));
  const listed = new Set(input.listed.map((x) => x.toLowerCase()));
  const read: FlowWorkspace[] = [];
  const unlisted: string[] = [];
  const add = (id: string, via: NetWorkspaceVia) => {
    if (!read.some((r) => r.id === id)) read.push({ id, name: maskGuids(byCid.get(id)?.name ?? shortId(id)), via });
  };
  for (const l of input.flowLogs) {
    if (l.enabled === false || l.ta !== true || !l.ws) continue;
    const arm = l.ws.toLowerCase();
    const cid = byArm.get(arm)?.customerId?.toLowerCase();
    if (cid && (listed.has(cid) || (input.homeReads && !input.listedElsewhere.has(cid)))) add(cid, "flowLog");
    else {
      const name = maskGuids(byArm.get(arm)?.name ?? arm.split("/").pop() ?? "");
      if (name && !unlisted.includes(name) && !(cid && read.some((r) => r.id === cid))) unlisted.push(name);
    }
  }
  for (const id of listed) add(id, "connection");
  if (input.homeReads && input.envWorkspace) add(input.envWorkspace.toLowerCase(), "env");
  const names = new Set(read.map((r) => r.name));
  return { read: read.slice(0, 10), unlisted: unlisted.filter((n) => !names.has(n)).sort(cmp) };
}

export function buildFlowCoverage(input: {
  flowLogs: FlowLogRow[];
  vnetRows: VnetRow[];
  workspaces: WorkspaceRow[];
  /** Customer ids of the workspaces this page reads */
  readWorkspaceIds: string[];
  /** Did the flow-log query succeed (false → every VNet's settings are unknown) */
  flowLogsRead: boolean;
  /** Regions with a visible Network Watcher (null = not known) */
  watcherRegions: Set<string> | null;
  /** The subscription itself is readable (Reader at subscription scope sees every flow log; null = not known) */
  subscriptionReadable: boolean | null;
  /** Rows per VNet in the workspaces read; null = not queried */
  observed: Map<string, ObservedVnet> | null;
}): { vnets: NetVnetCoverage[]; unmappedFlowLogs: number } {
  const logs = input.flowLogs.map((l) => ({ ...l, t: (l.t ?? "").toLowerCase(), ws: (l.ws ?? "").toLowerCase() }));
  const wsById = new Map(input.workspaces.map((w) => [w.id.toLowerCase(), w]));
  const readIds = new Set(input.readWorkspaceIds.map((x) => x.toLowerCase()));

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
    const mine = [...onVnet, ...onSubnet, ...onNsg];
    mine.forEach((i) => used.add(i));
    const key = `${v.row.resourceGroup}/${v.row.name}`;
    const obs = input.observed ? input.observed.get(key.toLowerCase()) ?? { rows7d: 0, lastRow: null, vnetLevel: false, workspaces: [] } : null;
    const region = (v.row.location ?? "").toLowerCase();
    const visible = input.flowLogsRead && (mine.length > 0 || input.subscriptionReadable === true || !!input.watcherRegions?.has(region));
    const base = {
      key,
      name: maskGuids(v.row.name),
      region: v.row.location ?? "",
      nsgLegacy: 0,
      disabledLogs: 0,
      observed: obs ? { rows7d: obs.rows7d, lastRow: obs.lastRow } : null,
    };

    if (!visible) {
      const seen = !!obs && obs.rows7d > 0;
      out.push({
        ...base,
        kind: seen ? (obs!.vnetLevel ? "vnet" : "partial") : "unknown",
        config: "hidden",
        trafficAnalytics: seen,
        intervalMin: null,
        ...(seen && obs!.workspaces.length ? { workspace: obs!.workspaces[0]! } : {}),
        workspaceMatches: seen ? true : null,
        retentionDays: null,
      });
      continue;
    }

    const enabled = (ix: number[]) => ix.filter((i) => logs[i]!.enabled !== false);
    const vnetSide = [...enabled(onVnet), ...enabled(onSubnet)].map((i) => logs[i]!);
    const kind: NetCoverageKind = enabled(onVnet).length ? "vnet" : enabled(onSubnet).length ? "partial" : enabled(onNsg).length ? "nsgOnly" : "none";
    const ta = vnetSide.filter((l) => l.ta === true);
    const intervals = ta.map((l) => l.interval).filter((n): n is number => typeof n === "number" && n > 0);
    const wsIds = [...new Set(ta.map((l) => l.ws).filter(Boolean))];
    const ws = wsIds.length ? wsById.get(wsIds[0]!) : undefined;
    let workspaceMatches: boolean | null = null;
    if (wsIds.length) {
      const cids = wsIds.map((w) => wsById.get(w)?.customerId?.toLowerCase());
      workspaceMatches = cids.some((c) => c && readIds.has(c)) || (!!obs && obs.rows7d > 0) ? true : cids.some((c) => c === undefined) ? null : false;
    }
    const retentions = vnetSide.map((l) => (l.retentionOn === false ? 0 : l.retention)).filter((n): n is number => typeof n === "number");
    out.push({
      ...base,
      kind,
      config: "read",
      trafficAnalytics: ta.length > 0,
      intervalMin: intervals.length ? Math.max(...intervals) : null,
      ...(ws ? { workspace: maskGuids(ws.name) } : wsIds.length ? { workspace: maskGuids(wsIds[0]!.split("/").pop() ?? "") } : {}),
      workspaceMatches,
      retentionDays: retentions.length ? Math.max(...retentions) : null,
      nsgLegacy: enabled(onNsg).length,
      disabledLogs: mine.filter((i) => logs[i]!.enabled === false).length,
    });
  }
  out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || cmp(a.name, b.name));
  return { vnets: out, unmappedFlowLogs: logs.length - used.size };
}
