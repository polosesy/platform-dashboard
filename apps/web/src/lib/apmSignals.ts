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
  error?: { count: number; rate: number | null; basis: "spans" | "graph" };
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
    if (r && r.errors > 0) s.error = { count: r.errors, rate: r.errorRate, basis: "spans" };
    else if (n.inbound.failed > 0) s.error = { count: n.inbound.failed, rate: n.inbound.errorRate, basis: "graph" };
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
