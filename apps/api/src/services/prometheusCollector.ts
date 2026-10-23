import type { Env } from "../env.js";
import type { WorkloadHealth, ResourceUsage, NodeResourceSummary } from "@aud/types";
import { CacheManager, bearerKeyPrefix, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getArmFetcherAuto, getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import { homeConnection } from "../infra/connectionRegistry.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { pickScope, scopeMatchers } from "./promScope.js";
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

const promWorkloadCache = new CacheManager<Map<string, Partial<WorkloadHealth>>>(5, 60_000);
const promNodeCache = new CacheManager<Map<string, Partial<NodeResourceSummary>>>(5, 60_000);

// ── Auto-discover Prometheus query endpoint ──

export type PrometheusTarget =
  | { state: "ok"; endpoint: string }
  | { state: "noWorkspace" | "forbidden" | "failed"; message?: string };

const targetCache = new CacheManager<PrometheusTarget>(20, 10 * 60_000);

/**
 * The cluster's own Azure Monitor workspace query endpoint — DCR associations → rules → monitoring accounts
 * (clusterMonitoring.ts), first with an endpoint (sorted ids — deterministic). Never another environment's workspace.
 * `AZURE_PROMETHEUS_ENDPOINT` applies only to clusters of the home connection (a customer cluster is never read from
 * the home deployment's endpoint). Failures are states, not exceptions (signin_required still throws).
 */
export async function resolvePrometheusTarget(env: Env, bearerToken: string | undefined, clusterId: string): Promise<PrometheusTarget> {
  if (!clusterId || !clusterId.toLowerCase().startsWith("/subscriptions/")) return { state: "noWorkspace" };
  if (env.AZURE_PROMETHEUS_ENDPOINT && clusterConnection(env, clusterId).connection.key === homeConnection(env).key) {
    return { state: "ok", endpoint: env.AZURE_PROMETHEUS_ENDPOINT };
  }
  const cacheKey = `${cachePrefix(bearerToken)}:prom-ep:${clusterId.toLowerCase()}`;
  const cached = targetCache.get(cacheKey);
  if (cached) return cached;
  let target: PrometheusTarget;
  try {
    const fetcher = await getArmFetcherAuto(env, bearerToken);
    const accounts = await clusterMonitorAccounts(fetcher, clusterId);
    debug(`[prometheus] ${accounts.length} Azure Monitor workspace(s) associated with the cluster`);
    target = { state: "noWorkspace" };
    for (const id of [...accounts].sort()) {
      const ep = await prometheusQueryEndpoint(fetcher, id).catch(() => null);
      if (ep) { target = { state: "ok", endpoint: ep }; break; }
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "signin_required") throw err;
    const message = safeMessage(err);
    debug(`[prometheus] endpoint resolve error: ${message.slice(0, 160)}`);
    const forbidden = (err instanceof HttpError && (err.status === 401 || err.status === 403)) || /^ARM 40[13]/.test(message);
    target = { state: forbidden ? "forbidden" : "failed", message };
  }
  if (target.state === "ok" || target.state === "noWorkspace") targetCache.set(cacheKey, target);
  return target;
}

/** The endpoint, or null for any non-ok state (workload / node panels) */
export async function resolvePrometheusEndpoint(env: Env, bearerToken: string | undefined, clusterId: string): Promise<string | null> {
  const t = await resolvePrometheusTarget(env, bearerToken, clusterId).catch(() => null);
  return t?.state === "ok" ? t.endpoint : null;
}

// ── Cluster scope (services/promScope.ts) ──

const familyScopeCache = new CacheManager<string | null>(50, 10 * 60_000);

/**
 * Label matchers that keep one metric family to this cluster and one collector: `group by (cluster, job) (<metric>)`
 * → `pickScope`. null = the workspace holds several clusters and none is this one (answer nothing rather than mix).
 * "" = the family has no cluster label (whole workspace — a single-cluster workspace).
 */
export async function familyMatchers(fetcher: PrometheusFetcher, endpoint: string, clusterId: string, metric: string, cacheKeyPrefix: string): Promise<string | null> {
  const key = `${cacheKeyPrefix}:prom-scope:${clusterId.toLowerCase()}:${metric}`;
  const hit = familyScopeCache.get(key);
  if (hit !== undefined) return hit;
  const resp = (await fetcher.query(endpoint, `group by (cluster, job, collector) (${metric})`)) as PromQueryResult;
  const rows = (resp.data?.result ?? []).map((r) => ({ cluster: r.metric.cluster, job: r.metric.job, collector: r.metric.collector }));
  const scope = pickScope(rows, clusterId.split("/").pop() ?? "");
  const m = scope === "ambiguous" ? null : scope ? scopeMatchers(scope) : "";
  familyScopeCache.set(key, m);
  return m;
}

const withScope = (m: string, rest: string) => [m, rest].filter(Boolean).join(",");

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
  // Keyed by cluster: one workspace can hold several clusters (the endpoint alone mixed them)
  const cacheKey = `${prefix}:prom:workloads:${clusterId.toLowerCase()}`;
  const cached = promWorkloadCache.get(cacheKey);
  if (cached) return { metrics: cached, available: true };

  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const result = new Map<string, Partial<WorkloadHealth>>();
    const M = await familyMatchers(fetcher, endpoint, clusterId, "container_cpu_usage_seconds_total", prefix);
    if (M === null) return { metrics: new Map(), available: false };

    // CPU usage per workload (namespace/workload) — [5m] = 5 samples at a 60 s scrape interval
    const cpuQuery = `
sum by (namespace, pod) (
  rate(container_cpu_usage_seconds_total{${withScope(M, 'container!="", container!="POD"')}}[5m])
) * 1000`;

    // Memory usage per workload
    const memQuery = `
sum by (namespace, pod) (
  container_memory_working_set_bytes{${withScope(M, 'container!="", container!="POD"')}}
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
  const cacheKey = `${prefix}:prom:nodes:${clusterId.toLowerCase()}`;
  const cached = promNodeCache.get(cacheKey);
  if (cached) return { metrics: cached, available: true };

  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const result = new Map<string, Partial<NodeResourceSummary>>();
    const M = await familyMatchers(fetcher, endpoint, clusterId, "node_cpu_seconds_total", prefix);
    if (M === null) return { metrics: new Map(), available: false };
    const sel = (rest = "") => `{${withScope(M, rest)}}`;

    // node-exporter series carry `instance` (IP:port), not `node` — the aggregator maps IPs to node names
    // Node CPU usage %
    const cpuQuery = `100 - (avg by (instance) (rate(node_cpu_seconds_total${sel('mode="idle"')}[5m])) * 100)`;
    // Node Memory usage %
    const memQuery = `100 * (1 - node_memory_MemAvailable_bytes${sel()} / node_memory_MemTotal_bytes${sel()})`;
    // Node Disk usage %
    const diskQuery = `100 - ((node_filesystem_avail_bytes${sel('mountpoint="/",fstype!="rootfs"')} / node_filesystem_size_bytes${sel('mountpoint="/",fstype!="rootfs"')}) * 100)`;
    // Node Network I/O
    const netRxQuery = `sum by (instance) (rate(node_network_receive_bytes_total${sel('device!~"lo|veth.*|docker.*|flannel.*|cali.*|cbr.*"')}[5m]))`;
    const netTxQuery = `sum by (instance) (rate(node_network_transmit_bytes_total${sel('device!~"lo|veth.*|docker.*|flannel.*|cali.*|cbr.*"')}[5m]))`;

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
