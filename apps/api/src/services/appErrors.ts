// 서비스 (APM) › 오류 — error events per application (Datadog Error Tracking / New Relic Errors inbox, the part a metric
// can answer): how many, since when, how the days compare, what is new — from the apps' own logging metrics.
//
// Measured on stg 2026-11-16: `log4j2_events_total` — 17 applications, 37 pods, one collector (alloy), level label
// (trace/debug/info/warn/error/fatal), present 25 days back, 0 resets in an hour, 124 ERROR in a day. `logback_events_total`
// is a known name with no series at all (now or 29 days back) — the earlier plan to use it was wrong. Neither metric has
// an exception class: which exception = the logs tab's insights (Loki, ≤ 6 h — a day-long regexp overloads Loki).
//
// Rules: counts are increase() over the window; the 7-day series is one range query (hourly increase) — first / last
// error hour, daily sums (UTC days), "new" = errors in the last 24 h and none in the 6 days before. The series' days that
// are not covered (the app did not exist) are 0 — said as "no series" only when the app has none at all.

import type { Env } from "../env.js";
import type { AppErrorSeries, AppErrorsResponse, RedWindow, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";

const QUERY_TIMEOUT_MS = 20_000;
export const ERROR_LEVELS = 'level=~"(?i)error|fatal"';
const HOUR = 3600;

/** The window queries for metric `m` within the scope matchers `C` (and `ksm` for the workloads) */
export function appErrorQueries(m: string, C: string, ksm: string, minutes: number): Record<string, string> {
  const sel = (extra: string) => `{${[C, extra].filter(Boolean).join(",")}}`;
  const k = (x: string) => `${x}${ksm ? `{${ksm}}` : ""}`;
  return {
    levels: `sum by (namespace, application, level) (increase(${m}${sel('level=~"(?i)error|fatal|warn"')}[${minutes}m]))`,
    workloads: `group by (namespace, deployment) (${k("kube_deployment_created")}) or group by (namespace, statefulset) (${k("kube_statefulset_created")}) or group by (namespace, daemonset) (${k("kube_daemonset_created")})`,
  };
}
/** The 7-day hourly series (a range query, step 1 h) */
export const hourlyQuery = (m: string, C: string) => `sum by (namespace, application) (increase(${m}{${[C, ERROR_LEVELS].filter(Boolean).join(",")}}[1h]))`;

type Series = { metric: Record<string, string>; values: Array<[number, number]> };
/** Midnight (UTC, epoch seconds) of the first of the 7 calendar days ending with the day that holds `end` − 1 s */
export const firstDayStart = (end: number) => Math.floor((end - 1) / 86400) * 86400 - 6 * 86400;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Pure: the applications from the window rows and the hourly series ending at `end` (epoch seconds) */
export function aggregateErrors(raw: Record<string, PromRow[]>, hourly: Series[] | null, end: number, failed: Set<string> = new Set()): AppErrorSeries[] {
  const apps = new Map<string, AppErrorSeries>();
  const app = (m: Record<string, string | undefined>) => {
    const a = m.application;
    if (!a) return null;
    let x = apps.get(a);
    if (!x) apps.set(a, (x = { application: a, namespace: m.namespace ?? null, workload: null, error: null, fatal: null, warn: null, daily: [], firstSeen: null, lastSeen: null, newIn24h: false }));
    x.namespace ??= m.namespace ?? null;
    return x;
  };
  const levelsRead = !failed.has("levels");
  for (const r of raw.levels ?? []) {
    const a = app(r.metric);
    if (!a) continue;
    const lv = (r.metric.level ?? "").toLowerCase() as "error" | "fatal" | "warn";
    if (lv !== "error" && lv !== "fatal" && lv !== "warn") continue;
    a[lv] = (a[lv] ?? 0) + r.value;
  }
  // increase() extrapolates (fractions): kept to 2 decimals so the apps add up to the total — rounding each app to a
  // whole number first made 730 of a 731 total (stg 2026-11-16)
  const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  if (levelsRead) for (const a of apps.values()) { a.error = r2(a.error ?? 0); a.fatal = r2(a.fatal ?? 0); a.warn = r2(a.warn ?? 0); }

  // A sample at t holds the hour that ENDS at t → its day is day(t − 1 s). The 7 days are calendar (UTC) days, the last
  // one up to `end` — the range starts at the first day's midnight (firstDayStart). A plain "7 × 24 h before end" spans 8
  // calendar days and dropped the oldest one's hours (stg 2026-11-16: 8,797 vs 9,109 for increase over the same span)
  const first = firstDayStart(end);
  const days = Array.from({ length: 7 }, (_, i) => day(first + i * 86400));
  for (const s of hourly ?? []) {
    const a = app(s.metric);
    if (!a) continue;
    const byDay = new Map(days.map((d) => [d, 0]));
    let first: number | null = null, last: number | null = null, recent = 0, before = 0;
    for (const [t, v] of s.values) {
      if (!(v > 0)) continue;
      const d = day(t - 1);
      if (byDay.has(d)) byDay.set(d, byDay.get(d)! + v);
      // the hour that ENDS at t holds the events
      first = first === null ? t - HOUR : Math.min(first, t - HOUR);
      last = last === null ? t : Math.max(last, t);
      if (t > end - 86400) recent += v; else before += v;
    }
    a.daily = days.map((d) => ({ day: d, errors: Math.round(byDay.get(d)! * 100) / 100 }));
    a.firstSeen = first === null ? null : new Date(first * 1000).toISOString();
    a.lastSeen = last === null ? null : new Date(last * 1000).toISOString();
    a.newIn24h = recent >= 0.5 && before < 0.5;
  }
  // service.name rule: a workload of exactly that name — in the app's namespace when known, else only one
  const named = new Map<string, NonNullable<AppErrorSeries["workload"]>[]>();
  for (const r of raw.workloads ?? []) {
    const ns = r.metric.namespace;
    const [name, kind] = r.metric.deployment ? [r.metric.deployment, "Deployment" as const] : r.metric.statefulset ? [r.metric.statefulset, "StatefulSet" as const] : r.metric.daemonset ? [r.metric.daemonset, "DaemonSet" as const] : [undefined, undefined];
    if (!ns || !name || !kind) continue;
    named.set(name, [...(named.get(name) ?? []), { namespace: ns, name, kind }]);
  }
  for (const a of apps.values()) {
    const same = (named.get(a.application) ?? []).filter((w) => !a.namespace || w.namespace === a.namespace);
    a.workload = same.length === 1 ? same[0]! : null;
    if (!a.daily.length && hourly) a.daily = days.map((d) => ({ day: d, errors: 0 }));
  }
  const errs = (a: AppErrorSeries) => (a.error ?? 0) + (a.fatal ?? 0);
  return [...apps.values()].sort((x, y) => errs(y) - errs(x) || Number(y.newIn24h) - Number(x.newIn24h) || cmp(x.application, y.application));
}

const cache = new CacheManager<AppErrorsResponse>(30, 60_000);
const inflight = new Map<string, Promise<AppErrorsResponse>>();

export async function getAppErrors(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<AppErrorsResponse> {
  const key = `${cachePrefix(bearerToken)}:apperr:${clusterId.toLowerCase()}:${minutes}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, minutes, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : at !== undefined ? 10 * 60_000 : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<AppErrorsResponse> {
  const base: AppErrorsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowMinutes: minutes, metricsState: "ok", metric: null, apps: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    // Which logging metric this cluster's apps write (Log4j2 or Logback), and its scope
    const scopeRun = await runAll(fetcher, target.endpoint, {
      log4j2_events_total: "group by (cluster, collector) (log4j2_events_total)",
      logback_events_total: "group by (cluster, collector) (logback_events_total)",
    }, 2, time, QUERY_TIMEOUT_MS);
    if (scopeRun.gaps.length === 2) throw scopeRun.firstError;
    const metric = (["log4j2_events_total", "logback_events_total"] as const).find((m) => (scopeRun.rows[m] ?? []).length) ?? null;
    if (!metric) return base;
    const scope = pickScope((scopeRun.rows[metric] ?? []).map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster", metric };
    if (scope === null) return { ...base, metric };
    const C = scopeMatchers(scope, false);
    const ksm = scope.cluster !== null ? `cluster=${promString(scope.cluster)}` : "";
    const queries = appErrorQueries(metric, C, ksm, minutes);
    const end = at ?? Math.floor(Date.now() / 1000 / HOUR) * HOUR;
    const hq = hourlyQuery(metric, C);
    const [run, hourly] = await Promise.all([
      runAll(fetcher, target.endpoint, queries, 2, time, QUERY_TIMEOUT_MS),
      (async () => {
        try {
          const r = (await fetcher.queryRange(target.endpoint, hq, String(firstDayStart(end) + HOUR), String(end), String(HOUR))) as { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> } };
          if (r.status && r.status !== "success") return null;
          return (r.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, values: (x.values ?? []).map(([t, v]) => [Number(t), Number(v)] as [number, number]) }));
        } catch { return null; }
      })(),
    ]);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (failed.has("levels") && !hourly) throw run.firstError;
    const gaps: StackQueryGap[] = [...run.gaps, ...(hourly ? [] : [{ query: "hourly", reason: "failed" as const }])];
    return { ...base, metric, queries: { levels: queries.levels!, hourly: `${hq}  (range: 7 d, step 1 h)` }, apps: aggregateErrors(run.rows, hourly, end, failed), ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
