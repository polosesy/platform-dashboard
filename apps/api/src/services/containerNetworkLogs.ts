// Hubble flows without exec, from ACNS container network logs (Log Analytics table ContainerNetworkLogs).
//
// The table only has rows once the customer applies a ContainerNetworkLog resource to the cluster (a cluster write —
// never the dashboard's; docs/deployment/kubernetes.md). Queried resource-centric on the cluster ARM id with the
// cluster's connection (azureClientFactory queryResource), so the workspace need not be in the connections file.
// Columns from `ContainerNetworkLogs | getschema` (2026-10-23); the dynamic columns (IP, Layer4, Layer7, EventType,
// *Workloads, Policies) are read in Hubble's flow shape, field by field — a missing field stays empty, never guessed.

import type { Env } from "../env.js";
import type { HubbleCoverage, HubbleEndpoint, HubbleFlow, HubbleFlowSet, HubbleLogsState } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getLogAnalyticsFetcherAuto, tableToObjects, type LogAnalyticsResponse } from "../infra/azureClientFactory.js";
import { HttpError, kqlString, safeMessage } from "../infra/requestParams.js";
import { parsePolicyRef } from "./hubbleAudit.js";
import { workloadFromPodName } from "./workloadOwners.js";

export type FlowLogsAvailability = { state: HubbleLogsState; rows1h: number | null; newest: string | null; message?: string };

const availabilityCache = new CacheManager<FlowLogsAvailability>(20, 5 * 60_000);

/** `union isfuzzy` → a missing table is 0 rows, not an error */
export const AVAILABILITY_KQL =
  "union isfuzzy=true (ContainerNetworkLogs | where TimeGenerated > ago(1h) | project TimeGenerated) | summarize n = count(), newest = max(TimeGenerated)";

export function logsStateOf(e: unknown): { state: HubbleLogsState; message: string } {
  const message = safeMessage(e);
  const status = e instanceof HttpError ? e.status : Number(/^LogAnalytics\s+(\d{3})\b/.exec(message)?.[1] ?? 0);
  return { state: status === 401 || status === 403 ? "forbidden" : "failed", message };
}

export async function flowLogsAvailability(env: Env, bearerToken: string | undefined, clusterId: string): Promise<FlowLogsAvailability> {
  const key = `${cachePrefix(bearerToken)}:cnl-avail:${clusterId.toLowerCase()}`;
  const cached = availabilityCache.get(key);
  if (cached) return cached;
  let out: FlowLogsAvailability;
  try {
    const fetcher = await getLogAnalyticsFetcherAuto(env, bearerToken);
    const resp = (await fetcher.queryResource(clusterId, AVAILABILITY_KQL, "PT1H")) as LogAnalyticsResponse;
    const row = resp.tables?.[0] ? tableToObjects(resp.tables[0])[0] : undefined;
    const n = Number(row?.n ?? 0);
    out = { state: n > 0 ? "ok" : "notEnabled", rows1h: n, newest: n > 0 && row?.newest ? String(row.newest) : null };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    out = { rows1h: null, newest: null, ...logsStateOf(e) };
  }
  if (out.state !== "failed") availabilityCache.set(key, out);
  return out;
}

const VERDICTS = new Set(["FORWARDED", "DROPPED", "AUDIT", "ERROR", "REDIRECTED"]);
const EVENT_TYPES: Record<string, number> = { drop: 1, trace: 4, "policy-verdict": 5, l7: 129 };

/** The flows query — filters only through kqlString / whitelists, never interpolated text */
export function flowLogsKql(opts: { minutes: number; limit: number; namespace?: string; verdict?: string; type?: string }): string {
  const lines = ["ContainerNetworkLogs", `| where TimeGenerated > ago(${Math.max(1, Math.min(1440, Math.floor(opts.minutes)))}m)`];
  if (opts.namespace) lines.push(`| where SourceNamespace == ${kqlString(opts.namespace)} or DestinationNamespace == ${kqlString(opts.namespace)}`);
  const verdict = opts.verdict?.toUpperCase();
  if (verdict && VERDICTS.has(verdict)) lines.push(`| where Verdict == ${kqlString(verdict)}`);
  const type = opts.type ? EVENT_TYPES[opts.type.toLowerCase()] : undefined;
  if (type !== undefined) lines.push(`| where toint(EventType.type) == ${type}`);
  lines.push(`| top ${Math.max(1, Math.min(10_000, Math.floor(opts.limit)))} by TimeGenerated desc`);
  return lines.join("\n");
}

const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return {}; } }
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
};
const arr = (v: unknown): unknown[] => {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : [];
};
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function endpoint(ns: unknown, pod: unknown, identity: unknown, workloads: unknown): HubbleEndpoint {
  const podName = str(pod);
  const wl = obj(arr(workloads)[0]);
  return { namespace: str(ns), podName, labels: {}, identity: Number(identity ?? 0) || 0, workloadName: str(wl.name) || (podName ? workloadFromPodName(podName) : "") };
}

/** One ContainerNetworkLogs row → a HubbleFlow (pure; fields that are absent stay empty) */
export function rowToHubbleFlow(row: Record<string, unknown>): HubbleFlow {
  const ip = obj(row.IP);
  const l4 = obj(row.Layer4);
  const tcp = obj(l4.TCP ?? l4.tcp);
  const udp = obj(l4.UDP ?? l4.udp);
  const l4Protocol: HubbleFlow["l4Protocol"] = Object.keys(tcp).length ? "TCP" : Object.keys(udp).length ? "UDP" : (l4.ICMPv4 || l4.ICMPv6) ? "ICMP" : "UNKNOWN";
  const ports = l4Protocol === "TCP" ? tcp : udp;
  const l7Raw = obj(row.Layer7);
  const dns = obj(l7Raw.dns);
  const http = obj(l7Raw.http);
  const l7: HubbleFlow["l7"] = Object.keys(l7Raw).length ? {
    type: Object.keys(dns).length ? "DNS" : Object.keys(http).length ? "HTTP" : "UNKNOWN",
    ...(Object.keys(dns).length ? { dns: { query: str(dns.query), rcode: Number(dns.rcode ?? 0), responseIps: arr(dns.ips).map(str) } } : {}),
    ...(Object.keys(http).length ? { http: { code: Number(http.code ?? 0), method: str(http.method), url: str(http.url), protocol: str(http.protocol), latencyNs: 0 } } : {}),
  } : undefined;
  const verdict = str(row.Verdict).toUpperCase();
  const direction = str(row.TrafficDirection).toUpperCase();
  const typeNo = Number(obj(row.EventType).type ?? NaN);
  const eventKind = typeNo === 1 ? "drop" : typeNo === 4 ? "trace" : typeNo === 5 ? "policy-verdict" : typeNo === 129 ? "l7" : undefined;
  const policies = arr(row.Policies);
  const flags = obj(tcp.flags);
  return {
    time: str(row.TimeGenerated),
    source: endpoint(row.SourceNamespace, row.SourcePodName, row.SourceIdentity, row.SourceWorkloads),
    destination: endpoint(row.DestinationNamespace, row.DestinationPodName, row.DestinationIdentity, row.DestinationWorkloads),
    verdict: (VERDICTS.has(verdict) ? verdict : "FORWARDED") as HubbleFlow["verdict"],
    type: str(row.FlowType).toUpperCase() === "L7" || l7 ? "L7" : "L3_L4",
    l4Protocol,
    sourcePort: Number(ports.source_port ?? ports.sourcePort ?? 0) || 0,
    destinationPort: Number(ports.destination_port ?? ports.destinationPort ?? 0) || 0,
    l7,
    trafficDirection: direction === "INGRESS" || direction === "EGRESS" ? direction : "UNKNOWN",
    dropReasonDesc: str(row.DropReason),
    isReply: row.Reply === true || row.Reply === "true",
    nodeName: str(row.NodeName),
    summary: "",
    ...(ip.source ? { sourceIp: str(ip.source) } : {}),
    ...(ip.destination ? { destinationIp: str(ip.destination) } : {}),
    ...(Object.keys(flags).length ? { tcpFlags: Object.keys(flags).sort().join(",") } : {}),
    ...(eventKind ? { eventKind } : {}),
    ...(eventKind === "policy-verdict" && policies.length ? { allowedBy: policies.map(parsePolicyRef) } : {}),
  };
}

export function flowLogsCoverage(flows: HubbleFlow[], minutes: number): HubbleCoverage {
  const times = flows.map((f) => f.time).filter(Boolean).sort();
  const nodes = [...new Set(flows.map((f) => f.nodeName).filter(Boolean))].sort();
  return {
    source: "flow-logs", nodesObserved: nodes.length, nodesTotal: nodes.length,
    nodes: nodes.map((nodeName) => {
      const mine = flows.filter((f) => f.nodeName === nodeName).map((f) => f.time).sort();
      return { nodeName, podName: "", events: mine.length, oldest: mine[0] ?? null, newest: mine[mine.length - 1] ?? null, bufferFull: false };
    }),
    commonSince: times[0] ?? null, newest: times[times.length - 1] ?? null, commonWindowMinutes: minutes,
    rawEvents: flows.length, duplicatesRemoved: 0,
  };
}

/** Flows from the logs, newest first (the collectors' input when exec is off) */
export async function getFlowsFromLogs(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { minutes?: number; limit: number; namespace?: string; verdict?: string; type?: string },
): Promise<HubbleFlowSet> {
  const minutes = opts.minutes ?? 15;
  const fetcher = await getLogAnalyticsFetcherAuto(env, bearerToken);
  const resp = (await fetcher.queryResource(clusterId, flowLogsKql({ ...opts, minutes }), `PT${Math.max(1, Math.ceil(minutes / 60))}H`)) as LogAnalyticsResponse;
  const flows = resp.tables?.[0] ? tableToObjects(resp.tables[0]).map(rowToHubbleFlow) : [];
  return { flows, coverage: flowLogsCoverage(flows, minutes) };
}
