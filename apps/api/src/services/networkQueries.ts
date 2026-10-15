// VNet traffic — KQL builders and row mappers over Traffic Analytics (NTANetAnalytics / NTAIpDetails).
// Pure; unit-tested from apps/api/test/networkQueries.test.ts.
//
// Units: "흐름 / flows" = the *Flows counters summed; "기록 / records" = log rows (count()) — used only where
// mv-expand would double-count the counters. Values from the server only: ranges and top are integers chosen here,
// every string (scope prefix, direction, IPs) goes through kqlString().
// Columns the probe could not confirm are read with column_ifexists (a missing column → empty, not an error).
import type { NetBlockedRow, NetDir, NetInternetRow, NetOverview, NetTalkerDim, NetTalkerRow } from "@aud/types";
import { kqlString, maskGuids } from "../infra/requestParams.js";

export const RANGES = [60, 360, 1440, 10080] as const;
export const MGMT_PORTS = [22, 3389, 445, 1433, 3306, 5432, 5985, 5986];

export const snapRange = (minutes: number) => ((RANGES as readonly number[]).includes(minutes) ? minutes : 1440);
export const binMinutes = (range: number) => (range <= 360 ? 10 : range <= 1440 ? 60 : 360);

/**
 * Lowercase scope prefix over Traffic Analytics' subnet form `sub/rg/vnet/subnet`: the subscription, or one VNet
 * (`vnet` = "rg/vnet").
 */
export function scopePrefix(subscriptionId: string, vnet?: string): string {
  return `${subscriptionId}/${vnet ? `${vnet}/` : ""}`.toLowerCase();
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/** Shared head: time range, flow rows, scope, and the derived columns every section uses */
export function baseQuery(table: string, range: number, prefix: string): string {
  const p = kqlString(prefix);
  return `let base = ${table}
| where TimeGenerated > ago(${range}m)
| where column_ifexists("SubType", "FlowLog") == "FlowLog"
| where tolower(SrcSubnet) startswith ${p} or tolower(DestSubnet) startswith ${p}
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

export function overviewQuery(table: string, range: number, prefix: string): string {
  return `${baseQuery(table, range, prefix)}base
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD), Records = count() by T = bin(TimeGenerated, ${binMinutes(range)}m), FT`;
}

const TALKER_KEYS: Record<Exclude<NetTalkerDim, "port">, string> = {
  subnet: `| where isnotempty(SrcSubnet) and isnotempty(DestSubnet)
| extend S = SrcSubnet, D = DestSubnet`,
  vm: `| extend S = coalesce(tostring(column_ifexists("SrcVm", "")), SrcIp), D = coalesce(tostring(column_ifexists("DestVm", "")), DestIp)
| where isnotempty(S) and isnotempty(D)`,
  ip: `| extend S = coalesce(SrcIp, SrcPub), D = coalesce(DestIp, DstPub)
| where isnotempty(S) and isnotempty(D)`,
};

export function talkersQuery(table: string, range: number, prefix: string, dim: NetTalkerDim, top: number): string {
  if (dim === "port") {
    return `${baseQuery(table, range, prefix)}base
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD),
    PublicInAllowed = countif(FT in ("ExternalPublic", "MaliciousFlow") and Dir == "in" and not(IsDenied))
    by Port = toint(DestPort), Proto = tostring(L4Protocol)
| top ${top} by Bytes desc`;
  }
  return `${baseQuery(table, range, prefix)}base
${TALKER_KEYS[dim]}
| summarize Bytes = sum(Bytes), Allowed = sum(FA), Denied = sum(FD) by S, D
| top ${top} by Bytes desc`;
}

export function blockedQuery(table: string, range: number, prefix: string, top: number): string {
  return `${baseQuery(table, range, prefix)}base
| where FD > 0 or IsDenied
| extend Grp = coalesce(tostring(column_ifexists("AclGroup", "")), tostring(column_ifexists("NsgList", ""))),
         Rule = coalesce(tostring(column_ifexists("AclRule", "")), tostring(column_ifexists("NsgRule", "")))
| summarize Flows = sum(FD), Records = count(), Sources = make_set(coalesce(SrcIp, SrcPub), 3), Last = max(TimeGenerated)
    by Grp, Rule, Dir, Port = toint(DestPort), Proto = tostring(L4Protocol)
| top ${top} by Flows desc`;
}

/** Public IPs on the Internet side; counts records (mv-expand), never sums bytes after the expansion */
export function internetQuery(table: string, range: number, prefix: string, dir: NetDir, top: number): string {
  const types = dir === "in" ? `"ExternalPublic", "MaliciousFlow"` : `"ExternalPublic", "MaliciousFlow", "AzurePublic"`;
  return `${baseQuery(table, range, prefix)}base
| where Dir == ${kqlString(dir)} and FT in (${types})
| mv-expand e = split(iff(Dir == "in", SrcPublicIps, DestPublicIps), " ") to typeof(string)
| extend Ip = tostring(split(e, "|")[0])
| where isnotempty(Ip)
| summarize Records = count(), AllowedRec = countif(not(IsDenied)), DeniedRec = countif(IsDenied), MalRec = countif(FT == "MaliciousFlow"),
    Types = make_set(FT, 3), Targets = make_set(iff(Dir == "in", coalesce(DestSubnet, DestIp), coalesce(tostring(column_ifexists("SrcVm", "")), SrcSubnet, SrcIp)), 5),
    Ports = make_set(toint(DestPort), 10), Country = take_any(tostring(column_ifexists("Country", ""))) by Ip
| order by MalRec desc, AllowedRec desc
| take ${top}`;
}

export function threatQuery(range: number, ips: string[]): string {
  return `NTAIpDetails
| where TimeGenerated > ago(${range}m) and Ip in (${ips.map(kqlString).join(", ")})
| summarize arg_max(TimeGenerated, *) by Ip
| project Ip, Threat = tostring(column_ifexists("ThreatType", "")), Detail = tostring(column_ifexists("ThreatDescription", "")), Loc = tostring(column_ifexists("Location", ""))`;
}

/** Last row in the scope (7 days) and the legacy NSG-flow-log table's rows, for the coverage tab */
export function freshnessQuery(table: string, prefix: string): string {
  const p = kqlString(prefix);
  return `union isfuzzy=true
  (${table} | where TimeGenerated > ago(7d) | where tolower(SrcSubnet) startswith ${p} or tolower(DestSubnet) startswith ${p} | summarize Last = max(TimeGenerated), Rows = count() | extend K = "vnet"),
  (AzureNetworkAnalytics_CL | where TimeGenerated > ago(7d) and SubType_s == "FlowLog" | summarize Last = max(TimeGenerated), Rows = count() | extend K = "legacy")`;
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
