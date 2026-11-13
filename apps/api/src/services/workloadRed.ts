// AKS 모니터링 › SLO › RED (트레이스) — Rate · Errors · Duration per service from the trace pipeline's spanmetrics in
// the cluster's Azure Monitor workspace (Alloy's `traces_spanmetrics_calls_total` and
// `traces_spanmetrics_duration_seconds_bucket`).
//
// Rules:
// - Server spans only (`span_kind` server) — a client span is the caller's view of someone else's request. /actuator
//   is apart (stg 2026-11-13: 83 % of the server spans are health and metrics scrapes) and shown as its own rate.
// - Errors = server spans with status ERROR (OpenTelemetry HTTP semantics: a server span is ERROR for 5xx or an
//   exception while handling it, not for 4xx) — close to, not the same as, Micrometer's 5xx.
// - Duration = the bucket holding the quantile ("≤ 0.5 s"), never interpolated; above the last boundary = "> 30 s".
// - Trust check: resets() over the window. The counter used to reset ~1,270× in 10 minutes (two writers per series,
//   2026-11-05) — rate() then inflated ~800×; fixed by the customer 2026-11-06, measured 0 on 2026-11-12/13. Resets
//   > 0 are said beside the numbers, never hidden.
// - service.name ↔ workload: only a workload of exactly that name, and only when one namespace has it (no namespace
//   label on the series) — else none, with how many had the name. Never by a similar name.
// - Values come from the window's increase(); a query that does not answer is a gap (calls failing fails the page).

import type { Env } from "../env.js";
import type { RedEndpoint, RedQuantile, RedService, RedWindow, StackQueryGap, WorkloadRedResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";

export const RED_WINDOWS: RedWindow[] = [5, 15, 60, 360, 1440];
/** Fewer requests than this in the window: ratios and quantiles are shown, not judged */
export const RED_MIN_REQUESTS = 20;
export const RED_TOP_ENDPOINTS = 5;
const QUERY_TIMEOUT_MS = 20_000;

const SERVER = 'span_kind=~"(?i)(span_kind_)?server"';
const ACTUATOR = /actuator/i;
const isError = (status: string | undefined) => /error$/i.test(status ?? "");

/** The queries for one window (minutes) within the scope matchers `C` and the kube-state-metrics matcher `ksm` */
export function redQueries(C: string, ksm: string, minutes: number): Record<string, string> {
  const sel = (extra: string[]) => `{${[C, SERVER, ...extra].filter(Boolean).join(",")}}`;
  const k = (m: string) => `${m}${ksm ? `{${ksm}}` : ""}`;
  return {
    calls: `sum by (service_name, span_name, status_code) (increase(traces_spanmetrics_calls_total${sel([])}[${minutes}m]))`,
    buckets: `sum by (service_name, span_name, le) (increase(traces_spanmetrics_duration_seconds_bucket${sel(['span_name!~"(?i).*actuator.*"'])}[${minutes}m]))`,
    resets: `sum(resets(traces_spanmetrics_calls_total{${C}}[${minutes}m]))`,
    workloads: `group by (namespace, deployment) (${k("kube_deployment_created")}) or group by (namespace, statefulset) (${k("kube_statefulset_created")}) or group by (namespace, daemonset) (${k("kube_daemonset_created")})`,
  };
}

/** Pure: the bucket holding quantile q of cumulative counts by boundary (seconds; Infinity = +Inf) — null without requests */
export function quantileBucket(cum: Map<number, number>, q: number): RedQuantile | null {
  const les = [...cum.keys()].sort((a, b) => a - b);
  const total = cum.get(Infinity) ?? (les.length ? cum.get(les[les.length - 1]!)! : 0);
  if (!(total > 0)) return null;
  for (const le of les) if (le !== Infinity && cum.get(le)! / total >= q) return { le };
  return { le: null };
}

const leOf = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  if (/^\+?inf$/i.test(s)) return Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Pure: the services from the query rows (`failed` = names of the queries that did not answer) */
export function aggregateRed(raw: Record<string, PromRow[]>, minutes: number, failed: Set<string> = new Set()): { services: RedService[]; buckets: number[]; resets: number | null } {
  type Acc = { requests: number; errors: number; actuator: number; spans: Map<string, { requests: number; errors: number }>; cum: Map<number, number>; spanCum: Map<string, Map<number, number>> };
  const by = new Map<string, Acc>();
  const acc = (s: string): Acc => {
    let a = by.get(s);
    if (!a) by.set(s, (a = { requests: 0, errors: 0, actuator: 0, spans: new Map(), cum: new Map(), spanCum: new Map() }));
    return a;
  };
  for (const r of raw.calls ?? []) {
    const s = r.metric.service_name;
    if (!s || !(r.value > 0)) continue;
    const a = acc(s);
    const name = r.metric.span_name ?? "";
    if (ACTUATOR.test(name)) { a.actuator += r.value; continue; }
    a.requests += r.value;
    const e = isError(r.metric.status_code) ? r.value : 0;
    a.errors += e;
    const sp = a.spans.get(name) ?? { requests: 0, errors: 0 };
    sp.requests += r.value; sp.errors += e;
    a.spans.set(name, sp);
  }
  const buckets = new Set<number>();
  for (const r of raw.buckets ?? []) {
    const s = r.metric.service_name, le = leOf(r.metric.le);
    if (!s || le === null) continue;
    if (le !== Infinity) buckets.add(le);
    const a = acc(s);
    a.cum.set(le, (a.cum.get(le) ?? 0) + r.value);
    const name = r.metric.span_name ?? "";
    const m = a.spanCum.get(name) ?? new Map<number, number>();
    m.set(le, (m.get(le) ?? 0) + r.value);
    a.spanCum.set(name, m);
  }
  // service.name → the workload of exactly that name (no namespace label on the series)
  const named = new Map<string, Array<{ namespace: string; name: string; kind: "Deployment" | "StatefulSet" | "DaemonSet" }>>();
  for (const r of raw.workloads ?? []) {
    const ns = r.metric.namespace;
    const [name, kind] = r.metric.deployment ? [r.metric.deployment, "Deployment" as const] : r.metric.statefulset ? [r.metric.statefulset, "StatefulSet" as const] : r.metric.daemonset ? [r.metric.daemonset, "DaemonSet" as const] : [undefined, undefined];
    if (!ns || !name || !kind) continue;
    named.set(name, [...(named.get(name) ?? []), { namespace: ns, name, kind }]);
  }
  const noDuration = failed.has("buckets");
  const services: RedService[] = [...by.entries()]
    .filter(([, a]) => a.requests > 0 || a.actuator > 0)
    .map(([service, a]) => {
      const same = named.get(service) ?? [];
      const endpoints: RedEndpoint[] = [...a.spans.entries()]
        .sort((x, y) => y[1].requests - x[1].requests || (x[0] < y[0] ? -1 : 1))
        .slice(0, RED_TOP_ENDPOINTS)
        .map(([name, sp]) => ({ name, requests: round(sp.requests), errors: round(sp.errors), p95: noDuration ? null : quantileBucket(a.spanCum.get(name) ?? new Map(), 0.95) }));
      const q = (p: number) => (noDuration ? null : quantileBucket(a.cum, p));
      return {
        service, workload: same.length === 1 ? same[0]! : null, sameName: same.length,
        requests: round(a.requests), rate: round(a.requests / (minutes * 60), 4), errors: round(a.errors),
        errorRate: a.requests > 0 ? round(a.errors / a.requests, 5) : null,
        p50: q(0.5), p95: q(0.95), p99: q(0.99),
        actuatorRate: round(a.actuator / (minutes * 60), 4),
        endpoints, lowTraffic: a.requests < RED_MIN_REQUESTS,
      };
    })
    // busiest first, then by name — a service with errors is not reordered: there is no threshold to rank by
    .sort((x, y) => y.requests - x.requests || (x.service < y.service ? -1 : 1));
  const resets = failed.has("resets") ? null : round(raw.resets?.[0]?.value ?? 0);
  return { services, buckets: [...buckets].sort((a, b) => a - b), resets };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const cache = new CacheManager<WorkloadRedResponse>(30, 60_000);
const PARTIAL_TTL_MS = 15_000;
const PAST_TTL_MS = 10 * 60_000;
const inflight = new Map<string, Promise<WorkloadRedResponse>>();

/** `at` = the window's end (epoch seconds) for a view of the past; none = now */
export async function getWorkloadRed(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<WorkloadRedResponse> {
  const key = `${cachePrefix(bearerToken)}:red:${clusterId.toLowerCase()}:${minutes}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, minutes, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? PARTIAL_TTL_MS : at !== undefined ? PAST_TTL_MS : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<WorkloadRedResponse> {
  const base: WorkloadRedResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowMinutes: minutes, metricsState: "ok", instrumented: false, buckets: [], resets: null, services: [],
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    // The scope of the spanmetrics series themselves: two collectors writing them would double every count
    const scopeRun = await runAll(fetcher, target.endpoint, { scope: "group by (cluster, collector) (traces_spanmetrics_calls_total)" }, 1, time, QUERY_TIMEOUT_MS);
    if (scopeRun.gaps.length) throw scopeRun.firstError;
    const scopeRows = scopeRun.rows.scope ?? [];
    const scope = pickScope(scopeRows.map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (scope === null) return base; // instrumented: false — the view explains what produces the series
    const C = scopeMatchers(scope, false);
    const ksm = scope.cluster !== null ? `cluster=${promString(scope.cluster)}` : "";
    const run = await runAll(fetcher, target.endpoint, redQueries(C, ksm, minutes), 4, time, QUERY_TIMEOUT_MS);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (failed.has("calls")) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    return { ...base, instrumented: true, ...aggregateRed(run.rows, minutes, failed), ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
