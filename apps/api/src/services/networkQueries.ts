// VNet traffic — KQL builders and row mappers over Traffic Analytics (NTANetAnalytics / NTAIpDetails).
// Pure; unit-tested from apps/api/test/networkQueries.test.ts.
//
// Units: "흐름 / flows" = the *Flows counters summed; "기록 / records" = log rows (count()) — used only where
// mv-expand would double-count the counters. Values from the server only: ranges and top are integers chosen here,
// every string (scope, direction, IPs) goes through kqlString().
// Columns the probe could not confirm are read with column_ifexists (a missing column → empty, not an error).
import type { NetBlockedRow, NetDir, NetExternal, NetInternetRow, NetMapData, NetMapEdge, NetOverview, NetTalkerDim, NetTalkerRow } from "@aud/types";
import { kqlString, maskGuids } from "../infra/requestParams.js";
import { RISK_PORTS } from "./riskPorts.js";

export const RANGES = [60, 360, 1440, 10080] as const;
/** Remote administration and data-store ports (critical + high of riskPorts.ts) */
export const MGMT_PORTS = [...RISK_PORTS.critical, ...RISK_PORTS.high];

export const snapRange = (minutes: number) => ((RANGES as readonly number[]).includes(minutes) ? minutes : 1440);
export const binMinutes = (range: number) => (range <= 360 ? 10 : range <= 1440 ? 60 : 360);

/** The subscription, or one VNet in it (`vnet` = "rg/vnet") */
export type FlowScope = { subscriptionId: string; vnet?: string };

/**
 * Rows of the flow logs in scope. Traffic Analytics stamps every VNet-flow-log row with `TargetResourceId` =
 * `sub/rg/vnet` (`…/subnet` for a subnet flow log) — the VNet whose flow log saw it. The subnet columns are no scope:
 * VNet-flow-log rows write them WITHOUT the subscription (`rg/vnet/subnet`, stg 2026-10-29) and half the rows (pod
 * overlay traffic, FlowType Unknown) have none. The subnet forms (with and without the subscription — NSG-era rows
 * carry it) are only a fallback for rows whose target is missing or not a VNet/subnet (a NIC flow log).
 * `Tgt` stays as a column (coverage groups by it).
 */
export function scopeClause(scope: FlowScope): string {
  const sub = scope.subscriptionId.toLowerCase();
  const head = `| extend Tgt = tolower(tostring(column_ifexists("TargetResourceId", ""))), TType = tostring(column_ifexists("TargetResourceType", ""))\n`;
  const sn = (pre: string) => `tolower(SrcSubnet) startswith ${kqlString(pre)} or tolower(DestSubnet) startswith ${kqlString(pre)}`;
  if (!scope.vnet) {
    return `${head}| where Tgt startswith ${kqlString(`${sub}/`)} or (isempty(Tgt) and (${sn(`${sub}/`)}
    or tostring(column_ifexists("SrcSubscription", "")) =~ ${kqlString(sub)} or tostring(column_ifexists("DestSubscription", "")) =~ ${kqlString(sub)}))`;
  }
  const v = scope.vnet.toLowerCase();
  return `${head}| where Tgt == ${kqlString(`${sub}/${v}`)} or Tgt startswith ${kqlString(`${sub}/${v}/`)}
    or ((isempty(Tgt) or TType !in~ ("VirtualNetwork", "Subnet")) and (${sn(`${v}/`)} or ${sn(`${sub}/${v}/`)}))`;
}

/** A row's target `sub/rg/vnet[/subnet]` → "rg/vnet" (lowercase); anything else → null */
export function targetVnetKey(tgt: string): string | null {
  const parts = tgt.toLowerCase().split("/");
  return parts.length >= 3 && GUID_RE.test(parts[0]!) && parts[1] && parts[2] ? `${parts[1]}/${parts[2]}` : null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/**
 * Shared head: time range, flow rows, scope, and the derived columns every section uses. Traffic Analytics writes
 * "unknown-rg/unknown-vm" when it cannot name a VM (13% of stg rows) — blanked so they do not merge into one "VM".
 */
export function baseQuery(table: string, range: number, scope: FlowScope): string {
  return `let base = ${table}
| where TimeGenerated > ago(${range}m)
| where column_ifexists("SubType", "FlowLog") == "FlowLog"
${scopeClause(scope)}
| extend SVm = tostring(column_ifexists("SrcVm", "")), DVm = tostring(column_ifexists("DestVm", ""))
| extend SVm = iff(SVm startswith "unknown-rg/", "", SVm), DVm = iff(DVm startswith "unknown-rg/", "", DVm)
| extend Bytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0)),
         FA = tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0)),
         FD = tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0)),
         Dir = case(FlowDirection in~ ("Inbound", "I"), "in", FlowDirection in~ ("Outbound", "O"), "out", ""),
         IsDenied = FlowStatus in~ ("Denied", "D"),
         FT = tostring(column_ifexists("FlowType", "")),
         SrcPub = tostring(split(tostring(split(SrcPublicIps, " ")[0]), "|")[0]),
         DstPub = tostring(split(tostring(split(DestPublicIps, " ")[0]), "|")[0]);
`;
}

export function overviewQuery(table: string, range: number, scope: FlowScope): string {
  return `${baseQuery(table, range, scope)}base
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD), Records = count() by T = bin(TimeGenerated, ${binMinutes(range)}m), FT`;
}

const TALKER_KEYS: Record<Exclude<NetTalkerDim, "port">, string> = {
  subnet: `| where isnotempty(SrcSubnet) and isnotempty(DestSubnet)
| extend S = SrcSubnet, D = DestSubnet`,
  vm: `| extend S = coalesce(SVm, SrcIp), D = coalesce(DVm, DestIp)
| where isnotempty(S) and isnotempty(D)`,
  ip: `| extend S = coalesce(SrcIp, SrcPub), D = coalesce(DestIp, DstPub)
| where isnotempty(S) and isnotempty(D)`,
};

export function talkersQuery(table: string, range: number, scope: FlowScope, dim: NetTalkerDim, top: number): string {
  if (dim === "port") {
    return `${baseQuery(table, range, scope)}base
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD),
    PublicInAllowed = countif(FT in ("ExternalPublic", "MaliciousFlow") and Dir == "in" and not(IsDenied))
    by Port = toint(DestPort), Proto = tostring(L4Protocol)
| top ${top} by Bytes desc`;
  }
  return `${baseQuery(table, range, scope)}base
${TALKER_KEYS[dim]}
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD) by S, D
| top ${top} by Bytes desc`;
}

export function blockedQuery(table: string, range: number, scope: FlowScope, top: number): string {
  return `${baseQuery(table, range, scope)}base
| where FD > 0 or IsDenied
| extend Grp = coalesce(tostring(column_ifexists("AclGroup", "")), tostring(column_ifexists("NsgList", ""))),
         Rule = coalesce(tostring(column_ifexists("AclRule", "")), tostring(column_ifexists("NsgRule", "")))
| summarize Flows = sum(FD), Records = count(), Sources = make_set(coalesce(SrcIp, SrcPub), 3), Last = max(TimeGenerated)
    by Grp, Rule, Dir, Port = toint(DestPort), Proto = tostring(L4Protocol)
| top ${top} by Flows desc`;
}

/** Public IPs on the Internet side; counts records (mv-expand), never sums bytes after the expansion */
export function internetQuery(table: string, range: number, scope: FlowScope, dir: NetDir, top: number): string {
  const types = dir === "in" ? `"ExternalPublic", "MaliciousFlow"` : `"ExternalPublic", "MaliciousFlow", "AzurePublic"`;
  return `${baseQuery(table, range, scope)}base
| where Dir == ${kqlString(dir)} and FT in (${types})
| mv-expand e = split(iff(Dir == "in", SrcPublicIps, DestPublicIps), " ") to typeof(string)
| extend Ip = tostring(split(e, "|")[0])
| where isnotempty(Ip)
| summarize Records = count(), AllowedRec = countif(not(IsDenied)), DeniedRec = countif(IsDenied), MalRec = countif(FT == "MaliciousFlow"),
    Types = make_set(FT, 3), Targets = make_set(iff(Dir == "in", coalesce(DestSubnet, DestIp), coalesce(SVm, SrcSubnet, SrcIp)), 5),
    Ports = make_set(toint(DestPort), 10), Country = take_any(tostring(column_ifexists("Country", ""))) by Ip
| order by MalRec desc, AllowedRec desc
| take ${top}`;
}

/**
 * The traffic map: one line per (source, destination) — a subnet, or for the end Traffic Analytics names no subnet
 * for, its address class from FlowType (NetExternal). Rows with no subnet on either end are folded into one "*" row
 * (counted, not drawn). The top `top` lines by bytes, plus every line with denied or malicious flows.
 */
export function mapQuery(table: string, range: number, scope: FlowScope, top: number): string {
  return `${baseQuery(table, range, scope)}base
| extend Cls = case(FT in ("ExternalPublic", "MaliciousFlow"), "internet", FT == "AzurePublic", "azure",
    FT in ("S2S", "P2S", "ExpressRoute"), "onprem", FT in ("UnknownPrivate", "InterVNet", "IntraVNet"), "private", "unknown")
| extend S = iff(isnotempty(SrcSubnet), tolower(SrcSubnet), strcat("@", Cls)), D = iff(isnotempty(DestSubnet), tolower(DestSubnet), strcat("@", Cls))
| extend Outside = S startswith "@" and D startswith "@"
| extend S = iff(Outside, "*", S), D = iff(Outside, "*", D)
| summarize Bytes = sum(Bytes), A = sum(FA), Dn = sum(FD), Rec = count(), Mal = countif(FT == "MaliciousFlow"), Last = max(TimeGenerated)
    by S, D, Port = toint(DestPort), Proto = tostring(L4Protocol)
| order by Bytes desc
| summarize Bytes = sum(Bytes), A = sum(A), Dn = sum(Dn), Rec = sum(Rec), Mal = sum(Mal), Last = max(Last),
    P = make_list(pack("p", Port, "pr", Proto, "b", Bytes, "a", A, "d", Dn), 8), DP = make_set_if(Port, Dn > 0, 20) by S, D
| order by Bytes desc
| extend Rk = row_number()
| extend Keep = S == "*" or Rk <= ${top} or Dn > 0 or Mal > 0
| summarize Rows = make_list_if(pack_all(), Keep, ${top + 300}), Omitted = countif(not(Keep))`;
}

export function threatQuery(range: number, ips: string[]): string {
  return `NTAIpDetails
| where TimeGenerated > ago(${range}m) and Ip in (${ips.map(kqlString).join(", ")})
| summarize arg_max(TimeGenerated, *) by Ip
| project Ip, Threat = tostring(column_ifexists("ThreatType", "")), Detail = tostring(column_ifexists("ThreatDescription", "")), Loc = tostring(column_ifexists("Location", ""))`;
}

/**
 * Per flow-log target in scope: last row and rows in 7 days (which VNets report into this workspace), plus the legacy
 * NSG-flow-log table's rows — for the coverage tab and for choosing the workspaces to read. K "table" is there iff
 * the table exists (an empty scope gives no "vnet" rows; a missing table gives no "table" row either).
 */
export function freshnessQuery(table: string, scope: FlowScope): string {
  return `union isfuzzy=true
  (${table} | where TimeGenerated > ago(7d) | take 1 | summarize Rows = count() | extend K = "table", Tgt = ""),
  (${table} | where TimeGenerated > ago(7d) | where column_ifexists("SubType", "FlowLog") == "FlowLog"
${scopeClause(scope)}
    | summarize Last = max(TimeGenerated), Rows = count() by Tgt | extend K = "vnet"),
  (AzureNetworkAnalytics_CL | where TimeGenerated > ago(7d) and SubType_s == "FlowLog" | summarize Last = max(TimeGenerated), Rows = count() | extend K = "legacy", Tgt = "")`;
}

// ── labels: no subscription GUIDs leave the API ──

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `sub/rg/vnet/subnet` → `rg/vnet/subnet`; an ARM id → `rg/…/name` parts; `sub/rg/vm` → `rg/vm`; anything else
 * (IPs, names) unchanged — then GUIDs masked.
 */
export function endpointLabel(s: string): string {
  if (!s) return "";
  let v = s.trim();
  const arm = /^\/subscriptions\/[^/]+\/resourcegroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)(?:\/subnets\/([^/]+))?/i.exec(v);
  if (arm) v = [arm[1], arm[2], arm[3]].filter(Boolean).join("/");
  else {
    const parts = v.split("/");
    if (parts.length >= 2 && GUID_RE.test(parts[0]!)) v = parts.slice(1).join("/");
  }
  return maskGuids(v);
}

/** NsgList / AclGroup → the NSG (or admin rule set) names, without subscription and resource group */
export function groupLabel(s: string): string {
  return s
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((g) => {
      const arm = /\/(?:networksecuritygroups|securityadminconfigurations|networkmanagers)\/([^/]+)/i.exec(g);
      if (arm) return arm[1]!;
      const parts = g.split("/");
      return maskGuids(parts[parts.length - 1] ?? g);
    })
    .filter((x, i, all) => all.indexOf(x) === i)
    .join(", ");
}

export const normProto = (p: unknown): string | null => {
  const v = str(p).toUpperCase();
  if (!v) return null;
  return v === "T" ? "TCP" : v === "U" ? "UDP" : v === "I" ? "ICMP" : v;
};

export const normDir = (d: unknown): NetDir | null => {
  const v = str(d).toLowerCase();
  return v === "in" || v === "i" || v === "inbound" ? "in" : v === "out" || v === "o" || v === "outbound" ? "out" : null;
};

const portOf = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === "string" && v.startsWith("[") ? (JSON.parse(v) as unknown[]) : []);

// ── mappers ──

export function mapOverview(rows: Record<string, unknown>[]): NetOverview {
  const series = new Map<string, { t: string; bytes: number; allowedFlows: number; deniedFlows: number }>();
  const types = new Map<string, { flowType: string; bytes: number; allowedFlows: number; deniedFlows: number; records: number }>();
  const totals = { bytes: 0, allowedFlows: 0, deniedFlows: 0, records: 0 };
  for (const r of rows) {
    const bytes = num(r.Bytes), a = num(r.Allowed), d = num(r.Denied), rec = num(r.Records);
    totals.bytes += bytes; totals.allowedFlows += a; totals.deniedFlows += d; totals.records += rec;
    const t = str(r.T);
    const s = series.get(t) ?? { t, bytes: 0, allowedFlows: 0, deniedFlows: 0 };
    s.bytes += bytes; s.allowedFlows += a; s.deniedFlows += d;
    series.set(t, s);
    const ft = str(r.FT) || "Unknown";
    const x = types.get(ft) ?? { flowType: ft, bytes: 0, allowedFlows: 0, deniedFlows: 0, records: 0 };
    x.bytes += bytes; x.allowedFlows += a; x.deniedFlows += d; x.records += rec;
    types.set(ft, x);
  }
  return {
    totals,
    series: [...series.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)),
    byFlowType: [...types.values()].sort((a, b) => b.bytes - a.bytes || b.records - a.records),
  };
}

export function mapTalkers(rows: Record<string, unknown>[], dim: NetTalkerDim): NetTalkerRow[] {
  return rows.map((r) => dim === "port"
    ? { port: portOf(r.Port), protocol: normProto(r.Proto), bytes: num(r.Bytes), allowedFlows: num(r.Allowed), deniedFlows: num(r.Denied), publicInAllowed: num(r.PublicInAllowed) }
    : { src: endpointLabel(str(r.S)), dest: endpointLabel(str(r.D)), bytes: num(r.Bytes), allowedFlows: num(r.Allowed), deniedFlows: num(r.Denied) });
}

export function mapBlocked(rows: Record<string, unknown>[]): NetBlockedRow[] {
  return rows.map((r) => ({
    group: groupLabel(str(r.Grp)),
    rule: maskGuids(str(r.Rule)),
    direction: normDir(r.Dir),
    port: portOf(r.Port),
    protocol: normProto(r.Proto),
    deniedFlows: num(r.Flows),
    records: num(r.Records),
    sources: list(r.Sources).map((x) => endpointLabel(str(x))).filter(Boolean),
    lastSeen: r.Last ? str(r.Last) : null,
  }));
}

const EXTERNALS: readonly NetExternal[] = ["internet", "azure", "onprem", "private", "unknown"];
/** A map end: "rg/vnet/subnet" (subscription stripped, GUIDs masked, lowercase) or "@<class>"; anything else → null */
export function mapEnd(v: unknown): string | null {
  const s = str(v).trim().toLowerCase();
  if (s.startsWith("@")) return (EXTERNALS as readonly string[]).includes(s.slice(1)) ? s : null;
  const label = endpointLabel(s);
  return label.split("/").length === 3 ? label : null;
}

export function mapMap(rows: Record<string, unknown>[]): NetMapData {
  const first = rows[0] ?? {};
  const inner = list(first.Rows) as Record<string, unknown>[];
  const edges = new Map<string, NetMapEdge>();
  let unplaced = { bytes: 0, records: 0 };
  for (const r of inner) {
    if (str(r.S) === "*") { unplaced = { bytes: unplaced.bytes + num(r.Bytes), records: unplaced.records + num(r.Rec) }; continue; }
    const src = mapEnd(r.S), dst = mapEnd(r.D);
    if (!src || !dst) continue;
    const ports = (list(r.P) as Record<string, unknown>[]).map((p) => ({
      port: portOf(p.p), proto: normProto(p.pr), bytes: num(p.b), allowedFlows: num(p.a), deniedFlows: num(p.d),
    })).sort((a, b) => b.bytes - a.bytes || (a.port ?? -1) - (b.port ?? -1));
    const key = `${src}>${dst}`;
    // Two raw ends can meet in one (a subnet written with and without the subscription): merge
    const prev = edges.get(key);
    const e: NetMapEdge = prev ?? { src, dst, bytes: 0, allowedFlows: 0, deniedFlows: 0, records: 0, maliciousRecords: 0, last: null, ports: [], deniedPorts: [] };
    e.bytes += num(r.Bytes); e.allowedFlows += num(r.A); e.deniedFlows += num(r.Dn); e.records += num(r.Rec); e.maliciousRecords += num(r.Mal);
    const last = str(r.Last) || null;
    if (last && (!e.last || last > e.last)) e.last = last;
    e.ports = [...e.ports, ...ports].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    e.deniedPorts = [...new Set([...e.deniedPorts, ...(list(r.DP) as unknown[]).map(portOf).filter((p): p is number => p !== null)])].sort((a, b) => a - b);
    edges.set(key, e);
  }
  return {
    edges: [...edges.values()].sort((a, b) => b.bytes - a.bytes || (a.src + a.dst < b.src + b.dst ? -1 : 1)),
    omitted: num(first.Omitted), unplaced,
  };
}

export function mapInternet(rows: Record<string, unknown>[], dir: NetDir, threats: Map<string, { threat?: string; detail?: string; location?: string }>): NetInternetRow[] {
  const out = rows.map((r): NetInternetRow => {
    const ip = str(r.Ip);
    const th = threats.get(ip);
    const flowTypes = list(r.Types).map(str).filter(Boolean);
    const country = str(r.Country) || th?.location || "";
    return {
      ip,
      direction: dir,
      flowTypes,
      malicious: num(r.MalRec) > 0 || flowTypes.includes("MaliciousFlow") || !!th?.threat,
      ...(country ? { country } : {}),
      ...(th?.threat ? { threat: th.threat } : {}),
      ...(th?.detail ? { threatDetail: maskGuids(th.detail).slice(0, 200) } : {}),
      targets: list(r.Targets).map((x) => endpointLabel(str(x))).filter(Boolean),
      ports: list(r.Ports).map((x) => Number(x)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
      records: num(r.Records),
      allowedRecords: num(r.AllowedRec),
      deniedRecords: num(r.DeniedRec),
    };
  });
  // Malicious first, then by allowed records (what got through)
  return out.sort((a, b) => Number(b.malicious) - Number(a.malicious) || b.allowedRecords - a.allowedRecords || b.records - a.records);
}
