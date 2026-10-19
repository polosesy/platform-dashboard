import type { Env } from "../env.js";
import type { WorkloadHealth, ResourceUsage, NodeResourceSummary } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto, getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import { debug } from "../infra/logger.js";
import { clusterMonitorAccounts, prometheusQueryEndpoint } from "./clusterMonitoring.js";

// ──────────────────────────────────────────────────────────────
// Azure Managed Prometheus Collector
//
// Queries Azure Monitor Workspace (Prometheus endpoint) for
// workload/node metrics via standard PromQL.
//
// Auto-discovers the query endpoint from the AKS cluster's
// Azure Monitor Profile → Data Collection Rule → Azure Monitor Workspace.
// Falls back to AZURE_PROMETHEUS_ENDPOINT env variable.
// ──────────────────────────────────────────────────────────────

type PromQueryResult = {
  status: string;
  data?: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      value?: [number, string];         // instant query
      values?: Array<[number, string]>; // range query
    }>;
  };
  error?: string;
  errorType?: string;
};

const endpointCache = new CacheManager<string>(10, 10 * 60_000); // 10min TTL
const promWorkloadCache = new CacheManager<Map<string, Partial<WorkloadHealth>>>(5, 60_000);
const promNodeCache = new CacheManager<Map<string, Partial<NodeResourceSummary>>>(5, 60_000);

// ── Auto-discover Prometheus query endpoint ──

export async function resolvePrometheusEndpoint(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<string | null> {
  // 1) 명시적 환경변수 우선
  if (env.AZURE_PROMETHEUS_ENDPOINT) {
    return env.AZURE_PROMETHEUS_ENDPOINT;
  }

  // 2) AKS 클러스터 ARM → Azure Monitor workspace → Prometheus query endpoint
  if (!clusterId || !clusterId.toLowerCase().startsWith("/subscriptions/")) {
    return null;
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:prom-ep:${clusterId.toLowerCase()}`;
  const cached = endpointCache.get(cacheKey);
  if (cached) return cached;

  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    // The cluster's own workspace(s) — DCR associations → rules → monitoring accounts (clusterMonitoring.ts).
    // Several: the first that has a query endpoint (sorted ids — deterministic); none → no Prometheus, never another
    // environment's workspace from the same subscription.
    const accounts = await clusterMonitorAccounts(fetcher, clusterId);
    debug(`[prometheus] ${accounts.length} Azure Monitor workspace(s) associated with the cluster`);
    for (const id of accounts) {
      const ep = await prometheusQueryEndpoint(fetcher, id).catch(() => null);
      if (ep) {
        endpointCache.set(cacheKey, ep);
        return ep;
      }
    }
    debug("[prometheus] no associated workspace with a query endpoint");
    return null;
  } catch (err) {
    debug(`[prometheus] endpoint resolve error: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`);
    return null;
  }
}

// ── Workload metrics via PromQL ──

export async function collectPrometheusWorkloadMetrics(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<{ metrics: Map<string, Partial<WorkloadHealth>>; available: boolean }> {
  const endpoint = await resolvePrometheusEndpoint(env, bearerToken, clusterId);
  if (!endpoint) {
    return { metrics: new Map(), available: false };
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:prom:workloads:${endpoint}`;
  const cached = promWorkloadCache.get(cacheKey);
  if (cached) return { metrics: cached, available: true };

  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken);
    const result = new Map<string, Partial<WorkloadHealth>>();

    // CPU usage per workload (namespace/workload)
    const cpuQuery = `
sum by (namespace, pod) (
  rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])
) * 1000`;

    // Memory usage per workload
    const memQuery = `
sum by (namespace, pod) (
  container_memory_working_set_bytes{container!="", container!="POD"}
) / 1024 / 1024`;

    const [cpuResp, memResp] = await Promise.allSettled([
      fetcher.query(endpoint, cpuQuery) as Promise<PromQueryResult>,
      fetcher.query(endpoint, memQuery) as Promise<PromQueryResult>,
    ]);

    // Parse CPU
    if (cpuResp.status === "fulfilled" && cpuResp.value.data?.result) {
      for (const r of cpuResp.value.data.result) {
        const ns = r.metric.namespace ?? "";
        const pod = r.metric.pod ?? "";
        if (!ns || !pod) continue;
        // pod → workload name (strip RS hash suffix)
        const workload = podToWorkloadName(pod);
        const key = `${ns}/${workload}`;
        const val = parseFloat(r.value?.[1] ?? "0");
        if (!result.has(key)) result.set(key, { namespace: ns, name: workload });
        const existing = result.get(key)!;
        const prevCpu = existing.cpu?.usageRaw ?? 0;
        existing.cpu = {
          usageRaw: Math.round(prevCpu + val),
          usagePct: 0, // limit 없으면 0
          limitRaw: null,
          requestRaw: null,
        };
      }
    }

    // Parse Memory
    if (memResp.status === "fulfilled" && memResp.value.data?.result) {
      for (const r of memResp.value.data.result) {
        const ns = r.metric.namespace ?? "";
        const pod = r.metric.pod ?? "";
        if (!ns || !pod) continue;
        const workload = podToWorkloadName(pod);
        const key = `${ns}/${workload}`;
        const val = parseFloat(r.value?.[1] ?? "0");
        if (!result.has(key)) result.set(key, { namespace: ns, name: workload });
        const existing = result.get(key)!;
        const prevMem = existing.memory?.usageRaw ?? 0;
        existing.memory = {
          usageRaw: Math.round(prevMem + val),
          usagePct: 0,
          limitRaw: null,
          requestRaw: null,
        };
      }
    }

    debug(`[prometheus] workload metrics: ${result.size} workloads from ${endpoint}`);
    promWorkloadCache.set(cacheKey, result);
    return { metrics: result, available: true };
  } catch (err) {
    console.error("[prometheus] workload metrics error:", err instanceof Error ? err.message : err);
    return { metrics: new Map(), available: false };
  }
}

// ── Node metrics via PromQL ──

export async function collectPrometheusNodeMetrics(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<{ metrics: Map<string, Partial<NodeResourceSummary>>; available: boolean }> {
  const endpoint = await resolvePrometheusEndpoint(env, bearerToken, clusterId);
  if (!endpoint) {
    return { metrics: new Map(), available: false };
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:prom:nodes:${endpoint}`;
  const cached = promNodeCache.get(cacheKey);
  if (cached) return { metrics: cached, available: true };

  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken);
    const result = new Map<string, Partial<NodeResourceSummary>>();

    // node-exporter series carry `instance` (IP:port), not `node` — the aggregator maps IPs to node names
    // Node CPU usage %
    const cpuQuery = `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`;
    // Node Memory usage %
    const memQuery = `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)`;
    // Node Disk usage %
    const diskQuery = `100 - ((node_filesystem_avail_bytes{mountpoint="/",fstype!="rootfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"}) * 100)`;
    // Node Network I/O
    const netRxQuery = `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|flannel.*|cali.*|cbr.*"}[5m]))`;
    const netTxQuery = `sum by (instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|flannel.*|cali.*|cbr.*"}[5m]))`;

    const [cpuResp, memResp, diskResp, netRxResp, netTxResp] = await Promise.allSettled([
      fetcher.query(endpoint, cpuQuery) as Promise<PromQueryResult>,
      fetcher.query(endpoint, memQuery) as Promise<PromQueryResult>,
      fetcher.query(endpoint, diskQuery) as Promise<PromQueryResult>,
      fetcher.query(endpoint, netRxQuery) as Promise<PromQueryResult>,
      fetcher.query(endpoint, netTxQuery) as Promise<PromQueryResult>,
    ]);

    function processResults(
      resp: PromiseSettledResult<PromQueryResult>,
      nodeKey: string,
      setter: (node: Partial<NodeResourceSummary>, val: number) => void,
    ) {
      if (resp.status !== "fulfilled" || !resp.value.data?.result) return;
      for (const r of resp.value.data.result) {
        const nodeName = r.metric.node ?? r.metric.instance ?? "";
        if (!nodeName) continue;
        // instance 형식 "10.0.0.4:9100" → nodeName으로 매핑은 별도 필요
        const name = nodeName.replace(/:.*$/, ""); // port 제거
        if (!result.has(name)) result.set(name, { name });
        const val = parseFloat(r.value?.[1] ?? "0");
        setter(result.get(name)!, val);
      }
    }

    processResults(cpuResp, "cpu", (n, v) => { n.cpuUsagePct = Math.min(100, Math.round(v)); });
    processResults(memResp, "mem", (n, v) => { n.memoryUsagePct = Math.min(100, Math.round(v)); });
    processResults(diskResp, "disk", (n, v) => { n.diskUsagePct = Math.min(100, Math.round(v)); });
    processResults(netRxResp, "netRx", (n, v) => { n.networkRxBytesPerSec = Math.round(v); });
    processResults(netTxResp, "netTx", (n, v) => { n.networkTxBytesPerSec = Math.round(v); });

    debug(`[prometheus] node metrics: ${result.size} nodes from ${endpoint}`);
    promNodeCache.set(cacheKey, result);
    return { metrics: result, available: true };
  } catch (err) {
    console.error("[prometheus] node metrics error:", err instanceof Error ? err.message : err);
    return { metrics: new Map(), available: false };
  }
}

// ── Helpers ──

/** Pod 이름에서 workload 이름 추출 (ReplicaSet hash suffix 제거) */
function podToWorkloadName(podName: string): string {
  // deployment-name-<rs-hash>-<pod-hash> → deployment-name
  // statefulset-name-0 → statefulset-name
  // daemonset-name-<pod-hash> → daemonset-name
  const match = podName.match(/^(.+)-[a-z0-9]{8,10}-[a-z0-9]{5}$/);
  if (match) return match[1]!;
  // StatefulSet: name-0, name-1
  const ssMatch = podName.match(/^(.+)-\d+$/);
  if (ssMatch) return ssMatch[1]!;
  // DaemonSet / Job: name-<5-char suffix> (k8s random suffix alphabet has no vowels)
  const dsMatch = podName.match(/^(.+)-[bcdfghjklmnpqrstvwxz2456789]{5}$/);
  if (dsMatch) return dsMatch[1]!;
  return podName;
}
