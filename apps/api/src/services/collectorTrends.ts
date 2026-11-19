// 모니터링 › 수집 상태 › 수집기 신호 (2026-11-19) — each collector's own metrics over the page's range, from the
// cluster's Azure Monitor workspace (the same rules as observabilityStack.ts: every value a query result, no series =
// not measured, never 0; a query that does not answer = a gap, the rest stands).
//
// A collector = a workload whose pods emit collector self-metrics (Grafana Alloy / OpenTelemetry Collector): Prometheus
// remote write (prometheus_remote_storage_*), Loki write (loki_write_*), OTLP traces (otelcol_receiver_* /
// otelcol_exporter_*), Pyroscope write (pyroscope_write_*). What it carries = which of these it emits.
//
// The four questions (OpenTelemetry Collector "monitoring" guidance — received vs sent, refused / send failed, exporter
// queue size vs capacity; Grafana Alloy remote-write metrics — failed, retried, pending, lag, shards desired vs max;
// USE for the process — the pods' CPU and memory against their limits, restarts, OOM):
//   throughput  in vs out per pipeline — "in > 0 and out = 0" = not delivering
//   errors      failed / dropped / refused at any point of the range
//   saturation  remote-write lag over RW_LAG_SECONDS · shards desired over max (cannot scale further) · the exporter
//               queue at QUEUE_FULL of its capacity (it drops when full)
//   resources   memory or CPU at LIMIT_NEAR of the limit · a restart · last termination OOMKilled
// Measured on stg (2026-11-19): 3 Alloy remote writers, 2 Loki writers, 1 OTLP collector with 3 exporter queues,
// 1 Pyroscope writer; every collector pod has container CPU / memory and kube-state-metrics limits.

import type { Env } from "../env.js";
import type { CollectorPipeline, CollectorRow, CollectorScrapeJob, CollectorSignal, CollectorVerdict, CollectorsResponse, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";
import { isTransient, RW_LAG_SECONDS, runAll, STACK_QUERY_TIMEOUT_MS, THROTTLE_RETRY_DELAY_MS } from "./observabilityStack.js";

export const QUEUE_FULL = 0.8;
export const LIMIT_NEAR = 0.9;
/** about this many points per series */
const POINTS = 120;

/** Pure: the step (s) for a range — ≥ 60 s (the scrape interval), about POINTS points */
export function stepFor(spanMinutes: number): number {
  return Math.max(60, Math.ceil((spanMinutes * 60) / POINTS / 60) * 60);
}

type Agg = "sum" | "max";
type SignalDef = { pipeline: CollectorPipeline | "resources"; unit: CollectorSignal["unit"]; agg: Agg; q: (C: string, P: string, w: string, step: string) => string };
const rate = (m: string, C: string, P: string, w: string, extra = "") => `sum by (pod) (rate(${m}{${C},${P}${extra}}[${w}]))`;
const gauge = (fn: "sum" | "max", m: string, C: string, P: string, extra = "") => `${fn} by (pod) (${m}{${C},${P}${extra}})`;
const CONTAINER = ',container!="",container!="POD"';

/** The signals (ids are the web's i18n keys obs.col.sig.<id>) — P = the collectors' pods */
export const SIGNALS: Record<string, SignalDef> = {
  rwIn: { pipeline: "metrics", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_samples_in_total", C, P, w) },
  rwSent: { pipeline: "metrics", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_samples_total", C, P, w) },
  rwFailed: { pipeline: "metrics", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_samples_failed_total", C, P, w) },
  rwRetried: { pipeline: "metrics", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_samples_retried_total", C, P, w) },
  rwDropped: { pipeline: "metrics", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_samples_dropped_total", C, P, w) },
  rwPending: { pipeline: "metrics", unit: "count", agg: "sum", q: (C, P) => gauge("sum", "prometheus_remote_storage_samples_pending", C, P) },
  rwLag: { pipeline: "metrics", unit: "seconds", agg: "max", q: (C, P) => `max by (pod) (prometheus_remote_storage_highest_timestamp_in_seconds{${C},${P}}) - max by (pod) (prometheus_remote_storage_queue_highest_sent_timestamp_seconds{${C},${P}})` },
  rwShards: { pipeline: "metrics", unit: "count", agg: "max", q: (C, P) => gauge("max", "prometheus_remote_storage_shards", C, P) },
  rwShardsDesired: { pipeline: "metrics", unit: "count", agg: "max", q: (C, P) => gauge("max", "prometheus_remote_storage_shards_desired", C, P) },
  rwShardsMax: { pipeline: "metrics", unit: "count", agg: "max", q: (C, P) => gauge("max", "prometheus_remote_storage_shards_max", C, P) },
  rwBytes: { pipeline: "metrics", unit: "bytesPerSecond", agg: "sum", q: (C, P, w) => rate("prometheus_remote_storage_bytes_total", C, P, w) },
  logSent: { pipeline: "logs", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("loki_write_sent_entries_total", C, P, w) },
  logDropped: { pipeline: "logs", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("loki_write_dropped_entries_total", C, P, w) },
  logRetries: { pipeline: "logs", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("loki_write_batch_retries_total", C, P, w) },
  logBytes: { pipeline: "logs", unit: "bytesPerSecond", agg: "sum", q: (C, P, w) => rate("loki_write_sent_bytes_total", C, P, w) },
  logP95: { pipeline: "logs", unit: "seconds", agg: "max", q: (C, P, w) => `histogram_quantile(0.95, sum by (pod, le) (rate(loki_write_request_duration_seconds_bucket{${C},${P}}[${w}])))` },
  spanIn: { pipeline: "traces", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("otelcol_receiver_accepted_spans_total", C, P, w) },
  spanRefused: { pipeline: "traces", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("otelcol_receiver_refused_spans_total", C, P, w) },
  spanOut: { pipeline: "traces", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("otelcol_exporter_sent_spans_total", C, P, w) },
  spanFailed: { pipeline: "traces", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("otelcol_exporter_send_failed_spans_total", C, P, w) },
  queueSize: { pipeline: "traces", unit: "count", agg: "sum", q: (C, P) => gauge("sum", "otelcol_exporter_queue_size", C, P) },
  queueCap: { pipeline: "traces", unit: "count", agg: "sum", q: (C, P) => gauge("sum", "otelcol_exporter_queue_capacity", C, P) },
  profBytes: { pipeline: "profiles", unit: "bytesPerSecond", agg: "sum", q: (C, P, w) => rate("pyroscope_write_sent_bytes_total", C, P, w) },
  profDropped: { pipeline: "profiles", unit: "perSecond", agg: "sum", q: (C, P, w) => rate("pyroscope_write_dropped_profiles_total", C, P, w) },
  cpu: { pipeline: "resources", unit: "cores", agg: "sum", q: (C, P, w) => rate("container_cpu_usage_seconds_total", C, P, w, CONTAINER) },
  cpuLimit: { pipeline: "resources", unit: "cores", agg: "sum", q: (C, P) => gauge("sum", "kube_pod_container_resource_limits", C, P, ',resource="cpu"') },
  mem: { pipeline: "resources", unit: "bytes", agg: "sum", q: (C, P) => gauge("sum", "container_memory_working_set_bytes", C, P, CONTAINER) },
  memLimit: { pipeline: "resources", unit: "bytes", agg: "sum", q: (C, P) => gauge("sum", "kube_pod_container_resource_limits", C, P, ',resource="memory"') },
  // the cumulative count (increase() over one 60 s step has < 2 samples at a 60 s scrape — stg read nothing); the
  // range's restarts = last − first of the collector's sum (collectorVerdicts)
  restarts: { pipeline: "resources", unit: "count", agg: "sum", q: (C, P) => gauge("sum", "kube_pod_container_status_restarts_total", C, P) },
  oom: { pipeline: "resources", unit: "count", agg: "max", q: (C, P) => gauge("max", "kube_pod_container_status_last_terminated_reason", C, P, ',reason="OOMKilled"') },
  throttled: { pipeline: "resources", unit: "ratio", agg: "max", q: (C, P, w) => `sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{${C},${P}${CONTAINER}}[${w}])) / sum by (pod) (rate(container_cpu_cfs_periods_total{${C},${P}${CONTAINER}}[${w}]))` },
};

/** The self-metric that marks a pod as a collector of that pipeline */
const MARKERS: Record<CollectorPipeline, string> = {
  metrics: "prometheus_remote_storage_samples_total",
  logs: "loki_write_sent_entries_total",
  traces: "otelcol_receiver_accepted_spans_total",
  profiles: "pyroscope_write_sent_bytes_total",
};

/** Pure: a PromQL alternation of pod names (Kubernetes names — the dots escaped) */
export const podAlternation = (pods: string[]) => [...new Set(pods)].sort().map((p) => p.replace(/[.]/g, "\\\\.")).join("|");

export type RangeRow = { metric: Record<string, string>; values: Array<[number, number]> };

/** Pure: per-pod series → one series per collector (sum or max at each time; a time only some pods have = theirs) */
export function combine(rows: RangeRow[], pods: Set<string>, agg: Agg): Array<[number, number]> | null {
  const mine = rows.filter((r) => pods.has(r.metric.pod ?? ""));
  if (!mine.length) return null;
  const at = new Map<number, number>();
  for (const r of mine) for (const [t, v] of r.values) {
    if (!Number.isFinite(v)) continue;
    const prev = at.get(t);
    at.set(t, prev === undefined ? v : agg === "sum" ? prev + v : Math.max(prev, v));
  }
  const out = [...at.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, Number(v.toPrecision(6))] as [number, number]);
  return out.length ? out : null;
}

const signalOf = (id: string, unit: CollectorSignal["unit"], series: Array<[number, number]> | null, failed: boolean): CollectorSignal => ({
  id, unit, series: failed ? null : series,
  now: !failed && series?.length ? series[series.length - 1]![1] : null,
  max: !failed && series?.length ? Math.max(...series.map((p) => p[1])) : null,
  ...(failed ? { failed: true as const } : {}),
});

/** Pure: the four verdicts from a collector's signals — facts, each with the values that decided it */
export function collectorVerdicts(s: Record<string, CollectorSignal>): CollectorVerdict[] {
  const has = (...ids: string[]) => ids.some((i) => s[i]?.series);
  const now = (i: string) => s[i]?.now ?? null;
  const max = (i: string) => s[i]?.max ?? null;
  const out: CollectorVerdict[] = [];
  // throughput: something comes in and nothing goes out (per pipeline)
  {
    const reasons: CollectorVerdict["reasons"] = [];
    let warn = false;
    for (const [inp, outp] of [["rwIn", "rwSent"], ["spanIn", "spanOut"]] as const) {
      if (s[inp]?.series && s[outp]?.series && (now(inp) ?? 0) > 0 && (now(outp) ?? 0) === 0) { warn = true; reasons.push({ key: `${outp}Zero`, value: now(inp) }); }
    }
    for (const i of ["rwSent", "logSent", "spanOut", "profBytes"]) if (s[i]?.series) reasons.push({ key: i, value: now(i) });
    out.push({ id: "throughput", state: !has("rwSent", "logSent", "spanOut", "profBytes", "rwIn", "spanIn") ? "unknown" : warn ? "warn" : "ok", reasons });
  }
  // errors: any failed / dropped / refused in the range
  {
    const ids = ["rwFailed", "rwDropped", "logDropped", "spanRefused", "spanFailed", "profDropped"];
    const reasons = ids.filter((i) => (max(i) ?? 0) > 0).map((i) => ({ key: i, value: max(i) }));
    out.push({ id: "errors", state: !has(...ids) ? "unknown" : reasons.length ? "warn" : "ok", reasons });
  }
  // saturation: lag, shards, exporter queue
  {
    const reasons: CollectorVerdict["reasons"] = [];
    if ((now("rwLag") ?? 0) > RW_LAG_SECONDS) reasons.push({ key: "rwLag", value: now("rwLag") });
    if (now("rwShardsDesired") !== null && now("rwShardsMax") !== null && now("rwShardsDesired")! > now("rwShardsMax")!) reasons.push({ key: "rwShards", value: now("rwShardsDesired") });
    const q = now("queueSize") !== null && (now("queueCap") ?? 0) > 0 ? now("queueSize")! / now("queueCap")! : null;
    if (q !== null && q >= QUEUE_FULL) reasons.push({ key: "queue", value: Math.round(q * 1000) / 1000 });
    out.push({ id: "saturation", state: !has("rwLag", "rwShardsDesired", "queueSize") ? "unknown" : reasons.length ? "warn" : "ok", reasons });
  }
  // resources: near the limit, restarts, OOM
  {
    const reasons: CollectorVerdict["reasons"] = [];
    const memR = now("mem") !== null && (now("memLimit") ?? 0) > 0 ? now("mem")! / now("memLimit")! : null;
    const cpuR = now("cpu") !== null && (now("cpuLimit") ?? 0) > 0 ? now("cpu")! / now("cpuLimit")! : null;
    if (memR !== null && memR >= LIMIT_NEAR) reasons.push({ key: "memNear", value: Math.round(memR * 1000) / 1000 });
    if (cpuR !== null && cpuR >= LIMIT_NEAR) reasons.push({ key: "cpuNear", value: Math.round(cpuR * 1000) / 1000 });
    const rs = s.restarts?.series;
    const restarts = rs?.length ? Math.max(0, Math.round(rs[rs.length - 1]![1] - Math.min(...rs.map((p) => p[1])))) : null;
    if ((restarts ?? 0) >= 1) reasons.push({ key: "restarts", value: restarts });
    if ((now("oom") ?? 0) >= 1) reasons.push({ key: "oom", value: 1 });
    out.push({ id: "resources", state: !has("cpu", "mem") ? "unknown" : reasons.length ? "warn" : "ok", reasons });
  }
  return out;
}

const cache = new CacheManager<CollectorsResponse>(20, 60_000);
const inflight = new Map<string, Promise<CollectorsResponse>>();

export async function getCollectors(env: Env, bearerToken: string | undefined, clusterId: string, spanMinutes: number, at?: number): Promise<CollectorsResponse> {
  const span = Math.max(30, Math.min(7 * 1440, Math.round(spanMinutes)));
  const key = `${cachePrefix(bearerToken)}:obs-collectors:${clusterId.toLowerCase()}:${span}:${at ?? Math.floor(Date.now() / 60_000)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, span, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : 60_000);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export async function rangeAll(fetcher: PrometheusFetcher, endpoint: string, queries: Record<string, string>, start: number, end: number, step: number): Promise<{ rows: Record<string, RangeRow[]>; gaps: StackQueryGap[] }> {
  const names = Object.keys(queries);
  const rows: Record<string, RangeRow[]> = {};
  const gaps: StackQueryGap[] = [];
  type R = { data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> } };
  const once = async (n: string) => (((await fetcher.queryRange(endpoint, queries[n]!, String(start), String(end), String(step))) as R)?.data?.result ?? [])
    .map((x) => ({ metric: x.metric ?? {}, values: (x.values ?? []).map(([t, v]) => [Number(t) * 1000, Number(v)] as [number, number]) }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
    while (next < names.length) {
      const n = names[next++]!;
      try { rows[n] = await once(n); } catch (e) {
        if (e instanceof HttpError) throw e;
        try {
          if (!isTransient(e)) throw e;
          if (/429|throttl/i.test(String((e as Error)?.message ?? e))) await new Promise((r) => setTimeout(r, THROTTLE_RETRY_DELAY_MS));
          rows[n] = await once(n);
        } catch (e2) {
          if (e2 instanceof HttpError) throw e2;
          rows[n] = [];
          const m = String((e2 as Error)?.message ?? e2);
          gaps.push({ query: n, reason: /abort|timeout/i.test(m) ? "timeout" : /429|throttl/i.test(m) ? "throttled" : "failed" });
        }
      }
    }
  }));
  gaps.sort((a, b) => (a.query < b.query ? -1 : 1));
  return { rows, gaps };
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, span: number, at?: number): Promise<CollectorsResponse> {
  const endS = at ?? Math.floor(Date.now() / 60_000) * 60;
  const startS = endS - span * 60;
  const step = stepFor(span);
  const base: CollectorsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", from: new Date(startS * 1000).toISOString(), to: new Date(endS * 1000).toISOString(), stepSeconds: step,
    collectors: [], scrape: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = String(endS);
    const scopeRows = (await runAll(fetcher, target.endpoint, { s: "group by (cluster) (up)" }, 1, time)).rows.s ?? [];
    const scope = pickScope(scopeRows.map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
    if (scope === null) return { ...base, metricsState: "noHubbleMetrics" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    const C = scopeMatchers(scope, false);
    const w = `${Math.max(step, 300)}s`;
    // 1. who collects: pods emitting a pipeline's self-metric anywhere in the range (a restarted pod counts)
    const disc: Record<string, string> = Object.fromEntries((Object.entries(MARKERS) as Array<[CollectorPipeline, string]>).map(([p, m]) =>
      [p, `group by (namespace, pod) (max_over_time(${m}{${C}}[${span}m]))`]));
    disc.owners = `group by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{${C}}[${span}m]))`;
    disc.rsOwners = `group by (namespace, replicaset, owner_kind, owner_name) (max_over_time(kube_replicaset_owner{${C}}[${span}m]))`;
    disc.jobTargets = `count by (job) (up{${C}})`;
    disc.jobDown = `count by (job) (up{${C}} == 0)`;
    disc.jobUpRatio = `avg by (job) (avg_over_time(up{${C}}[${span}m]))`;
    disc.jobDur = `max by (job) (max_over_time(scrape_duration_seconds{${C}}[${span}m]))`;
    disc.jobSamples = `sum by (job) (scrape_samples_scraped{${C}})`;
    const d = await runAll(fetcher, target.endpoint, disc, 4, time, STACK_QUERY_TIMEOUT_MS);
    const pipelinesOf = new Map<string, Set<CollectorPipeline>>();
    const nsOf = new Map<string, string>();
    for (const p of Object.keys(MARKERS) as CollectorPipeline[]) for (const r of d.rows[p] ?? []) {
      const pod = r.metric.pod ?? "";
      if (!pod) continue;
      (pipelinesOf.get(pod) ?? pipelinesOf.set(pod, new Set()).get(pod)!).add(p);
      if (r.metric.namespace) nsOf.set(pod, r.metric.namespace);
    }
    const owners = ownerIndex(
      (d.rows.owners ?? []).map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.pod ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
      (d.rows.rsOwners ?? []).map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.replicaset ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
    );
    const groups = new Map<string, { name: string; namespace: string | null; pods: string[]; pipelines: Set<CollectorPipeline> }>();
    for (const [pod, ps] of pipelinesOf) {
      const ns = nsOf.get(pod) ?? null;
      const wl = ns ? resolveWorkload(`${ns}/${pod}`, owners)?.workload ?? pod : pod;
      const k = `${ns ?? ""}/${wl}`;
      const g = groups.get(k) ?? { name: wl, namespace: ns, pods: [], pipelines: new Set() };
      g.pods.push(pod);
      for (const p of ps) g.pipelines.add(p);
      groups.set(k, g);
    }
    // 2. the signals over the range, all collector pods at once (per pod), then per collector
    const allPods = [...pipelinesOf.keys()];
    const P = allPods.length ? `pod=~"${podAlternation(allPods)}"` : 'pod="-"';
    const queries = Object.fromEntries(Object.entries(SIGNALS).map(([id, s]) => [id, s.q(C, P, w, `${step}s`)]));
    const up = { upSeries: `avg by (job) (up{${C}})` };
    const r = allPods.length ? await rangeAll(fetcher, target.endpoint, { ...queries, ...up }, startS, endS, step) : await rangeAll(fetcher, target.endpoint, up, startS, endS, step);
    const failed = new Set(r.gaps.map((g) => g.query));
    const collectors: CollectorRow[] = [...groups.values()].map((g) => {
      const pods = new Set(g.pods);
      const signals: Record<string, CollectorSignal> = {};
      for (const [id, s] of Object.entries(SIGNALS)) {
        if (s.pipeline !== "resources" && !g.pipelines.has(s.pipeline)) continue;
        signals[id] = signalOf(id, s.unit, combine(r.rows[id] ?? [], pods, s.agg), failed.has(id));
      }
      return { name: g.name, namespace: g.namespace, pods: g.pods.sort(), pipelines: (["metrics", "logs", "traces", "profiles"] as const).filter((p) => g.pipelines.has(p)), signals, verdicts: collectorVerdicts(signals) };
    }).sort((a, b) => (`${a.namespace}/${a.name}` < `${b.namespace}/${b.name}` ? -1 : 1));
    // 3. scrape jobs
    const byJob = (rows: PromRow[] | undefined) => new Map((rows ?? []).map((x) => [x.metric.job ?? "", x.value]));
    const targets = byJob(d.rows.jobTargets), down = byJob(d.rows.jobDown), ratio = byJob(d.rows.jobUpRatio), dur = byJob(d.rows.jobDur), samples = byJob(d.rows.jobSamples);
    const upSeries = new Map((r.rows.upSeries ?? []).map((x) => [x.metric.job ?? "", x.values]));
    const scrape: CollectorScrapeJob[] = [...targets.entries()].filter(([job]) => job).map(([job, n]) => ({
      job, targets: n, down: down.get(job) ?? 0, upRatio: ratio.has(job) ? Math.round(ratio.get(job)! * 10000) / 10000 : null,
      durationMax: dur.has(job) ? Math.round(dur.get(job)! * 1000) / 1000 : null, samples: samples.has(job) ? Math.round(samples.get(job)!) : null,
      series: upSeries.get(job)?.map(([t, v]) => [t, Math.round(v * 10000) / 10000] as [number, number]) ?? null,
    })).sort((a, b) => (a.upRatio ?? 1) - (b.upRatio ?? 1) || b.down - a.down || (a.job < b.job ? -1 : 1));
    const gaps = [...d.gaps, ...r.gaps];
    // the PromQL per signal, with a readable placeholder for the pod list
    const shown = Object.fromEntries(Object.entries(SIGNALS).map(([id, s]) => [id, s.q(C, 'pod=~"<pods>"', w, `${step}s`)]));
    return { ...base, collectors, scrape, queries: shown, ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
