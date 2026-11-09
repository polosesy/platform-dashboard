// Service SLO / SLI (AKS 모니터링 › SLO) — request SLIs per service from Micrometer's
// `http_server_requests_seconds` in the cluster's Azure Monitor workspace, with the Google SRE Workbook's error budget
// and multiwindow burn-rate alerts, and the URIs that spent the budget.
//
// Rules:
// - Micrometer only. The customer's spanmetrics counter resets ~1,270 times in 10 minutes (2026-11-05, stg — two
//   writers per series), so rate() over it is inflated ~800×; Micrometer: 0 resets in an hour, 30 days kept.
// - availability = requests not answered 5xx · latency = non-1xx requests finished within a histogram bucket boundary
//   at or under the threshold (no interpolation — the effective boundary is shown). /actuator is never counted.
// - Every window is queried per (namespace, application, uri, method, status) and summed here: one query gives both
//   SLIs' counts, the per-URI sources and the team's URI exclusions (a gateway's webhook path) apply everywhere alike.
// - Targets: the connection file (`aks.observability.slo`) or the marked defaults — "achievable" is only a reference.
// - Low traffic: when one bad request would use the whole budget, the ratio is shown but not judged (lowTraffic).
// - A query that does not answer is a gap: the values that need it say queryFailed; the window's counts failing
//   fails the page.
// - The SLO window is read in parts of at most SLO_PART_DAYS (`increase(…[3d] offset 3d·i)`, summed here): Azure
//   Monitor refuses ONE query whose cost — series × (range ÷ sample interval) ÷ 5000 — exceeds 15,000, and a range
//   counts every series alive during it (2026-11-09 stg: 501 series now, 6,898 over 30 days as pods are replaced →
//   cost ≈ 27,900 → 429 "expanding series … Query cost=27939 exceeds max limit=15000" on every try, not a rate limit).
//   A 3-day part: ≤ 2,500 series, cost ≈ 900–2,000; the parts sum to the single query within 0.005 % (6 d measured).

import type { Env } from "../env.js";
import type {
  SloAdvice, SloAlert, SloBadSource, SloBurnWindow, SloKind, SloService, SloSli, SloState, StackQueryGap, WorkloadSloResponse,
} from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";

/** Used when the connection file sets none — marked "default" on every SLI, never presented as the team's */
export const SLO_DEFAULTS = { availability: 0.999, latency: { thresholdMs: 1000, target: 0.99 } };
/** The usual targets a team picks from — "achievable" = the highest one the window met */
export const SLO_TIERS = [0.9, 0.95, 0.99, 0.995, 0.999, 0.9995, 0.9999];
export const BURN_WINDOWS: SloBurnWindow[] = ["5m", "30m", "1h", "6h", "3d"];
/**
 * The SRE Workbook's multiwindow, multi-burn-rate alerts for a 30-day SLO (ch. 5): 2 % of the budget in an hour or 5 %
 * in six hours = page, 10 % in three days = ticket; the short window stops the alert soon after the burn stops
 */
export const SLO_ALERTS: Omit<SloAlert, "firing">[] = [
  { id: "page1h", factor: 14.4, long: "1h", short: "5m" },
  { id: "page6h", factor: 6, long: "6h", short: "30m" },
  { id: "ticket3d", factor: 1, long: "3d", short: "6h" },
];
/** An alert's long window needs this many requests — fewer, and one failure reads as a huge burn */
export const SLO_MIN_BURN_EVENTS = 100;
export const SLO_AT_RISK = 0.75;
/** Under this share of the window with series, the SLI covers fewer days than the window says */
export const SLO_COVERAGE_PARTIAL = 0.9;
export const SLO_WINDOW_DAYS = [7, 14, 28, 30] as const;
/** A 3-day part takes 1 – 4 s on stg; the limit leaves room for a slow workspace */
export const SLO_QUERY_TIMEOUT_MS = 25_000;
/** The SLO window's part length — the 3d burn window is part 0 (see the header: Azure's per-query cost limit) */
export const SLO_PART_DAYS = 3;

export type SloTargets = { availability?: number; latency?: { thresholdMs: number; target: number }; excludeUris?: string[] };
export type SloConfig = SloTargets & { windowDays?: number; services?: Record<string, SloTargets & { exclude?: boolean }> };

type Resolved = { availability: { target: number; source: "config" | "default" }; latency: { thresholdMs: number; target: number; source: "config" | "default" }; exclude: Set<string> };
/** Pure: a service's targets — `services["<ns>/<application>"]` over the file's top level over the defaults */
export function targetsFor(cfg: SloConfig | undefined, namespace: string, application: string): Resolved & { skip: boolean } {
  const svc = cfg?.services?.[`${namespace}/${application}`];
  const av = svc?.availability ?? cfg?.availability;
  const lat = svc?.latency ?? cfg?.latency;
  return {
    availability: { target: av ?? SLO_DEFAULTS.availability, source: av !== undefined ? "config" : "default" },
    latency: { ...(lat ?? SLO_DEFAULTS.latency), source: lat ? "config" : "default" },
    exclude: new Set([...(cfg?.excludeUris ?? []), ...(svc?.excludeUris ?? [])]),
    skip: svc?.exclude === true,
  };
}

/** Pure: the bucket boundary counted for a threshold — the largest at or under it (null = none) */
export function effectiveBucket(les: string[], thresholdMs: number): { le: string; ms: number } | null {
  let best: { le: string; ms: number } | null = null;
  for (const le of les) {
    const s = Number(le);
    if (!Number.isFinite(s)) continue; // +Inf
    const ms = s * 1000;
    if (ms <= thresholdMs * (1 + 1e-9) && (!best || ms > best.ms)) best = { le, ms };
  }
  return best;
}

const BY = "namespace, application, uri, method, status";

/** Pure: the SLO window as consecutive parts, newest first — part 0 is the 3d burn window itself (no extra query) */
export function sloWindowParts(windowDays: number): Array<{ range: string; offset: string }> {
  const parts: Array<{ range: string; offset: string }> = [];
  for (let from = 0; from < windowDays; from += SLO_PART_DAYS) {
    parts.push({ range: `${Math.min(SLO_PART_DAYS, windowDays - from)}d`, offset: from ? ` offset ${from}d` : "" });
  }
  return parts;
}
/** Pure: the query name of part i of an SLO-window value (`n:30d`, `g:30d:<le>`, `coverage`) — part 0 of the counts
 *  is the 3d burn window's own query */
export function sloPartKey(base: string, windowDays: number, i: number): string {
  const first = sloWindowParts(windowDays)[0]!;
  return i === 0 && base !== "coverage" && first.range === `${SLO_PART_DAYS}d` ? base.replace(`:${windowDays}d`, `:${SLO_PART_DAYS}d`) : `${base}#${i}`;
}

/** Pure: the queries — counts per window, the good-latency bucket per boundary, coverage and the workload names */
export function sloQueries(C: string, ksm: string, windowDays: number, les: string[]): Record<string, string> {
  const sel = (m: string, extra = "") => `${m}{${[C, 'uri!~"/actuator.*"', extra].filter(Boolean).join(",")}}`;
  const n = (r: string, off = "") => `sum by (${BY}) (increase(${sel("http_server_requests_seconds_count")}[${r}]${off}))`;
  const g = (le: string, r: string, off = "") => `sum by (${BY}) (increase(${sel("http_server_requests_seconds_bucket", `le=${promString(le)}`)}[${r}]${off}))`;
  const q: Record<string, string> = {};
  for (const w of BURN_WINDOWS) {
    q[`n:${w}`] = n(w);
    for (const le of les) q[`g:${w}:${le}`] = g(le, w);
  }
  const W = `${windowDays}d`;
  sloWindowParts(windowDays).forEach((p, i) => {
    q[sloPartKey(`n:${W}`, windowDays, i)] ??= n(p.range, p.offset);
    for (const le of les) q[sloPartKey(`g:${W}:${le}`, windowDays, i)] ??= g(le, p.range, p.offset);
    q[sloPartKey("coverage", windowDays, i)] = `count_over_time((sum by (namespace, application) (${sel("http_server_requests_seconds_count")}))[${p.range}:1h]${p.offset})`;
  });
  const k = (m: string) => `${m}{${ksm}}`;
  q.deployments = `max by (namespace, deployment) (${k("kube_deployment_spec_replicas")}) > 0`;
  q.statefulsets = `max by (namespace, statefulset) (${k("kube_statefulset_replicas")}) > 0`;
  return q;
}

/** Pure: the PromQL shown beside an SLI (one service, the SLO window) */
export function sliExpr(C: string, kind: SloKind, namespace: string, application: string, windowDays: number, le: string | null): string {
  const m = [C, `namespace=${promString(namespace)}`, `application=${promString(application)}`, 'uri!~"/actuator.*"'].filter(Boolean).join(",");
  const w = `[${windowDays}d]`;
  if (kind === "availability") {
    return `1 - sum(increase(http_server_requests_seconds_count{${m},status=~"5.."}${w})) / sum(increase(http_server_requests_seconds_count{${m}}${w}))`;
  }
  return `sum(increase(http_server_requests_seconds_bucket{${m},status!~"1..",le=${promString(le ?? "")}}${w})) / sum(increase(http_server_requests_seconds_count{${m},status!~"1.."}${w}))`;
}

export type SloRaw = Record<string, PromRow[]>;

/**
 * Pure: the SLO window's parts summed into `n:<W>` / `g:<W>:<le>` / `coverage` (rows keyed by their whole label set);
 * a value with a part that failed is failed itself (never a partial sum shown as the window)
 */
export function mergeSloParts(raw: SloRaw, failed: Set<string>, windowDays: number, les: string[]): { raw: SloRaw; failed: Set<string> } {
  const W = `${windowDays}d`;
  const parts = sloWindowParts(windowDays);
  const out: SloRaw = { ...raw };
  const outFailed = new Set(failed);
  for (const base of [`n:${W}`, ...les.map((le) => `g:${W}:${le}`), "coverage"]) {
    const keys = parts.map((_, i) => sloPartKey(base, windowDays, i));
    if (keys.some((k) => failed.has(k))) { out[base] = []; outFailed.add(base); continue; }
    const sum = new Map<string, PromRow>();
    for (const k of keys) {
      for (const r of raw[k] ?? []) {
        const id = Object.keys(r.metric).sort().map((l) => `${l}=${r.metric[l]}`).join("\u0000");
        const prev = sum.get(id);
        sum.set(id, prev ? { metric: prev.metric, value: prev.value + r.value } : { metric: r.metric, value: r.value });
      }
    }
    out[base] = [...sum.values()];
  }
  return { raw: out, failed: outFailed };
}
type Counts = { events: number; bad: number; uris: Map<string, { uri: string; method: string; events: number; bad: number }> };
const RANK: Record<SloState, number> = { fastBurn: 7, exhausted: 6, slowBurn: 5, atRisk: 4, ok: 3, lowTraffic: 2, queryFailed: 1, noData: 0 };
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Pure: raw query rows → services (sorted: worst first) and the names without an SLI */
export function aggregateSlo(raw: SloRaw, opts: {
  cfg?: SloConfig; windowDays: number; les: string[]; C: string; failed?: Set<string>;
}): { services: SloService[]; uninstrumented: WorkloadSloResponse["uninstrumented"] } {
  const W = `${opts.windowDays}d`;
  const failed = opts.failed ?? new Set<string>();
  const keyOf = (r: PromRow) => `${r.metric.namespace ?? ""}\u0000${r.metric.application ?? ""}`;
  const resolved = new Map<string, ReturnType<typeof targetsFor>>();
  const targets = (key: string) => {
    let t = resolved.get(key);
    if (!t) { const [ns, app] = key.split("\u0000"); t = targetsFor(opts.cfg, ns!, app!); resolved.set(key, t); }
    return t;
  };
  const leFor = (key: string) => effectiveBucket(opts.les, targets(key).latency.thresholdMs);

  // Per window and SLI: requests and bad ones per service (and per URI for the SLO window)
  const tally = (w: string, kind: SloKind): Map<string, Counts> => {
    const out = new Map<string, Counts>();
    const add = (key: string, uri: string, method: string, events: number, bad: number) => {
      let c = out.get(key);
      if (!c) { c = { events: 0, bad: 0, uris: new Map() }; out.set(key, c); }
      c.events += events; c.bad += bad;
      if (w !== W) return;
      const uk = `${method} ${uri}`;
      const u = c.uris.get(uk) ?? { uri, method, events: 0, bad: 0 };
      u.events += events; u.bad += bad;
      c.uris.set(uk, u);
    };
    for (const r of raw[`n:${w}`] ?? []) {
      const key = keyOf(r);
      const t = targets(key);
      const uri = r.metric.uri ?? "";
      if (t.skip || t.exclude.has(uri)) continue;
      const status = r.metric.status ?? "";
      if (kind === "availability") add(key, uri, r.metric.method ?? "", r.value, /^5/.test(status) ? r.value : 0);
      else if (!/^1/.test(status)) add(key, uri, r.metric.method ?? "", r.value, r.value);
    }
    if (kind === "latency") {
      // bad = requests − those within the boundary (each service its own boundary)
      for (const le of opts.les) {
        for (const r of raw[`g:${w}:${le}`] ?? []) {
          const key = keyOf(r);
          const t = targets(key);
          const uri = r.metric.uri ?? "";
          if (t.skip || t.exclude.has(uri) || /^1/.test(r.metric.status ?? "") || leFor(key)?.le !== le) continue;
          const c = out.get(key);
          if (!c) continue;
          c.bad -= r.value;
          if (w === W) { const u = c.uris.get(`${r.metric.method ?? ""} ${uri}`); if (u) u.bad -= r.value; }
        }
      }
      for (const c of out.values()) { c.bad = Math.max(0, c.bad); for (const u of c.uris.values()) u.bad = Math.max(0, u.bad); }
    }
    return out;
  };
  const latencyFailed = (w: string, key: string) => failed.has(`n:${w}`) || (leFor(key) ? failed.has(`g:${w}:${leFor(key)!.le}`) : false);
  const hasBuckets = new Set(opts.les.flatMap((le) => (raw[`g:${W}:${le}`] ?? []).map(keyOf)));

  const windows: Record<string, { availability: Map<string, Counts>; latency: Map<string, Counts> }> = {};
  for (const w of [...BURN_WINDOWS, W]) windows[w] = { availability: tally(w, "availability"), latency: tally(w, "latency") };
  const coverage = new Map((raw.coverage ?? []).map((r) => [keyOf(r), r.value] as const));

  const names = new Map<string, Set<string>>();
  const kinds = new Map<string, "Deployment" | "StatefulSet">();
  for (const [q, label, kind] of [["deployments", "deployment", "Deployment"], ["statefulsets", "statefulset", "StatefulSet"]] as const) {
    for (const r of raw[q] ?? []) {
      const ns = r.metric.namespace ?? "", n = r.metric[label] ?? "";
      if (!names.has(ns)) names.set(ns, new Set());
      names.get(ns)!.add(n);
      kinds.set(`${ns}/${n}`, kind);
    }
  }

  const keys = new Set([...(raw[`n:${W}`] ?? []).map(keyOf)].filter((k) => !targets(k).skip));
  const services: SloService[] = [];
  for (const key of keys) {
    const [namespace, application] = key.split("\u0000") as [string, string];
    const t = targets(key);
    const slis: SloSli[] = [];
    for (const kind of ["availability", "latency"] as SloKind[]) {
      const target = kind === "availability" ? t.availability.target : t.latency.target;
      const allowed = 1 - target;
      const eff = kind === "latency" ? leFor(key) : null;
      const winFailed = (w: string) => (kind === "availability" ? failed.has(`n:${w}`) : latencyFailed(w, key));
      const c = windows[W]![kind].get(key);
      const events = c ? c.events : 0;
      const bad = c ? c.bad : 0;
      const measurable = kind === "availability" || (eff !== null && hasBuckets.has(key));
      const burn = BURN_WINDOWS.map((w) => {
        if (winFailed(w) || !measurable) return { window: w, rate: null, events: null };
        const x = windows[w]![kind].get(key);
        const n = x?.events ?? 0;
        return { window: w, rate: n > 0 ? round((x!.bad / n) / allowed) : 0, events: Math.round(n) };
      });
      const rateOf = (w: SloBurnWindow) => burn.find((b) => b.window === w)!;
      const alerts: SloAlert[] = SLO_ALERTS.map((a) => {
        const L = rateOf(a.long), S = rateOf(a.short);
        const firing = L.rate === null || S.rate === null || (L.events ?? 0) < SLO_MIN_BURN_EVENTS ? null : L.rate > a.factor && S.rate > a.factor;
        return { ...a, firing };
      });
      const sli = measurable && events > 0 ? 1 - bad / events : null;
      const budgetUsed = measurable && events > 0 ? round(bad / (allowed * events)) : null;
      let state: SloState;
      if (winFailed(W)) state = "queryFailed";
      else if (!measurable) state = "noData";
      else if (allowed * events < 1) state = "lowTraffic";
      else if (alerts.some((a) => a.firing && a.id !== "ticket3d")) state = "fastBurn";
      else if ((budgetUsed ?? 0) >= 1) state = "exhausted";
      else if (alerts.some((a) => a.firing && a.id === "ticket3d")) state = "slowBurn";
      else if ((budgetUsed ?? 0) >= SLO_AT_RISK) state = "atRisk";
      else state = "ok";
      const topBad: SloBadSource[] = state === "queryFailed" || !measurable || !c ? [] : [...c.uris.values()]
        .filter((u) => u.bad >= 0.5).sort((a, b) => b.bad - a.bad || (a.uri < b.uri ? -1 : 1)).slice(0, 3)
        .map((u) => ({ uri: u.uri, method: u.method, bad: Math.round(u.bad), events: Math.round(u.events) }));
      slis.push({
        kind, target, targetSource: kind === "availability" ? t.availability.source : t.latency.source,
        ...(kind === "latency" ? { thresholdMs: t.latency.thresholdMs, effectiveMs: eff ? Math.round(eff.ms * 1000) / 1000 : null } : {}),
        events: state === "queryFailed" ? null : Math.round(events), bad: state === "queryFailed" || !measurable ? null : Math.round(bad),
        sli: state === "queryFailed" ? null : sli, budgetUsed: state === "queryFailed" ? null : budgetUsed, burn, alerts, state,
        achievable: sli === null || state === "lowTraffic" ? null : [...SLO_TIERS].reverse().find((x) => sli >= x) ?? null,
        topBad, expr: sliExpr(opts.C, kind, namespace, application, opts.windowDays, eff?.le ?? null),
      });
    }
    const hours = coverage.get(key);
    const windowHours = opts.windowDays * 24;
    const advice: SloAdvice[] = [];
    if (application === "") advice.push({ id: "noApplication" });
    for (const s of slis) {
      if (s.state === "fastBurn") advice.push({ id: "fastBurn", sli: s.kind, params: { alerts: s.alerts.filter((a) => a.firing).map((a) => a.id).join(",") } });
      if (s.state === "exhausted" || (s.state === "fastBurn" && (s.budgetUsed ?? 0) >= 1)) advice.push({ id: "exhausted", sli: s.kind, params: { used: Math.round((s.budgetUsed ?? 0) * 100) } });
      if (s.state === "slowBurn") advice.push({ id: "slowBurn", sli: s.kind });
      if (s.state === "atRisk") advice.push({ id: "atRisk", sli: s.kind, params: { used: Math.round((s.budgetUsed ?? 0) * 100) } });
      if (["fastBurn", "exhausted", "slowBurn", "atRisk"].includes(s.state) && s.topBad[0] && s.bad) {
        advice.push({ id: "topBad", sli: s.kind, params: { method: s.topBad[0].method.toUpperCase(), uri: s.topBad[0].uri, share: Math.round((s.topBad[0].bad / s.bad) * 100) } });
      }
      if (s.state === "lowTraffic") advice.push({ id: "lowTraffic", sli: s.kind, params: { events: s.events ?? 0 } });
      if (s.kind === "latency" && s.state === "noData") advice.push({ id: "noHistogram" });
      if (s.kind === "latency" && s.effectiveMs != null && s.thresholdMs !== undefined && s.effectiveMs < s.thresholdMs - 0.5) {
        advice.push({ id: "thresholdNotBucket", params: { asked: s.thresholdMs, counted: Math.round(s.effectiveMs) } });
      }
    }
    if (hours !== undefined && hours < windowHours * SLO_COVERAGE_PARTIAL) advice.push({ id: "partialData", params: { days: Math.round((hours / 24) * 10) / 10, window: opts.windowDays } });
    const state = slis.reduce<SloState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), "noData");
    const workload = names.get(namespace)?.has(application) ? application : null;
    services.push({ namespace, application, workload, slis, state, coverage: hours === undefined ? null : { hours, windowHours }, advice });
  }
  const worstUse = (s: SloService) => Math.max(...s.slis.map((x) => x.budgetUsed ?? -1));
  services.sort((a, b) => RANK[b.state] - RANK[a.state] || worstUse(b) - worstUse(a) || (a.namespace + a.application < b.namespace + b.application ? -1 : 1));

  const withSli = new Map<string, Set<string>>();
  for (const s of services) { if (!withSli.has(s.namespace)) withSli.set(s.namespace, new Set()); withSli.get(s.namespace)!.add(s.application); }
  const uninstrumented: WorkloadSloResponse["uninstrumented"] = [];
  for (const [ns, apps] of withSli) {
    for (const n of [...(names.get(ns) ?? [])].sort()) if (!apps.has(n)) uninstrumented.push({ namespace: ns, name: n, kind: kinds.get(`${ns}/${n}`)! });
  }
  return { services, uninstrumented };
}

// ── Collection ──

type PromResponse = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }; error?: string };
const rowsOf = (resp: unknown): PromRow[] => {
  const r = resp as PromResponse;
  if (r?.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
  return (r?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) })).filter((x) => Number.isFinite(x.value));
};

const cache = new CacheManager<WorkloadSloResponse>(20, 5 * 60_000);
const PARTIAL_TTL_MS = 30_000;
const PAST_TTL_MS = 10 * 60_000;
const inflight = new Map<string, Promise<WorkloadSloResponse>>();

/** `at` = the window's end (epoch seconds, on a minute) for a view of the past; none = now */
export async function getWorkloadSlo(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<WorkloadSloResponse> {
  const key = `${cachePrefix(bearerToken)}:slo:${clusterId.toLowerCase()}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? PARTIAL_TTL_MS : at !== undefined ? PAST_TTL_MS : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, at?: number): Promise<WorkloadSloResponse> {
  const obs = clusterConnection(env, clusterId).connection.aks?.observability;
  const cfg = obs?.slo as SloConfig | undefined;
  const windowDays = cfg?.windowDays ?? 30;
  const base: WorkloadSloResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", cluster: null, windowDays, configured: !!cfg && (cfg.availability !== undefined || cfg.latency !== undefined || !!cfg.services),
    defaults: SLO_DEFAULTS, buckets: [], instrumented: false, services: [], uninstrumented: [],
    grafana: obs?.grafana ? { endpoint: obs.grafana.endpoint.replace(/\/+$/, ""), datasources: obs.grafana.datasources ?? {} } : null,
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    const ask = async (q: string) => rowsOf(await fetcher.query(target.endpoint, q, time, { timeoutMs: SLO_QUERY_TIMEOUT_MS }));
    // The scope of the HTTP series themselves: two collectors scraping the apps would double every count
    const scopeRows = await ask("group by (cluster, collector) (http_server_requests_seconds_count)");
    const scope = pickScope(scopeRows.map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (scope === null) return base; // instrumented: false — the page explains how to expose the metrics
    const C = scopeMatchers(scope, false);
    const ksm = scope.cluster !== null ? `cluster=${promString(scope.cluster)}` : "";
    const les = [...new Set((await ask(`count by (le) (http_server_requests_seconds_bucket{${[C, 'uri!~"/actuator.*"'].filter(Boolean).join(",")}})`)).map((r) => r.metric.le ?? ""))]
      .filter((le) => Number.isFinite(Number(le)));
    // Only the boundaries some service counts with (one per distinct threshold)
    const thresholds = new Set([SLO_DEFAULTS.latency.thresholdMs, ...(cfg?.latency ? [cfg.latency.thresholdMs] : []),
      ...Object.values(cfg?.services ?? {}).flatMap((s) => (s.latency ? [s.latency.thresholdMs] : []))]);
    const used = [...new Set([...thresholds].map((ms) => effectiveBucket(les, ms)?.le).filter((x): x is string => !!x))];
    const run = await runAll(fetcher, target.endpoint, sloQueries(C, ksm, windowDays, used), 4, time, SLO_QUERY_TIMEOUT_MS);
    const merged = mergeSloParts(run.rows, new Set(run.gaps.map((g) => g.query)), windowDays, used);
    const failed = merged.failed;
    if (failed.has(`n:${windowDays}d`)) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    return {
      ...base, cluster: scope.cluster, instrumented: true,
      buckets: les.map(Number).sort((a, b) => a - b),
      ...aggregateSlo(merged.raw, { cfg, windowDays, les: used, C, failed }),
      ...(gaps.length ? { gaps } : {}),
    };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
