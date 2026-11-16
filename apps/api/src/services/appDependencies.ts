// 서비스 (APM) › 의존성 — what each application calls outside the traced services and what it waits on (Datadog
// external services · AppDynamics backends · New Relic externals / databases / queues), from the applications' own
// Micrometer metrics in the cluster's Azure Monitor workspace — vendor-neutral names, the same on any cloud.
//
// Measured on stg 2026-11-16 (1 h): outbound HTTP from 23 application × target pairs in two tag conventions — classic
// (`client_name` · `status` · `outcome` · `exception`, 535 requests) and Observation (`clientname` · `http_status_code`
// · `error`, 1,618 requests, 6 apps); no histogram (`_bucket` 0 series) → average and max only; JDBC pools 24 series
// (pending 0, timeouts 0); Kafka consumers 15 series (lag 0); one collector (alloy); `application` equals the trace
// service.name for 10 of 11 apps.
//
// Rules:
// - Failed = status 5xx, a status naming an I/O failure without a response (IO_ERROR / CLIENT_ERROR as a *status*), or an
//   exception / error tag other than none — never 4xx (the server-side definition used by RED and the service map).
// - Latency: sum / count (average) and max_over_time of `_max` — the timer has no buckets, so no percentile is claimed.
// - A family that does not answer is a gap; its values are null (not 0). No family at all = not instrumented.
// - application ↔ service map: exact name only.

import type { Env } from "../env.js";
import type { AppDependencies, AppDependenciesResponse, DbPool, KafkaConsumer, OutboundCall, RedWindow, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";

const QUERY_TIMEOUT_MS = 20_000;
const OUT_BY = "namespace, application, client_name, clientname, status, http_status_code, outcome, exception, error";
const APP = "namespace, application";

/** The queries for one window (minutes) within the scope matchers `C` */
export function dependencyQueries(C: string, minutes: number): Record<string, string> {
  const s = C ? `{${C}}` : "";
  const w = `[${minutes}m]`;
  return {
    outCount: `sum by (${OUT_BY}) (increase(http_client_requests_seconds_count${s}${w}))`,
    outSum: `sum by (${APP}, client_name, clientname) (increase(http_client_requests_seconds_sum${s}${w}))`,
    outMax: `max by (${APP}, client_name, clientname) (max_over_time(http_client_requests_seconds_max${s}${w}))`,
    poolActive: `max by (${APP}, pool) (hikaricp_connections_active${s})`,
    poolMax: `max by (${APP}, pool) (hikaricp_connections_max${s})`,
    poolPending: `max by (${APP}, pool) (hikaricp_connections_pending${s})`,
    poolPendingPeak: `max by (${APP}, pool) (max_over_time(hikaricp_connections_pending${s}${w}))`,
    poolTimeouts: `sum by (${APP}, pool) (increase(hikaricp_connections_timeout_total${s}${w}))`,
    poolAcquireSum: `sum by (${APP}, pool) (increase(hikaricp_connections_acquire_seconds_sum${s}${w}))`,
    poolAcquireCount: `sum by (${APP}, pool) (increase(hikaricp_connections_acquire_seconds_count${s}${w}))`,
    kafkaLag: `max by (${APP}, topic) (kafka_consumer_fetch_manager_records_lag_max${s})`,
    kafkaLagPeak: `max by (${APP}, topic) (max_over_time(kafka_consumer_fetch_manager_records_lag_max${s}${w}))`,
  };
}

const NONE = /^(|none)$/i;
/** Pure: whether an outbound request (its tags) failed — 5xx, an I/O failure as status, an exception / error tag; not 4xx */
export function outboundFailed(m: Record<string, string | undefined>): boolean {
  const status = (m.status ?? m.http_status_code ?? "").trim();
  if (/^5\d\d$/.test(status)) return true;
  if (/^(io_error|client_error)$/i.test(status)) return true;
  return !NONE.test((m.exception ?? "").trim()) || !NONE.test((m.error ?? "").trim());
}
const targetOf = (m: Record<string, string | undefined>) => m.client_name ?? m.clientname ?? "";
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the applications from the query rows (`failed` = names of the queries that did not answer) */
export function aggregateDependencies(raw: Record<string, PromRow[]>, minutes: number, serviceNames: ReadonlySet<string>, failed: Set<string> = new Set()): AppDependencies[] {
  const apps = new Map<string, AppDependencies>();
  const app = (m: Record<string, string | undefined>): AppDependencies | null => {
    const a = m.application;
    if (!a) return null;
    let x = apps.get(a);
    if (!x) apps.set(a, (x = { application: a, namespace: m.namespace ?? null, inServiceMap: serviceNames.has(a), outbound: [], pools: [], consumers: [] }));
    x.namespace ??= m.namespace ?? null;
    return x;
  };
  const val = (q: string, key: (m: Record<string, string | undefined>) => string) => {
    const out = new Map<string, number>();
    if (failed.has(q)) return null;
    for (const r of raw[q] ?? []) out.set(key(r.metric), (out.get(key(r.metric)) ?? 0) + r.value);
    return out;
  };

  // Outbound HTTP
  type O = { call: OutboundCall; status: Map<string, number> };
  const outs = new Map<string, O>();
  const okey = (m: Record<string, string | undefined>) => `${m.application}\u0000${targetOf(m)}`;
  for (const r of raw.outCount ?? []) {
    const a = app(r.metric);
    if (!a || !(r.value >= 0)) continue;
    const k = okey(r.metric);
    let o = outs.get(k);
    if (!o) {
      o = { call: { target: targetOf(r.metric), convention: r.metric.client_name !== undefined ? "micrometer" : "observation", requests: 0, rate: 0, failed: 0, errorRate: null, avg: null, max: null, statuses: [] }, status: new Map() };
      outs.set(k, o);
      a.outbound.push(o.call);
    }
    o.call.requests += r.value;
    if (outboundFailed(r.metric)) o.call.failed += r.value;
    const st = r.metric.status ?? r.metric.http_status_code ?? "";
    o.status.set(st, (o.status.get(st) ?? 0) + r.value);
  }
  const sums = val("outSum", okey), maxes = val("outMax", okey);
  for (const [k, o] of outs) {
    const c = o.call;
    c.rate = round(c.requests / (minutes * 60), 4);
    c.errorRate = c.requests > 0 ? round(c.failed / c.requests, 5) : null;
    c.avg = sums && c.requests > 0 && sums.has(k) ? round(sums.get(k)! / c.requests, 4) : null;
    c.max = maxes?.has(k) ? round(maxes.get(k)!, 4) : null;
    c.requests = round(c.requests); c.failed = round(c.failed);
    c.statuses = [...o.status.entries()].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).slice(0, 6).map(([status, n]) => ({ status, requests: round(n) }));
  }

  // JDBC pools
  const pkey = (m: Record<string, string | undefined>) => `${m.application}\u0000${m.pool ?? ""}`;
  const pv = Object.fromEntries(["poolActive", "poolMax", "poolPending", "poolPendingPeak", "poolTimeouts", "poolAcquireSum", "poolAcquireCount"].map((q) => [q, val(q, pkey)]));
  const pools = new Map<string, DbPool>();
  for (const q of ["poolMax", "poolActive", "poolPending"]) for (const r of raw[q] ?? []) {
    const a = app(r.metric);
    const k = pkey(r.metric);
    if (!a || pools.has(k)) continue;
    const get = (n: string) => (pv[n]?.has(k) ? round(pv[n]!.get(k)!, 4) : null);
    const cnt = get("poolAcquireCount"), sum = get("poolAcquireSum");
    const p: DbPool = {
      pool: r.metric.pool ?? "", active: get("poolActive"), max: get("poolMax"), pending: get("poolPending"), pendingPeak: get("poolPendingPeak"),
      timeouts: get("poolTimeouts"), acquireAvg: cnt && cnt > 0 && sum !== null ? round(sum / cnt, 5) : null,
    };
    pools.set(k, p);
    a.pools.push(p);
  }

  // Kafka consumers
  const kkey = (m: Record<string, string | undefined>) => `${m.application}\u0000${m.topic ?? ""}`;
  const lag = val("kafkaLag", kkey), peak = val("kafkaLagPeak", kkey);
  const seen = new Set<string>();
  for (const r of [...(raw.kafkaLag ?? []), ...(raw.kafkaLagPeak ?? [])]) {
    const a = app(r.metric);
    const k = kkey(r.metric);
    if (!a || seen.has(k)) continue;
    seen.add(k);
    const c: KafkaConsumer = { topic: r.metric.topic ?? "", lag: lag?.has(k) ? Math.round(lag.get(k)!) : null, lagPeak: peak?.has(k) ? Math.round(peak.get(k)!) : null };
    a.consumers.push(c);
  }

  for (const a of apps.values()) {
    a.outbound.sort((x, y) => y.failed - x.failed || y.requests - x.requests || cmp(x.target, y.target));
    a.pools.sort((x, y) => (y.pendingPeak ?? 0) - (x.pendingPeak ?? 0) || cmp(x.pool, y.pool));
    a.consumers.sort((x, y) => (y.lagPeak ?? 0) - (x.lagPeak ?? 0) || cmp(x.topic, y.topic));
  }
  return [...apps.values()].sort((x, y) => cmp(x.application, y.application));
}

const cache = new CacheManager<AppDependenciesResponse>(30, 60_000);
const PARTIAL_TTL_MS = 15_000;
const PAST_TTL_MS = 10 * 60_000;
const inflight = new Map<string, Promise<AppDependenciesResponse>>();

/** `at` = the window's end (epoch seconds) for a view of the past; none = now */
export async function getAppDependencies(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<AppDependenciesResponse> {
  const key = `${cachePrefix(bearerToken)}:deps:${clusterId.toLowerCase()}:${minutes}:${at ?? "now"}`;
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

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<AppDependenciesResponse> {
  const base: AppDependenciesResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowMinutes: minutes, metricsState: "ok", instrumented: false, apps: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    // The scope of the three families: two collectors writing them would double the counts
    const scopeRun = await runAll(fetcher, target.endpoint, {
      scope: "group by (cluster, collector) (http_client_requests_seconds_count or hikaricp_connections_pending or kafka_consumer_fetch_manager_records_lag_max)",
      names: "group by (client) (traces_service_graph_request_total) or group by (server) (traces_service_graph_request_total)",
    }, 2, time, QUERY_TIMEOUT_MS);
    if (scopeRun.gaps.some((g) => g.query === "scope")) throw scopeRun.firstError;
    const scope = pickScope((scopeRun.rows.scope ?? []).map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (scope === null) return base;
    const serviceNames = new Set((scopeRun.rows.names ?? []).flatMap((r) => [r.metric.client, r.metric.server].filter((x): x is string => !!x)));
    const queries = dependencyQueries(scopeMatchers(scope, false), minutes);
    const run = await runAll(fetcher, target.endpoint, queries, 4, time, QUERY_TIMEOUT_MS);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (failed.size === Object.keys(queries).length) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    return { ...base, instrumented: true, queries, apps: aggregateDependencies(run.rows, minutes, serviceNames, failed), ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
