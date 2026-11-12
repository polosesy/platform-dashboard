// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표 — what kind of application each workload is, and that kind's
// representative metrics, from the cluster's Azure Monitor workspace.
//
// The heatmap's application signals are Micrometer's (Java / Spring); every other workload read "not instrumented".
// Here each runtime / software has a detection metric — the one its standard client library or exporter always
// exposes — and one or two representative values:
//   jvm (Micrometer) · nodejs (prom-client) · python (prometheus_client) · go (client_golang) · dotnet (prometheus-net)
//   nginx (nginx-prometheus-exporter) · redis (redis_exporter) · postgres (postgres_exporter)
// Rules:
// - "what it is" has a basis, strongest first — never a guess from a name (2026-11-12: the image-name hint is gone):
//   `metrics` = its detection metric is in the workspace for a pod of the workload (+ the version it reports) ·
//   `telemetry` = the OpenTelemetry SDK's target_info · `spec` = the manifest declares it · `config` = the image's own
//   configuration from the registry (services/imageConfig.ts — Env JAVA_VERSION …, Entrypoint; opt-in) · `scan` = Defender's image
//   scan found that language's packages · `image` = a Docker Hub official image (services/runtimeEvidence.ts).
// - a value is the workload's worst pod (max) or the sum where the unit adds up (requests · connections).
// - no series = no value (never 0); a query that did not answer is a gap and its column says so.
// - metrics carry `namespace` · `pod` (the collector's relabeling — the same assumption as the heatmap's JVM queries);
//   an exporter in its own pod is attributed to the exporter's workload.
import type { Env } from "../env.js";
import type { AppColumnId, AppMetricsResponse, AppRuntimeEvidence, AppRuntimeKind, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";
import { collectScanRows, officialImageRuntime, runtimesOfScan, runtimesOfSpec, type RuntimeEvidence, type ScanRow, type SpecContainer } from "./runtimeEvidence.js";
import { workloadTemplates } from "./workloadVpa.js";
import { collectImageConfigs, type ImageConfigFacts } from "./imageConfig.js";

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

/** Where a runtime's metrics carry its version: [metric, label] (the detection metric itself when it has the label) */
export const RUNTIME_VERSION: Partial<Record<AppRuntimeKind, [string, string]>> = {
  jvm: ["jvm_info", "version"], nodejs: ["nodejs_version_info", "version"], python: ["python_info", "version"],
  go: ["go_info", "version"], redis: ["redis_instance_info", "redis_version"],
};
/** OpenTelemetry `telemetry.sdk.language` → kind */
const SDK_LANGUAGE: Record<string, AppRuntimeKind> = { java: "jvm", nodejs: "nodejs", python: "python", go: "go", dotnet: "dotnet" };
/** Pure: "v20.11.0" · "go1.22.3" · "17.0.9+9" → "20.11.0" · "1.22.3" · "17.0.9" (null when it is not a version) */
export function cleanVersion(v: string | undefined): string | null {
  const m = /(\d+(?:\.\d+){0,3})/.exec(v ?? "");
  return m ? m[1]! : null;
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
    images: `group by (namespace, pod, image, image_id) (${sel("kube_pod_container_info")})`,
    // OpenTelemetry resource attributes (pod labels as the collector writes them — either spelling)
    otel: `group by (namespace, pod, k8s_namespace_name, k8s_pod_name, telemetry_sdk_language, process_runtime_version) (${sel("target_info")})`,
  };
  for (const k of RUNTIME_KINDS) q[`detect:${k}`] = `count by (namespace, pod) (${sel(RUNTIME_DETECT[k])})`;
  for (const k of RUNTIME_KINDS) { const v = RUNTIME_VERSION[k]; if (v) q[`ver:${k}`] = `group by (namespace, pod, ${v[1]}) (${sel(v[0])})`; }
  for (const id of APP_COLUMN_IDS) q[`col:${id}`] = APP_COLUMNS[id].expr(sel);
  return q;
}
/** Without these there are no workloads to name */
export const APP_CORE_QUERIES = ["podOwners", "rsOwners"];

const owner = (r: PromRow): OwnerRow => ({ namespace: r.metric.namespace ?? "", name: r.metric.pod ?? r.metric.replicaset ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" });

/** What the Kubernetes API and Defender add (null = that source was not read) */
export type AppEvidenceInput = {
  templates?: { containers: Map<string, unknown[]>; annotations: Map<string, Record<string, string>> } | null;
  scan?: ScanRow[] | null;
  /** Image config facts by `imageKey(image, image_id)` (services/imageConfig.ts) */
  configs?: Map<string, ImageConfigFacts> | null;
};
/** The key one container image is known by: the status image + its imageID (a digest-pinned pod's image is a bare sha256) */
export const imageKey = (image: string, imageId: string) => `${image}|${imageId}`;
const TEMPLATE_KINDS = ["Deployment", "StatefulSet", "DaemonSet"];

/** Pure: the answers → per workload its kinds (with basis) and values; per runtime / column whether it is measured */
export function aggregateApps(raw: Record<string, PromRow[]>, failed: Set<string> = new Set(), extra: AppEvidenceInput = {}): Pick<AppMetricsResponse, "runtimes" | "columns" | "workloads"> {
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
  // the version the runtime reports (one per workload: pods of a rollout can differ — the newest string wins the sort)
  for (const k of RUNTIME_KINDS) {
    const label = RUNTIME_VERSION[k]?.[1];
    if (!label) continue;
    for (const r of raw[`ver:${k}`] ?? []) {
      const v = cleanVersion(r.metric[label]);
      const hit = v ? at(r)?.kinds.find((x) => x.kind === k) : undefined;
      if (hit && v && (!hit.version || hit.version < v)) hit.version = v;
    }
  }
  // weaker evidence only speaks for a kind nothing stronger named
  const add = (w: W | null, e: AppRuntimeEvidence) => { if (w && !w.kinds.some((x) => x.kind === e.kind)) w.kinds.push(e); };
  for (const r of raw.otel ?? []) {
    const kind = SDK_LANGUAGE[r.metric.telemetry_sdk_language ?? ""];
    if (!kind) continue;
    const w = at({ ...r, metric: { ...r.metric, namespace: r.metric.namespace || r.metric.k8s_namespace_name || "", pod: r.metric.pod || r.metric.k8s_pod_name || "" } });
    const version = cleanVersion(r.metric.process_runtime_version);
    add(w, { kind, basis: "telemetry", evidence: `telemetry.sdk.language: ${r.metric.telemetry_sdk_language}`, ...(version ? { version } : {}) });
  }
  const podImages = (raw.images ?? []).map((r) => {
    const image = r.metric.image ?? "", imageId = (r.metric.image_id ?? "").replace(/^[a-z-]+:\/\//, "");
    // a pod pinned by digest reports its image as a bare "sha256:…" — its repository is only in image_id
    return { r, image, imageId, named: image.includes("/") && !/^sha256:/.test(image) ? image : imageId || image, digest: /sha256:[0-9a-f]{64}/.exec(imageId)?.[0] };
  });
  // the image's own configuration (registry): names a kind, and gives the version to a kind already named without one
  if (extra.configs) {
    for (const { r, image, imageId } of podImages) {
      const w = at(r);
      for (const c of extra.configs.get(imageKey(image, imageId))?.runtimes ?? []) {
        const hit = w?.kinds.find((x) => x.kind === c.kind);
        if (hit) { if (!hit.version && c.version) hit.version = c.version; }
        else add(w, { kind: c.kind, basis: "config", evidence: c.evidence, ...(c.version ? { version: c.version } : {}) });
      }
    }
  }
  if (extra.templates) {
    for (const w of by.values()) {
      for (const tk of TEMPLATE_KINDS) {
        const key = `${tk}/${w.namespace}/${w.workload}`;
        const containers = extra.templates.containers.get(key) as SpecContainer[] | undefined;
        if (!containers) continue;
        for (const e of runtimesOfSpec(containers, extra.templates.annotations.get(key))) add(w, { kind: e.kind, basis: "spec", evidence: e.evidence });
      }
    }
  }
  if (extra.scan?.length) {
    const found: Map<string, RuntimeEvidence[]> = runtimesOfScan(podImages.map(({ named, digest }) => ({ image: named, ...(digest ? { digest } : {}) })), extra.scan);
    for (const { r, named } of podImages) for (const e of found.get(named) ?? []) add(at(r), { kind: e.kind, basis: "scan", evidence: e.evidence });
  }
  for (const { r, named } of podImages) {
    const k = officialImageRuntime(named);
    if (k) add(at(r), { kind: k, basis: "image", evidence: "Docker Hub official image" });
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
      hinted: workloads.filter((w) => w.kinds.some((x) => x.kind === kind && x.basis !== "metrics")).length,
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
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length || r.evidence?.spec === "unavailable" || r.evidence?.imageConfig?.pending ? 15_000 : undefined);
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
    // Manifest (Kubernetes API, 2 s — it keeps loading into its cache) and Defender's image scan, beside the metrics
    const [run, templates, scan] = await Promise.all([
      runAll(fetcher, target.endpoint, appQueries(scopeMatchers(scope, false)), undefined, time),
      workloadTemplates(env, bearerToken, clusterId, 2_000),
      collectScanRows(env, bearerToken, clusterId).catch(() => null),
    ]);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (APP_CORE_QUERIES.some((q) => failed.has(q))) throw run.firstError;
    // the optional evidence queries are not gaps of the table (a workspace without target_info is normal)
    const gaps: StackQueryGap[] = run.gaps.filter((g) => g.query !== "otel" && !g.query.startsWith("ver:"));
    // The registry's image configs for the images the metrics list (opt-in per connection; cached by digest for a day)
    const cfg = await collectImageConfigs(env, bearerToken, clusterId, (run.rows.images ?? []).map((r) => {
      const image = r.metric.image ?? "", imageId = (r.metric.image_id ?? "").replace(/^[a-z-]+:\/\//, "");
      return { key: imageKey(image, imageId), image, imageId };
    }));
    const evidence = {
      spec: templates ? ("ok" as const) : ("unavailable" as const), scan: scan === null ? ("unavailable" as const) : scan.length ? ("ok" as const) : ("empty" as const),
      imageConfig: { state: cfg.state, read: cfg.read, pending: cfg.pending },
    };
    return { ...base, ...aggregateApps(run.rows, failed, { templates, scan, configs: cfg.byImage }), evidence, ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
