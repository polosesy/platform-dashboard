import type { Env } from "../env.js";
import type { DiagramNodeSpec, DiagramEdgeSpec } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getLogAnalyticsFetcherAuto, tableToObjects, type LogAnalyticsResponse } from "../infra/azureClientFactory.js";

// ────────────────────────────────────────────
// Traffic Analytics Collector (for Live Diagram)
//
// Queries NTANetAnalytics Log Analytics table
// for subnet pair traffic, then maps the flows
// to diagram edges with throughput data.
// ────────────────────────────────────────────

export type EdgeTrafficData = {
  edgeId: string;
  totalBytes: number;
  allowedFlows: number;
  deniedFlows: number;
  throughputBps: number;
};

const trafficCache = new CacheManager<EdgeTrafficData[]>(20, 60_000);
/**
 * Look-back for flow rows. Traffic Analytics lands every 10–60 min, so a 5 min window was almost always empty;
 * throughput is the average over this window.
 */
const WINDOW_MIN = 120;

/**
 * Collect traffic analytics data and map to diagram edges.
 *
 * Queries NTANetAnalytics for subnet pair traffic (SrcSubnet → DestSubnet)
 * and maps it to diagram edges via the nodes' subnet resource IDs.
 */
export async function collectTrafficAnalytics(
  env: Env,
  bearerToken: string | undefined,
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<EdgeTrafficData[]> {
  if (!env.AZURE_TRAFFIC_ANALYTICS_ENABLED) return [];
  if (!env.AZURE_LOG_ANALYTICS_WORKSPACE_ID) return [];

  const cacheKey = `${cachePrefix(bearerToken)}:traffic:${edges.map((e) => e.id).sort().join(",")}`;
  const cached = trafficCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getLogAnalyticsFetcherAuto(env, bearerToken);
  const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  const table = env.AZURE_LOG_ANALYTICS_TABLE;

  // Build resource name → node ID mapping for subnet resolution
  const nodeNameToId = new Map<string, string>();
  const nodeSubnetPatterns = new Map<string, string>(); // subnet pattern → nodeId

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    // Extract resource name from Azure ID
    const parts = node.azureResourceId.split("/");
    const name = parts[parts.length - 1]?.toLowerCase();
    if (name) nodeNameToId.set(name, node.id);

    // Extract subnet references for subnet-based matching
    const subnetMatch = node.azureResourceId.match(/subnets\/([^/]+)/i);
    if (subnetMatch) {
      nodeSubnetPatterns.set(subnetMatch[1]!.toLowerCase(), node.id);
    }
  }

  // Build edge source→target lookup
  const edgeLookup = new Map<string, string>(); // "srcNodeId→tgtNodeId" → edgeId
  for (const edge of edges) {
    edgeLookup.set(`${edge.source}→${edge.target}`, edge.id);
    edgeLookup.set(`${edge.target}→${edge.source}`, edge.id); // bidirectional
  }

  // Subnet pair traffic (IP-pair resolution is not implemented, so only subnet pairs are queried)
  const subnetKql = `${table}
| where SubType == "FlowLog" and TimeGenerated > ago(${WINDOW_MIN}m)
| where isnotempty(SrcSubnet) and isnotempty(DestSubnet)
| extend TotalBytes = tolong(coalesce(BytesSrcToDest, 0)) + tolong(coalesce(BytesDestToSrc, 0))
| summarize
    TotalBytes=sum(TotalBytes),
    AllowedFlows=sum(tolong(coalesce(AllowedInFlows, 0)) + tolong(coalesce(AllowedOutFlows, 0))),
    DeniedFlows=sum(tolong(coalesce(DeniedInFlows, 0)) + tolong(coalesce(DeniedOutFlows, 0)))
  by SrcSubnet, DestSubnet
| top 50 by TotalBytes desc`;

  const [subnetResult] = await Promise.allSettled([fetcher.query(workspaceId, subnetKql)]);

  // Aggregate traffic data per edge
  const edgeTraffic = new Map<string, { totalBytes: number; allowedFlows: number; deniedFlows: number }>();

  // Process subnet pairs
  if (subnetResult.status === "fulfilled") {
    const resp = subnetResult.value as LogAnalyticsResponse;
    const tableData = resp.tables?.[0];
    if (tableData) {
      const rows = tableToObjects(tableData);
      for (const row of rows) {
        const srcSubnet = asString(row.SrcSubnet).toLowerCase();
        const destSubnet = asString(row.DestSubnet).toLowerCase();

        // Try to resolve subnets to node IDs
        const srcNodeId = resolveSubnetToNode(srcSubnet, nodeSubnetPatterns, nodeNameToId);
        const destNodeId = resolveSubnetToNode(destSubnet, nodeSubnetPatterns, nodeNameToId);

        if (srcNodeId && destNodeId && srcNodeId !== destNodeId) {
          const edgeId = edgeLookup.get(`${srcNodeId}→${destNodeId}`);
          if (edgeId) {
            const existing = edgeTraffic.get(edgeId) ?? { totalBytes: 0, allowedFlows: 0, deniedFlows: 0 };
            existing.totalBytes += asNumber(row.TotalBytes);
            existing.allowedFlows += asNumber(row.AllowedFlows);
            existing.deniedFlows += asNumber(row.DeniedFlows);
            edgeTraffic.set(edgeId, existing);
          }
        }
      }
    }
  }

  // Convert to EdgeTrafficData[]
  const LOOKBACK_SECONDS = WINDOW_MIN * 60;
  const result: EdgeTrafficData[] = [];

  for (const [edgeId, data] of edgeTraffic) {
    result.push({
      edgeId,
      totalBytes: data.totalBytes,
      allowedFlows: data.allowedFlows,
      deniedFlows: data.deniedFlows,
      throughputBps: Math.round((data.totalBytes * 8) / LOOKBACK_SECONDS), // bits per second
    });
  }

  trafficCache.set(cacheKey, result);
  return result;
}

// ── Helpers ──

function resolveSubnetToNode(
  subnet: string,
  subnetPatterns: Map<string, string>,
  nameMap: Map<string, string>,
): string | null {
  // Direct subnet name match
  const lastSegment = subnet.split("/").pop()?.toLowerCase() ?? subnet.toLowerCase();
  const byPattern = subnetPatterns.get(lastSegment);
  if (byPattern) return byPattern;

  // Resource name match (e.g., subnet name matches node name pattern)
  const byName = nameMap.get(lastSegment);
  if (byName) return byName;

  return null;
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
