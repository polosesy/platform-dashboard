import type { Env } from "../env";
import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  LiveNode,
  LiveEdge,
  LiveAlert,
  SparklineData,
  FaultImpact,
  HeatmapCell,
  TrafficHeatmapData,
} from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { collectBatchMetrics, collectBatchEdgeMetrics } from "./metricsCollector";
import { collectAppInsightsMetrics, resolveAppInsightsResourceId } from "./appInsightsCollector";
import { collectDiagramAlerts } from "./alertsCollector";
import { collectTrafficAnalytics, type EdgeTrafficData } from "./trafficAnalyticsCollector";
import { collectNsgFlowLogs, type NsgFlowEdgeData } from "./nsgFlowLogCollector";
import { collectAppInsightsDependencies, type DependencyEdgeData } from "./appInsightsDependencyCollector";
import { collectConnectionMonitorData, type ConnectionMonitorEdgeData } from "./connectionMonitorCollector";
import {
  resolveNodeHealth,
  resolveEdgeStatus,
  resolveTrafficLevel,
} from "./healthCalculator";

// ────────────────────────────────────────────
// Live Diagram Aggregator
//
// Orchestrates: DiagramSpec → Metric Collection
//   → Health Calculation → Snapshot Assembly
//
// Phase 3: Full multi-source traffic flow integration:
//   - Azure Monitor metrics (node + edge)
//   - App Insights edge metrics
//   - Traffic Analytics KQL (edge throughput)
//   - NSG Flow Logs (edge throughput from Storage)
//   - App Insights Dependencies (edge call rates)
//   - Connection Monitor (edge latency/loss)
//   - Azure Monitor Alerts
// ────────────────────────────────────────────

const snapshotCache = new CacheManager<LiveDiagramSnapshot>(20, 30_000);

// ── In-memory diagram store (PoC — migrate to DB later) ──
const diagramStore = new Map<string, DiagramSpec>();

// ── Sparkline ring buffer (last N metric values per node) ──
const SPARKLINE_MAX_LEN = 20;
const sparklineBuffers = new Map<string, { values: number[]; timestamps: string[] }>();

export function saveDiagramSpec(spec: DiagramSpec): void {
  diagramStore.set(spec.id, spec);
}

export function getDiagramSpec(id: string): DiagramSpec | undefined {
  return diagramStore.get(id);
}

export function listDiagramSpecs(): Array<{ id: string; name: string; updatedAt: string }> {
  return [...diagramStore.values()].map((d) => ({
    id: d.id,
    name: d.name,
    updatedAt: d.updatedAt,
  }));
}

// ────────────────────────────────────────────
// Snapshot Assembly
// ────────────────────────────────────────────

export async function buildLiveSnapshot(
  env: Env,
  bearerToken: string | undefined,
  diagramId: string,
): Promise<LiveDiagramSnapshot | null> {
  const spec = diagramStore.get(diagramId);
  if (!spec) return null;

  // Check cache
  if (bearerToken) {
    const prefix = bearerKeyPrefix(bearerToken);
    const cacheKey = `${prefix}:snapshot:${diagramId}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached) return cached;
  }

  const azureEnabled = env.AZURE_LIVE_DIAGRAM_ENABLED;
  const hasBearerToken = bearerToken != null;

  // ── Collect node metrics from Azure Monitor ──
  let nodeMetricsMap = new Map<string, Record<string, number | null>>();
  let resolvedBindings = 0;
  let failedBindings = 0;

  if (azureEnabled && hasBearerToken) {
    const resources = spec.nodes
      .filter((n) => n.azureResourceId)
      .map((n) => ({
        azureResourceId: n.azureResourceId!,
        bindings: n.bindings,
      }));

    try {
      nodeMetricsMap = await collectBatchMetrics(env, bearerToken!, resources);
      resolvedBindings = [...nodeMetricsMap.values()].reduce(
        (sum, m) => sum + Object.values(m).filter((v) => v != null).length,
        0,
      );
    } catch {
      failedBindings = resources.length;
    }
  }

  // ── Collect edge metrics (monitor-source bindings) ──
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  let edgeMonitorMetrics = new Map<string, Record<string, number | null>>();

  if (azureEnabled && hasBearerToken) {
    const edgeItems = spec.edges
      .filter((e) => {
        const srcNode = nodeById.get(e.source);
        return srcNode?.azureResourceId && Object.values(e.bindings).some((b) => b.source === "monitor");
      })
      .map((e) => ({
        edge: e,
        sourceNode: nodeById.get(e.source)!,
      }));

    if (edgeItems.length > 0) {
      try {
        edgeMonitorMetrics = await collectBatchEdgeMetrics(env, bearerToken!, edgeItems);
        resolvedBindings += [...edgeMonitorMetrics.values()].reduce(
          (sum, m) => sum + Object.values(m).filter((v) => v != null).length,
          0,
        );
      } catch {
        // Non-critical
      }
    }
  }

  // ── Collect App Insights metrics for edges ──
  const appInsightsEdgeMetrics = new Map<string, Record<string, number | null>>();

  if (azureEnabled && hasBearerToken) {
    const appInsightsEdges = spec.edges.filter((e) =>
      Object.values(e.bindings).some((b) => b.source === "appInsights"),
    );

    if (appInsightsEdges.length > 0) {
      const results = await Promise.allSettled(
        appInsightsEdges.map(async (edge) => {
          const srcNode = nodeById.get(edge.source);
          const aiResourceId = resolveAppInsightsResourceId(env, srcNode?.azureResourceId);
          if (!aiResourceId) return { edgeId: edge.id, metrics: {} as Record<string, number | null> };

          const metrics = await collectAppInsightsMetrics(
            env, bearerToken!, aiResourceId, edge.bindings,
          );
          return { edgeId: edge.id, metrics };
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          appInsightsEdgeMetrics.set(result.value.edgeId, result.value.metrics);
        }
      }
    }
  }

  // ── Collect Azure Monitor Alerts ──
  let liveAlerts: LiveAlert[] = [];

  if (azureEnabled && hasBearerToken) {
    const edgeMap = new Map(spec.edges.map((e) => [e.id, { source: e.source, target: e.target }]));
    try {
      liveAlerts = await collectDiagramAlerts(env, bearerToken!, spec.nodes, edgeMap);
    } catch {
      // Non-critical
    }
  }

  // ── Collect Traffic Flow Data (multi-source) ──
  // These collectors use SP fallback — no bearer token required.
  const trafficFlowData = await collectAllTrafficSources(env, bearerToken, spec);

  // ── Build alert lookup for node/edge activeAlertIds ──
  const nodeAlertIds = new Map<string, string[]>();
  const edgeAlertIds = new Map<string, string[]>();
  for (const alert of liveAlerts) {
    for (const nodeId of alert.affectedNodeIds) {
      const existing = nodeAlertIds.get(nodeId) ?? [];
      existing.push(alert.id);
      nodeAlertIds.set(nodeId, existing);
    }
    for (const edgeId of alert.affectedEdgeIds) {
      const existing = edgeAlertIds.get(edgeId) ?? [];
      existing.push(alert.id);
      edgeAlertIds.set(edgeId, existing);
    }
  }

  // ── Build live nodes ──
  const now = new Date().toISOString();

  const liveNodes: LiveNode[] = spec.nodes.map((nodeSpec) => {
    const metrics = nodeMetricsMap.get(nodeSpec.azureResourceId ?? "") ?? {};
    const { health, score } = resolveNodeHealth(metrics, nodeSpec.bindings);

    // ── Sparkline ring buffer: push primary metric per node ──
    const bufferKey = `${diagramId}:${nodeSpec.id}`;
    const primaryValue = findPrimaryMetric(metrics);
    const sparklines: Record<string, SparklineData> = {};

    if (primaryValue != null) {
      let buf = sparklineBuffers.get(bufferKey);
      if (!buf) {
        buf = { values: [], timestamps: [] };
        sparklineBuffers.set(bufferKey, buf);
      }
      buf.values.push(primaryValue);
      buf.timestamps.push(now);

      // Ring buffer: keep last SPARKLINE_MAX_LEN entries
      if (buf.values.length > SPARKLINE_MAX_LEN) {
        buf.values = buf.values.slice(-SPARKLINE_MAX_LEN);
        buf.timestamps = buf.timestamps.slice(-SPARKLINE_MAX_LEN);
      }

      // Determine the metric name for the primary metric
      const primaryMetricName = findPrimaryMetricName(metrics) ?? "primary";
      sparklines[primaryMetricName] = {
        values: [...buf.values],
        timestamps: [...buf.timestamps],
        metric: primaryMetricName,
      };
    }

    return {
      id: nodeSpec.id,
      health,
      healthScore: Math.round(score * 100) / 100,
      metrics,
      activeAlertIds: nodeAlertIds.get(nodeSpec.id) ?? [],
      sparkline: sparklineBuffers.get(bufferKey)?.values
        ? [...(sparklineBuffers.get(bufferKey)!.values)]
        : undefined,
      sparklines: Object.keys(sparklines).length > 0 ? sparklines : undefined,
    };
  });

  // ── Build live edges (merge all data sources) ──
  const rawEdges: Array<{ id: string; edgeMetrics: LiveEdge["metrics"] }> = [];

  for (const edgeSpec of spec.edges) {
    const monitorMetrics = edgeMonitorMetrics.get(edgeSpec.id) ?? {};
    const aiMetrics = appInsightsEdgeMetrics.get(edgeSpec.id) ?? {};
    const merged = { ...monitorMetrics, ...aiMetrics };

    // Start with monitor/appInsights binding-based metrics
    const edgeMetrics: LiveEdge["metrics"] = {
      throughputBps: toNumber(merged.throughput),
      latencyMs: toNumber(merged.latency),
      errorRate: toNumber(merged.errorRate),
      requestsPerSec: toNumber(merged.rps ?? merged.requestsPerSec),
    };

    // Merge traffic flow data (Traffic Analytics / NSG Flow Logs)
    const trafficData = trafficFlowData.traffic.get(edgeSpec.id);
    if (trafficData) {
      // Traffic sources provide throughputBps — use if no monitor binding
      if (edgeMetrics.throughputBps == null && trafficData.throughputBps > 0) {
        edgeMetrics.throughputBps = trafficData.throughputBps;
      }
      resolvedBindings++;
    }

    // Merge App Insights dependency data
    const depData = trafficFlowData.dependencies.get(edgeSpec.id);
    if (depData) {
      if (edgeMetrics.requestsPerSec == null && depData.requestsPerSec > 0) {
        edgeMetrics.requestsPerSec = depData.requestsPerSec;
      }
      if (edgeMetrics.latencyMs == null && depData.avgDurationMs > 0) {
        edgeMetrics.latencyMs = depData.avgDurationMs;
      }
      if (edgeMetrics.errorRate == null && depData.successRate < 100) {
        edgeMetrics.errorRate = 100 - depData.successRate;
      }
      resolvedBindings++;
    }

    // Merge Connection Monitor data
    const cmData = trafficFlowData.connectionMonitor.get(edgeSpec.id);
    if (cmData) {
      if (edgeMetrics.latencyMs == null && cmData.avgLatencyMs > 0) {
        edgeMetrics.latencyMs = cmData.avgLatencyMs;
      }
      resolvedBindings++;
    }

    rawEdges.push({ id: edgeSpec.id, edgeMetrics });
  }

  const maxThroughput = Math.max(1, ...rawEdges.map((e) => e.edgeMetrics.throughputBps ?? 0));

  const liveEdges: LiveEdge[] = rawEdges.map(({ id, edgeMetrics }) => ({
    id,
    status: resolveEdgeStatus(edgeMetrics),
    metrics: edgeMetrics,
    trafficLevel: resolveTrafficLevel(edgeMetrics.throughputBps, maxThroughput),
    activeAlertIds: edgeAlertIds.get(id) ?? [],
  }));

  // ── Fault impact detection ──
  const faultImpacts: FaultImpact[] = buildFaultImpacts(liveNodes, spec.edges);

  // ── Heatmap generation ──
  const heatmap: TrafficHeatmapData = buildTrafficHeatmap(liveEdges, spec.edges, maxThroughput);

  const snapshot: LiveDiagramSnapshot = {
    diagramId,
    generatedAt: now,
    refreshIntervalSec: spec.settings.refreshIntervalSec,
    nodes: liveNodes,
    edges: liveEdges,
    alerts: liveAlerts,
    topology: {
      nodeCount: spec.nodes.length,
      edgeCount: spec.edges.length,
      resolvedBindings,
      failedBindings,
    },
    faultImpacts: faultImpacts.length > 0 ? faultImpacts : undefined,
    heatmap: heatmap.cells.length > 0 ? heatmap : undefined,
  };

  // Cache
  if (bearerToken) {
    const prefix = bearerKeyPrefix(bearerToken);
    snapshotCache.set(`${prefix}:snapshot:${diagramId}`, snapshot);
  }

  return snapshot;
}

// ────────────────────────────────────────────
// Multi-Source Traffic Flow Collector
// ────────────────────────────────────────────

type TrafficFlowResult = {
  traffic: Map<string, EdgeTrafficData>;
  nsgFlows: Map<string, NsgFlowEdgeData>;
  dependencies: Map<string, DependencyEdgeData>;
  connectionMonitor: Map<string, ConnectionMonitorEdgeData>;
};

async function collectAllTrafficSources(
  env: Env,
  bearerToken: string | undefined,
  spec: DiagramSpec,
): Promise<TrafficFlowResult> {
  const result: TrafficFlowResult = {
    traffic: new Map(),
    nsgFlows: new Map(),
    dependencies: new Map(),
    connectionMonitor: new Map(),
  };

  if (!env.AZURE_LIVE_DIAGRAM_ENABLED) return result;

  // Collect all traffic sources in parallel
  const [trafficResult, nsgResult, depResult, cmResult] = await Promise.allSettled([
    collectTrafficAnalytics(env, bearerToken, spec.nodes, spec.edges),
    collectNsgFlowLogs(env, bearerToken, spec.nodes, spec.edges),
    collectAppInsightsDependencies(env, bearerToken, spec.nodes, spec.edges),
    collectConnectionMonitorData(env, bearerToken, spec.nodes, spec.edges),
  ]);

  // Traffic Analytics
  if (trafficResult.status === "fulfilled") {
    for (const data of trafficResult.value) {
      result.traffic.set(data.edgeId, data);
    }
  }

  // NSG Flow Logs — merge with traffic analytics (prefer TA if both available)
  if (nsgResult.status === "fulfilled") {
    for (const data of nsgResult.value) {
      result.nsgFlows.set(data.edgeId, data);
      // If no traffic analytics data for this edge, use NSG flow data
      if (!result.traffic.has(data.edgeId)) {
        result.traffic.set(data.edgeId, {
          edgeId: data.edgeId,
          totalBytes: data.totalBytes,
          allowedFlows: data.allowedFlows,
          deniedFlows: data.deniedFlows,
          throughputBps: data.throughputBps,
        });
      }
    }
  }

  // App Insights Dependencies
  if (depResult.status === "fulfilled") {
    for (const data of depResult.value) {
      result.dependencies.set(data.edgeId, data);
    }
  }

  // Connection Monitor
  if (cmResult.status === "fulfilled") {
    for (const data of cmResult.value) {
      result.connectionMonitor.set(data.edgeId, data);
    }
  }

  return result;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  return undefined;
}

// ────────────────────────────────────────────
// Sparkline helpers
// ────────────────────────────────────────────

/** Return the first non-null metric value from a node's metrics map. */
function findPrimaryMetric(metrics: Record<string, number | null>): number | null {
  for (const v of Object.values(metrics)) {
    if (v != null) return v;
  }
  return null;
}

/** Return the key of the first non-null metric (for labelling). */
function findPrimaryMetricName(metrics: Record<string, number | null>): string | null {
  for (const [key, v] of Object.entries(metrics)) {
    if (v != null) return key;
  }
  return null;
}

// ────────────────────────────────────────────
// Fault Impact Detection
// ────────────────────────────────────────────

/**
 * For each critical node, find connected edges and their
 * target/source nodes as affected. Ripple radius is based
 * on the health status of the critical node's neighbours.
 */
function buildFaultImpacts(
  liveNodes: LiveNode[],
  edgeSpecs: DiagramSpec["edges"],
): FaultImpact[] {
  const criticalNodes = liveNodes.filter((n) => n.health === "critical");
  if (criticalNodes.length === 0) return [];

  const nodeHealthMap = new Map(liveNodes.map((n) => [n.id, n.health]));
  const impacts: FaultImpact[] = [];

  for (const critNode of criticalNodes) {
    const affectedEdgeIds: string[] = [];
    const affectedNodeIdSet = new Set<string>();

    for (const edge of edgeSpecs) {
      if (edge.source === critNode.id || edge.target === critNode.id) {
        affectedEdgeIds.push(edge.id);
        const peerId = edge.source === critNode.id ? edge.target : edge.source;
        affectedNodeIdSet.add(peerId);
      }
    }

    // Determine severity — check the worst health among affected neighbours
    const peerHealthStatuses = [...affectedNodeIdSet]
      .map((id) => nodeHealthMap.get(id))
      .filter(Boolean);
    const hasCriticalPeer = peerHealthStatuses.includes("critical");
    const hasWarningPeer = peerHealthStatuses.includes("warning");

    // Base ripple from the critical source node = 3
    // Extend if there are degraded neighbours
    const rippleRadius = hasCriticalPeer ? 3 : hasWarningPeer ? 2 : 3;

    impacts.push({
      sourceNodeId: critNode.id,
      severity: "critical",
      affectedNodeIds: [...affectedNodeIdSet],
      affectedEdgeIds,
      rippleRadius,
    });
  }

  return impacts;
}

// ────────────────────────────────────────────
// Traffic Heatmap Generation
// ────────────────────────────────────────────

/**
 * Build a heatmap from edge throughput metrics.
 * Each cell is an edge between source → target normalised
 * against the max throughput across all edges.
 */
function buildTrafficHeatmap(
  liveEdges: LiveEdge[],
  edgeSpecs: DiagramSpec["edges"],
  maxThroughput: number,
): TrafficHeatmapData {
  const edgeSpecMap = new Map(edgeSpecs.map((e) => [e.id, e]));
  const subnetSet = new Set<string>();
  const cells: HeatmapCell[] = [];

  for (const edge of liveEdges) {
    const spec = edgeSpecMap.get(edge.id);
    if (!spec) continue;

    const throughput = edge.metrics.throughputBps ?? 0;
    const normalizedValue = maxThroughput > 0 ? throughput / maxThroughput : 0;

    subnetSet.add(spec.source);
    subnetSet.add(spec.target);

    cells.push({
      source: spec.source,
      target: spec.target,
      value: throughput,
      normalizedValue: Math.round(normalizedValue * 1000) / 1000,
    });
  }

  return {
    cells,
    subnets: [...subnetSet],
    maxValue: maxThroughput,
  };
}
