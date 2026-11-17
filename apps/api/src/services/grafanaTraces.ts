// 서비스 (APM) › 트레이스 — trace search and one trace's spans, read from Tempo THROUGH the customer's Azure Managed
// Grafana (docs/architecture/apm-parity.md §4c). Tempo inside the cluster has no authentication of its own, so the
// dashboard never reads it directly; Grafana's datasource proxy is the gate: the connection's identity needs a Grafana
// role (Grafana Viewer) and the connection must opt in (`aks.observability.grafana.traces` + a tempo datasource UID).
//
// Measured shapes (Grafana 12.4 · Tempo, stg 2026-11-16):
//   GET <grafana>/api/datasources/proxy/uid/<tempo>/api/search?q=<TraceQL>&start&end&limit&spss
//     → { traces: [{ traceID (hex), rootServiceName, rootTraceName, startTimeUnixNano, durationMs,
//          spanSets: [{ spans: [{ spanID, startTimeUnixNano, durationNanos, attributes }], matched }],
//          serviceStats: { <service>: { spanCount, errorCount } } }],
//        metrics: { completedJobs, totalJobs, … } }
//   GET <grafana>/api/datasources/proxy/uid/<tempo>/api/v2/traces/<id>
//     → { trace: { resourceSpans: [{ resource: { attributes }, scopeSpans: [{ spans: [{ traceId, spanId,
//          parentSpanId (base64), name, kind SPAN_KIND_*, start/endTimeUnixNano, attributes, events, status }] }] }] } }
// Attribute values and event texts (exception messages, stack traces) are masked like log lines before they leave.

import type { Env } from "../env.js";
import type { TraceDetailResponse, TraceSearchQuery, TraceSearchResponse, TraceSpan, TraceState, TraceSummary } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, connectionToken, signinRequired } from "../infra/azureClientFactory.js";
import { credentialGroup } from "../infra/connectionRegistry.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { MANAGED_GRAFANA_SCOPE } from "./grafanaAlertPull.js";
import { redactLogText } from "./logRedaction.js";

export const TRACE_SEARCH_LIMIT = 50;
export const TRACE_MAX_SPANS = 2000;
const VALUE_MAX = 500;
const STACK_MAX = 4000;
const ATTRS_MAX = 40;
const SEARCH_TIMEOUT_MS = 20_000;
const TRACE_TIMEOUT_MS = 15_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── TraceQL (pure) ──

const SERVICE_RE = /^[\w.\-:/]{1,128}$/;
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAME_RE = /^[^"\\\n\r\t]{1,200}$/;

/** Pure: validates the filters (400 on a value outside its shape — never escaped into the query) */
export function validTraceQuery(q: TraceSearchQuery): TraceSearchQuery {
  if (q.service !== undefined && !SERVICE_RE.test(q.service)) throw new HttpError(400, "invalid_service", "A service name: letters, digits, . - _ : /");
  if (q.namespace !== undefined && !NAMESPACE_RE.test(q.namespace)) throw new HttpError(400, "invalid_namespace", "A Kubernetes namespace name");
  if (q.name !== undefined && !NAME_RE.test(q.name)) throw new HttpError(400, "invalid_span_name", "A span name without quotes, backslashes or line breaks");
  if (q.minDurationMs !== undefined && !(Number.isInteger(q.minDurationMs) && q.minDurationMs >= 0 && q.minDurationMs <= 3_600_000)) {
    throw new HttpError(400, "invalid_duration", "minDurationMs: 0–3600000");
  }
  return q;
}

/** Pure: the TraceQL span selector for the filters (resource attributes as the OpenTelemetry SDK sets them) */
export function traceqlFor(q: TraceSearchQuery): string {
  const c: string[] = [];
  if (q.service) c.push(`resource.service.name = "${q.service}"`);
  if (q.namespace) c.push(`resource.k8s.namespace.name = "${q.namespace}"`);
  if (q.name) c.push(`name = "${q.name}"`);
  if (q.errorsOnly) c.push("status = error");
  if (q.minDurationMs) c.push(`duration >= ${q.minDurationMs}ms`);
  return c.length ? `{ ${c.join(" && ")} }` : "{}";
}

/** Grafana Explore on the Tempo datasource with a TraceQL query (or a trace ID) — a link the operator opens */
export function tempoExploreUrl(endpoint: string, tempoUid: string, query: string, from: string, to: string): string {
  const panes = { aud: { datasource: tempoUid, queries: [{ refId: "A", datasource: { type: "tempo", uid: tempoUid }, queryType: "traceql", query, limit: 20 }], range: { from, to } } };
  return `${endpoint.replace(/\/+$/, "")}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

// ── Answers (pure) ──

const nsToIso = (ns: unknown): string => {
  const n = typeof ns === "string" ? Number(BigInt(ns) / 1_000_000n) : Number(ns) / 1e6;
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
};
/** Tempo prints trace IDs without leading zeros — always 32 hex digits here */
export const traceHex = (id: string) => id.toLowerCase().padStart(32, "0");

/** Pure: Tempo's search answer → trace rows (newest first, as Tempo orders them) */
export function searchRows(body: unknown): { traces: TraceSummary[]; partial: boolean } {
  const b = obj(body);
  if (!b || !Array.isArray(b.traces)) throw new Error("unexpected_shape");
  const traces: TraceSummary[] = [];
  for (const x of b.traces) {
    const t = obj(x);
    if (!t || typeof t.traceID !== "string" || !/^[0-9a-f]{1,32}$/i.test(t.traceID)) continue;
    const stats = obj(t.serviceStats) ?? {};
    const sets = arr(t.spanSets).length ? arr(t.spanSets) : t.spanSet ? [t.spanSet] : [];
    traces.push({
      traceId: traceHex(t.traceID),
      rootService: typeof t.rootServiceName === "string" && t.rootServiceName !== "<root span not yet received>" ? t.rootServiceName : null,
      rootName: typeof t.rootTraceName === "string" ? t.rootTraceName : null,
      start: nsToIso(t.startTimeUnixNano ?? 0),
      durationMs: typeof t.durationMs === "number" ? t.durationMs : null,
      services: Object.entries(stats).map(([name, v]) => ({ name, spans: Number(obj(v)?.spanCount ?? 0), errors: Number(obj(v)?.errorCount ?? 0) }))
        .sort((a, z) => z.errors - a.errors || z.spans - a.spans || (a.name < z.name ? -1 : 1)),
      matched: sets.reduce<number>((n, s) => n + Number(obj(s)?.matched ?? 0), 0),
    });
  }
  const m = obj(b.metrics);
  const partial = !!m && Number(m.totalJobs ?? 0) > Number(m.completedJobs ?? 0);
  return { traces, partial };
}

const b64hex = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  if (/^[0-9a-f]{16}$|^[0-9a-f]{32}$/i.test(v)) return v.toLowerCase();
  const hex = Buffer.from(v, "base64").toString("hex");
  return /^0*$/.test(hex) ? null : hex;
};
const anyValue = (v: unknown): string => {
  const o = obj(v);
  if (!o) return "";
  if ("stringValue" in o) return String(o.stringValue);
  if ("intValue" in o) return String(o.intValue);
  if ("doubleValue" in o) return String(o.doubleValue);
  if ("boolValue" in o) return String(o.boolValue);
  if (obj(o.arrayValue)) return arr(obj(o.arrayValue)!.values).map(anyValue).join(", ");
  return "";
};
const KINDS: Record<string, TraceSpan["kind"]> = {
  SPAN_KIND_SERVER: "server", SPAN_KIND_CLIENT: "client", SPAN_KIND_INTERNAL: "internal", SPAN_KIND_PRODUCER: "producer", SPAN_KIND_CONSUMER: "consumer",
};

/** Pure: Tempo's trace (OTLP JSON, v2 `trace.resourceSpans` or v1 `batches`) → spans in start order, masked */
export function traceSpans(body: unknown): { spans: TraceSpan[]; start?: string; durationMs?: number; truncated?: number; redacted: number } {
  const b = obj(body);
  const batches = arr(obj(b?.trace)?.resourceSpans ?? b?.batches);
  let redacted = 0;
  const mask = (text: string, max: number) => {
    const r = redactLogText(text.length > max ? `${text.slice(0, max)}…` : text);
    redacted += r.n;
    return r.text;
  };
  const attrs = (list: unknown, max = VALUE_MAX) => arr(list).slice(0, ATTRS_MAX).flatMap((a) => {
    const o = obj(a);
    if (!o || typeof o.key !== "string") return [];
    return [{ key: o.key.slice(0, 120), value: mask(anyValue(o.value), o.key === "exception.stacktrace" ? STACK_MAX : max) }];
  });
  type Raw = Omit<TraceSpan, "offsetMs"> & { startNs: bigint };
  const raw: Raw[] = [];
  for (const rb of batches) {
    const r = obj(rb);
    const res = new Map(arr(obj(r?.resource)?.attributes).map((a) => [String(obj(a)?.key ?? ""), anyValue(obj(a)?.value)]));
    for (const ss of arr(r?.scopeSpans ?? r?.instrumentationLibrarySpans)) {
      for (const x of arr(obj(ss)?.spans)) {
        const s = obj(x);
        const spanId = b64hex(s?.spanId);
        if (!s || !spanId) continue;
        const startNs = BigInt(String(s.startTimeUnixNano ?? "0"));
        const endNs = BigInt(String(s.endTimeUnixNano ?? s.startTimeUnixNano ?? "0"));
        const st = obj(s.status);
        const code = String(st?.code ?? "");
        raw.push({
          spanId,
          parentId: b64hex(s.parentSpanId),
          service: res.get("service.name") || null,
          namespace: res.get("k8s.namespace.name") || null,
          pod: res.get("k8s.pod.name") || null,
          name: String(s.name ?? "").slice(0, 300),
          kind: KINDS[String(s.kind ?? "")] ?? "unspecified",
          durationMs: Number(endNs - startNs) / 1e6,
          status: code === "STATUS_CODE_ERROR" || code === "2" ? "error" : code === "STATUS_CODE_OK" || code === "1" ? "ok" : "unset",
          ...(typeof st?.message === "string" && st.message ? { statusMessage: mask(st.message, VALUE_MAX) } : {}),
          attributes: attrs(s.attributes),
          events: arr(s.events).slice(0, 20).map((e) => ({
            name: String(obj(e)?.name ?? "").slice(0, 120),
            offsetMs: Number(BigInt(String(obj(e)?.timeUnixNano ?? s.startTimeUnixNano ?? "0")) - startNs) / 1e6,
            attributes: attrs(obj(e)?.attributes),
          })),
          startNs,
        });
      }
    }
  }
  if (!raw.length) return { spans: [], redacted };
  raw.sort((a, z) => (a.startNs < z.startNs ? -1 : a.startNs > z.startNs ? 1 : a.spanId < z.spanId ? -1 : 1));
  const t0 = raw[0]!.startNs;
  const end = raw.reduce((m, s) => { const e = s.startNs + BigInt(Math.round(s.durationMs * 1e6)); return e > m ? e : m; }, t0);
  const spans = raw.slice(0, TRACE_MAX_SPANS).map(({ startNs, ...s }) => ({ ...s, offsetMs: Number(startNs - t0) / 1e6 }));
  return {
    spans, start: nsToIso(t0.toString()), durationMs: Number(end - t0) / 1e6, redacted,
    ...(raw.length > TRACE_MAX_SPANS ? { truncated: raw.length - TRACE_MAX_SPANS } : {}),
  };
}

// ── Reading ──

type Setup = { endpoint: string; tempo: string; token: () => Promise<string> };
type NotReady = { state: TraceState; message: string };

/** The cluster's Grafana + Tempo datasource + a token of the connection's identity, or why not */
function setup(env: Env, bearerToken: string | undefined, clusterId: string): Setup | NotReady {
  if (!bearerToken) throw signinRequired();
  const { connection } = clusterConnection(env, clusterId);
  const g = connection.aks?.observability?.grafana;
  if (!g || !g.traces || !g.datasources.tempo) {
    return { state: "notConfigured", message: !g ? "no Grafana on this connection" : !g.datasources.tempo ? "no tempo datasource UID" : "traces are not enabled (aks.observability.grafana.traces)" };
  }
  if (credentialGroup(env, connection) === "delegated" || connection.mode === "lighthouse") {
    return { state: "unsupportedMode", message: "this connection mode has no app token for the customer's Grafana" };
  }
  return { endpoint: g.endpoint.replace(/\/+$/, ""), tempo: g.datasources.tempo, token: () => connectionToken(env, bearerToken, connection, MANAGED_GRAFANA_SCOPE) };
}

async function grafanaGet(s: Setup, path: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${s.endpoint}/api/datasources/proxy/uid/${encodeURIComponent(s.tempo)}${path}`, {
      headers: { authorization: `Bearer ${await s.token()}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const stateOfStatus = (status: number): TraceState => (status === 401 || status === 403 ? "forbidden" : status === 404 ? "notFound" : "failed");
const failMessage = (status: number) =>
  status === 401 || status === 403 ? `Grafana ${status}: the connection's identity needs a Grafana role (Grafana Viewer) on this Grafana` : `Grafana ${status}`;

const searchCache = new CacheManager<TraceSearchResponse>(50, 30_000);
const traceCache = new CacheManager<TraceDetailResponse>(100, 5 * 60_000);

/**
 * Tempo ≥ 2.x without `most_recent` stops as soon as `limit` traces are found in whatever blocks answered first — not
 * the newest (stg Tempo 3.1.1, 2026-11-17: 5 of 8 jobs, traces up to 37 min old while newer ones existed). With the hint
 * every block is searched and the newest `limit` come back, so paging by start time is gapless: an hour of
 * `{ status = error }` paged 30 at a time = 60 traces = one request of 2000 (0 missing, 0 extra) = spanmetrics' 60.
 */
export const MOST_RECENT = " with (most_recent=true)";

/** Pure: the next page's end (epoch s) — the oldest start + 1 (dedupe by trace ID), never past this page's end */
export function nextPageEnd(rows: Array<{ start: string }>, limit: number, start: number, end: number): number | null {
  if (rows.length < limit) return null;
  const oldest = Math.min(...rows.map((r) => Math.floor(Date.parse(r.start) / 1000)));
  if (oldest <= start) return null; // reached the window's start — another page would repeat this one
  const next = Math.min(oldest + 1, end - 1);
  return next > start ? next : null;
}

export async function searchTraces(env: Env, bearerToken: string | undefined, clusterId: string, query: TraceSearchQuery, minutes: number, at?: number, limit = 20,
  page?: { since: number; before: number }): Promise<TraceSearchResponse> {
  const q = validTraceQuery(query);
  const traceql = `${traceqlFor(q)}${MOST_RECENT}`;
  // `at` = epoch seconds (queryPastTime — the page's time picker), absent = now. A later page keeps the first page's
  // window start (`since`) and ends where the previous page's oldest trace began (`before`).
  if (page && !(page.since < page.before && page.before - page.since <= (minutes + 1) * 60)) {
    throw new HttpError(400, "invalid_page", "since < before, within the window");
  }
  const end = page?.before ?? at ?? Math.floor(Date.now() / 1000);
  const start = page?.since ?? end - minutes * 60;
  const lim = Math.max(1, Math.min(TRACE_SEARCH_LIMIT, limit));
  const base: TraceSearchResponse = {
    clusterId, generatedAt: new Date().toISOString(), state: "ok", traceql,
    from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), traces: [], partial: false, limit: lim,
    since: start, next: null,
  };
  const s = setup(env, bearerToken, clusterId);
  if ("state" in s) return { ...base, state: s.state, message: s.message };
  base.exploreUrl = tempoExploreUrl(s.endpoint, s.tempo, traceql, String(start * 1000), String(end * 1000));
  // `at` absent: the minute is the key (a 30-second cache must not freeze "now")
  const key = `${cachePrefix(bearerToken)}:traces:${clusterId.toLowerCase()}:${traceql}:${minutes}:${page ? `${start}-${end}` : at !== undefined ? end : Math.floor(end / 60)}:${lim}`;
  const hit = searchCache.get(key);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({ q: traceql, start: String(start), end: String(end), limit: String(lim), spss: "3" });
    const r = await grafanaGet(s, `/api/search?${params}`, SEARCH_TIMEOUT_MS);
    if (r.status !== 200) return { ...base, state: stateOfStatus(r.status) === "notFound" ? "failed" : stateOfStatus(r.status), message: failMessage(r.status) };
    const rows = searchRows(r.body);
    const out = { ...base, ...rows, next: nextPageEnd(rows.traces, lim, start, end) };
    searchCache.set(key, out);
    return out;
  } catch (e: unknown) {
    if (e instanceof HttpError) throw e;
    return { ...base, state: "failed", message: safeMessage(e) };
  }
}

export async function getTrace(env: Env, bearerToken: string | undefined, clusterId: string, traceId: string): Promise<TraceDetailResponse> {
  if (!/^[0-9a-f]{1,32}$/i.test(traceId)) throw new HttpError(400, "invalid_trace_id", "A trace ID: up to 32 hex digits");
  const id = traceHex(traceId);
  const base: TraceDetailResponse = { clusterId, generatedAt: new Date().toISOString(), state: "ok", traceId: id, spans: [], redacted: 0 };
  const s = setup(env, bearerToken, clusterId);
  if ("state" in s) return { ...base, state: s.state, message: s.message };
  base.exploreUrl = tempoExploreUrl(s.endpoint, s.tempo, id, "now-7d", "now");
  const key = `${cachePrefix(bearerToken)}:trace:${clusterId.toLowerCase()}:${id}`;
  const hit = traceCache.get(key);
  if (hit) return hit;
  try {
    const r = await grafanaGet(s, `/api/v2/traces/${id}`, TRACE_TIMEOUT_MS);
    if (r.status !== 200) return { ...base, state: stateOfStatus(r.status), message: r.status === 404 ? "not in Tempo (retention or sampling)" : failMessage(r.status) };
    const t = traceSpans(r.body);
    if (!t.spans.length) return { ...base, state: "notFound", message: "not in Tempo (retention or sampling)" };
    const out = { ...base, ...t };
    traceCache.set(key, out);
    return out;
  } catch (e: unknown) {
    if (e instanceof HttpError) throw e;
    return { ...base, state: "failed", message: safeMessage(e) };
  }
}
