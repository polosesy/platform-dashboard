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

// ── trace detail views (2026-11-18 — Datadog trace view: flame graph · waterfall · span list, exec time per service) ──

/** One block of the flame graph: the span, its row (children always below their parent), its place on the time axis */
export type FlameBlock = { span: TraceSpan; row: number; leftPct: number; widthPct: number };

/**
 * Pure: the flame graph — a time axis (the trace's), every span below its parent; spans whose times overlap never
 * share a row (asynchronous siblings take the next free row), so no block hides another. Order: the waterfall's
 * (depth-first, siblings by start) — each span takes the first free row under its parent.
 */
export function flameLayout(spans: TraceSpan[], totalMs?: number): { blocks: FlameBlock[]; rows: number } {
  const total = totalMs && totalMs > 0 ? totalMs : Math.max(1e-6, ...spans.map((s) => s.offsetMs + s.durationMs));
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const used: Array<Array<[number, number]>> = [];
  const free = (r: number, a: number, b: number) => !(used[r] ?? []).some(([x, y]) => a < y && x < b);
  const rowOf = new Map<string, number>();
  const blocks: FlameBlock[] = [];
  for (const w of waterfall(spans, total)) {
    const s = w.span;
    const parentRow = s.parentId && byId.has(s.parentId) ? rowOf.get(s.parentId) : undefined;
    // a zero-length span still takes a sliver
    const a = s.offsetMs, b = s.offsetMs + Math.max(s.durationMs, total * 1e-4);
    let r = parentRow === undefined ? 0 : parentRow + 1;
    while (!free(r, a, b)) r++;
    (used[r] ??= []).push([a, b]);
    rowOf.set(s.spanId, r);
    blocks.push({ span: s, row: r, leftPct: w.leftPct, widthPct: w.widthPct });
  }
  return { blocks, rows: used.length };
}

/** Colour slots of the categorical series (globals.css --series1…5-rgb); beyond = "other" (slate) */
export const SERIES_SLOTS = 5;

/**
 * Pure: service → colour slot 1…SERIES_SLOTS in the order the services first appear in the waterfall (the root's first);
 * the 6th service on = 0 ("other"). Colour follows the service within this trace — filtering, zooming or picking never
 * repaints a service (dataviz: colour follows the entity, never its rank).
 */
export function serviceSlots(spans: TraceSpan[], totalMs?: number): Map<string, number> {
  const out = new Map<string, number>();
  let next = 1;
  for (const w of waterfall(spans, totalMs)) {
    const k = w.span.service ?? "";
    if (out.has(k)) continue;
    out.set(k, next <= SERIES_SLOTS ? next : 0);
    next++;
  }
  return out;
}
/** The CSS channel token of a slot ("none" colouring = the accent) */
export const slotVar = (slot: number | undefined, colorBy: "service" | "none") =>
  colorBy === "none" ? "var(--accent-rgb)" : slot ? `var(--series${slot}-rgb)` : "var(--slate-rgb)";

/** A zoomed time window of the flame graph (ms from the trace's start) */
export type FlameZoom = { from: number; to: number };

/**
 * Pure: the blocks inside a time window, placed on it (0–100 %). Outside the window = left out; a block cut by an edge
 * is clipped to it; a block thinner than 0.3 % still shows, kept inside the right edge (2026-11-18: a short span at the
 * trace's end drew 0.3 % past it). No zoom = the whole trace.
 */
export function flameWindow(blocks: FlameBlock[], totalMs: number, zoom: FlameZoom | null): FlameBlock[] {
  const from = zoom ? zoom.from : 0;
  const to = zoom ? zoom.to : totalMs > 0 ? totalMs : Math.max(1e-6, ...blocks.map((b) => b.span.offsetMs + b.span.durationMs));
  const w = Math.max(1e-9, to - from);
  const out: FlameBlock[] = [];
  for (const b of blocks) {
    const a = ((b.span.offsetMs - from) / w) * 100, z = ((b.span.offsetMs + b.span.durationMs - from) / w) * 100;
    if (z < 0 || a > 100) continue;
    const width = Math.max(0.3, Math.min(100, z) - Math.max(0, a));
    out.push({ ...b, leftPct: Math.min(Math.max(0, a), 100 - width), widthPct: width });
  }
  return out;
}

/** Pure: the length of the union of intervals (ms) */
function unionLength(iv: Array<[number, number]>): number {
  const s = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let n = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) { if (cur) n += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  return cur ? n + cur[1] - cur[0] : n;
}

/**
 * Pure: a span's own time = its length minus the time any child of it ran (children clipped to the span — the union,
 * so parallel children count once). Per service: the sum of its spans' own time; share = of the sum over all services
 * (it adds up to 100 %; with asynchronous work the sum can exceed the trace's length — the shares say where time went).
 */
export function execTimeByService(spans: TraceSpan[]): Array<{ service: string; selfMs: number; share: number; spans: number }> {
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map<string, TraceSpan[]>();
  for (const s of spans) if (s.parentId && s.parentId !== s.spanId && ids.has(s.parentId)) (kids.get(s.parentId) ?? kids.set(s.parentId, []).get(s.parentId)!).push(s);
  const by = new Map<string, { selfMs: number; spans: number }>();
  for (const s of spans) {
    const a = s.offsetMs, b = s.offsetMs + s.durationMs;
    const covered = unionLength((kids.get(s.spanId) ?? []).map((c) => [Math.max(a, c.offsetMs), Math.min(b, c.offsetMs + c.durationMs)] as [number, number]));
    const self = Math.max(0, s.durationMs - covered);
    const k = s.service ?? "";
    const e = by.get(k) ?? { selfMs: 0, spans: 0 };
    e.selfMs += self;
    e.spans++;
    by.set(k, e);
  }
  const sum = [...by.values()].reduce((n, e) => n + e.selfMs, 0);
  return [...by.entries()].map(([service, e]) => ({ service, selfMs: e.selfMs, spans: e.spans, share: sum > 0 ? e.selfMs / sum : 0 }))
    .sort((x, y) => y.selfMs - x.selfMs || (x.service < y.service ? -1 : 1));
}

export type SpanGroup = { service: string; name: string; count: number; totalMs: number; avgMs: number; maxMs: number; errors: number; first: string };
/** Pure: the span list — spans grouped by service × name (Datadog's span list), most total time first */
export function spanGroups(spans: TraceSpan[]): SpanGroup[] {
  const by = new Map<string, { service: string; name: string; count: number; totalMs: number; maxMs: number; errors: number; first: TraceSpan }>();
  for (const s of spans) {
    const k = `${s.service ?? ""}|${s.name}`;
    const e = by.get(k);
    if (!e) by.set(k, { service: s.service ?? "", name: s.name, count: 1, totalMs: s.durationMs, maxMs: s.durationMs, errors: s.status === "error" ? 1 : 0, first: s });
    else {
      e.count++;
      e.totalMs += s.durationMs;
      e.maxMs = Math.max(e.maxMs, s.durationMs);
      if (s.status === "error") e.errors++;
      if (s.offsetMs < e.first.offsetMs) e.first = s;
    }
  }
  return [...by.values()].map((e) => ({ service: e.service, name: e.name, count: e.count, totalMs: e.totalMs, avgMs: e.totalMs / e.count, maxMs: e.maxMs, errors: e.errors, first: e.first.spanId }))
    .sort((x, y) => y.totalMs - x.totalMs || (x.name < y.name ? -1 : 1));
}

/** Pure: the span filter — every word of the query in the span's name, service, namespace, pod, an attribute key or value */
export function spanMatches(s: TraceSpan, query: string, errorsOnly = false): boolean {
  if (errorsOnly && s.status !== "error") return false;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.name, s.service ?? "", s.namespace ?? "", s.pod ?? "", ...s.attributes.flatMap((a) => [a.key, a.value])].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** An attribute tree node: dotted keys nested (http.request.method → http › request › method) */
export type AttrNode = { key: string; path: string; value?: string; children: AttrNode[] };

/** Pure: attributes as a tree by their dotted keys (OpenTelemetry semantic conventions), keys sorted */
export function attrTree(attributes: TraceSpan["attributes"]): AttrNode[] {
  const root: AttrNode = { key: "", path: "", children: [] };
  for (const a of attributes) {
    let cur = root;
    const parts = a.key.split(".").filter(Boolean);
    parts.forEach((p, i) => {
      let next = cur.children.find((c) => c.key === p);
      if (!next) { next = { key: p, path: parts.slice(0, i + 1).join("."), children: [] }; cur.children.push(next); }
      cur = next;
    });
    cur.value = a.value;
  }
  const sort = (n: AttrNode) => { n.children.sort((x, y) => (x.key < y.key ? -1 : 1)); n.children.forEach(sort); };
  sort(root);
  return root.children;
}

/** Pure: the tree as nested JSON (a key that is both a value and a prefix keeps its value under "") — for copying */
export function attrJson(attributes: TraceSpan["attributes"]): string {
  const walk = (ns: AttrNode[]): Record<string, unknown> => Object.fromEntries(ns.map((n) => [n.key, n.children.length
    ? { ...(n.value !== undefined ? { "": n.value } : {}), ...walk(n.children) }
    : n.value ?? null]));
  return JSON.stringify(walk(attrTree(attributes)), null, 2);
}

/** Pure: an HTTP span's request line — OpenTelemetry semantic conventions, the new names first, then the older ones */
export function httpSummary(s: TraceSpan | null | undefined): { method: string; target: string | null; status: number | null } | null {
  if (!s) return null;
  const v = (...keys: string[]) => {
    for (const k of keys) { const x = s.attributes.find((a) => a.key === k)?.value; if (x) return x; }
    return null;
  };
  const method = v("http.request.method", "http.method");
  if (!method) return null;
  const target = v("url.full", "http.url", "http.route", "url.path", "http.target");
  const status = Number(v("http.response.status_code", "http.status_code"));
  return { method, target, status: Number.isFinite(status) && status > 0 ? status : null };
}

/** The address of one trace in this dashboard (the cluster stays the viewer's own — a trace ID is per cluster) */
export const traceLink = (origin: string, traceId: string) => `${origin}/observability/services?trace=${encodeURIComponent(traceId)}`;
/** A trace ID as Tempo writes it (hex, 1–32) — anything else in ?trace= is ignored */
export const TRACE_ID = /^[0-9a-f]{1,32}$/i;
