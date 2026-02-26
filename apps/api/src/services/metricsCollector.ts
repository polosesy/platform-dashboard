import type { Env } from "../env";
import type { MetricBinding, MetricAggregation, DiagramEdgeSpec, DiagramNodeSpec } from "@aud/types";
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
