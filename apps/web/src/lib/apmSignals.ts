// 서비스 (APM) › 서비스 맵 — per-service signals (Datadog's "filter by signal: Latency · Error Rate · Request Volume"),
// as facts with a stated rule, never a model or an unstated threshold (docs/architecture/apm-parity.md 4d):
//   error   = server spans with status ERROR in the window (RED), else failed calls into it (service graph) — any > 0
//   latency = p95 bucket now above the p95 bucket of the same window a week ago (RED weekAgo) — buckets, no interpolation
//   volume  = requests now vs a week ago ×2 or more, or ½ or less
// Latency and volume are judged only with RED_MIN_REQUESTS (= API workloadRed.ts) on the larger side — a handful of
// requests says nothing. Callers / callees = distinct services on the service graph (the map's own lines).
import type { RedQuantile, RedService, ServiceGraphResponse } from "@aud/types";

/** = apps/api workloadRed.ts RED_MIN_REQUESTS (test checks they stay equal) */
export const SIGNAL_MIN_REQUESTS = 20;
/** volume: this many times more, or this fraction or less, than a week ago */
export const VOLUME_FACTOR = 2;

export type SignalKind = "error" | "latency" | "volume";
export type ServiceSignals = {
  error?: { count: number; rate: number | null; requests: number; basis: "spans" | "graph" };
  latency?: { now: RedQuantile; weekAgo: RedQuantile };
  volume?: { now: number; weekAgo: number; ratio: number | null };
  /** distinct services calling it / it calls (service graph, self calls excluded) */
  callers: number;
  callees: number;
};

/** p95 bucket order: a bound, or above the last bucket (le null) = highest */
const rank = (q: RedQuantile) => (q.le === null ? Infinity : q.le);

/** Pure: the signals of every service on the map (entries — callers outside the traces — get none) */
export function serviceSignals(graph: Pick<ServiceGraphResponse, "nodes" | "edges">, red: RedService[] | null): Map<string, ServiceSignals> {
  const redOf = new Map((red ?? []).map((r) => [r.service, r]));
  const callers = new Map<string, Set<string>>(), callees = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.client === e.server) continue;
    (callers.get(e.server) ?? callers.set(e.server, new Set()).get(e.server)!).add(e.client);
    (callees.get(e.client) ?? callees.set(e.client, new Set()).get(e.client)!).add(e.server);
  }
  const out = new Map<string, ServiceSignals>();
  for (const n of graph.nodes) {
    if (n.entry) continue;
    const s: ServiceSignals = { callers: callers.get(n.service)?.size ?? 0, callees: callees.get(n.service)?.size ?? 0 };
    const r = redOf.get(n.service);
    if (r && r.errors > 0) s.error = { count: r.errors, rate: r.errorRate, requests: r.requests, basis: "spans" };
    else if (n.inbound.failed > 0) s.error = { count: n.inbound.failed, rate: n.inbound.errorRate, requests: n.inbound.requests, basis: "graph" };
    const w = r?.weekAgo;
    if (r && w) {
      const enough = Math.max(r.requests, w.requests) >= SIGNAL_MIN_REQUESTS;
      if (enough && r.p95 && w.p95 && r.requests >= SIGNAL_MIN_REQUESTS && w.requests >= SIGNAL_MIN_REQUESTS && rank(r.p95) > rank(w.p95)) {
        s.latency = { now: r.p95, weekAgo: w.p95 };
      }
      if (enough) {
        const ratio = w.requests > 0 ? r.requests / w.requests : null;
        if (ratio === null || ratio >= VOLUME_FACTOR || ratio <= 1 / VOLUME_FACTOR) s.volume = { now: r.requests, weekAgo: w.requests, ratio };
      }
    }
    out.set(n.service, s);
  }
  return out;
}

/** Pure: how many services carry each signal (the filter chips' counts) */
export function signalCounts(signals: Map<string, ServiceSignals>): Record<SignalKind, number> {
  const c = { error: 0, latency: 0, volume: 0 };
  for (const s of signals.values()) { if (s.error) c.error++; if (s.latency) c.latency++; if (s.volume) c.volume++; }
  return c;
}

export type CoverageRow = { namespace: string; workload: string; kinds: string[] };
export type Coverage = { namespaces: string[]; total: number; traced: number; untraced: CoverageRow[]; unmatchedServices: string[] };

/**
 * Pure: instrumentation coverage (Datadog's "explore which services need instrumentation") — scope = the namespaces
 * where at least one workload sends traces (no guessing which namespaces are "system"); in them, the running workloads
 * (app-metrics: every pod owner) that no trace service is matched to. A service is matched to a workload by the service
 * graph / RED workload (exact name), or by an exact name match in a scope namespace. Services matched to no workload
 * are listed apart — their workload could be one of the "untraced" ones under another name.
 */
export function instrumentationCoverage(
  graph: Pick<ServiceGraphResponse, "nodes">, red: RedService[] | null,
  workloads: Array<{ namespace: string; workload: string; kinds: Array<{ kind: string }> }>,
): Coverage {
  const key = (ns: string, w: string) => `${ns}/${w}`;
  const traced = new Set<string>();
  // matched = the service graph or RED already named its workload
  const services: Array<{ service: string; namespace: string | null; matched: boolean }> = [];
  const add = (service: string, namespace: string | null, matched: boolean) => {
    const s = services.find((x) => x.service === service);
    if (!s) services.push({ service, namespace, matched });
    else { s.matched ||= matched; s.namespace ??= namespace; }
  };
  for (const n of graph.nodes) {
    if (n.entry) continue;
    if (n.workload) traced.add(key(n.workload.namespace, n.workload.name));
    add(n.service, n.namespace ?? n.workload?.namespace ?? null, !!n.workload);
  }
  for (const r of red ?? []) {
    if (r.workload) traced.add(key(r.workload.namespace, r.workload.name));
    add(r.service, r.workload?.namespace ?? null, !!r.workload);
  }
  const scope = new Set<string>([...traced].map((k) => k.slice(0, k.indexOf("/"))));
  for (const s of services) if (s.namespace) scope.add(s.namespace);
  // a service whose name is exactly a workload's name in a scope namespace
  const unmatched: string[] = [];
  for (const s of services) {
    if (s.matched) continue;
    const hits = workloads.filter((w) => w.workload === s.service && scope.has(w.namespace) && (!s.namespace || w.namespace === s.namespace));
    if (hits.length) for (const h of hits) traced.add(key(h.namespace, h.workload));
    else unmatched.push(s.service);
  }
  const inScope = workloads.filter((w) => scope.has(w.namespace));
  const untraced = inScope.filter((w) => !traced.has(key(w.namespace, w.workload)))
    .map((w) => ({ namespace: w.namespace, workload: w.workload, kinds: w.kinds.map((k) => k.kind) }))
    .sort((a, b) => (a.namespace + "/" + a.workload < b.namespace + "/" + b.workload ? -1 : 1));
  return { namespaces: [...scope].sort(), total: inScope.length, traced: inScope.length - untraced.length, untraced, unmatchedServices: [...new Set(unmatched)].sort() };
}

/** Pure: the services that carry a signal (null = no filter) */
export function withSignal(signals: Map<string, ServiceSignals>, kind: SignalKind | null): Set<string> | null {
  if (!kind) return null;
  return new Set([...signals].filter(([, s]) => !!s[kind]).map(([k]) => k));
}

// ── the card's band and footnote (2026-11-18 — Datadog service discovery: "Critical error rate", "High latency",
// "Critical dependency", "High fan-out") — each word is a stated rule, nothing is a model ──

/** = apps/api workloadSlo.ts SLO_DEFAULTS.availability and the SRE Workbook page factor (burn ×14.4 over 1 h) — tested */
export const DEFAULT_AVAILABILITY = 0.999;
export const FAST_BURN = 14.4;
/** The error rate that burns a 99.9 % budget at the paging speed (2 % of a 30-day budget in an hour) = 1.44 % */
export const CRITICAL_ERROR_RATE = Math.round(FAST_BURN * (1 - DEFAULT_AVAILABILITY) * 1e6) / 1e6;
/** A shared dependency: called by at least this many services (a failure there reaches more than one caller) */
export const SHARED_DEP_MIN = 2;
/** High fan-out: calls at least this many services (one request waits on all of them — any slow one slows it) */
export const FANOUT_MIN = 3;

export type BandLevel = "critical" | "high" | "info";
export type BandLabel = "errorCritical" | "errors" | "latency" | "volumeUp" | "volumeDown" | "volumeNew";
export type Band = { kind: SignalKind; level: BandLevel; label: BandLabel };

/**
 * Pure: a service's bands, worst first —
 *   errorCritical (critical) = error rate ≥ CRITICAL_ERROR_RATE on at least SIGNAL_MIN_REQUESTS requests
 *   errors (high)            = any other error
 *   latency (high)           = the latency signal (p95 bucket above a week ago)
 *   volume (info)            = ×2 up, ½ down, or new — a change, not a fault: no warning colour
 */
export function bandsOf(s: ServiceSignals | null | undefined): Band[] {
  if (!s) return [];
  const out: Band[] = [];
  if (s.error) {
    const critical = s.error.rate !== null && s.error.requests >= SIGNAL_MIN_REQUESTS && s.error.rate >= CRITICAL_ERROR_RATE;
    out.push({ kind: "error", level: critical ? "critical" : "high", label: critical ? "errorCritical" : "errors" });
  }
  if (s.latency) out.push({ kind: "latency", level: "high", label: "latency" });
  if (s.volume) out.push({ kind: "volume", level: "info", label: s.volume.ratio === null ? "volumeNew" : s.volume.ratio >= 1 ? "volumeUp" : "volumeDown" });
  return out;
}

/** Pure: the footnote under a card — shared dependency (callers) and high fan-out (callees), null = not one */
export function notesOf(s: ServiceSignals | null | undefined): { shared: number | null; fanout: number | null } {
  return {
    shared: s && s.callers >= SHARED_DEP_MIN ? s.callers : null,
    fanout: s && s.callees >= FANOUT_MIN ? s.callees : null,
  };
}

/** Pure: the window's short code and words ("15m" · 15 min, "1h" · 1 hour) — the frame head's "15m Past 15 minutes" */
export function windowText(minutes: number): { short: string; n: number; unit: "min" | "hour" } {
  if (minutes >= 60 && minutes % 60 === 0) return { short: `${minutes / 60}h`, n: minutes / 60, unit: "hour" };
  return { short: `${minutes}m`, n: minutes, unit: "min" };
}

/** Pure: the list's rows — the services on the map that carry the chosen signal (all of them with none), worst bands
 *  first (critical error 8 · error 4 · latency 2 · volume 1, summed), then most requests, then name. The same set the
 *  map highlights. */
export function serviceRows<C extends { id: string; kind: string; name: string; inRequests: number }>(
  cards: C[], signals: Map<string, ServiceSignals>, marked: Set<string> | null,
): C[] {
  const W: Record<BandLabel, number> = { errorCritical: 8, errors: 4, latency: 2, volumeUp: 1, volumeDown: 1, volumeNew: 1 };
  const weight = (s: ServiceSignals | undefined) => bandsOf(s).reduce((n, b) => n + W[b.label], 0);
  return cards.filter((c) => c.kind === "service" && (!marked || marked.has(c.id)))
    .sort((a, b) => weight(signals.get(b.id)) - weight(signals.get(a.id)) || b.inRequests - a.inRequests || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
