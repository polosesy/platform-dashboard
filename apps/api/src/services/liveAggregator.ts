import type { Env } from "../env.js";
import type {
  DiagramSpec,
  LiveDiagramSnapshot,
  LiveNode,
  LiveEdge,
  LiveAlert,
  AlertRuleInfo,
  PowerState,
  SparklineData,
  FaultImpact,
  LiveCoverage,
  LiveSourceState,
} from "@aud/types";
import { CacheManager, bearerKeyPrefix, cachePrefix, principalKey } from "../infra/cacheManager.js";
import { collectBatchMetrics, collectBatchEdgeMetrics, collectBatchPowerStates } from "./metricsCollector.js";
import { normalizeSpecBindings } from "./specGenerator.js";
import { collectAppInsightsMetrics, resolveAppInsightsResourceId } from "./appInsightsCollector.js";
import { collectDiagramAlerts } from "./alertsCollector.js";
import { collectAlertRules } from "./alertRulesCollector.js";
import { collectTrafficAnalytics, type EdgeTrafficData } from "./trafficAnalyticsCollector.js";
import { collectNsgFlowLogs, type NsgFlowEdgeData } from "./nsgFlowLogCollector.js";
import { collectAppInsightsDependencies, type DependencyEdgeData } from "./appInsightsDependencyCollector.js";
import { collectConnectionMonitorData, type ConnectionMonitorEdgeData } from "./connectionMonitorCollector.js";
import {
  resolveNodeHealth,
  resolveEdgeStatus,
  resolveTrafficLevel,
} from "./healthCalculator.js";

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
// Keyed by owner: a diagram generated from Azure holds that user's inventory, so only that user reads it.
// Built-in samples are "public". Owner = the stable per-user cache prefix (u:{tid}:{oid}).
const diagramStore = new Map<string, DiagramSpec>();
export const PUBLIC_OWNER = "public";
/** Owner of what a caller saves / reads: the signed-in user, or "public" (samples, anonymous dev mode) */
export const diagramOwner = (bearerToken: string | undefined) => (bearerToken ? principalKey(bearerToken) : PUBLIC_OWNER);
const storeKey = (owner: string, id: string) => `${owner}|${id}`;

// ── Sparkline ring buffer (last N metric values per node) ──
const SPARKLINE_MAX_LEN = 20;
const sparklineBuffers = new Map<string, { values: number[]; timestamps: string[] }>();

/** Upper bound on stored specs — POST /api/live/diagrams accepts arbitrary IDs. */
const MAX_DIAGRAMS = 50;

export function saveDiagramSpec(input: DiagramSpec, owner: string = PUBLIC_OWNER): void {
  // Diagrams generated from Azure are measured with the current binding table (a copy saved in a browser may be
  // older); the sample diagram keeps its own
  const spec = input.id.startsWith("auto-") ? normalizeSpecBindings(input) : input;
  const key = storeKey(owner, spec.id);
  diagramStore.delete(key);
  diagramStore.set(key, spec);
  // Evict least-recently-saved diagrams, keeping the first (seed) entry
  const seedKey = diagramStore.keys().next().value;
  for (const k of diagramStore.keys()) {
    if (diagramStore.size <= MAX_DIAGRAMS) break;
    if (k === seedKey || k === key) continue;
    diagramStore.delete(k);
    sparklineBuffers.forEach((_v, b) => {
      if (b.startsWith(`${k}:`)) sparklineBuffers.delete(b);
    });
  }
}

/** The caller's own diagram, else a public sample with that id */
export function getDiagramSpec(id: string, owner: string = PUBLIC_OWNER): DiagramSpec | undefined {
  return diagramStore.get(storeKey(owner, id)) ?? diagramStore.get(storeKey(PUBLIC_OWNER, id));
}

export function listDiagramSpecs(owner: string = PUBLIC_OWNER): Array<{ id: string; name: string; updatedAt: string }> {
  return [...diagramStore.entries()]
    .filter(([k]) => k.startsWith(`${owner}|`) || k.startsWith(`${PUBLIC_OWNER}|`))
    .map(([, d]) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt }));
}

// ────────────────────────────────────────────
// Snapshot Assembly
// ────────────────────────────────────────────

export async function buildLiveSnapshot(
  env: Env,
  bearerToken: string | undefined,
  diagramId: string,
): Promise<LiveDiagramSnapshot | null> {
  const spec = getDiagramSpec(diagramId, diagramOwner(bearerToken));
  if (!spec) return null;

  // Check cache
  if (bearerToken) {
    const prefix = bearerKeyPrefix(bearerToken);
    const cacheKey = `${prefix}:snapshot:${diagramId}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached) return cached;
  }

  // Auto-generated diagrams (from "Generate from Azure") should also fetch
  // live data via ARM APIs, even if AZURE_LIVE_DIAGRAM_ENABLED is not set.
  const azureEnabled = env.AZURE_LIVE_DIAGRAM_ENABLED || diagramId.startsWith("auto-");
  const hasBearerToken = bearerToken != null;

  // ── Collect node metrics from Azure Monitor ──
  let nodeMetricsMap = new Map<string, Record<string, number | null>>();
  let resolvedBindings = 0;
  let failedBindings = 0;
  // Per-source state, so the page can say why something is empty (sign in / not configured / failed)
  let metricsState: LiveSourceState = !azureEnabled ? "disabled" : !hasBearerToken ? "signin" : "ok";

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
      metricsState = "failed";
    }
  }

  // ── Collect edge metrics (monitor-source bindings) ──
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  let edgeMonitorMetrics = new Map<string, Record<string, number | null>>();

  if (azureEnabled && hasBearerToken) {
    // The queried end: `node: "target"` on a binding (Internet → public LB reads the LB), the source otherwise
    const queried = (e: (typeof spec.edges)[number]) => nodeById.get(Object.values(e.bindings).some((b) => b.node === "target") ? e.target : e.source);
    const edgeItems = spec.edges
      .filter((e) => queried(e)?.azureResourceId && Object.values(e.bindings).some((b) => b.source === "monitor"))
      .map((e) => ({ edge: e, node: queried(e)! }));

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
  let alertRules: AlertRuleInfo[] = [];
  let alertsState: LiveSourceState = !azureEnabled ? "disabled" : !hasBearerToken ? "signin" : "ok";

  if (azureEnabled && hasBearerToken) {
    const edgeMap = new Map(spec.edges.map((e) => [e.id, { source: e.source, target: e.target }]));
    try {
      liveAlerts = await collectDiagramAlerts(env, bearerToken!, spec.nodes, edgeMap);
    } catch {
      alertsState = "failed";
    }
    try {
      alertRules = await collectAlertRules(env, bearerToken!, spec.nodes);
    } catch {
      // Non-critical
    }
  }

  // ── Collect PowerState for compute resources ──
  let powerStateMap = new Map<string, PowerState>();

  if (azureEnabled) {
    // Use SP fallback when no bearer token — collectBatchPowerStates handles undefined
    const computeNodes = spec.nodes
      .filter((n) => n.azureResourceId && n.resourceKind)
      .map((n) => ({ azureResourceId: n.azureResourceId!, resourceKind: n.resourceKind! }));
    if (computeNodes.length > 0) {
      try {
        powerStateMap = await collectBatchPowerStates(env, bearerToken, computeNodes);
      } catch {
        // Non-critical
      }
    }

    // No default: a power state that was not collected stays unknown (LB / App Gateway / PaaS have none,
    // and an assumed "running" painted cards green without evidence)
  }

  // ── Collect Traffic Flow Data (multi-source) ──
  // These collectors use SP fallback — no bearer token required.
  const trafficFlowData = await collectAllTrafficSources(env, bearerToken, spec, azureEnabled);

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

  // ── Build live nodes (skip group/container nodes — they don't have metrics) ──
  const now = new Date().toISOString();
  const resourceNodeSpecs = spec.nodes.filter((n) => n.nodeType !== "group");

  const liveNodes: LiveNode[] = resourceNodeSpecs.map((nodeSpec) => {
    const metrics = nodeMetricsMap.get(nodeSpec.azureResourceId ?? "") ?? {};
    // VM availability is judged only while the VM is meant to run (a stopped VM is "unavailable" by design)
    const running = powerStateMap.get(nodeSpec.azureResourceId ?? "") === "running";
    const forHealth = !running && "vmAvail" in metrics ? Object.fromEntries(Object.entries(metrics).filter(([k]) => k !== "vmAvail")) : metrics;
    const { health, score } = resolveNodeHealth(forHealth, nodeSpec.bindings);

    // ── Sparkline ring buffers: one series per (node, metric) so different metrics never mix ──
    // Every measured metric keeps its own trend (card: CPU and memory, panel: each metric row)
    const bufferKey = `${diagramId}:${nodeSpec.id}:${findPrimaryMetricName(metrics) ?? "primary"}`;
    const sparklines: Record<string, SparklineData> = {};

    for (const [metricName, value] of Object.entries(metrics)) {
      if (value == null) continue;
      const key = `${diagramId}:${nodeSpec.id}:${metricName}`;
      let buf = sparklineBuffers.get(key);
      if (!buf) {
        buf = { values: [], timestamps: [] };
        sparklineBuffers.set(key, buf);
      }
      buf.values.push(value);
      buf.timestamps.push(now);

      // Ring buffer: keep last SPARKLINE_MAX_LEN entries
      if (buf.values.length > SPARKLINE_MAX_LEN) {
        buf.values = buf.values.slice(-SPARKLINE_MAX_LEN);
        buf.timestamps = buf.timestamps.slice(-SPARKLINE_MAX_LEN);
      }
      sparklines[metricName] = {
        values: [...buf.values],
        timestamps: [...buf.timestamps],
        metric: metricName,
      };
    }

    const powerState = powerStateMap.get(nodeSpec.azureResourceId ?? "") as PowerState | undefined;

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
      powerState,
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

  // Only measured values reach the page. (A former fallback invented 2–22 Mbps per edge when nothing was
  // measured — it drove particles, widths and the edge panel with numbers that were not real.)
  const isMeasured = (m: LiveEdge["metrics"]) => Object.values(m).some((v) => v != null);

  const liveEdges: LiveEdge[] = rawEdges.map(({ id, edgeMetrics }) => {
    const measured = isMeasured(edgeMetrics);
    return {
      id,
      status: measured ? resolveEdgeStatus(edgeMetrics) : "normal",
      metrics: measured ? edgeMetrics : {},
      trafficLevel: measured ? resolveTrafficLevel(edgeMetrics.throughputBps) : "none",
      activeAlertIds: edgeAlertIds.get(id) ?? [],
      ...(measured ? { metricsSource: "measured" as const } : {}),
    };
  });

  // ── Fault impact detection ──
  const faultImpacts: FaultImpact[] = buildFaultImpacts(liveNodes, spec.edges, liveAlerts);

  // ── Coverage: how much of this picture is measured ──
  // Resources with a metric binding, and how many of them returned a value (numerator ⊆ denominator)
  const boundIds = new Set(resourceNodeSpecs.filter((n) => Object.values(n.bindings).some((b) => b.source !== "composite")).map((n) => n.id));
  const nodesWithBindings = boundIds.size;
  const configuredEdges = spec.edges.filter((e) => e.edgeKind !== "inferred" && e.evidence !== "inferred").length;
  const edgesWithTraffic = liveEdges.filter((e) => e.metricsSource === "measured").length;
  const nodesWithMetrics = liveNodes.filter((n) => boundIds.has(n.id) && Object.values(n.metrics).some((v) => v != null)).length;
  if (metricsState === "ok" && nodesWithMetrics === 0) metricsState = "empty";
  const coverage: LiveCoverage = {
    nodesWithMetrics,
    nodesWithBindings,
    edgesWithTraffic,
    configuredEdges,
    sources: {
      metrics: metricsState,
      traffic: !azureEnabled ? "disabled" : !hasBearerToken && edgesWithTraffic === 0 ? "signin" : edgesWithTraffic > 0 ? "ok" : "empty",
      alerts: alertsState,
    },
  };

  const snapshot: LiveDiagramSnapshot = {
    diagramId,
    generatedAt: now,
    refreshIntervalSec: spec.settings.refreshIntervalSec,
    nodes: liveNodes,
    edges: liveEdges,
    alerts: liveAlerts,
    alertRules: alertRules.length > 0 ? alertRules : undefined,
    topology: {
      nodeCount: resourceNodeSpecs.length,
      edgeCount: spec.edges.length,
      resolvedBindings,
      failedBindings,
    },
    faultImpacts: faultImpacts.length > 0 ? faultImpacts : undefined,
    dataSource: "azure",
    coverage,
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
  enabled: boolean,
): Promise<TrafficFlowResult> {
  const result: TrafficFlowResult = {
    traffic: new Map(),
    nsgFlows: new Map(),
    dependencies: new Map(),
    connectionMonitor: new Map(),
  };

  if (!enabled) return result;

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

/** Configured links an impact may travel along. Guessed (inferred), Internet and NAT-association links never carry it. */
const IMPACT_EDGE_KINDS = new Set(["network", "routes", "privateLink", "peering"]);

/**
 * A resource whose metric health is critical, or that has an active critical Azure Monitor alert, and the
 * resources one configured hop away. "Affected" means impact is possible — it is not confirmed.
 */
export function buildFaultImpacts(
  liveNodes: LiveNode[],
  edgeSpecs: DiagramSpec["edges"],
  alerts: LiveAlert[] = [],
): FaultImpact[] {
  const criticalAlertNodes = new Set(alerts.filter((a) => a.severity === "critical").flatMap((a) => a.affectedNodeIds));
  const sources = liveNodes
    .map((n) => (n.health === "critical" ? { id: n.id, trigger: "metric" as const } : criticalAlertNodes.has(n.id) ? { id: n.id, trigger: "alert" as const } : null))
    .filter((x): x is { id: string; trigger: "metric" | "alert" } => x !== null);
  const links = edgeSpecs.filter((e) => e.evidence !== "inferred" && (e.edgeKind == null || IMPACT_EDGE_KINDS.has(e.edgeKind)));

  return sources.map(({ id, trigger }) => {
    const touching = links.filter((e) => e.source === id || e.target === id);
    return {
      sourceNodeId: id,
      severity: "critical",
      trigger,
      affectedNodeIds: [...new Set(touching.map((e) => (e.source === id ? e.target : e.source)))].filter((x) => x !== id),
      affectedEdgeIds: touching.map((e) => e.id),
    };
  });
}
