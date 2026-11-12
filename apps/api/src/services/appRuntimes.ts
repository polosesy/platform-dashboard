// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표 — what kind of application each workload is, and that kind's
// representative metrics, from the cluster's Azure Monitor workspace.
//
// The heatmap's application signals are Micrometer's (Java / Spring); every other workload read "not instrumented".
// Here each runtime / software has a detection metric — the one its standard client library or exporter always
// exposes — and one or two representative values:
//   jvm (Micrometer) · nodejs (prom-client) · python (prometheus_client) · go (client_golang) · dotnet (prometheus-net)
//   nginx (nginx-prometheus-exporter) · redis (redis_exporter) · postgres (postgres_exporter)
// Rules:
// - "what it is" has a basis: `metrics` = its detection metric is in the workspace for a pod of the workload (a fact);
//   `image` = only the image name says so (a hint — the guide then says what to expose). Nothing else is guessed.
// - a value is the workload's worst pod (max) or the sum where the unit adds up (requests · connections).
// - no series = no value (never 0); a query that did not answer is a gap and its column says so.
// - metrics carry `namespace` · `pod` (the collector's relabeling — the same assumption as the heatmap's JVM queries);
//   an exporter in its own pod is attributed to the exporter's workload.
import type { Env } from "../env.js";
import type { AppColumnId, AppMetricsResponse, AppRuntimeKind, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";

/** The metric that says "this pod runs that" — exposed by default by the runtime's standard library / exporter */
export const RUNTIME_DETECT: Record<AppRuntimeKind, string> = {
  jvm: "jvm_memory_used_bytes",
  nodejs: "nodejs_version_info",
  python: "python_info",
  go: "go_info",
  dotnet: "dotnet_total_memory_bytes",
  nginx: "nginx_up",
  redis: "redis_up",
  postgres: "pg_up",
};
export const RUNTIME_KINDS = Object.keys(RUNTIME_DETECT) as AppRuntimeKind[];

/** Image names that name a software with an exporter here (the last path segment, before the tag) — a hint only */
const IMAGE_HINTS: Array<[RegExp, AppRuntimeKind]> = [
  [/^(nginx|nginx-unprivileged|openresty)$/, "nginx"],
  [/^(redis|valkey|redis-stack-server)$/, "redis"],
  [/^(postgres|postgresql|pgbouncer)$/, "postgres"],
];
/** Pure: the software an image name states (`registry/path/redis:7` → redis), or null — never from a partial match */
export function runtimeOfImage(image: string): AppRuntimeKind | null {
  const base = (image.split("@")[0] ?? "").split("/").pop()?.split(":")[0]?.toLowerCase() ?? "";
  return IMAGE_HINTS.find(([re]) => re.test(base))?.[1] ?? null;
}

type ColumnDef = { runtime: AppRuntimeKind | "any"; unit: "ms" | "bytes" | "count" | "perSec" | "ratio"; agg: "max" | "sum"; expr: (sel: (m: string) => string) => string };
const byPod = (expr: string, agg: "max" | "sum" = "max") => `${agg} by (namespace, pod) (${expr})`;
/** The representative values — one or two per runtime; `openFds` is every client library's process collector */
export const APP_COLUMNS: Record<AppColumnId, ColumnDef> = {
  nodeEventLoopLag: { runtime: "nodejs", unit: "ms", agg: "max", expr: (s) => `${byPod(s("nodejs_eventloop_lag_p99_seconds"))} * 1000` },
  nodeHeapUsed: { runtime: "nodejs", unit: "bytes", agg: "max", expr: (s) => byPod(s("nodejs_heap_size_used_bytes"), "sum") },
  pyRss: { runtime: "python", unit: "bytes", agg: "max", expr: (s) => `${byPod(s("process_resident_memory_bytes"))} and on (namespace, pod) ${byPod(s("python_info"))}` },
  goGoroutines: { runtime: "go", unit: "count", agg: "max", expr: (s) => byPod(s("go_goroutines")) },
  goHeapInuse: { runtime: "go", unit: "bytes", agg: "max", expr: (s) => byPod(s("go_memstats_heap_inuse_bytes")) },
  dotnetMemory: { runtime: "dotnet", unit: "bytes", agg: "max", expr: (s) => byPod(s("dotnet_total_memory_bytes")) },
  nginxConnections: { runtime: "nginx", unit: "count", agg: "sum", expr: (s) => byPod(s("nginx_connections_active"), "sum") },
  nginxRequests: { runtime: "nginx", unit: "perSec", agg: "sum", expr: (s) => `sum by (namespace, pod) (rate(${s("nginx_http_requests_total")}[5m]))` },
  redisClients: { runtime: "redis", unit: "count", agg: "sum", expr: (s) => byPod(s("redis_connected_clients"), "sum") },
  redisMemory: { runtime: "redis", unit: "bytes", agg: "max", expr: (s) => byPod(s("redis_memory_used_bytes")) },
  pgConnections: { runtime: "postgres", unit: "count", agg: "sum", expr: (s) => `sum by (namespace, pod) (${s("pg_stat_activity_count")})` },
  openFds: { runtime: "any", unit: "ratio", agg: "max", expr: (s) => `${byPod(s("process_open_fds"))} / on (namespace, pod) ${byPod(s("process_max_fds"))}` },
};
export const APP_COLUMN_IDS = Object.keys(APP_COLUMNS) as AppColumnId[];

/** Pure: the queries — owners, images, one detection and one value query per runtime / column */
export function appQueries(C: string): Record<string, string> {
  const sel = (m: string) => `${m}{${C}}`;
  const q: Record<string, string> = {
    podOwners: `group by (namespace, pod, owner_kind, owner_name) (${sel("kube_pod_owner")})`,
    rsOwners: `group by (namespace, replicaset, owner_kind, owner_name) (${sel("kube_replicaset_owner")})`,
    images: `group by (namespace, pod, image) (${sel("kube_pod_container_info")})`,
  };
  for (const k of RUNTIME_KINDS) q[`detect:${k}`] = `count by (namespace, pod) (${sel(RUNTIME_DETECT[k])})`;
  for (const id of APP_COLUMN_IDS) q[`col:${id}`] = APP_COLUMNS[id].expr(sel);
  return q;
}
/** Without these there are no workloads to name */
export const APP_CORE_QUERIES = ["podOwners", "rsOwners"];

const owner = (r: PromRow): OwnerRow => ({ namespace: r.metric.namespace ?? "", name: r.metric.pod ?? r.metric.replicaset ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" });

/** Pure: the answers → per workload its kinds (with basis) and values; per runtime / column whether it is measured */
export function aggregateApps(raw: Record<string, PromRow[]>, failed: Set<string> = new Set()): Pick<AppMetricsResponse, "runtimes" | "columns" | "workloads"> {
  const owners = ownerIndex((raw.podOwners ?? []).map(owner), (raw.rsOwners ?? []).map(owner));
  type W = AppMetricsResponse["workloads"][number];
  const by = new Map<string, W>();
  const at = (r: PromRow): W | null => {
    const ref = resolveWorkload(`${r.metric.namespace ?? ""}/${r.metric.pod ?? ""}`, owners);
    if (!ref) return null;
    const key = `${ref.namespace}/${ref.workload}`;
    let w = by.get(key);
    if (!w) { w = { namespace: ref.namespace, workload: ref.workload, kinds: [], values: {} }; by.set(key, w); }
    return w;
  };
  // every running workload is listed (a workload of no known kind is the guide's reason to exist)
  for (const r of raw.podOwners ?? []) at(r);
  for (const k of RUNTIME_KINDS) {
    for (const r of raw[`detect:${k}`] ?? []) {
      const w = at(r);
      if (w && !w.kinds.some((x) => x.kind === k)) w.kinds.push({ kind: k, basis: "metrics" });
    }
  }
  for (const r of raw.images ?? []) {
    const k = runtimeOfImage(r.metric.image ?? "");
    const w = k ? at(r) : null;
    // the image only speaks when the metrics do not: a measured kind needs no hint
    if (w && k && !w.kinds.some((x) => x.kind === k)) w.kinds.push({ kind: k, basis: "image" });
  }
  for (const id of APP_COLUMN_IDS) {
    for (const r of raw[`col:${id}`] ?? []) {
      const w = at(r);
      if (!w || !Number.isFinite(r.value)) continue;
      const prev = w.values[id];
      w.values[id] = prev === undefined ? r.value : APP_COLUMNS[id].agg === "sum" ? prev + r.value : Math.max(prev, r.value);
    }
  }
  const workloads = [...by.values()].sort((a, b) => (a.namespace + "/" + a.workload < b.namespace + "/" + b.workload ? -1 : 1));
  return {
    workloads,
    runtimes: RUNTIME_KINDS.map((kind) => ({
      kind,
      state: failed.has(`detect:${kind}`) ? "queryFailed" : (raw[`detect:${kind}`] ?? []).length ? "measured" : "absent",
      workloads: workloads.filter((w) => w.kinds.some((x) => x.kind === kind && x.basis === "metrics")).length,
      hinted: workloads.filter((w) => w.kinds.some((x) => x.kind === kind && x.basis === "image")).length,
    })),
    columns: APP_COLUMN_IDS.map((id) => ({
      id, runtime: APP_COLUMNS[id].runtime, unit: APP_COLUMNS[id].unit,
      state: failed.has(`col:${id}`) ? "queryFailed" : (raw[`col:${id}`] ?? []).length ? "measured" : "absent",
      workloads: workloads.filter((w) => w.values[id] !== undefined).length,
    })),
  };
}

type PromResponse = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }; error?: string };
const rowsOf = (resp: unknown): PromRow[] => {
  const r = resp as PromResponse;
  if (r?.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
  return (r?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) })).filter((x) => Number.isFinite(x.value));
};

const cache = new CacheManager<AppMetricsResponse>(20, 60_000);
const inflight = new Map<string, Promise<AppMetricsResponse>>();

/** `at` = epoch seconds (a view of the past); none = now */
export async function getAppMetrics(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<AppMetricsResponse> {
  const key = `${cachePrefix(bearerToken)}:app-metrics:${clusterId.toLowerCase()}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<AppMetricsResponse> {
  const base: AppMetricsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", runtimes: [], columns: [], workloads: [],
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    const scope = pickScope(rowsOf(await fetcher.query(target.endpoint, "group by (cluster) (kube_pod_owner)", time)).map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
    if (scope === null) return { ...base, metricsState: "noHubbleMetrics" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    const run = await runAll(fetcher, target.endpoint, appQueries(scopeMatchers(scope, false)), undefined, time);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (APP_CORE_QUERIES.some((q) => failed.has(q))) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    return { ...base, ...aggregateApps(run.rows, failed), ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
