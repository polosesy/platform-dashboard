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
// - Platform settings (services/sloSettingsStore.ts, AKS 모니터링 › SLO › 설정) override the connection file field by
//   field — the most specific wins (`targetsFor`). An error-budget reset counts a service's SLO window from the reset:
//   the 3-day parts wholly after it plus ONE extra query for the piece between the reset and the next part boundary
//   (`resetPlans` — filtered to that service, so it is cheap). The burn-rate windows (5 m – 3 d) are not reset.

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
import { readSloSettings, resetFor, sloSettingsDir, type SloSettingsDoc } from "./sloSettingsStore.js";
import type { SloBudgetReset, SloBudgetResetApplied } from "@aud/types";

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

type Source = "platform" | "config" | "default";
type Resolved = { availability: { target: number; source: Source }; latency: { thresholdMs: number; target: number; source: Source }; exclude: Set<string> };
/**
 * Pure: a service's targets — the most specific wins: the service's platform value › the service's file value
 * (`services["<ns>/<application>"]`) › the cluster's platform value › the file's top level › the defaults. Excluded URIs
 * add up; `exclude` (leave the service out) is the service's platform value › its file value.
 */
export function targetsFor(cfg: SloConfig | undefined, namespace: string, application: string, platform?: SloConfig): Resolved & { skip: boolean } {
  const key = `${namespace}/${application}`;
  const ps = platform?.services?.[key], fs = cfg?.services?.[key];
  const pick = <T>(f: (x: SloTargets | undefined) => T | undefined): { v: T; source: Source } | null => {
    for (const [x, source] of [[ps, "platform"], [fs, "config"], [platform, "platform"], [cfg, "config"]] as const) {
      const v = f(x);
      if (v !== undefined) return { v, source };
    }
    return null;
  };
  const av = pick((x) => x?.availability);
  const lat = pick((x) => x?.latency);
  return {
    availability: { target: av?.v ?? SLO_DEFAULTS.availability, source: av?.source ?? "default" },
    latency: { ...(lat?.v ?? SLO_DEFAULTS.latency), source: lat?.source ?? "default" },
    exclude: new Set([...(cfg?.excludeUris ?? []), ...(fs?.excludeUris ?? []), ...(platform?.excludeUris ?? []), ...(ps?.excludeUris ?? [])]),
    skip: (ps?.exclude ?? fs?.exclude) === true,
  };
}

/** A reset as the queries see it: counted from `ageMin` minutes before the window's end = `full` whole 3-day parts +
 *  `remMin` minutes of the next part (one extra query, `r<i>:…`) */
export type SloResetPlan = { reset: SloBudgetReset; ageMin: number; full: number; remMin: number };
const PART_MIN = SLO_PART_DAYS * 1440;
/** Pure: the active resets (inside the window, at or before its end) as query plans, newest first */
export function resetPlans(resets: SloBudgetReset[], endMs: number, windowDays: number): SloResetPlan[] {
  return resets
    .filter((r) => { const t = Date.parse(r.at); return Number.isFinite(t) && t <= endMs && t > endMs - windowDays * 86_400_000; })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((reset) => {
      const ageMin = Math.max(1, Math.floor((endMs - Date.parse(reset.at)) / 60_000));
      const full = Math.floor(ageMin / PART_MIN);
      return { reset, ageMin, full, remMin: ageMin - full * PART_MIN };
    });
}
/** Pure: which plan counts for a service (the latest matching reset) — index into `plans`, -1 = none */
export function planIndex(plans: SloResetPlan[], namespace: string, application: string): number {
  const best = resetFor(plans.map((p) => p.reset), namespace, application, Infinity, Infinity);
  return best ? plans.findIndex((p) => p.reset === best) : -1;
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

/** Pure: the queries — counts per window, the good-latency bucket per boundary, coverage and the workload names;
 *  per reset plan the piece between the reset and its part boundary (`r<i>:n` · `r<i>:g:<le>` · `r<i>:coverage`) */
export function sloQueries(C: string, ksm: string, windowDays: number, les: string[], plans: SloResetPlan[] = []): Record<string, string> {
  const sel = (m: string, ...extra: string[]) => `${m}{${[C, 'uri!~"/actuator.*"', ...extra].filter(Boolean).join(",")}}`;
  const n = (r: string, off = "", f = "") => `sum by (${BY}) (increase(${sel("http_server_requests_seconds_count", f)}[${r}]${off}))`;
  const g = (le: string, r: string, off = "", f = "") => `sum by (${BY}) (increase(${sel("http_server_requests_seconds_bucket", `le=${promString(le)}`, f)}[${r}]${off}))`;
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
  plans.forEach((p, i) => {
    if (p.remMin <= 0) return;
    const f = p.reset.service === "*" ? "" : (() => { const [ns, app] = splitService(p.reset.service); return `namespace=${promString(ns)},application=${promString(app)}`; })();
    const r = `${p.remMin}m`, off = p.full ? ` offset ${p.full * SLO_PART_DAYS}d` : "";
    q[`r${i}:n`] = n(r, off, f);
    for (const le of les) q[`r${i}:g:${le}`] = g(le, r, off, f);
    q[`r${i}:coverage`] = `count_over_time((sum by (namespace, application) (${sel("http_server_requests_seconds_count", f)}))[${r}:1h]${off})`;
  });
  const k = (m: string) => `${m}{${ksm}}`;
  q.deployments = `max by (namespace, deployment) (${k("kube_deployment_spec_replicas")}) > 0`;
  q.statefulsets = `max by (namespace, statefulset) (${k("kube_statefulset_replicas")}) > 0`;
  return q;
}

const splitService = (k: string): [string, string] => { const i = k.indexOf("/"); return [k.slice(0, i), k.slice(i + 1)]; };

/** Pure: the PromQL shown beside an SLI (one service, the SLO window — days, or a range such as `4320m` since a reset) */
export function sliExpr(C: string, kind: SloKind, namespace: string, application: string, windowDays: number | string, le: string | null): string {
  const m = [C, `namespace=${promString(namespace)}`, `application=${promString(application)}`, 'uri!~"/actuator.*"'].filter(Boolean).join(",");
  const w = `[${typeof windowDays === "number" ? `${windowDays}d` : windowDays}]`;
  if (kind === "availability") {
    return `1 - sum(increase(http_server_requests_seconds_count{${m},status=~"5.."}${w})) / sum(increase(http_server_requests_seconds_count{${m}}${w}))`;
  }
  return `sum(increase(http_server_requests_seconds_bucket{${m},status!~"1..",le=${promString(le ?? "")}}${w})) / sum(increase(http_server_requests_seconds_count{${m},status!~"1.."}${w}))`;
}

export type SloRaw = Record<string, PromRow[]>;

/**
 * Pure: the SLO window's parts summed into `n:<W>` / `g:<W>:<le>` / `coverage` (rows keyed by their whole label set);
 * a value with a part that failed is failed itself (never a partial sum shown as the window). A service with a reset
 * plan sums only the parts wholly after the reset plus the plan's own piece; a piece that failed = `failedPlans`
 * (those services say queryFailed — the others are unaffected).
 */
export function mergeSloParts(raw: SloRaw, failed: Set<string>, windowDays: number, les: string[], plans: SloResetPlan[] = []): { raw: SloRaw; failed: Set<string>; failedPlans: Set<number> } {
  const W = `${windowDays}d`;
  const parts = sloWindowParts(windowDays);
  const out: SloRaw = { ...raw };
  const outFailed = new Set(failed);
  const failedPlans = new Set<number>();
  const assigned = new Map<string, number>();
  const planOf = (m: Record<string, string>) => {
    const k = `${m.namespace ?? ""}/${m.application ?? ""}`;
    let i = assigned.get(k);
    if (i === undefined) { i = plans.length ? planIndex(plans, m.namespace ?? "", m.application ?? "") : -1; assigned.set(k, i); }
    return i;
  };
  const bases: Array<[string, string]> = [[`n:${W}`, "n"], ...les.map((le): [string, string] => [`g:${W}:${le}`, `g:${le}`]), ["coverage", "coverage"]];
  for (const [base, piece] of bases) {
    const keys = parts.map((_, i) => sloPartKey(base, windowDays, i));
    if (keys.some((k) => failed.has(k))) { out[base] = []; outFailed.add(base); continue; }
    const sum = new Map<string, PromRow>();
    const add = (r: PromRow) => {
      const id = Object.keys(r.metric).sort().map((l) => `${l}=${r.metric[l]}`).join("\u0000");
      const prev = sum.get(id);
      sum.set(id, prev ? { metric: prev.metric, value: prev.value + r.value } : { metric: r.metric, value: r.value });
    };
    keys.forEach((k, p) => {
      for (const r of raw[k] ?? []) {
        const i = planOf(r.metric);
        if (i < 0 || p < plans[i]!.full) add(r);
      }
    });
    plans.forEach((plan, i) => {
      if (plan.remMin <= 0) return;
      const k = `r${i}:${piece}`;
      if (failed.has(k)) { failedPlans.add(i); return; }
      for (const r of raw[k] ?? []) if (planOf(r.metric) === i) add(r);
    });
    out[base] = [...sum.values()];
  }
  return { raw: out, failed: outFailed, failedPlans };
}
type Counts = { events: number; bad: number; uris: Map<string, { uri: string; method: string; events: number; bad: number }> };
const RANK: Record<SloState, number> = { fastBurn: 7, exhausted: 6, slowBurn: 5, atRisk: 4, ok: 3, lowTraffic: 2, queryFailed: 1, noData: 0 };
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Pure: raw query rows → services (sorted: worst first) and the names without an SLI */
export function aggregateSlo(raw: SloRaw, opts: {
  cfg?: SloConfig; platform?: SloConfig; windowDays: number; les: string[]; C: string; failed?: Set<string>;
  plans?: SloResetPlan[]; failedPlans?: Set<number>;
}): { services: SloService[]; uninstrumented: WorkloadSloResponse["uninstrumented"] } {
  const W = `${opts.windowDays}d`;
  const failed = opts.failed ?? new Set<string>();
  const plans = opts.plans ?? [];
  const keyOf = (r: PromRow) => `${r.metric.namespace ?? ""}\u0000${r.metric.application ?? ""}`;
  const resolved = new Map<string, ReturnType<typeof targetsFor>>();
  const targets = (key: string) => {
    let t = resolved.get(key);
    if (!t) { const [ns, app] = key.split("\u0000"); t = targetsFor(opts.cfg, ns!, app!, opts.platform); resolved.set(key, t); }
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
    const pi = plans.length ? planIndex(plans, namespace, application) : -1;
    const plan = pi >= 0 ? plans[pi]! : null;
    const planFailed = pi >= 0 && (opts.failedPlans?.has(pi) ?? false);
    const slis: SloSli[] = [];
    for (const kind of ["availability", "latency"] as SloKind[]) {
      const target = kind === "availability" ? t.availability.target : t.latency.target;
      const allowed = 1 - target;
      const eff = kind === "latency" ? leFor(key) : null;
      const winFailed = (w: string) => (w === W && planFailed) || (kind === "availability" ? failed.has(`n:${w}`) : latencyFailed(w, key));
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
        topBad, expr: sliExpr(opts.C, kind, namespace, application, plan ? `${plan.ageMin}m` : opts.windowDays, eff?.le ?? null),
      });
    }
    const windowHours = plan ? Math.round((plan.ageMin / 60) * 10) / 10 : opts.windowDays * 24;
    const measured = coverage.get(key);
    const hours = measured === undefined ? undefined : Math.min(measured, Math.max(1, Math.ceil(windowHours)));
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
    if (!plan && hours !== undefined && hours < windowHours * SLO_COVERAGE_PARTIAL) advice.push({ id: "partialData", params: { days: Math.round((hours / 24) * 10) / 10, window: opts.windowDays } });
    const state = slis.reduce<SloState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), "noData");
    const workload = names.get(namespace)?.has(application) ? application : null;
    const reset: SloBudgetResetApplied | undefined = plan ? {
      id: plan.reset.id, at: plan.reset.at, scope: plan.reset.service === "*" ? "all" : "service", windowHours,
      ...(plan.reset.by ? { by: plan.reset.by } : {}), ...(plan.reset.reason ? { reason: plan.reset.reason } : {}),
    } : undefined;
    services.push({ namespace, application, workload, slis, state, coverage: hours === undefined ? null : { hours, windowHours }, advice, ...(reset ? { reset } : {}) });
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
  // The platform settings' version is part of the key: a save or a reset shows on the next read, not 5 minutes later
  const settings = await readSloSettings(sloSettingsDir(env), clusterId);
  const key = `${cachePrefix(bearerToken)}:slo:${clusterId.toLowerCase()}:${at ?? "now"}:v${settings.version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, settings, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? PARTIAL_TTL_MS : at !== undefined ? PAST_TTL_MS : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

const setsTargets = (c: SloConfig | undefined) => !!c && (c.availability !== undefined || c.latency !== undefined || !!c.services);

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, settings: SloSettingsDoc, at?: number): Promise<WorkloadSloResponse> {
  const obs = clusterConnection(env, clusterId).connection.aks?.observability;
  const cfg = obs?.slo as SloConfig | undefined;
  const platform = settings.settings as SloConfig;
  const windowDays = platform.windowDays ?? cfg?.windowDays ?? 30;
  const endMs = (at ?? Math.floor(Date.now() / 60_000) * 60) * 1000;
  const plans = resetPlans(settings.resets, endMs, windowDays);
  const base: WorkloadSloResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", cluster: null, windowDays, configured: setsTargets(cfg) || setsTargets(platform),
    settingsVersion: settings.version, windowSource: platform.windowDays ? "platform" : cfg?.windowDays ? "config" : "default",
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
    const thresholds = new Set([SLO_DEFAULTS.latency.thresholdMs, ...[cfg, platform].flatMap((c) => [
      ...(c?.latency ? [c.latency.thresholdMs] : []), ...Object.values(c?.services ?? {}).flatMap((s) => (s.latency ? [s.latency.thresholdMs] : []))])]);
    const used = [...new Set([...thresholds].map((ms) => effectiveBucket(les, ms)?.le).filter((x): x is string => !!x))];
    const run = await runAll(fetcher, target.endpoint, sloQueries(C, ksm, windowDays, used, plans), 4, time, SLO_QUERY_TIMEOUT_MS);
    const merged = mergeSloParts(run.rows, new Set(run.gaps.map((g) => g.query)), windowDays, used, plans);
    const failed = merged.failed;
    if (failed.has(`n:${windowDays}d`)) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    return {
      ...base, cluster: scope.cluster, instrumented: true,
      buckets: les.map(Number).sort((a, b) => a - b),
      ...aggregateSlo(merged.raw, { cfg, platform, windowDays, les: used, C, failed, plans, failedPlans: merged.failedPlans }),
      ...(gaps.length ? { gaps } : {}),
    };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
