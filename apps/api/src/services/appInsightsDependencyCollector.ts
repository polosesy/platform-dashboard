import type { Env } from "../env";
import type { DiagramNodeSpec, DiagramEdgeSpec } from "@aud/types";
import { CacheManager } from "../infra/cacheManager";
import { getArmFetcherAuto, type ArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Application Insights Dependency Mapper
//
// Queries App Insights "dependencies" table via
// ARM REST API to discover app-to-app call relationships,
// success/failure rates, and latency data.
// Maps results to diagram edges.
// ────────────────────────────────────────────

export type DependencyEdgeData = {
  edgeId: string;
  callCount: number;
  failedCount: number;
  avgDurationMs: number;
  successRate: number;       // 0–100
  requestsPerSec: number;
};

const dependencyCache = new CacheManager<DependencyEdgeData[]>(20, 60_000);

type AppInsightsQueryResponse = {
  tables?: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
  }>;
  error?: { message?: string; code?: string };
};

/**
 * Collect App Insights dependency data and map to diagram edges.
 *
 * Uses the App Insights REST API (via ARM) to query the `dependencies` table:
 * - Finds caller→callee relationships
 * - Calculates success/failure rates
 * - Maps to diagram edges by matching resource names
 */
export async function collectAppInsightsDependencies(
  env: Env,
  bearerToken: string | undefined,
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<DependencyEdgeData[]> {
  if (!env.AZURE_APP_INSIGHTS_APP_ID) return [];

  const cacheKey = `aidep:${env.AZURE_APP_INSIGHTS_APP_ID}:${edges.length}`;
  const cached = dependencyCache.get(cacheKey);
  if (cached) return cached;

  // Find the App Insights resource ID from any node in the diagram
  const appInsightsResourceId = findAppInsightsResourceId(env, nodes);
  if (!appInsightsResourceId) return [];

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Query dependencies KQL via App Insights REST API
  const kql = `dependencies
| where timestamp > ago(5m)
| summarize
    callCount = count(),
    failedCount = countif(success == false),
    avgDurationMs = avg(duration),
    p95DurationMs = percentile(duration, 95)
  by target, type, cloud_RoleName
| top 100 by callCount desc`;

  const queryResult = await queryAppInsights(fetcher, appInsightsResourceId, kql);
  if (!queryResult) return [];

  // Build node name → node ID mapping
  const nodeNameToId = buildNodeNameMap(nodes);

  // Build edge lookup
  const edgeLookup = new Map<string, string>();
  for (const edge of edges) {
    edgeLookup.set(`${edge.source}→${edge.target}`, edge.id);
    edgeLookup.set(`${edge.target}→${edge.source}`, edge.id);
  }

  // Map dependency rows to edges
  const edgeData = new Map<string, DependencyEdgeData>();

  for (const row of queryResult) {
    const target = asString(row.target).toLowerCase();
    const callerRole = asString(row.cloud_RoleName).toLowerCase();
    const callCount = asNumber(row.callCount);
    const failedCount = asNumber(row.failedCount);
    const avgDuration = asNumber(row.avgDurationMs);

    // Resolve caller and target to node IDs
    const callerNodeId = resolveNameToNode(callerRole, nodeNameToId);
    const targetNodeId = resolveNameToNode(target, nodeNameToId);

    if (!callerNodeId || !targetNodeId || callerNodeId === targetNodeId) continue;

    const edgeId = edgeLookup.get(`${callerNodeId}→${targetNodeId}`);
    if (!edgeId) continue;

    const existing = edgeData.get(edgeId);
    if (existing) {
      existing.callCount += callCount;
      existing.failedCount += failedCount;
      existing.avgDurationMs = (existing.avgDurationMs + avgDuration) / 2;
      existing.successRate = existing.callCount > 0
        ? Math.round((1 - existing.failedCount / existing.callCount) * 10000) / 100
        : 100;
      existing.requestsPerSec = existing.callCount / 300; // 5 min window
    } else {
      edgeData.set(edgeId, {
        edgeId,
        callCount,
        failedCount,
        avgDurationMs: avgDuration,
        successRate: callCount > 0
          ? Math.round((1 - failedCount / callCount) * 10000) / 100
          : 100,
        requestsPerSec: callCount / 300,
      });
    }
  }

  const result = [...edgeData.values()];
  dependencyCache.set(cacheKey, result);
  return result;
}

// ── Helpers ──

function findAppInsightsResourceId(env: Env, nodes: DiagramNodeSpec[]): string | null {
  if (!env.AZURE_APP_INSIGHTS_APP_ID) return null;

  // Find a node with a resource ID we can derive the App Insights path from
  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    const match = node.azureResourceId.match(
      /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)/i,
    );
    if (match) {
      const [, subId, rgName] = match;
      return `/subscriptions/${subId}/resourceGroups/${rgName}/providers/microsoft.insights/components/${env.AZURE_APP_INSIGHTS_APP_ID}`;
    }
  }
  return null;
}

async function queryAppInsights(
  fetcher: ArmFetcher,
  resourceId: string,
  kql: string,
): Promise<Record<string, unknown>[] | null> {
  try {
    const url =
      `https://management.azure.com${resourceId}` +
      `/api/query?api-version=2018-04-20`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fetcher.armToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: kql }),
    });

    if (!res.ok) return null;
    const json = await res.json() as AppInsightsQueryResponse;

    const table = json.tables?.[0];
    if (!table) return null;

    const cols = table.columns.map((c) => c.name);
    return table.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]!] = row[i];
      return obj;
    });
  } catch {
    return null;
  }
}

function buildNodeNameMap(nodes: DiagramNodeSpec[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    // Map by node label (lowercase)
    map.set(node.label.toLowerCase(), node.id);

    // Map by resource name from Azure resource ID
    if (node.azureResourceId) {
      const parts = node.azureResourceId.split("/");
      const name = parts[parts.length - 1]?.toLowerCase();
      if (name) map.set(name, node.id);
    }

    // Map by node ID
    map.set(node.id.toLowerCase(), node.id);
  }
  return map;
}

/**
 * Resolve a dependency target name to a diagram node ID.
 * Tries exact match, then partial/fuzzy matching.
 */
function resolveNameToNode(
  name: string,
  nodeNameMap: Map<string, string>,
): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();

  // Exact match
  const exact = nodeNameMap.get(lower);
  if (exact) return exact;

  // Try matching after stripping common suffixes
  const stripped = lower
    .replace(/\.database\.windows\.net$/, "")
    .replace(/\.redis\.cache\.windows\.net$/, "")
    .replace(/\.documents\.azure\.com$/, "")
    .replace(/\.postgres\.database\.azure\.com$/, "")
    .replace(/\.servicebus\.windows\.net$/, "")
    .replace(/\.blob\.core\.windows\.net$/, "")
    .replace(/\.azurewebsites\.net$/, "")
    .replace(/\.azurecontainerapps\.io$/, "");

  const strippedMatch = nodeNameMap.get(stripped);
  if (strippedMatch) return strippedMatch;

  // Partial match — check if any node name contains or is contained in the target
  for (const [nodeName, nodeId] of nodeNameMap) {
    if (lower.includes(nodeName) || nodeName.includes(lower)) {
      return nodeId;
    }
  }

  return null;
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
