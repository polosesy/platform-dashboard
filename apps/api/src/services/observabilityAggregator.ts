import type { Env } from "../env.js";
import type {
  ObservabilityOverview,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
  ObservabilityDataSourceStatus,
  WorkloadHealth,
  NodeResourceSummary,
} from "@aud/types";
import { collectWorkloadHealth, collectNodeHealth } from "./containerInsightsCollector.js";
import { collectAppInsightsApm } from "./appInsightsApmCollector.js";
import { collectPrometheusWorkloadMetrics, collectPrometheusNodeMetrics, resolvePrometheusEndpoint } from "./prometheusCollector.js";
import { fetchAksNodeInfoMap, listAllNamespacePods } from "./kubernetes.js";
import { debug } from "../infra/logger.js";

// ──────────────────────────────────────────────────────────────
// Observability Aggregator
//
// Combines Container Insights + Managed Prometheus + App Insights
// into unified ObservabilityOverview / Workloads / Nodes responses.
// Node list falls back to the Kubernetes API when Container Insights
// does not collect KubeNodeInventory (e.g. logs-only collection profiles).
// ──────────────────────────────────────────────────────────────

type NodeIpIndex = Map<string, string>; // private IP → node name

/**
 * Node list from the Kubernetes API, used when Container Insights returned no
 * nodes. Without it, Prometheus node metrics had nothing to attach to and the
 * Infrastructure tab stayed empty even though Prometheus was available.
 */
async function nodesFromKubernetesApi(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<{ nodes: NodeResourceSummary[]; ipIndex: NodeIpIndex }> {
  const ipIndex: NodeIpIndex = new Map();
  if (!clusterId.toLowerCase().startsWith("/subscriptions/")) return { nodes: [], ipIndex };
  try {
    const [info, podsResult] = await Promise.all([
      fetchAksNodeInfoMap(env, bearerToken, clusterId),
      listAllNamespacePods(env, bearerToken, clusterId).catch(() => null),
    ]);
    const podsPerNode = new Map<string, number>();
    for (const p of podsResult?.pods ?? []) {
      if (p.nodeName) podsPerNode.set(p.nodeName, (podsPerNode.get(p.nodeName) ?? 0) + 1);
    }
    const nodes = Object.entries(info).map(([name, n]): NodeResourceSummary => {
      if (n.privateIp) ipIndex.set(n.privateIp, name);
      const ready = n.conditions.find((c) => c.type === "Ready")?.status;
      return {
        name,
        status: ready === "True" ? "Ready" : ready === "False" ? "NotReady" : "Unknown",
        cpuUsagePct: null,
        memoryUsagePct: null,
        cpuCapacityMillicores: null,
        memoryCapacityMiB: null,
        diskUsagePct: null,
        diskCapacityGB: null,
        networkRxBytesPerSec: null,
        networkTxBytesPerSec: null,
        podCount: podsPerNode.get(name) ?? 0,
        conditions: n.conditions.map((c) => ({ type: c.type, status: c.status })),
      };
    });
    return { nodes, ipIndex };
  } catch (e) {
    console.warn("[observability] Kubernetes API node fallback failed:", e instanceof Error ? e.message : e);
    return { nodes: [], ipIndex };
  }
}

/** Container Insights nodes, or the Kubernetes API node list when CI has none. */
async function resolveNodes(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
  ciNodes: NodeResourceSummary[],
): Promise<{ nodes: NodeResourceSummary[]; ipIndex: NodeIpIndex }> {
  if (ciNodes.length > 0) return { nodes: ciNodes, ipIndex: new Map() };
  return nodesFromKubernetesApi(env, bearerToken, clusterId);
}

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

  // CI에 노드 인벤토리가 없으면 Kubernetes API 노드 목록 사용, 이후 Prometheus 메트릭으로 보강
  const resolved = await resolveNodes(env, bearerToken, clusterId, nodes);
  nodes = resolved.nodes;
  if (promNodeResult.status === "fulfilled" && promNodeResult.value.metrics.size > 0) {
    nodes = enrichNodesWithPrometheus(nodes, promNodeResult.value.metrics, resolved.ipIndex);
  }

  debug(`[observability] overview: CI=${containerInsightsAvailable} Prom=${prometheusAvailable} workloads=${workloads.length} nodes=${nodes.length} cluster=${clusterId}`);

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
  const { nodes: baseNodes, ipIndex } = await resolveNodes(env, bearerToken, clusterId, ciNodes);
  const nodes = (promResult.status === "fulfilled" && promResult.value.metrics.size > 0)
    ? enrichNodesWithPrometheus(baseNodes, promResult.value.metrics, ipIndex)
    : baseNodes;

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
  ipIndex: NodeIpIndex = new Map(),
): NodeResourceSummary[] {
  // Prometheus 시리즈는 node 이름(`node` 라벨) 또는 IP(`instance` 라벨)로 키를 가짐 — 둘 다 매칭
  const byNodeName = new Map<string, Partial<NodeResourceSummary>>();
  for (const [key, metrics] of promMetrics) {
    const name = ipIndex.get(key) ?? key;
    byNodeName.set(name, { ...byNodeName.get(name), ...metrics });
  }
  for (const node of nodes) {
    const prom = byNodeName.get(node.name);
    if (!prom) continue;
    if (node.cpuUsagePct === null && prom.cpuUsagePct != null) node.cpuUsagePct = prom.cpuUsagePct;
    if (node.memoryUsagePct === null && prom.memoryUsagePct != null) node.memoryUsagePct = prom.memoryUsagePct;
    if (node.diskUsagePct === null && prom.diskUsagePct != null) node.diskUsagePct = prom.diskUsagePct;
    if (node.networkRxBytesPerSec === null && prom.networkRxBytesPerSec != null) node.networkRxBytesPerSec = prom.networkRxBytesPerSec;
    if (node.networkTxBytesPerSec === null && prom.networkTxBytesPerSec != null) node.networkTxBytesPerSec = prom.networkTxBytesPerSec;
  }
  return nodes;
}
