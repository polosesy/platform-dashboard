// 모니터링 › 애플리케이션 (APM) › 메트릭 (2026-11-19) — the metrics pillar of one service, on one time axis (the
// page's range), from the Micrometer series already in the cluster's Azure Monitor workspace. Traces and logs have
// their own views; the numbers here were spread over RED (spanmetrics), SLO (Micrometer windows) and the heatmap
// (now) — none showed a service's metrics over time side by side.
//
// Sections (Datadog / New Relic APM service page — golden signals, runtime, dependencies, infrastructure):
//   golden   requests per second by status class (2xx·3xx / 4xx / 5xx — /actuator left out like RED and SLO) · the
//            5xx share (the SLO's availability failure) · latency p50 / p95 / p99 as the BOUND of the bucket that holds
//            the percentile (no interpolation — the RED and SLO rule; over the largest bound = "> cap")
//   runtime  JVM heap used vs max · non-heap · GC pause seconds per second and the longest pause · live threads ·
//            process CPU (Micrometer process_cpu_usage, share of the pod's CPUs)
//   deps     HikariCP active / max / pending + timeouts · outbound HTTP requests and failures · executor queue
//   pods     the service's pods: container CPU vs request / limit, working set vs request / limit
// Every counter through counterIncrease (a Micrometer counter starts at its first increment — promScope.ts). A series
// the workspace does not have = not measured (null), never 0.
// stg (2026-11-19): 38 pods with Micrometer HTTP server metrics; JVM, executor and log4j2 on all 38; HikariCP on 20,
// outbound HTTP on 17; no Tomcat / Jetty thread metrics.

import type { Env } from "../env.js";
import type { ApmMetricSection, ApmMetricsResponse, CollectorSignal } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf } from "./hubbleMetrics.js";
import { counterIncrease, pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll, STACK_QUERY_TIMEOUT_MS } from "./observabilityStack.js";
import { podAlternation, rangeAll, stepFor, type RangeRow } from "./collectorTrends.js";
import { quantileBucket } from "./workloadRed.js";

const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const APP = /^[\w.-]{1,128}$/;
const HTTP = "http_server_requests_seconds";
const NOT_ACTUATOR = 'uri!~"/actuator.*"';

type Def = { section: ApmMetricSection; unit: CollectorSignal["unit"]; q: (S: string, P: string, w: string, wSec: number) => string };
const inc = (sel: string, w: string, wSec: number) => `sum(${counterIncrease(sel, w)}) / ${wSec}`;

/** The signals — S = the service's selector (cluster, namespace, application), P = its pods' selector (cluster, pods) */
export const APM_SIGNALS: Record<string, Def> = {
  reqOk: { section: "golden", unit: "perSecond", q: (S, _P, w, s) => inc(`${HTTP}_count{${S},${NOT_ACTUATOR},status!~"[45].."}`, w, s) },
  req4xx: { section: "golden", unit: "perSecond", q: (S, _P, w, s) => inc(`${HTTP}_count{${S},${NOT_ACTUATOR},status=~"4.."}`, w, s) },
  req5xx: { section: "golden", unit: "perSecond", q: (S, _P, w, s) => inc(`${HTTP}_count{${S},${NOT_ACTUATOR},status=~"5.."}`, w, s) },
  heapUsed: { section: "runtime", unit: "bytes", q: (S) => `sum(jvm_memory_used_bytes{${S},area="heap"})` },
  heapMax: { section: "runtime", unit: "bytes", q: (S) => `sum(jvm_memory_max_bytes{${S},area="heap"} > 0)` },
  nonHeap: { section: "runtime", unit: "bytes", q: (S) => `sum(jvm_memory_used_bytes{${S},area="nonheap"})` },
  gcPause: { section: "runtime", unit: "ratio", q: (S, _P, w, s) => inc(`jvm_gc_pause_seconds_sum{${S}}`, w, s) },
  gcMax: { section: "runtime", unit: "seconds", q: (S) => `max(jvm_gc_pause_seconds_max{${S}})` },
  threads: { section: "runtime", unit: "count", q: (S) => `sum(jvm_threads_live_threads{${S}})` },
  cpuProcess: { section: "runtime", unit: "ratio", q: (S) => `max(process_cpu_usage{${S}})` },
  poolActive: { section: "deps", unit: "count", q: (S) => `sum(hikaricp_connections_active{${S}})` },
  poolMax: { section: "deps", unit: "count", q: (S) => `sum(hikaricp_connections_max{${S}})` },
  poolPending: { section: "deps", unit: "count", q: (S) => `sum(hikaricp_connections_pending{${S}})` },
  poolTimeouts: { section: "deps", unit: "perSecond", q: (S, _P, w, s) => inc(`hikaricp_connections_timeout_total{${S}}`, w, s) },
  clientReq: { section: "deps", unit: "perSecond", q: (S, _P, w, s) => inc(`http_client_requests_seconds_count{${S}}`, w, s) },
  // failed outbound = 5xx or no answer (IO_ERROR / CLIENT_ERROR status, or an exception tag) — 4xx is the callee's answer
  clientFailed: { section: "deps", unit: "perSecond", q: (S, _P, w, s) => inc(`http_client_requests_seconds_count{${S},status=~"5..|IO_ERROR|CLIENT_ERROR"}`, w, s) },
  queued: { section: "deps", unit: "count", q: (S) => `sum(executor_queued_tasks{${S}})` },
  cpu: { section: "pods", unit: "cores", q: (_S, P, w) => `sum(rate(container_cpu_usage_seconds_total{${P},container!="",container!="POD"}[${w}]))` },
  cpuRequest: { section: "pods", unit: "cores", q: (_S, P) => `sum(kube_pod_container_resource_requests{${P},resource="cpu"})` },
  cpuLimit: { section: "pods", unit: "cores", q: (_S, P) => `sum(kube_pod_container_resource_limits{${P},resource="cpu"})` },
  mem: { section: "pods", unit: "bytes", q: (_S, P) => `sum(container_memory_working_set_bytes{${P},container!="",container!="POD"})` },
  memRequest: { section: "pods", unit: "bytes", q: (_S, P) => `sum(kube_pod_container_resource_requests{${P},resource="memory"})` },
  memLimit: { section: "pods", unit: "bytes", q: (_S, P) => `sum(kube_pod_container_resource_limits{${P},resource="memory"})` },
};

/** Pure: the newest point and the range's largest */
const signal = (id: string, unit: CollectorSignal["unit"], series: Array<[number, number]> | null, failed = false, cap?: number, overAt?: number[]): CollectorSignal => ({
  id, unit, series: failed ? null : series,
  now: !failed && series?.length ? series[series.length - 1]![1] : null,
  max: !failed && series?.length ? Math.max(...series.map((p) => p[1])) : null,
  ...(failed ? { failed: true as const } : {}), ...(cap !== undefined ? { cap } : {}), ...(overAt?.length ? { overAt } : {}),
});

/** Pure: a one-series range answer → points (null when the workspace returned nothing) */
export function pointsOf(rows: RangeRow[] | undefined): Array<[number, number]> | null {
  const r = rows?.[0];
  const pts = r ? r.values.filter(([, v]) => Number.isFinite(v)).map(([t, v]) => [t, Number(v.toPrecision(6))] as [number, number]) : [];
  return pts.length ? pts : null;
}

/** Pure: the 5xx share per time — only where the service had requests (no request = no point, never 0 %) */
export function errorShare(ok: Array<[number, number]> | null, c4: Array<[number, number]> | null, c5: Array<[number, number]> | null): Array<[number, number]> | null {
  const at = new Map<number, { all: number; bad: number }>();
  for (const [s, bad] of [[ok, false], [c4, false], [c5, true]] as const) for (const [t, v] of s ?? []) {
    const e = at.get(t) ?? { all: 0, bad: 0 };
    e.all += v;
    if (bad) e.bad += v;
    at.set(t, e);
  }
  const out = [...at.entries()].filter(([, e]) => e.all > 0).sort((a, b) => a[0] - b[0]).map(([t, e]) => [t, Number((e.bad / e.all).toPrecision(6))] as [number, number]);
  return out.length ? out : null;
}

/**
 * Pure: percentile series from per-bucket (le) increases over time — at each time the bound of the bucket that holds
 * the percentile (workloadRed quantileBucket — no interpolation); over the largest finite bound = that bound, marked
 * by `cap`; a time with no request = no point
 */
/** Pure: a bucket bound — the workspace writes infinity as "+inf" (lower case; Prometheus "+Inf"): both read */
export const leOf = (s: string | undefined): number => (s === undefined ? NaN : /^\+?inf$/i.test(s) ? Infinity : Number(s));

export function percentileSeries(rows: RangeRow[], q: number): { series: Array<[number, number]> | null; cap: number | null; bounds: number[]; overAt: number[] } {
  const bounds = [...new Set(rows.map((r) => leOf(r.metric.le)).filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  const cap = bounds.length ? bounds[bounds.length - 1]! : null;
  const byTime = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const le = leOf(r.metric.le);
    if (Number.isNaN(le)) continue;
    for (const [t, v] of r.values) {
      if (!Number.isFinite(v)) continue;
      const m = byTime.get(t) ?? byTime.set(t, new Map()).get(t)!;
      m.set(le, (m.get(le) ?? 0) + v);
    }
  }
  const out: Array<[number, number]> = [];
  const overAt: number[] = [];
  for (const [t, cum] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    const b = quantileBucket(cum, q);
    if (!b) continue;
    if (b.le === null) overAt.push(t);
    out.push([t, b.le ?? cap ?? 0]);
  }
  return { series: out.length ? out : null, cap, bounds, overAt };
}

const cache = new CacheManager<ApmMetricsResponse>(30, 60_000);

export async function getApmMetrics(env: Env, bearerToken: string | undefined, clusterId: string, spanMinutes: number, namespace?: string, application?: string, at?: number): Promise<ApmMetricsResponse> {
  if ((namespace && !NS.test(namespace)) || (application && !APP.test(application))) throw new HttpError(400, "invalid_service", "namespace / application: Kubernetes and Micrometer names");
  const span = Math.max(30, Math.min(7 * 1440, Math.round(spanMinutes)));
  const key = `${cachePrefix(bearerToken)}:apm-metrics:${clusterId.toLowerCase()}:${namespace ?? ""}/${application ?? ""}:${span}:${at ?? Math.floor(Date.now() / 60_000)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await collect(env, bearerToken, clusterId, span, namespace, application, at);
  if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : 60_000);
  return r;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, span: number, namespace?: string, application?: string, at?: number): Promise<ApmMetricsResponse> {
  const endS = at ?? Math.floor(Date.now() / 60_000) * 60;
  const startS = endS - span * 60;
  const step = stepFor(span);
  const wSec = Math.max(step, 300);
  const w = `${wSec / 60}m`;
  const base: ApmMetricsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", from: new Date(startS * 1000).toISOString(), to: new Date(endS * 1000).toISOString(), stepSeconds: step, services: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = String(endS);
    const scopeRows = (await runAll(fetcher, target.endpoint, { s: `group by (cluster) (${HTTP}_count)` }, 1, time)).rows.s ?? [];
    const scope = pickScope(scopeRows.map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
    if (scope === null) return { ...base, metricsState: "failed", message: "no http_server_requests series in this cluster" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    const C = scopeMatchers(scope, false);
    const inst: Record<string, string> = {
      services: `sum by (namespace, application) (${counterIncrease(`${HTTP}_count{${C},${NOT_ACTUATOR}}`, w)}) / ${wSec}`,
    };
    const S = namespace && application ? `${C},namespace=${promString(namespace)},application=${promString(application)}` : "";
    if (S) inst.pods = `group by (pod) (max_over_time(${HTTP}_count{${S}}[${span}m]))`;
    const d = await runAll(fetcher, target.endpoint, inst, 2, time, STACK_QUERY_TIMEOUT_MS);
    const services = (d.rows.services ?? []).filter((r) => r.metric.application).map((r) => ({ namespace: r.metric.namespace ?? "", application: r.metric.application!, rps: Number(r.value.toPrecision(4)) }))
      .sort((a, b) => (b.rps ?? 0) - (a.rps ?? 0) || (`${a.namespace}/${a.application}` < `${b.namespace}/${b.application}` ? -1 : 1));
    if (!S) return { ...base, services, ...(d.gaps.length ? { gaps: d.gaps } : {}) };
    const pods = (d.rows.pods ?? []).map((r) => r.metric.pod ?? "").filter(Boolean);
    const P = pods.length ? `${C},pod=~"${podAlternation(pods)}"` : `${C},pod="-"`;
    const queries = Object.fromEntries(Object.entries(APM_SIGNALS).map(([id, s]) => [id, s.q(S, P, w, wSec)]));
    queries.latency = `sum by (le) (${counterIncrease(`${HTTP}_bucket{${S},${NOT_ACTUATOR}}`, w)})`;
    const r = await rangeAll(fetcher, target.endpoint, queries, startS, endS, step);
    const failed = new Set(r.gaps.map((g) => g.query));
    const sections: NonNullable<ApmMetricsResponse["service"]>["sections"] = { golden: {}, runtime: {}, deps: {}, pods: {} };
    for (const [id, s] of Object.entries(APM_SIGNALS)) sections[s.section][id] = signal(id, s.unit, pointsOf(r.rows[id]), failed.has(id));
    const g = sections.golden;
    sections.golden.errShare = signal("errShare", "ratio", errorShare(g.reqOk!.series, g.req4xx!.series, g.req5xx!.series), ["reqOk", "req4xx", "req5xx"].some((x) => failed.has(x)));
    let bounds: number[] = [];
    for (const [id, q] of [["p50", 0.5], ["p95", 0.95], ["p99", 0.99]] as const) {
      const p = percentileSeries(r.rows.latency ?? [], q);
      bounds = p.bounds;
      sections.golden[id] = signal(id, "seconds", p.series, failed.has("latency"), p.cap ?? undefined, p.overAt);
    }
    // the PromQL shown: the pods' list as a placeholder
    const shown = Object.fromEntries(Object.entries(queries).map(([id, q]) => [id, q.replace(/pod=~"[^"]*"/g, 'pod=~"<pods>"')]));
    return {
      ...base, services, queries: shown,
      service: { namespace: namespace!, application: application!, pods: pods.length, sections, buckets: bounds },
      ...(d.gaps.length || r.gaps.length ? { gaps: [...d.gaps, ...r.gaps] } : {}),
    };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
