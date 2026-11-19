// 모니터링 › 애플리케이션 › SLO › 서비스 상세 — Datadog's suite SLO page (docs.datadoghq.com/synthetics/test_suites:
// "the SLO status and error budget", "Global Uptime timeline", "Primary Contributors") for one service, from the same
// Micrometer counters as the SLO cards (services/workloadSlo.ts):
//   · the window = the service's own (settings `services[k].windowDays`) else the cluster's, counted from a later budget
//     reset when there is one (the card counts the same way);
//   · the global uptime bar = the window in ~168 buckets; per bucket requests and failed (5xx) → the bucket's SLI against
//     the availability target: ok · error (an SLI under the target) · noData (no request) — a fact per bucket, no model;
//   · primary contributors = the endpoints whose failed requests spent the budget, with their share of all failed;
//   · URIs: the service's core endpoints only (`onlyUris`, when set — Datadog's critical tests), never the excluded ones.
// Counters through counterIncrease (a series created inside a bucket counts from its first value — promScope.ts).
// The buckets and the window are read separately; the measured sums are compared in the test and on stg.

import type { Env } from "../env.js";
import type { PromRow } from "./hubbleMetrics.js";
import type { SloUptimeBucket, SloUptimeResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { counterIncrease, pickScope, promString, scopeMatchers } from "./promScope.js";
import { metricsStateOf } from "./hubbleMetrics.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { readSloSettings, resetFor, sloSettingsDir } from "./sloSettingsStore.js";
import { targetsFor, type SloConfig } from "./workloadSlo.js";

const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const APP = /^[\w.-]{0,128}$/;
/** about a week of hours — Datadog's bar has a mark per run; here a fixed number of buckets over any window */
export const UPTIME_BUCKETS = 168;
const STEPS_MIN = [60, 120, 180, 240, 360, 720];
const TIMEOUT_MS = 25_000;

/** Pure: the bucket length for a window — the smallest step that keeps the bar near UPTIME_BUCKETS */
export function bucketMinutes(windowMin: number): number {
  return STEPS_MIN.find((s) => windowMin / s <= UPTIME_BUCKETS * 1.1) ?? STEPS_MIN[STEPS_MIN.length - 1]!;
}

/** Pure: a URI list as a PromQL regex alternation (literal strings — every regex character escaped) */
export function uriAlternation(uris: string[]): string {
  return uris.map((u) => u.replace(/[\\.^$|?*+()[\]{}]/g, (c) => `\\${c}`)).join("|");
}

/** Pure: the bucket states from the per-bucket requests and failed requests (aligned by time) */
export function uptimeBuckets(total: Map<number, number>, bad: Map<number, number>, times: number[], target: number): SloUptimeBucket[] {
  return times.map((t) => {
    const n = total.get(t) ?? 0, b = Math.min(bad.get(t) ?? 0, n);
    if (!(n >= 0.5)) return { t, total: Math.round(n * 100) / 100, bad: 0, sli: null, state: "noData" as const };
    const sli = 1 - b / n;
    // a failed request inside a bucket whose SLI is under the target = an error bucket; fractions of increase() under
    // half a request are not a request
    return { t, total: Math.round(n * 100) / 100, bad: Math.round(b * 100) / 100, sli: Math.round(sli * 100000) / 100000, state: b >= 0.5 && sli < target ? "error" as const : "ok" as const };
  });
}

/** Pure: the window's totals from the buckets — requests, failed, SLI, the error budget and the uptime share */
export function uptimeTotals(buckets: SloUptimeBucket[], target: number): SloUptimeResponse["totals"] {
  const total = buckets.reduce((a, b) => a + b.total, 0), bad = buckets.reduce((a, b) => a + b.bad, 0);
  const judged = buckets.filter((b) => b.state !== "noData");
  const allowed = (1 - target) * total;
  return {
    total: Math.round(total), bad: Math.round(bad), sli: total > 0 ? Math.round((1 - bad / total) * 100000) / 100000 : null,
    allowed: Math.round(allowed * 100) / 100, budgetUsed: allowed > 0 ? Math.round((bad / allowed) * 1000) / 1000 : null,
    uptime: judged.length ? Math.round((judged.filter((b) => b.state === "ok").length / judged.length) * 10000) / 10000 : null,
  };
}

/** Pure: the endpoints that failed — share of all failed in the window, most first */
export function contributorsOf(byUri: PromRow[], totals: PromRow[], limit = 5): { contributors: SloUptimeResponse["contributors"]; consumedBy: number } {
  const key = (r: PromRow) => `${(r.metric.method ?? "").toUpperCase()} ${r.metric.uri ?? ""}`;
  const tot = new Map<string, number>();
  for (const r of totals) tot.set(key(r), (tot.get(key(r)) ?? 0) + r.value);
  const bad = new Map<string, { method: string; uri: string; bad: number }>();
  for (const r of byUri) {
    const k = key(r);
    const e = bad.get(k) ?? bad.set(k, { method: (r.metric.method ?? "").toUpperCase(), uri: r.metric.uri ?? "", bad: 0 }).get(k)!;
    e.bad += r.value;
  }
  const failed = [...bad.entries()].filter(([, e]) => e.bad >= 0.5);
  const all = failed.reduce((a, [, e]) => a + e.bad, 0);
  return {
    consumedBy: failed.length,
    contributors: failed.sort((a, b) => b[1].bad - a[1].bad || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([k, e]) => ({
      method: e.method, uri: e.uri, bad: Math.round(e.bad), total: Math.round(tot.get(k) ?? 0), share: all > 0 ? Math.round((e.bad / all) * 1000) / 1000 : 0,
    })),
  };
}

const cache = new CacheManager<SloUptimeResponse>(50, 5 * 60_000);

export async function getSloUptime(env: Env, bearerToken: string | undefined, clusterId: string, namespace: string, application: string, at?: number): Promise<SloUptimeResponse> {
  if (!NS.test(namespace) || !APP.test(application)) throw new HttpError(400, "invalid_service", "namespace / application: Kubernetes and Micrometer names");
  const obs = clusterConnection(env, clusterId).connection.aks?.observability;
  const cfg = obs?.slo as SloConfig | undefined;
  const settings = await readSloSettings(sloSettingsDir(env), clusterId);
  const platform = settings.settings as SloConfig;
  const clusterDays = platform.windowDays ?? cfg?.windowDays ?? 30;
  const t = targetsFor(cfg, namespace, application, platform);
  const windowDays = t.windowDays !== null && t.windowDays < clusterDays ? t.windowDays : clusterDays;
  const endMs = (at ?? Math.floor(Date.now() / 60_000) * 60) * 1000;
  // a later budget reset of this service (or of all) starts the window later — the card counts the same way
  const reset = resetFor(settings.resets, namespace, application, endMs, windowDays);
  const startMs = reset ? Math.max(endMs - windowDays * 86_400_000, Date.parse(reset.at)) : endMs - windowDays * 86_400_000;
  const windowMin = Math.max(5, Math.floor((endMs - startMs) / 60_000));
  const step = bucketMinutes(windowMin);
  const base: SloUptimeResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", namespace, application, target: t.availability.target, targetSource: t.availability.source,
    windowDays, windowSource: t.windowDays !== null && t.windowDays < clusterDays ? "service" : "cluster",
    from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(), bucketMinutes: step, buckets: [],
    totals: { total: 0, bad: 0, sli: null, allowed: 0, budgetUsed: null, uptime: null }, contributors: [], consumedBy: 0,
    only: t.only ? [...t.only] : [], excluded: [...t.exclude], ...(reset ? { reset: { at: reset.at, ...(reset.reason ? { reason: reset.reason } : {}) } } : {}),
    queries: { total: "", bad: "", byUri: "" },
  };
  const key = `${cachePrefix(bearerToken)}:slo-uptime:${clusterId.toLowerCase()}:${namespace}/${application}:${settings.version}:${at ?? Math.floor(endMs / 60_000)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    type R = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }> } };
    const rows = (r: unknown): PromRow[] => ((r as R)?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) })).filter((x) => Number.isFinite(x.value));
    const scopeRows = rows(await fetcher.query(target.endpoint, "group by (cluster, collector) (http_server_requests_seconds_count)", time, { timeoutMs: TIMEOUT_MS }));
    const scope = pickScope(scopeRows.map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (scope === null) return { ...base, metricsState: "failed", message: "no http_server_requests series in this cluster" };
    const m = [scopeMatchers(scope, false), `namespace=${promString(namespace)}`, `application=${promString(application)}`, 'uri!~"/actuator.*"',
      ...(t.exclude.size ? [`uri!~${promString(uriAlternation([...t.exclude]))}`] : []), ...(t.only ? [`uri=~${promString(uriAlternation([...t.only]))}`] : [])].filter(Boolean).join(",");
    const S = (extra = "") => `http_server_requests_seconds_count{${m}${extra}}`;
    const qTotal = `sum(${counterIncrease(S(), `${step}m`)})`;
    const qBad = `sum(${counterIncrease(S(',status=~"5.."'), `${step}m`)})`;
    // per URI over the same buckets (summed here) — one whole-window query per URI exceeded Azure's query cost limit on
    // stg (30 days: 4,857 series, cost 18,930 > 15,000 → 429); bucket by bucket it answers, and the contributors then add
    // up to the bar's failed requests exactly
    const qByUri = `sum by (method, uri) (${counterIncrease(S(',status=~"5.."'), `${step}m`)})`;
    const qTotalUri = `sum by (method, uri) (${counterIncrease(S(), `${step}m`)})`;
    // bucket i ends at start + (i+1)·step — its value is the increase over (end − step, end]
    const first = Math.floor(startMs / 1000) + step * 60, last = Math.floor(endMs / 1000);
    const times: number[] = [];
    for (let s = first; s <= last; s += step * 60) times.push(s * 1000);
    const range = async (q: string) => (await fetcher.queryRange(target.endpoint, q, String(first), String(last), String(step * 60))) as R;
    const series = async (q: string) => {
      const out = new Map<number, number>();
      for (const v of (await range(q))?.data?.result?.[0]?.values ?? []) out.set(Number(v[0]) * 1000, Number(v[1]));
      return out;
    };
    // a per-URI range answer summed over its buckets → one row per URI
    const summed = async (q: string): Promise<PromRow[]> => ((await range(q))?.data?.result ?? [])
      .map((x) => ({ metric: x.metric ?? {}, value: (x.values ?? []).reduce((a, v) => a + (Number.isFinite(Number(v[1])) ? Number(v[1]) : 0), 0) }));
    const [tot, bad, byUri, totUri] = await Promise.all([
      series(qTotal), series(qBad),
      summed(qByUri),
      summed(qTotalUri),
    ]);
    const buckets = uptimeBuckets(tot, bad, times, t.availability.target);
    const out: SloUptimeResponse = {
      ...base, buckets, totals: uptimeTotals(buckets, t.availability.target), ...contributorsOf(byUri, totUri),
      queries: { total: qTotal, bad: qBad, byUri: qByUri },
    };
    cache.set(key, out);
    return out;
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}

