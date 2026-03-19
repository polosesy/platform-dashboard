import type { Env } from "../env";
import type { ApmMetrics } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcherAuto } from "../infra/azureClientFactory";

// ──────────────────────────────────────────────────────────────
// App Insights APM Collector (workload-level)
//
// Fetches per-application APM metrics (request rate, error rate,
// p95 latency) using the App Insights Metrics API.
//
// Returns a map of workloadKey → ApmMetrics for workload enrichment.
// workloadKey is "namespace/name" or just "name" as fallback.
// ──────────────────────────────────────────────────────────────

const apmCache = new CacheManager<Map<string, ApmMetrics>>(10, 60_000);

type AiMetricsResponse = {
  value?: AiMetricValue[];
};

export async function collectAppInsightsApm(
  env: Env,
  bearerToken: string | undefined,
): Promise<Map<string, ApmMetrics>> {
  if (!env.AZURE_APP_INSIGHTS_APP_ID) return new Map();

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:obs:apm:${env.AZURE_APP_INSIGHTS_APP_ID}`;
  const cached = apmCache.get(cacheKey);
  if (cached) return cached;

  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);

    // We query global App Insights for aggregate metrics.
    // Phase 2: multi-resource query or cloud_RoleName dimension for per-service breakdown.
    const appInsightsPath = resolveAppInsightsPath(env);
    if (!appInsightsPath) return new Map();

    const metrics = [
      "requests/count",
      "requests/failed",
      "requests/duration",
    ].join(",");

    const url =
      `https://management.azure.com${appInsightsPath}` +
      `/providers/microsoft.insights/metrics` +
      `?api-version=2024-02-01` +
      `&metricnames=${metrics}` +
      `&timespan=PT5M` +
      `&interval=PT5M` +
      `&aggregation=avg,count,total`;

    const resp = await fetcher.fetchJson<AiMetricsResponse>(url);

    const result = buildApmFromResponse(resp);

    // Store as a single "global" entry — workload enrichment uses "global" key
    const map = new Map<string, ApmMetrics>([["__global__", result]]);
    apmCache.set(cacheKey, map);
    return map;
  } catch (err) {
    console.error("[appInsightsApm] error:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

function resolveAppInsightsPath(env: Env): string | null {
  // env.AZURE_APP_INSIGHTS_APP_ID can be:
  //   a) Full ARM resource ID: /subscriptions/.../providers/microsoft.insights/components/...
  //   b) Short component name (requires subscription + RG context — best effort)
  const appId = env.AZURE_APP_INSIGHTS_APP_ID;
  if (!appId) return null;
  if (appId.startsWith("/subscriptions/")) return appId;
  // Can't build ARM path without subscription/RG, return null
  return null;
}

type AiMetricValue = {
  name: { value: string };
  timeseries?: Array<{
    data?: Array<{
      average?: number; total?: number; count?: number;
      percentile_50?: number; percentile_95?: number; percentile_99?: number;
    }>;
  }>;
};

function buildApmFromResponse(resp: { value?: AiMetricValue[] }): ApmMetrics {
  const metrics: Record<string, number | null> = {};

  for (const m of resp.value ?? []) {
    const name = m.name?.value;
    const data = m.timeseries?.[0]?.data;
    if (!name || !data || data.length === 0) continue;
    const last = data[data.length - 1]!;
    if (name === "requests/count") metrics.reqCount = last.count ?? last.total ?? null;
    if (name === "requests/failed") metrics.failCount = last.count ?? last.total ?? null;
    if (name === "requests/duration") metrics.durationAvg = last.average ?? null;
  }

  const reqCount = metrics.reqCount ?? null;
  const failCount = metrics.failCount ?? null;
  const errorRate = reqCount && reqCount > 0 && failCount !== null
    ? Math.min(1, failCount / reqCount)
    : null;
  const requestsPerSec = reqCount !== null ? reqCount / 300 : null; // 5 min window

  return {
    requestsPerSec,
    errorRate,
    p50Ms: null,       // Basic App Insights API doesn't return percentiles without KQL
    p95Ms: metrics.durationAvg ?? null,  // avg as proxy for p95 when percentiles unavailable
    p99Ms: null,
    activeAlerts: 0,
    source: "appInsights",
  };
}
