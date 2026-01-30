import { OnBehalfOfCredential } from "@azure/identity";
import type { Env } from "../env";
import type { NetworkFlowPair, NetworkPortSummary, NetworkSummary, NetworkTotals } from "../types";

type LogAnalyticsTable = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
};

type LogAnalyticsResponse = {
  tables?: LogAnalyticsTable[];
  error?: { message?: string; code?: string };
};

type NetworkQueryParams = {
  lookbackMinutes: number;
  top: number;
};

let cache:
  | {
      key: string;
      expiresAt: number;
      summary: NetworkSummary;
    }
  | undefined;

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function tableToObjects(table: LogAnalyticsTable): Record<string, unknown>[] {
  const cols = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]!] = row[i];
    return obj;
  });
}

async function queryLogAnalytics(env: Env, bearerToken: string, query: string): Promise<LogAnalyticsTable> {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;

  if (!tenantId || !clientId || !clientSecret || !workspaceId) {
    throw new Error("Azure Log Analytics not configured (AZURE_AD_* and AZURE_LOG_ANALYTICS_WORKSPACE_ID required)");
  }

  const credential = new OnBehalfOfCredential({
    tenantId,
    clientId,
    clientSecret,
    userAssertionToken: bearerToken,
  });
  const token = await credential.getToken("https://api.loganalytics.io/.default");
  if (!token?.token) throw new Error("Failed to acquire Log Analytics token");

  const url = `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Log Analytics query failed: HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }

  const json = (await res.json()) as LogAnalyticsResponse;
  const table = json.tables?.[0];
  if (!table) {
    const msg = json.error?.message || "No tables returned";
    throw new Error(`Log Analytics query returned no data: ${msg}`);
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
      { src: "subnet-app", dest: "subnet-platform", totalBytes: 3_700_000, allowedFlows: 4200, deniedFlows: 14 },
      { src: "subnet-app", dest: "subnet-data", totalBytes: 2_100_000, allowedFlows: 3100, deniedFlows: 22 },
      { src: "subnet-platform", dest: "subnet-egress", totalBytes: 1_200_000, allowedFlows: 1600, deniedFlows: 4 },
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
  params: NetworkQueryParams
): Promise<NetworkSummary | null> {
  if (!bearerToken) return null;
  if (!env.AZURE_LOG_ANALYTICS_WORKSPACE_ID) return null;

  const lookbackMinutes = clampInt(params.lookbackMinutes, 5, 60 * 24 * 14);
  const top = clampInt(params.top, 5, 50);
  const table = env.AZURE_LOG_ANALYTICS_TABLE;

  const key = `${env.AZURE_LOG_ANALYTICS_WORKSPACE_ID}:${table}:${lookbackMinutes}:${top}`;
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) return cache.summary;

  const [totalsTable, subnetsTable, ipsTable, portsTable] = await Promise.all([
    queryLogAnalytics(env, bearerToken, totalsQuery(table, lookbackMinutes)),
    queryLogAnalytics(env, bearerToken, topSubnetPairsQuery(table, lookbackMinutes, top)),
    queryLogAnalytics(env, bearerToken, topIpPairsQuery(table, lookbackMinutes, top)),
    queryLogAnalytics(env, bearerToken, topPortsQuery(table, lookbackMinutes, top)),
  ]);

  const totals = mapTotals(tableToObjects(totalsTable)[0]);
  const topSubnetPairs = mapPairs(tableToObjects(subnetsTable), "SrcSubnet", "DestSubnet");
  const topIpPairs = mapPairs(tableToObjects(ipsTable), "SrcIp", "DestIp");
  const topPorts = mapPorts(tableToObjects(portsTable));

  const summary: NetworkSummary = {
    generatedAt: new Date().toISOString(),
    lookbackMinutes,
    table,
    totals,
    topSubnetPairs,
    topIpPairs,
    topPorts,
  };

  cache = {
    key,
    expiresAt: now + env.AZURE_LOG_ANALYTICS_CACHE_TTL_MS,
    summary,
  };

  return summary;
}
