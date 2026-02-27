import type { Env } from "../env";
import type { DiagramNodeSpec, DiagramEdgeSpec } from "@aud/types";
import { CacheManager } from "../infra/cacheManager";
import { getArmFetcherAuto, type ArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Connection Monitor Collector
//
// Queries Azure Network Watcher Connection Monitor
// results to get endpoint-to-endpoint latency,
// packet loss, and connectivity status.
// Maps results to diagram edges.
// ────────────────────────────────────────────

export type ConnectionMonitorEdgeData = {
  edgeId: string;
  avgLatencyMs: number;
  maxLatencyMs: number;
  packetLossPercent: number;
  checksTotal: number;
  checksFailed: number;
  status: "reachable" | "unreachable" | "unknown";
};

const cmCache = new CacheManager<ConnectionMonitorEdgeData[]>(10, 120_000);

// ARM API response types
type ConnectionMonitorListResponse = {
  value?: ConnectionMonitorResource[];
};

type ConnectionMonitorResource = {
  id: string;
  name: string;
  properties: {
    endpoints: Array<{
      name: string;
      resourceId?: string;
      address?: string;
    }>;
    testGroups: Array<{
      name: string;
      sources: string[];
      destinations: string[];
      testConfigurations: string[];
    }>;
    testConfigurations: Array<{
      name: string;
      protocol: string;
      tcpConfiguration?: { port: number };
      icmpConfiguration?: Record<string, unknown>;
    }>;
  };
};

type ConnectionMonitorQueryResult = {
  states?: Array<{
    name: string;
    startTime: string;
    endTime: string;
    evaluationState: string; // "Passed" | "Warning" | "Failed" | "NotApplicable"
    connectionState: string; // "Reachable" | "Unreachable" | "Unknown"
    avgLatencyInMs?: number;
    maxLatencyInMs?: number;
    minLatencyInMs?: number;
    probesSent?: number;
    probesFailed?: number;
  }>;
};

/**
 * Collect Connection Monitor data and map to diagram edges.
 */
export async function collectConnectionMonitorData(
  env: Env,
  bearerToken: string | undefined,
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<ConnectionMonitorEdgeData[]> {
  if (!env.AZURE_CONNECTION_MONITOR_ENABLED) return [];

  const cacheKey = `connmon:${edges.length}`;
  const cached = cmCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Extract subscription + resource group combos from node resource IDs
  const subRgPairs = new Set<string>();
  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    const match = node.azureResourceId.match(
      /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)/i,
    );
    if (match) {
      subRgPairs.add(`${match[1]}/${match[2]}`);
    }
  }

  if (subRgPairs.size === 0) return [];

  // Build node resource ID → node ID map
  const resourceIdToNodeId = new Map<string, string>();
  const addressToNodeId = new Map<string, string>();

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    resourceIdToNodeId.set(node.azureResourceId.toLowerCase(), node.id);
    // Also map by name
    const name = node.azureResourceId.split("/").pop()?.toLowerCase();
    if (name) addressToNodeId.set(name, node.id);
  }

  // Build edge lookup
  const edgeLookup = new Map<string, string>();
  for (const edge of edges) {
    edgeLookup.set(`${edge.source}→${edge.target}`, edge.id);
    edgeLookup.set(`${edge.target}→${edge.source}`, edge.id);
  }

  // List Network Watchers and their Connection Monitors
  const allEdgeData: ConnectionMonitorEdgeData[] = [];

  for (const pair of subRgPairs) {
    const [subId, rgName] = pair.split("/");
    if (!subId || !rgName) continue;

    try {
      const monitors = await listConnectionMonitors(fetcher, subId, rgName);

      for (const monitor of monitors) {
        const results = await queryConnectionMonitor(fetcher, monitor.id);
        if (!results?.states) continue;

        // Map endpoints to node IDs
        const endpointToNodeId = new Map<string, string>();
        for (const ep of monitor.properties.endpoints) {
          const nodeId = ep.resourceId
            ? resourceIdToNodeId.get(ep.resourceId.toLowerCase())
            : ep.address
              ? addressToNodeId.get(ep.address.toLowerCase())
              : null;
          if (nodeId) endpointToNodeId.set(ep.name, nodeId);
        }

        // Map test groups to edges
        for (const testGroup of monitor.properties.testGroups) {
          for (const srcName of testGroup.sources) {
            for (const destName of testGroup.destinations) {
              const srcNodeId = endpointToNodeId.get(srcName);
              const destNodeId = endpointToNodeId.get(destName);
              if (!srcNodeId || !destNodeId || srcNodeId === destNodeId) continue;

              const edgeId = edgeLookup.get(`${srcNodeId}→${destNodeId}`);
              if (!edgeId) continue;

              // Find matching state
              const stateKey = `${testGroup.name}`;
              const state = results.states.find((s) => s.name.includes(stateKey));
              if (!state) continue;

              allEdgeData.push({
                edgeId,
                avgLatencyMs: state.avgLatencyInMs ?? 0,
                maxLatencyMs: state.maxLatencyInMs ?? 0,
                packetLossPercent: state.probesSent
                  ? Math.round(((state.probesFailed ?? 0) / state.probesSent) * 10000) / 100
                  : 0,
                checksTotal: state.probesSent ?? 0,
                checksFailed: state.probesFailed ?? 0,
                status: state.connectionState === "Reachable"
                  ? "reachable"
                  : state.connectionState === "Unreachable"
                    ? "unreachable"
                    : "unknown",
              });
            }
          }
        }
      }
    } catch {
      // Non-critical: skip failed subscriptions
    }
  }

  cmCache.set(cacheKey, allEdgeData);
  return allEdgeData;
}

// ── ARM API calls ──

async function listConnectionMonitors(
  fetcher: ArmFetcher,
  subscriptionId: string,
  resourceGroupName: string,
): Promise<ConnectionMonitorResource[]> {
  // List Network Watchers first
  const nwUrl =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroupName}` +
    `/providers/Microsoft.Network/networkWatchers` +
    `?api-version=2023-11-01`;

  type NwListResponse = { value?: Array<{ id: string; name: string }> };
  const nwResp = await fetcher.fetchJson<NwListResponse>(nwUrl);
  const watchers = nwResp.value ?? [];

  const monitors: ConnectionMonitorResource[] = [];

  for (const watcher of watchers) {
    const cmUrl =
      `https://management.azure.com${watcher.id}` +
      `/connectionMonitors` +
      `?api-version=2023-11-01`;

    try {
      const cmResp = await fetcher.fetchJson<ConnectionMonitorListResponse>(cmUrl);
      if (cmResp.value) monitors.push(...cmResp.value);
    } catch {
      // Skip if listing fails
    }
  }

  return monitors;
}

async function queryConnectionMonitor(
  fetcher: ArmFetcher,
  connectionMonitorId: string,
): Promise<ConnectionMonitorQueryResult | null> {
  const url =
    `https://management.azure.com${connectionMonitorId}` +
    `/query?api-version=2023-11-01`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fetcher.armToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) return null;
    return await res.json() as ConnectionMonitorQueryResult;
  } catch {
    return null;
  }
}
