import type { Env } from "../env";
import type {
  ObservabilityOverview,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
  ObservabilityDataSourceStatus,
  WorkloadHealth,
} from "@aud/types";
import { collectWorkloadHealth, collectNodeHealth } from "./containerInsightsCollector";
import { collectAppInsightsApm } from "./appInsightsApmCollector";

// ──────────────────────────────────────────────────────────────
// Observability Aggregator
//
// Combines Container Insights + App Insights (+ future Prometheus)
// into unified ObservabilityOverview / Workloads / Nodes responses.
// ──────────────────────────────────────────────────────────────

function buildDataSourceStatus(
  containerInsights: boolean,
  prometheus: boolean,
  appInsights: boolean,
): ObservabilityDataSourceStatus {
  return { containerInsights, prometheus, appInsights };
}

export async function getObservabilityOverview(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  clusterName: string,
): Promise<ObservabilityOverview> {
  const [workloadResult, nodeResult] = await Promise.allSettled([
    collectWorkloadHealth(env, bearerToken, clusterId),
    collectNodeHealth(env, bearerToken, clusterId),
  ]);

  const { workloads, containerInsightsAvailable: ciWorkloads } =
    workloadResult.status === "fulfilled"
      ? workloadResult.value
      : { workloads: [], containerInsightsAvailable: false };

  const { nodes, containerInsightsAvailable: ciNodes } =
    nodeResult.status === "fulfilled"
      ? nodeResult.value
      : { nodes: [], containerInsightsAvailable: false };

  const containerInsightsAvailable = ciWorkloads || ciNodes;
  const appInsightsConfigured = !!env.AZURE_APP_INSIGHTS_APP_ID;
  console.log(`[observability] overview: CI=${containerInsightsAvailable} workloads=${workloads.length} nodes=${nodes.length} cluster=${clusterId}`);

  // Enrich workloads with APM data if App Insights is configured
  const enrichedWorkloads = appInsightsConfigured
    ? await enrichWithApm(env, bearerToken, workloads)
    : workloads;

  const podSummary = enrichedWorkloads.reduce(
    (acc, w) => ({
      total: acc.total + w.pods.total,
      running: acc.running + w.pods.running,
      pending: acc.pending + w.pods.pending,
      failed: acc.failed + w.pods.failed,
    }),
    { total: 0, running: 0, pending: 0, failed: 0 },
  );

  const nodeSummary = {
    total: nodes.length,
    ready: nodes.filter((n) => n.status === "Ready").length,
    notReady: nodes.filter((n) => n.status !== "Ready").length,
  };

  // Top alerting workloads: sort by error rate desc, then by failed pod count
  const topAlertingWorkloads = [...enrichedWorkloads]
    .filter((w) => w.pods.failed > 0 || (w.apm?.errorRate ?? 0) > 0)
    .sort((a, b) => {
      const aScore = (a.apm?.errorRate ?? 0) * 100 + a.pods.failed;
      const bScore = (b.apm?.errorRate ?? 0) * 100 + b.pods.failed;
      return bScore - aScore;
    })
    .slice(0, 5);

  return {
    clusterId,
    clusterName,
    generatedAt: new Date().toISOString(),
    dataSourceStatus: buildDataSourceStatus(
      containerInsightsAvailable,
      !!env.AZURE_PROMETHEUS_ENDPOINT, // Phase 2 — endpoint 설정 시 활성
      appInsightsConfigured,
    ),
    nodeSummary,
    podSummary,
    topAlertingWorkloads,
  };
}

export async function getObservabilityWorkloads(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<ObservabilityWorkloadsResponse> {
  const { workloads, containerInsightsAvailable } = await collectWorkloadHealth(env, bearerToken, clusterId).catch(
    () => ({ workloads: [], containerInsightsAvailable: false }),
  );

  const appInsightsConfigured = !!env.AZURE_APP_INSIGHTS_APP_ID;
  const enriched = appInsightsConfigured
    ? await enrichWithApm(env, bearerToken, workloads)
    : workloads;

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    dataSourceStatus: buildDataSourceStatus(containerInsightsAvailable, false, appInsightsConfigured),
    workloads: enriched,
  };
}

export async function getObservabilityNodes(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<ObservabilityNodesResponse> {
  const { nodes, containerInsightsAvailable } = await collectNodeHealth(env, bearerToken, clusterId).catch(
    () => ({ nodes: [], containerInsightsAvailable: false }),
  );

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    dataSourceStatus: buildDataSourceStatus(containerInsightsAvailable, false, !!env.AZURE_APP_INSIGHTS_APP_ID),
    nodes,
  };
}

// ── Enrich workloads with APM metrics from App Insights ──

async function enrichWithApm(
  env: Env,
  bearerToken: string | undefined,
  workloads: WorkloadHealth[],
): Promise<WorkloadHealth[]> {
  if (workloads.length === 0) return workloads;
  try {
    const apmMap = await collectAppInsightsApm(env, bearerToken);
    return workloads.map((wl) => {
      const apm = apmMap.get(`${wl.namespace}/${wl.name}`) ?? apmMap.get(wl.name);
      return apm ? { ...wl, apm } : wl;
    });
  } catch {
    return workloads;
  }
}
