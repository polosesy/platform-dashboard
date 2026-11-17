// 서비스 (APM) › 트레이스 — pure view model (API services/grafanaTraces.ts): the trace list's windows and filters, one
// trace as a waterfall (span tree in start order, bars on the trace's own time axis), durations as text. No colour from
// thresholds — a span is marked only by its own status (ERROR = ▲).

import type { RedService, TraceSpan, TraceSummary } from "@aud/types";

/** Search windows (minutes) = RED's, so a problem group's count (spanmetrics) and its traces cover the same minutes */
export const TRACE_WINDOWS = [5, 15, 60, 360, 1440] as const;
/** "at least" choices for a trace's slowest matching span (ms; 0 = any) */
export const TRACE_MIN_DURATIONS = [0, 100, 500, 1000, 5000] as const;

export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export type WaterfallRow = { span: TraceSpan; depth: number; leftPct: number; widthPct: number; children: number };

/**
 * Pure: the span tree in start order — each span under its parent, siblings by start; a span whose parent is not in
 * the trace (not received, or cut by the cap) starts its own branch at depth 0. Bars: offset and length on the trace's
 * time axis (a zero-length span still shows a hairline).
 */
export function waterfall(spans: TraceSpan[], totalMs?: number): WaterfallRow[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const s of spans) {
    if (s.parentId && ids.has(s.parentId) && s.parentId !== s.spanId) {
      const list = kids.get(s.parentId) ?? [];
      list.push(s);
      kids.set(s.parentId, list);
    } else roots.push(s);
  }
  const byStart = (a: TraceSpan, z: TraceSpan) => a.offsetMs - z.offsetMs || (a.spanId < z.spanId ? -1 : 1);
  const total = totalMs && totalMs > 0 ? totalMs : Math.max(1e-6, ...spans.map((s) => s.offsetMs + s.durationMs));
  const out: WaterfallRow[] = [];
  const seen = new Set<string>();
  const walk = (s: TraceSpan, depth: number) => {
    if (seen.has(s.spanId)) return; // a cycle in bad data — never loop
    seen.add(s.spanId);
    const children = (kids.get(s.spanId) ?? []).sort(byStart);
    out.push({
      span: s, depth, children: children.length,
      leftPct: Math.min(100, (s.offsetMs / total) * 100),
      widthPct: Math.max(0.3, Math.min(100 - Math.min(100, (s.offsetMs / total) * 100), (s.durationMs / total) * 100)),
    });
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) walk(r, 0);
  return out;
}

/** Pure: one trace's counts for the header line */
export function traceCounts(spans: TraceSpan[]): { spans: number; errors: number; services: number } {
  return { spans: spans.length, errors: spans.filter((s) => s.status === "error").length, services: new Set(spans.map((s) => s.service ?? "")).size };
}

/** Pure: a search row's error spans (all services) */
export const rowErrors = (t: TraceSummary) => t.services.reduce((n, s) => n + s.errors, 0);
export const rowSpans = (t: TraceSummary) => t.services.reduce((n, s) => n + s.spans, 0);

/** Pure: the stack trace of a span (OpenTelemetry `exception` event), for the details' code box */
export function exceptionOf(s: TraceSpan): { type: string | null; message: string | null; stack: string | null } | null {
  const e = s.events.find((x) => x.name === "exception");
  if (!e) return null;
  const v = (k: string) => e.attributes.find((a) => a.key === k)?.value ?? null;
  return { type: v("exception.type"), message: v("exception.message"), stack: v("exception.stacktrace") };
}

/**
 * A problem group = one endpoint (service × span name) from spanmetrics — complete counts, not limited like a trace
 * search. errors: endpoints with error spans, most first. slow: the slowest p95 buckets (above the last bucket first);
 * its trace filter is the p95 bucket's lower edge, so the traces shown are the ones at or above p95's bucket.
 */
export type ProblemGroup = {
  kind: "errors" | "slow";
  service: string;
  name: string;
  /** errors: error spans in the window · slow: requests in the window */
  count: number;
  requests: number;
  p95: { le: number | null } | null;
  /** slow: the p95 bucket's lower edge (ms) — the trace filter */
  minDurationMs?: number;
};

/** the API's span-name rule (no quotes, backslashes, line breaks) — other names get no trace link */
const SAFE_NAME = /^[^"\\\r\n\t]{1,200}$/;

export function problemGroups(services: RedService[], buckets: number[], top = 8): { errors: ProblemGroup[]; slow: ProblemGroup[] } {
  const eps = services.flatMap((s) => s.endpoints.filter((e) => SAFE_NAME.test(e.name)).map((e) => ({ s, e })));
  const errors = eps.filter(({ e }) => e.errors > 0)
    .sort((a, z) => z.e.errors - a.e.errors || z.e.requests - a.e.requests || (a.e.name < z.e.name ? -1 : 1))
    .slice(0, top)
    .map(({ s, e }): ProblemGroup => ({ kind: "errors", service: s.service, name: e.name, count: e.errors, requests: e.requests, p95: e.p95 }));
  const sorted = [...buckets].sort((a, z) => a - z);
  const lowerEdge = (le: number | null) => (le === null ? sorted[sorted.length - 1] ?? 0 : [...sorted].reverse().find((b) => b < le) ?? 0);
  const rank = (le: number | null) => (le === null ? Infinity : le);
  const slow = eps.filter(({ e }) => e.p95 && e.requests >= 1)
    .sort((a, z) => rank(z.e.p95!.le) - rank(a.e.p95!.le) || z.e.requests - a.e.requests || (a.e.name < z.e.name ? -1 : 1))
    .slice(0, top)
    .map(({ s, e }): ProblemGroup => ({ kind: "slow", service: s.service, name: e.name, count: e.requests, requests: e.requests, p95: e.p95, minDurationMs: Math.floor(lowerEdge(e.p95!.le) * 1000) }));
  return { errors, slow };
}

/** Pure: pages joined in order, a trace once (pages overlap by one second) */
export function mergePages(pages: TraceSummary[][]): TraceSummary[] {
  const seen = new Set<string>();
  const out: TraceSummary[] = [];
  for (const p of pages) for (const t of p) if (!seen.has(t.traceId)) { seen.add(t.traceId); out.push(t); }
  return out;
}

/** Pure: spans that matched the filters, over the loaded traces (compare with a group's spanmetrics count) */
export const matchedSpans = (rows: TraceSummary[]) => rows.reduce((n, t) => n + t.matched, 0);
