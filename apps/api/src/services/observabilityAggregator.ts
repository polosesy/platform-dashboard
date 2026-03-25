import type { Env } from "../env";
import type {
  ObservabilityOverview,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
  ObservabilityDataSourceStatus,
  WorkloadHealth,
  NodeResourceSummary,
} from "@aud/types";
import { collectWorkloadHealth, collectNodeHealth } from "./containerInsightsCollector";
import { collectAppInsightsApm } from "./appInsightsApmCollector";
import { collectPrometheusWorkloadMetrics, collectPrometheusNodeMetrics, resolvePrometheusEndpoint } from "./prometheusCollector";

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
  const [workloadResult, nodeResult, promWlResult, promNodeResult] = await Promise.allSettled([
    collectWorkloadHealth(env, bearerToken, clusterId),
    collectNodeHealth(env, bearerToken, clusterId),
    collectPrometheusWorkloadMetrics(env, bearerToken, clusterId),
    collectPrometheusNodeMetrics(env, bearerToken, clusterId),
  ]);

  const { workloads, containerInsightsAvailable: ciWorkloads } =
    workloadResult.status === "fulfilled"
      ? workloadResult.value
      : { workloads: [], containerInsightsAvailable: false };

  let { nodes, containerInsightsAvailable: ciNodes } =
    nodeResult.status === "fulfilled"
      ? nodeResult.value
      : { nodes: [] as NodeResourceSummary[], containerInsightsAvailable: false };

  const containerInsightsAvailable = ciWorkloads || ciNodes;
  const prometheusAvailable =
    (promWlResult.status === "fulfilled" && promWlResult.value.available) ||
    (promNodeResult.status === "fulfilled" && promNodeResult.value.available);
  const appInsightsConfigured = !!env.AZURE_APP_INSIGHTS_APP_ID;

  // Prometheus 메트릭으로 workload CPU/Mem 보강 (CI 데이터가 없을 때)
  if (promWlResult.status === "fulfilled" && promWlResult.value.metrics.size > 0) {
    enrichWorkloadsWithPrometheus(workloads, promWlResult.value.metrics);
  }

  // Prometheus 메트릭으로 node 보강
  if (promNodeResult.status === "fulfilled" && promNodeResult.value.metrics.size > 0) {
    nodes = enrichNodesWithPrometheus(nodes, promNodeResult.value.metrics);
  }

  console.log(`[observability] overview: CI=${containerInsightsAvailable} Prom=${prometheusAvailable} workloads=${workloads.length} nodes=${nodes.length} cluster=${clusterId}`);

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
      prometheusAvailable,
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
  const [ciResult, promResult] = await Promise.allSettled([
    collectWorkloadHealth(env, bearerToken, clusterId),
    collectPrometheusWorkloadMetrics(env, bearerToken, clusterId),
  ]);

  const { workloads, containerInsightsAvailable } =
    ciResult.status === "fulfilled"
      ? ciResult.value
      : { workloads: [] as WorkloadHealth[], containerInsightsAvailable: false };

  const prometheusAvailable = promResult.status === "fulfilled" && promResult.value.available;
  if (promResult.status === "fulfilled" && promResult.value.metrics.size > 0) {
    enrichWorkloadsWithPrometheus(workloads, promResult.value.metrics);
  }

  const appInsightsConfigured = !!env.AZURE_APP_INSIGHTS_APP_ID;
  const enriched = appInsightsConfigured
    ? await enrichWithApm(env, bearerToken, workloads)
    : workloads;

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    dataSourceStatus: buildDataSourceStatus(containerInsightsAvailable, prometheusAvailable, appInsightsConfigured),
    workloads: enriched,
  };
}

export async function getObservabilityNodes(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<ObservabilityNodesResponse> {
  const [ciResult, promResult] = await Promise.allSettled([
    collectNodeHealth(env, bearerToken, clusterId),
    collectPrometheusNodeMetrics(env, bearerToken, clusterId),
  ]);

  const { nodes: ciNodes, containerInsightsAvailable } =
    ciResult.status === "fulfilled"
      ? ciResult.value
      : { nodes: [] as NodeResourceSummary[], containerInsightsAvailable: false };

  const prometheusAvailable = promResult.status === "fulfilled" && promResult.value.available;
  const nodes = (promResult.status === "fulfilled" && promResult.value.metrics.size > 0)
    ? enrichNodesWithPrometheus(ciNodes, promResult.value.metrics)
    : ciNodes;

  return {
    clusterId,
    generatedAt: new Date().toISOString(),
    dataSourceStatus: buildDataSourceStatus(containerInsightsAvailable, prometheusAvailable, !!env.AZURE_APP_INSIGHTS_APP_ID),
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

// ── Enrich workloads with Prometheus CPU/Memory ──

function enrichWorkloadsWithPrometheus(
  workloads: WorkloadHealth[],
  promMetrics: Map<string, Partial<WorkloadHealth>>,
): void {
  for (const wl of workloads) {
    const key = `${wl.namespace}/${wl.name}`;
    const prom = promMetrics.get(key);
    if (!prom) continue;
    // CI 데이터가 없을 때만 Prometheus로 채움
    if (!wl.cpu && prom.cpu) wl.cpu = prom.cpu as WorkloadHealth["cpu"];
    if (!wl.memory && prom.memory) wl.memory = prom.memory as WorkloadHealth["memory"];
  }
}

// ── Enrich nodes with Prometheus metrics ──

function enrichNodesWithPrometheus(
  nodes: NodeResourceSummary[],
  promMetrics: Map<string, Partial<NodeResourceSummary>>,
): NodeResourceSummary[] {
  // Prometheus는 node 이름 or IP로 키를 가질 수 있음
  for (const node of nodes) {
    const prom = promMetrics.get(node.name);
    if (!prom) continue;
    if (node.cpuUsagePct === null && prom.cpuUsagePct != null) node.cpuUsagePct = prom.cpuUsagePct;
    if (node.memoryUsagePct === null && prom.memoryUsagePct != null) node.memoryUsagePct = prom.memoryUsagePct;
    if (node.diskUsagePct === null && prom.diskUsagePct != null) node.diskUsagePct = prom.diskUsagePct;
    if (node.networkRxBytesPerSec === null && prom.networkRxBytesPerSec != null) node.networkRxBytesPerSec = prom.networkRxBytesPerSec;
    if (node.networkTxBytesPerSec === null && prom.networkTxBytesPerSec != null) node.networkTxBytesPerSec = prom.networkTxBytesPerSec;
  }
  return nodes;
}
