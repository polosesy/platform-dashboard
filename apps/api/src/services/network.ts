import type { Env } from "../env.js";
import type { NetworkFlowPair, NetworkPortSummary, NetworkSummary, NetworkTotals } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import {
  getLogAnalyticsFetcher,
  tableToObjects,
  type LogAnalyticsFetcher,
  type LogAnalyticsResponse,
  type LogAnalyticsTable,
} from "../infra/azureClientFactory.js";

type NetworkQueryParams = {
  lookbackMinutes: number;
  top: number;
};

const summaryCache = new CacheManager<NetworkSummary>(50);

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(v) ? v : min)));
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

async function queryTable(fetcher: LogAnalyticsFetcher, workspaceId: string, query: string): Promise<LogAnalyticsTable> {
  const json = (await fetcher.query(workspaceId, query)) as LogAnalyticsResponse;
  const table = json.tables?.[0];
  if (!table) {
    throw new Error(`Log Analytics query returned no data: ${json.error?.message || "No tables returned"}`);
  }
  return table;
}

function totalsQuery(table: string, lookbackMinutes: number): string {
  return `${table}
| where SubType == "FlowLog" and TimeGenerated > ago(${lookbackMinutes}m)
| extend TotalBytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0))
| summarize TotalBytes=sum(TotalBytes), AllowedFlows=sum(tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0))), DeniedFlows=sum(tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0)))`;
}

function topSubnetPairsQuery(table: string, lookbackMinutes: number, top: number): string {
  return `${table}
| where SubType == "FlowLog" and TimeGenerated > ago(${lookbackMinutes}m)
| where isnotempty(SrcSubnet) and isnotempty(DestSubnet)
| extend TotalBytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0))
| summarize TotalBytes=sum(TotalBytes), AllowedFlows=sum(tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0))), DeniedFlows=sum(tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0))) by SrcSubnet, DestSubnet
| top ${top} by TotalBytes desc`;
}

function topIpPairsQuery(table: string, lookbackMinutes: number, top: number): string {
  return `${table}
| where SubType == "FlowLog" and TimeGenerated > ago(${lookbackMinutes}m)
| where isnotempty(SrcIp) and isnotempty(DestIp)
| extend TotalBytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0))
| summarize TotalBytes=sum(TotalBytes), AllowedFlows=sum(tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0))), DeniedFlows=sum(tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0))) by SrcIp, DestIp
| top ${top} by TotalBytes desc`;
}

function topPortsQuery(table: string, lookbackMinutes: number, top: number): string {
  return `${table}
| where SubType == "FlowLog" and TimeGenerated > ago(${lookbackMinutes}m)
| extend TotalBytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0))
| summarize TotalBytes=sum(TotalBytes), AllowedFlows=sum(tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0))), DeniedFlows=sum(tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0))) by DestPort, L4Protocol
| top ${top} by TotalBytes desc`;
}

function mapTotals(row: Record<string, unknown> | undefined): NetworkTotals {
  return {
    totalBytes: asNumber(row?.TotalBytes),
    allowedFlows: asNumber(row?.AllowedFlows),
    deniedFlows: asNumber(row?.DeniedFlows),
  };
}

function mapPairs(rows: Record<string, unknown>[], srcKey: string, destKey: string): NetworkFlowPair[] {
  return rows.map((r) => ({
    src: asString(r[srcKey]),
    dest: asString(r[destKey]),
    totalBytes: asNumber(r.TotalBytes),
    allowedFlows: asNumber(r.AllowedFlows),
    deniedFlows: asNumber(r.DeniedFlows),
  }));
}

function mapPorts(rows: Record<string, unknown>[]): NetworkPortSummary[] {
  return rows.map((r) => ({
    destPort: typeof r.DestPort === "number" ? r.DestPort : r.DestPort == null ? null : Number(r.DestPort),
    protocol: r.L4Protocol == null ? null : asString(r.L4Protocol),
    totalBytes: asNumber(r.TotalBytes),
    allowedFlows: asNumber(r.AllowedFlows),
    deniedFlows: asNumber(r.DeniedFlows),
  }));
}

export function mockNetworkSummary(lookbackMinutes: number, table: string, note?: string): NetworkSummary {
  return {
    generatedAt: new Date().toISOString(),
    lookbackMinutes,
    table,
    totals: { totalBytes: 7_800_000, allowedFlows: 12_420, deniedFlows: 190 },
    topSubnetPairs: [
      { src: "snet-agw", dest: "snet-aks", totalBytes: 3_700_000, allowedFlows: 4200, deniedFlows: 14 },
      { src: "snet-aks", dest: "snet-pe", totalBytes: 2_100_000, allowedFlows: 3100, deniedFlows: 22 },
      { src: "snet-aks", dest: "snet-db", totalBytes: 1_200_000, allowedFlows: 1600, deniedFlows: 4 },
    ],
    topIpPairs: [
      { src: "10.10.1.12", dest: "10.10.2.31", totalBytes: 1_400_000, allowedFlows: 2200, deniedFlows: 2 },
      { src: "10.10.1.12", dest: "10.10.3.9", totalBytes: 1_050_000, allowedFlows: 1800, deniedFlows: 18 },
    ],
    topPorts: [
      { destPort: 443, protocol: "T", totalBytes: 3_900_000, allowedFlows: 5400, deniedFlows: 7 },
      { destPort: 80, protocol: "T", totalBytes: 1_100_000, allowedFlows: 1900, deniedFlows: 0 },
      { destPort: 53, protocol: "U", totalBytes: 210_000, allowedFlows: 760, deniedFlows: 0 },
      { destPort: 22, protocol: "T", totalBytes: 30_000, allowedFlows: 22, deniedFlows: 28 },
    ],
    note,
  };
}

export async function tryGetNetworkSummaryFromLogAnalytics(
  env: Env,
  bearerToken: string | undefined,
  params: NetworkQueryParams,
): Promise<NetworkSummary | null> {
  const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  if (!bearerToken || !workspaceId) return null;

  const lookbackMinutes = clampInt(params.lookbackMinutes, 5, 60 * 24 * 14);
  const top = clampInt(params.top, 5, 50);
  const table = env.AZURE_LOG_ANALYTICS_TABLE;

  const key = `${cachePrefix(bearerToken)}:${workspaceId}:${table}:${lookbackMinutes}:${top}`;
  const cached = summaryCache.get(key);
  if (cached) return cached;

  const fetcher = await getLogAnalyticsFetcher(env, bearerToken);
  const [totalsTable, subnetsTable, ipsTable, portsTable] = await Promise.all([
    queryTable(fetcher, workspaceId, totalsQuery(table, lookbackMinutes)),
    queryTable(fetcher, workspaceId, topSubnetPairsQuery(table, lookbackMinutes, top)),
    queryTable(fetcher, workspaceId, topIpPairsQuery(table, lookbackMinutes, top)),
    queryTable(fetcher, workspaceId, topPortsQuery(table, lookbackMinutes, top)),
  ]);

  const summary: NetworkSummary = {
    generatedAt: new Date().toISOString(),
    lookbackMinutes,
    table,
    totals: mapTotals(tableToObjects(totalsTable)[0]),
    topSubnetPairs: mapPairs(tableToObjects(subnetsTable), "SrcSubnet", "DestSubnet"),
    topIpPairs: mapPairs(tableToObjects(ipsTable), "SrcIp", "DestIp"),
    topPorts: mapPorts(tableToObjects(portsTable)),
  };

  summaryCache.set(key, summary, env.AZURE_LOG_ANALYTICS_CACHE_TTL_MS);
  return summary;
}
