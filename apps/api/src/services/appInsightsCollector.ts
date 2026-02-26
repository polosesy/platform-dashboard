import type { Env } from "../env";
import type { MetricBinding, MetricAggregation } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Application Insights Metrics Collector
//
// Fetches App Insights metrics via the ARM-based
// Metrics API, reusing OBO token infrastructure.
// Used for edge bindings with source: "appInsights"
// (e.g. requests/failed, dependencies/duration).
// ────────────────────────────────────────────

const appInsightsCache = new CacheManager<Record<string, number | null>>(100, 60_000);

type AppInsightsMetricResponse = {
  value?: Array<{
    name: { value: string };
    timeseries?: Array<{
      data?: Array<{
        timeStamp: string;
        average?: number;
        maximum?: number;
        minimum?: number;
        total?: number;
        count?: number;
      }>;
    }>;
  }>;
};

// Map App Insights SDK-style names to ARM metric names
const METRIC_NAME_MAP: Record<string, string> = {
  "requests/failed": "requests/failed",
  "requests/count": "requests/count",
  "requests/duration": "requests/duration",
  "dependencies/duration": "dependencies/duration",
  "dependencies/failed": "dependencies/failed",
  "dependencies/count": "dependencies/count",
  "exceptions/count": "exceptions/count",
  "performanceCounters/requestsPerSecond": "performanceCounters/requestsPerSecond",
};

function resolveMetricName(input: string): string {
  return METRIC_NAME_MAP[input] ?? input;
}

function aggToParam(agg: MetricAggregation): string {
  switch (agg) {
    case "avg": return "avg";
    case "max": return "max";
    case "min": return "min";
    case "total": return "sum";
    case "count": return "count";
    case "rate": return "count";
    case "p50": return "avg";
    case "p95": return "avg";
    case "p99": return "max";
    default: return "avg";
  }
}

function pickValue(
  data: NonNullable<NonNullable<AppInsightsMetricResponse["value"]>[0]["timeseries"]>[0]["data"],
  agg: MetricAggregation,
): number | null {
  if (!data || data.length === 0) return null;
  const last = data[data.length - 1]!;
  switch (agg) {
    case "avg": case "p50": case "p95": return last.average ?? null;
    case "max": case "p99": return last.maximum ?? null;
    case "min": return last.minimum ?? null;
    case "total": return last.total ?? null;
    case "count": return last.count ?? null;
    case "rate": return last.count != null ? last.count / 60 : null;
    default: return last.average ?? null;
  }
}

/**
 * Fetch App Insights metrics for edge bindings.
 *
 * Uses the ARM Metrics API against the App Insights resource:
 *   GET /providers/microsoft.insights/metrics?metricnames=...
 *
 * `appInsightsResourceId` is the full ARM resource ID of the
 * Application Insights resource (not the app GUID).
 */
export async function collectAppInsightsMetrics(
  env: Env,
  bearerToken: string,
  appInsightsResourceId: string,
  bindings: Record<string, MetricBinding>,
): Promise<Record<string, number | null>> {
  const prefix = bearerKeyPrefix(bearerToken);
  const bindingKeys = Object.keys(bindings).sort().join(",");
  const cacheKey = `${prefix}:appinsights:${appInsightsResourceId}:${bindingKeys}`;
  const cached = appInsightsCache.get(cacheKey);
  if (cached) return cached;

  const appInsightsBindings = Object.entries(bindings).filter(
    ([, b]) => b.source === "appInsights" && b.metric,
  );
  if (appInsightsBindings.length === 0) return {};

  const metricNames = [...new Set(appInsightsBindings.map(([, b]) => resolveMetricName(b.metric!)))];
  const aggregations = [...new Set(appInsightsBindings.map(([, b]) => aggToParam(b.aggregation ?? "avg")))];

  const fetcher = await getArmFetcher(env, bearerToken);

  // App Insights metrics via ARM API
  const url =
    `https://management.azure.com${appInsightsResourceId}` +
    `/providers/microsoft.insights/metrics` +
    `?api-version=2024-02-01` +
    `&metricnames=${metricNames.join(",")}` +
    `&timespan=PT5M` +
    `&interval=PT1M` +
    `&aggregation=${aggregations.join(",")}`;

  const resp = await fetcher.fetchJson<AppInsightsMetricResponse>(url);

  const result: Record<string, number | null> = {};
  for (const [key, binding] of appInsightsBindings) {
    const metricName = resolveMetricName(binding.metric!);
    const metric = resp.value?.find((v) => v.name.value === metricName);
    const data = metric?.timeseries?.[0]?.data;
    result[key] = pickValue(data, binding.aggregation ?? "avg");
  }

  appInsightsCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve the App Insights resource ID for a given node.
 * Strategy: look up linked App Insights via the node's azureResourceId
 * resource group, or use the env-configured default.
 */
export function resolveAppInsightsResourceId(
  env: Env,
  nodeResourceId?: string,
): string | null {
  // If env provides a specific App Insights app ID, construct the resource ID
  if (env.AZURE_APP_INSIGHTS_APP_ID && nodeResourceId) {
    // Extract subscription + resource group from the node resource ID
    const match = nodeResourceId.match(
      /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)/i,
    );
    if (match) {
      const [, subId, rgName] = match;
      return `/subscriptions/${subId}/resourceGroups/${rgName}/providers/microsoft.insights/components/${env.AZURE_APP_INSIGHTS_APP_ID}`;
    }
  }
  return null;
}
