import type { Env } from "../env";
import type { MetricBinding, MetricAggregation, DiagramEdgeSpec, DiagramNodeSpec, PowerState } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Azure Monitor Metrics REST client
// Batch-fetches metrics per resource, CacheManager-backed
// ────────────────────────────────────────────

const metricCache = new CacheManager<Record<string, number | null>>(200, 60_000);
const edgeMetricCache = new CacheManager<Record<string, number | null>>(200, 60_000);

type MonitorTimeseriesValue = {
  timeStamp: string;
  average?: number;
  maximum?: number;
  minimum?: number;
  total?: number;
  count?: number;
};

type MonitorMetricValue = {
  name: { value: string };
  timeseries?: Array<{
    data?: MonitorTimeseriesValue[];
  }>;
};

type MonitorMetricsResponse = {
  value?: MonitorMetricValue[];
};

function pickAggregation(values: MonitorTimeseriesValue[], agg: MetricAggregation): number | null {
  if (values.length === 0) return null;
  const last = values[values.length - 1]!;
  switch (agg) {
    case "avg": return last.average ?? null;
    case "max": return last.maximum ?? null;
    case "min": return last.minimum ?? null;
    case "total": return last.total ?? null;
    case "count": return last.count ?? null;
    case "rate": return last.count != null && last.count > 0 ? last.count / 60 : null;
    default: return last.average ?? null;
  }
}

function monitorAggParam(agg: MetricAggregation): string {
  switch (agg) {
    case "avg": return "Average";
    case "max": return "Maximum";
    case "min": return "Minimum";
    case "total": return "Total";
    case "count": return "Count";
    case "rate": return "Count";
    default: return "Average";
  }
}

/**
 * Fetches Azure Monitor metrics for a single resource.
 * Returns a map of metricName → value.
 */
export async function collectResourceMetrics(
  env: Env,
  bearerToken: string,
  azureResourceId: string,
  bindings: Record<string, MetricBinding>,
): Promise<Record<string, number | null>> {
  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:metrics:${azureResourceId}`;
  const cached = metricCache.get(cacheKey);
  if (cached) return cached;

  // Filter only monitor-source bindings
  const monitorBindings = Object.entries(bindings).filter(
    ([, b]) => b.source === "monitor" && b.metric,
  );
  if (monitorBindings.length === 0) return {};

  const metricNames = [...new Set(monitorBindings.map(([, b]) => b.metric!))];
  const aggregations = [...new Set(monitorBindings.map(([, b]) => monitorAggParam(b.aggregation ?? "avg")))];

  const fetcher = await getArmFetcher(env, bearerToken);
  const url =
    `https://management.azure.com${azureResourceId}` +
    `/providers/microsoft.insights/metrics` +
    `?api-version=2024-02-01` +
    `&metricnames=${metricNames.join(",")}` +
    `&timespan=PT5M` +
    `&interval=PT1M` +
    `&aggregation=${aggregations.join(",")}`;

  const resp = await fetcher.fetchJson<MonitorMetricsResponse>(url);

  const valueByMetricName = new Map<string, MonitorTimeseriesValue[]>();
  for (const mv of resp.value ?? []) {
    const data = mv.timeseries?.[0]?.data ?? [];
    valueByMetricName.set(mv.name.value, data);
  }

  const result: Record<string, number | null> = {};
  for (const [key, binding] of monitorBindings) {
    const data = valueByMetricName.get(binding.metric!) ?? [];
    result[key] = pickAggregation(data, binding.aggregation ?? "avg");
  }

  metricCache.set(cacheKey, result);
  return result;
}

/**
 * Batch collect metrics for multiple resources (parallel with concurrency limit).
 */
export async function collectBatchMetrics(
  env: Env,
  bearerToken: string,
  resources: Array<{ azureResourceId: string; bindings: Record<string, MetricBinding> }>,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 6;
  const results = new Map<string, Record<string, number | null>>();
  const queue = [...resources];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const metrics = await collectResourceMetrics(env, bearerToken, item.azureResourceId, item.bindings);
        results.set(item.azureResourceId, metrics);
      } catch {
        results.set(item.azureResourceId, {});
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

// ────────────────────────────────────────────
// Edge Metric Collection
//
// Resolves edge bindings (source: "monitor") by
// fetching metrics from the edge's source node's
// Azure resource. Maps binding keys to edge metrics
// (throughputBps, latencyMs, errorRate).
// ────────────────────────────────────────────

/**
 * Build a merged binding set for an edge, using the
 * source node's azureResourceId for "monitor" bindings.
 */
export async function collectEdgeMonitorMetrics(
  env: Env,
  bearerToken: string,
  edge: DiagramEdgeSpec,
  sourceNode: DiagramNodeSpec,
): Promise<Record<string, number | null>> {
  const resourceId = sourceNode.azureResourceId;
  if (!resourceId) return {};

  const monitorBindings = Object.entries(edge.bindings).filter(
    ([, b]) => b.source === "monitor" && b.metric,
  );
  if (monitorBindings.length === 0) return {};

  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:edgemetrics:${edge.id}:${resourceId}`;
  const cached = edgeMetricCache.get(cacheKey);
  if (cached) return cached;

  const metricNames = [...new Set(monitorBindings.map(([, b]) => b.metric!))];
  const aggregations = [...new Set(monitorBindings.map(([, b]) => monitorAggParam(b.aggregation ?? "avg")))];

  const fetcher = await getArmFetcher(env, bearerToken);
  const url =
    `https://management.azure.com${resourceId}` +
    `/providers/microsoft.insights/metrics` +
    `?api-version=2024-02-01` +
    `&metricnames=${metricNames.join(",")}` +
    `&timespan=PT5M` +
    `&interval=PT1M` +
    `&aggregation=${aggregations.join(",")}`;

  const resp = await fetcher.fetchJson<MonitorMetricsResponse>(url);

  const valueByMetricName = new Map<string, MonitorTimeseriesValue[]>();
  for (const mv of resp.value ?? []) {
    const data = mv.timeseries?.[0]?.data ?? [];
    valueByMetricName.set(mv.name.value, data);
  }

  const result: Record<string, number | null> = {};
  for (const [key, binding] of monitorBindings) {
    const data = valueByMetricName.get(binding.metric!) ?? [];
    result[key] = pickAggregation(data, binding.aggregation ?? "avg");
  }

  edgeMetricCache.set(cacheKey, result);
  return result;
}

/**
 * Batch collect edge monitor metrics (parallel with concurrency limit).
 */
export async function collectBatchEdgeMetrics(
  env: Env,
  bearerToken: string,
  items: Array<{ edge: DiagramEdgeSpec; sourceNode: DiagramNodeSpec }>,
): Promise<Map<string, Record<string, number | null>>> {
  const CONCURRENCY = 6;
  const results = new Map<string, Record<string, number | null>>();
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const metrics = await collectEdgeMonitorMetrics(env, bearerToken, item.edge, item.sourceNode);
        results.set(item.edge.id, metrics);
      } catch {
        results.set(item.edge.id, {});
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

// ────────────────────────────────────────────
// PowerState Collection
//
// Fetches instance power state for compute resources
// (VM, VMSS, AKS, Container App, Function App, App Service).
// Uses ARM instanceView or properties.powerState/state.
// ────────────────────────────────────────────

const powerStateCache = new CacheManager<PowerState>(200, 120_000);

const POWER_STATE_RESOURCE_KINDS = new Set([
  "vm", "vmss", "aks", "containerApp", "functionApp", "appService",
  "postgres", "sql", "redis", "cosmosDb", "storage", "keyVault",
]);

function parsePowerState(code: string): PowerState {
  const lower = code.toLowerCase();
  // Compute states
  if (lower.includes("running")) return "running";
  if (lower.includes("deallocat")) return "deallocated";
  if (lower.includes("stopped")) return "stopped";
  if (lower.includes("starting")) return "starting";
  if (lower.includes("stopping")) return "stopping";
  // PaaS operational states
  if (lower === "ready" || lower === "online" || lower === "succeeded" || lower === "available") return "running";
  if (lower === "disabled" || lower === "offline" || lower === "paused" || lower === "dropped") return "stopped";
  if (lower === "creating" || lower === "resuming" || lower === "updating") return "starting";
  if (lower === "deleting" || lower === "pausing" || lower === "scaling") return "stopping";
  return "unknown";
}

async function collectResourcePowerState(
  env: Env,
  bearerToken: string,
  azureResourceId: string,
  resourceKind: string,
): Promise<PowerState> {
  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:powerstate:${azureResourceId}`;
  const cached = powerStateCache.get(cacheKey);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  let state: PowerState = "unknown";

  try {
    if (resourceKind === "vm") {
      const resp = await fetcher.fetchJson<{
        statuses?: Array<{ code: string }>;
      }>(`https://management.azure.com${azureResourceId}/instanceView?api-version=2024-07-01`);
      const psStatus = resp.statuses?.find((s) => s.code.startsWith("PowerState/"));
      if (psStatus) state = parsePowerState(psStatus.code);
    } else if (resourceKind === "vmss") {
      const resp = await fetcher.fetchJson<{
        statuses?: Array<{ code: string }>;
      }>(`https://management.azure.com${azureResourceId}/instanceView?api-version=2024-07-01`);
      const psStatus = resp.statuses?.find((s) => s.code.startsWith("PowerState/"));
      if (psStatus) state = parsePowerState(psStatus.code);
    } else if (resourceKind === "aks") {
      const resp = await fetcher.fetchJson<{
        properties?: { powerState?: { code: string } };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-09-01`);
      const code = resp.properties?.powerState?.code;
      if (code) state = parsePowerState(code);
    } else if (resourceKind === "containerApp") {
      const resp = await fetcher.fetchJson<{
        properties?: { runningStatus?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-03-01`);
      const rs = resp.properties?.runningStatus;
      if (rs) state = parsePowerState(rs);
    } else if (resourceKind === "functionApp" || resourceKind === "appService") {
      const resp = await fetcher.fetchJson<{
        properties?: { state?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-12-01`);
      const s = resp.properties?.state;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "postgres") {
      const resp = await fetcher.fetchJson<{
        properties?: { state?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2022-12-01`);
      const s = resp.properties?.state;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "sql") {
      const resp = await fetcher.fetchJson<{
        properties?: { status?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2021-11-01`);
      const s = resp.properties?.status;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "redis") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-08-01`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "cosmosDb") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2024-02-15-preview`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "storage") {
      const resp = await fetcher.fetchJson<{
        properties?: { statusOfPrimary?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-05-01`);
      const s = resp.properties?.statusOfPrimary;
      if (s) state = parsePowerState(s);
    } else if (resourceKind === "keyVault") {
      const resp = await fetcher.fetchJson<{
        properties?: { provisioningState?: string };
      }>(`https://management.azure.com${azureResourceId}?api-version=2023-07-01`);
      const s = resp.properties?.provisioningState;
      if (s) state = parsePowerState(s);
    }
  } catch {
    // Non-critical — return "unknown"
  }

  powerStateCache.set(cacheKey, state);
  return state;
}

/**
 * Batch collect power states for compute resources (parallel with concurrency limit).
 */
export async function collectBatchPowerStates(
  env: Env,
  bearerToken: string,
  nodes: Array<{ azureResourceId: string; resourceKind: string }>,
): Promise<Map<string, PowerState>> {
  const CONCURRENCY = 6;
  const targets = nodes.filter(
    (n) => n.azureResourceId && POWER_STATE_RESOURCE_KINDS.has(n.resourceKind),
  );

  const results = new Map<string, PowerState>();
  const queue = [...targets];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const state = await collectResourcePowerState(env, bearerToken, item.azureResourceId, item.resourceKind);
        results.set(item.azureResourceId, state);
      } catch {
        results.set(item.azureResourceId, "unknown");
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}
