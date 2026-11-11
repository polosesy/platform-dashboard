// The cluster's own Loki, read in-cluster (connections file `aks.observability.loki`): a workload's log stream and
// Hubble drops shipped by hubble-flow-exporter (`{job="hubble-flows"}`).
//
// Rules (docs/deployment/kubernetes.md): the API builds every LogQL itself from validated Kubernetes names — a query
// string never comes from the browser; workload logs pass the same gate as kubelet pod logs (operator role +
// `aks.podLogNamespaces`); lines are redacted (logRedaction.ts) and capped (500 lines · 4 KB a line · 2 MB a
// response · 25 s). Two failures are told apart: no connection (refused, no route, DNS, connect timeout — the
// customer's monitor-namespace policy) = "unreachable" with the rule to add; a connection that ran out of time or got
// 499 / 5xx while /ready answers = "busy" (Loki overloaded — 2026-11-05 the alert queries filled its querier and the
// panel showed the network-policy fix for a reachable Loki). After "busy" the next minute's reads wait (no added load).
// Never sample lines.

import type { Env } from "../env.js";
import type { HubbleFlow, LogContextResponse, LogInsightsResponse, LogLine, LokiDropsResponse, LokiState, PodLogEntry, WorkloadLogsResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { assertSignedInForCluster, clusterConnection } from "../infra/azureClientFactory.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { redactLogLine } from "./logRedaction.js";
import { parseHubbleJsonOutput } from "./hubbleClient.js";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const MAX_LINES = 500;
const MAX_LINE_BYTES = 4096;
const MAX_BODY = 2 * 1024 * 1024;
/** A workload's stream (every pod of it): up to 6 h — the time picker's quick ranges below that (web WORKLOAD_LOG_WINDOWS) */
export const LOG_WINDOWS = [5, 15, 30, 60, 180, 360] as const;
/** Drop windows — 15 m for a short past range (the time range bar: the drops of that span, from Loki's 30 days) */
export const DROP_WINDOWS = [15, 60, 360, 1440] as const;

/** Escape for a LogQL label regex (RE2) inside a double-quoted string */
export const re2 = (s: string) => s.replace(/[\\.+*?()|[\]{}^$]/g, (c) => `\\\\${c}`).replace(/"/g, '\\"');
const R = "[bcdfghjklmnpqrstvwxz2456789]";

/**
 * A workload's pods as a stream selector: the pods we know now (validated names) plus the patterns its controller
 * makes — Deployment `<name>-<hash>-<5>`, StatefulSet `<name>-<n>`, DaemonSet/Job `<name>-<5>` — so restarted pods
 * still match and a longer name sharing the prefix does not.
 */
export function workloadSelector(namespace: string, workload: string, pods: string[] = []): string {
  if (!NAME.test(namespace) || !NAME.test(workload)) throw new HttpError(400, "invalid_name", "namespace / workload is not a Kubernetes name");
  const known = pods.filter((p) => NAME.test(p)).slice(0, 20).map(re2);
  const w = re2(workload);
  const alts = [...known, `${w}-${R}{6,10}-${R}{5}`, `${w}-[0-9]+`, `${w}-${R}{5}`];
  return `{namespace="${namespace}", pod=~"${alts.join("|")}"}`;
}

/** ERROR / FATAL lines — the customer's ANSI-aware pattern (works before `level` metadata exists) */
export const ERROR_FILTER = String.raw`|~ "(^|\\s|\\x1b\\[[0-9;]*m)(ERROR|FATAL)(\\s|\\x1b|:)|\\[(error|fatal)\\]:"`;
const EXCEPTION = String.raw`| regexp "(?P<exc>[A-Z][A-Za-z0-9_$]*(?:Exception|Error))\\b"`;

export function logQueries(selector: string, errorsOnly: boolean, minutes: number) {
  return {
    lines: `${selector}${errorsOnly ? ` ${ERROR_FILTER}` : ""}`,
    exceptions: `topk(10, sum by (exc) (count_over_time(${selector} ${ERROR_FILTER} ${EXCEPTION} [${minutes}m])))`,
  };
}

const LEVEL = /(^|[\s[|])(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
/** Their Spring log pattern `[service,traceId,spanId,…]` — an empty id is no trace (it matched every line before) */
const TRACE = /\[[\w.-]*,([0-9a-f]{16,32}),[0-9a-f]{16},/;

export function parseLogLine(stream: Record<string, string>, tsNs: string, raw: string, meta?: Record<string, string>): { line: LogLine; redactions: number } {
  const cut = raw.length > MAX_LINE_BYTES ? `${raw.slice(0, MAX_LINE_BYTES)}…` : raw;
  const { line: text, n } = redactLogLine(cut.replace(/\x1b\[[0-9;]*m/g, ""));
  const lv = (meta?.level ?? meta?.detected_level ?? stream.level ?? stream.detected_level ?? LEVEL.exec(text)?.[2] ?? "").toLowerCase();
  const level: LogLine["level"] = /^(error|fatal|err|crit)/.test(lv) ? "error" : /^warn/.test(lv) ? "warn" : /^(info|debug|trace)/.test(lv) ? "info" : "unknown";
  const traceId = TRACE.exec(text)?.[1];
  const ms = Number(BigInt(tsNs) / 1_000_000n);
  return { line: { time: new Date(ms).toISOString(), level, text, ...(stream.pod ? { pod: stream.pod } : {}), ...(traceId ? { traceId } : {}) }, redactions: n };
}

type LokiStreams = { status?: string; data?: { resultType?: string; result?: Array<{ stream?: Record<string, string>; values?: Array<[string, string, Record<string, string>?]> }> }; error?: string };
type LokiVector = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> } };

export function lokiConfig(env: Env, clusterId: string): { url: string; tenant?: string } | null {
  const l = clusterConnection(env, clusterId).connection.aks?.observability?.loki;
  return l ? { url: l.url.replace(/\/+$/, ""), ...(l.tenant ? { tenant: l.tenant } : {}) } : null;
}

/** No connection at all: refused, no route, no name, the connect itself timed out (a policy drops the SYN) */
const CONNECT = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i;
/** Loki answered, overloaded: client gone (499), gateway / unavailable / too many, or a 500 that is a timeout */
const BUSY_STATUS = /^Loki (429|499|502|503|504)\b|^Loki 500: .*(timeout|deadline|cancel|too many|queue|limit)/i;
/** Our time limit or the connection cut mid-answer (Loki's 30 s write timeout = EOF) — reachable or not: ask /ready */
const SLOW = /TimeoutError|aborted|timeout|other side closed|UND_ERR_SOCKET|ECONNRESET|EPIPE|terminated|fetch failed/i;

/**
 * Pure: a Loki read's error → state. `answers` = whether /ready answered right after (null = not asked): a slow /
 * cut read on a Loki that answers is busy, on one that does not is unreachable
 */
export function lokiStateOf(e: unknown, answers: boolean | null = null): { state: LokiState; message: string } {
  const message = safeMessage(e);
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const text = `${(e as { name?: string })?.name ?? ""} ${message} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  if (CONNECT.test(text)) return { state: "unreachable", message };
  if (BUSY_STATUS.test(message)) return { state: "busy", message };
  if (SLOW.test(text)) return { state: answers === true ? "busy" : "unreachable", message };
  return { state: "failed", message };
}
/** Whether this read's error needs the /ready question to be told apart */
const needsProbe = (e: unknown) => {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const text = `${(e as { name?: string })?.name ?? ""} ${safeMessage(e)} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  return !CONNECT.test(text) && !BUSY_STATUS.test(safeMessage(e)) && SLOW.test(text);
};

/** Loki's /ready answered at all (any status — even "not ready" is a reachable Loki); reads no log data */
async function lokiAnswers(cfg: { url: string; tenant?: string }): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.url}/ready`, { headers: cfg.tenant ? { "X-Scope-OrgID": cfg.tenant } : {}, signal: AbortSignal.timeout(3000) });
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** After "busy", reads of that Loki wait this long — every refresh would otherwise queue more work on it */
export const BUSY_BACKOFF_MS = 60_000;
const busyUntil = new Map<string, { until: number; message: string }>();
/** A read's failure → state, asking /ready when needed; "busy" starts the backoff for that Loki */
async function classify(cfg: { url: string; tenant?: string }, e: unknown): Promise<{ state: LokiState; message: string; retryAt?: string }> {
  const s = lokiStateOf(e, needsProbe(e) ? await lokiAnswers(cfg) : null);
  if (s.state !== "busy") return s;
  const until = Date.now() + BUSY_BACKOFF_MS;
  busyUntil.set(cfg.url, { until, message: s.message });
  return { ...s, retryAt: new Date(until).toISOString() };
}
/** Still backing off: the last "busy" answer instead of a new read */
function backingOff(cfg: { url: string }): { state: "busy"; message: string; retryAt: string } | null {
  const b = busyUntil.get(cfg.url);
  if (!b || b.until <= Date.now()) return null;
  return { state: "busy", message: b.message, retryAt: new Date(b.until).toISOString() };
}

/** 25 s: just under Loki's 30 s server write timeout — cutting earlier throws away work Loki already did (499) */
const READ_TIMEOUT_MS = 25_000;
async function lokiGet<T>(cfg: { url: string; tenant?: string }, path: string, params: Record<string, string>, timeoutMs = READ_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<{ body: T; truncated: boolean }> {
  const res = await fetch(`${cfg.url}${path}?${new URLSearchParams(params)}`, {
    headers: { Accept: "application/json", ...(cfg.tenant ? { "X-Scope-OrgID": cfg.tenant } : {}), ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Loki ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const truncated = text.length > MAX_BODY;
  return { body: JSON.parse(truncated ? "{}" : text) as T, truncated };
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
/** The last `minutes`, ending now or at `at` (epoch seconds — a range in the past, infra queryPastTime) */
const range = (minutes: number, at?: number) => {
  const end = at === undefined ? nowNs() : BigInt(at) * 1_000_000_000n;
  return { start: String(end - BigInt(minutes) * 60_000_000_000n), end: String(end) };
};

const logCache = new CacheManager<WorkloadLogsResponse>(50, 15_000);

export async function getWorkloadLogs(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace: string; workload: string; pods?: string[]; errorsOnly: boolean; minutes: number; at?: number },
): Promise<WorkloadLogsResponse> {
  if (!(LOG_WINDOWS as readonly number[]).includes(opts.minutes)) throw new HttpError(400, "invalid_window", `minutes must be one of ${LOG_WINDOWS.join(", ")}`);
  assertSignedInForCluster(env, bearerToken);
  const selector = workloadSelector(opts.namespace, opts.workload, opts.pods);
  const base: WorkloadLogsResponse = { clusterId, generatedAt: new Date().toISOString(), state: "ok", lines: [], exceptions: [], truncated: false, redactions: 0, windowMinutes: opts.minutes,
    ...(opts.at !== undefined ? { at: new Date(opts.at * 1000).toISOString() } : {}) };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const key = `${cachePrefix(bearerToken)}:loki-logs:${clusterId.toLowerCase()}:${selector}:${opts.errorsOnly}:${opts.minutes}:${opts.at ?? "now"}`;
  const hit = logCache.get(key);
  if (hit) return hit;
  const wait = backingOff(cfg);
  if (wait) return { ...base, ...wait };
  const q = logQueries(selector, opts.errorsOnly, opts.minutes);
  // The exception count is evaluated at the window's end too (a past range counted "now" before)
  const evalAt = opts.at === undefined ? nowNs() : BigInt(opts.at) * 1_000_000_000n;
  try {
    const [lines, exc] = await Promise.all([
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: q.lines, ...range(opts.minutes, opts.at), limit: String(MAX_LINES), direction: "backward" }),
      lokiGet<LokiVector>(cfg, "/loki/api/v1/query", { query: q.exceptions, time: String(evalAt) }, 15_000).catch(() => null),
    ]);
    let redactions = 0;
    const out: LogLine[] = [];
    for (const s of lines.body.data?.result ?? []) {
      for (const v of s.values ?? []) {
        const p = parseLogLine(s.stream ?? {}, v[0], v[1] ?? "", v[2]);
        redactions += p.redactions;
        out.push(p.line);
      }
    }
    out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    const result: WorkloadLogsResponse = {
      ...base, lines: out.slice(0, MAX_LINES), redactions, truncated: lines.truncated || out.length > MAX_LINES,
      exceptions: (exc?.body.data?.result ?? []).map((r) => ({ cls: r.metric?.exc ?? "", count: Math.round(Number(r.value?.[1] ?? 0)) })).filter((x) => x.cls && x.count > 0),
    };
    logCache.set(key, result);
    return result;
  } catch (e) {
    return { ...base, ...(await classify(cfg, e)) };
  }
}

// ── Log insights (AKS 모니터링 › 로그): counts, not lines ──

/** WARN lines — the customer's ANSI-aware pattern, like ERROR_FILTER */
export const WARN_FILTER = String.raw`|~ "(^|\\s|\\x1b\\[[0-9;]*m)WARN(\\s|\\x1b)|\\[warn\\]:"`;
/** Error-ish lines naming an exception class (their "Error & Exception Explorer" query) */
const EXCEPTION_LINES = String.raw`|~ "(?i)(exception|\\berror\\b)" | regexp "(?P<exc>[A-Z][A-Za-z0-9_$]*(?:Exception|Error))" | exc!=""`;
const BUCKETS = 30;

/**
 * Pure: the workload a pod belongs to, from its name — Deployment `<name>-<hash>-<5>`, StatefulSet `<name>-<n>`,
 * DaemonSet / Job `<name>-<5>`; a name of none of these shapes is its own workload. No site-specific Loki label is
 * needed (the customer's `service_name` is theirs), and the names match the heatmap's.
 */
export function workloadOfPod(pod: string): string {
  const m = new RegExp(`^(.+)-${R}{6,10}-${R}{5}$`).exec(pod) ?? /^(.+)-[0-9]+$/.exec(pod) ?? new RegExp(`^(.+)-${R}{5}$`).exec(pod);
  return m ? m[1]! : pod;
}

/** Pure: the insight queries of a selector — per pod (summed into workloads here), the window as one range */
export function insightQueries(selector: string, minutes: number): Record<"errors" | "warns" | "exceptions" | "timeline", string> {
  const step = Math.max(10, Math.round((minutes * 60) / BUCKETS));
  return {
    errors: `sum by (pod) (count_over_time(${selector} ${ERROR_FILTER} [${minutes}m]))`,
    warns: `sum by (pod) (count_over_time(${selector} ${WARN_FILTER} [${minutes}m]))`,
    exceptions: `sum by (pod, exc) (count_over_time(${selector} ${EXCEPTION_LINES} [${minutes}m]))`,
    timeline: `sum by (pod) (count_over_time(${selector} ${ERROR_FILTER} [${step}s]))`,
  };
}

type VecRow = { metric?: Record<string, string>; value?: [number, string] };
type MatrixRow = { metric?: Record<string, string>; values?: Array<[number, string]> };
export type InsightRaw = { errors: VecRow[] | null; warns: VecRow[] | null; exceptions: VecRow[] | null; timeline: MatrixRow[] | null };

/** Pure: Loki's per-pod answers → per-workload numbers; a part that is null (not answered) stays null and is a gap */
export function summarizeInsights(raw: InsightRaw, opts: { minutes: number; endMs: number }): Pick<LogInsightsResponse, "errors" | "warns" | "services" | "exceptions" | "exceptionClasses" | "timeline" | "gaps"> {
  const n = (v: VecRow) => Math.round(Number(v.value?.[1] ?? 0)) || 0;
  const perWorkload = (rows: VecRow[] | null) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) { const w = workloadOfPod(r.metric?.pod ?? ""); if (w) m.set(w, (m.get(w) ?? 0) + n(r)); }
    return m;
  };
  const err = perWorkload(raw.errors), warn = perWorkload(raw.warns);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const names = new Set([...err.keys(), ...warn.keys()]);
  const services = [...names].map((workload) => ({ workload, errors: err.get(workload) ?? 0, warns: warn.get(workload) ?? 0 }))
    .filter((x) => x.errors > 0 || x.warns > 0)
    .sort((a, b) => b.errors - a.errors || b.warns - a.warns || (a.workload < b.workload ? -1 : 1));

  let exceptions: LogInsightsResponse["exceptions"] = null, exceptionClasses: number | null = null;
  if (raw.exceptions) {
    const m = new Map<string, { workload: string; cls: string; count: number }>();
    for (const r of raw.exceptions) {
      const workload = workloadOfPod(r.metric?.pod ?? ""), cls = r.metric?.exc ?? "";
      if (!workload || !cls) continue;
      const k = `${workload}\u0000${cls}`;
      const x = m.get(k) ?? { workload, cls, count: 0 };
      x.count += n(r);
      m.set(k, x);
    }
    const all = [...m.values()].filter((x) => x.count > 0);
    exceptionClasses = new Set(all.map((x) => x.cls)).size;
    exceptions = all.sort((a, b) => b.count - a.count || (a.cls < b.cls ? -1 : 1)).slice(0, 15);
  }

  let timeline: LogInsightsResponse["timeline"] = null;
  if (raw.timeline) {
    const stepSeconds = Math.max(10, Math.round((opts.minutes * 60) / BUCKETS));
    const endS = Math.floor(opts.endMs / 1000), startS = endS - opts.minutes * 60;
    const count = Math.max(1, Math.ceil((endS - startS) / stepSeconds));
    const by = new Map<string, number[]>();
    for (const r of raw.timeline) {
      const w = workloadOfPod(r.metric?.pod ?? "");
      if (!w) continue;
      const b = by.get(w) ?? new Array<number>(count).fill(0);
      for (const [t, v] of r.values ?? []) {
        // A point at t counts the step ending at t → the bucket that step falls in
        const i = Math.min(count - 1, Math.max(0, Math.ceil((t - startS) / stepSeconds) - 1));
        b[i]! += Math.round(Number(v)) || 0;
      }
      by.set(w, b);
    }
    const buckets = new Array<number>(count).fill(0);
    for (const b of by.values()) b.forEach((v, i) => { buckets[i]! += v; });
    const total = (b: number[]) => b.reduce((a, c) => a + c, 0);
    timeline = {
      start: new Date(startS * 1000).toISOString(), stepSeconds, buckets,
      byWorkload: [...by.entries()].map(([workload, b]) => ({ workload, buckets: b })).filter((x) => total(x.buckets) > 0)
        .sort((a, b) => total(b.buckets) - total(a.buckets) || (a.workload < b.workload ? -1 : 1)).slice(0, 6),
    };
  }
  const gaps = (["errors", "warns", "exceptions", "timeline"] as const).filter((k) => raw[k] === null);
  return { errors: raw.errors ? sum(err) : null, warns: raw.warns ? sum(warn) : null, services, exceptions, exceptionClasses, timeline, gaps };
}

const insightCache = new CacheManager<LogInsightsResponse>(40, 30_000);
const insightInflight = new Map<string, Promise<LogInsightsResponse>>();

/**
 * A namespace's log counts from Loki (the pod-log gate is the route's): four count queries side by side, each on its
 * own — one that fails is a gap, all failing is the Loki state (unreachable · busy · failed). Windows = LOG_WINDOWS
 * (≤ 6 h): a regexp over a day of every pod's lines is the kind of read that overloads a small Loki.
 */
export async function getLogInsights(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace: string; workload?: string; minutes: number; at?: number },
): Promise<LogInsightsResponse> {
  if (!(LOG_WINDOWS as readonly number[]).includes(opts.minutes)) throw new HttpError(400, "invalid_window", `minutes must be one of ${LOG_WINDOWS.join(", ")}`);
  assertSignedInForCluster(env, bearerToken);
  if (!NAME.test(opts.namespace)) throw new HttpError(400, "invalid_name", "namespace is not a Kubernetes name");
  const selector = opts.workload ? workloadSelector(opts.namespace, opts.workload) : `{namespace="${opts.namespace}"}`;
  const endMs = opts.at === undefined ? Math.floor(Date.now() / 60_000) * 60_000 : opts.at * 1000;
  const base: LogInsightsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(opts.at !== undefined ? { at: new Date(opts.at * 1000).toISOString() } : {}),
    state: "ok", namespace: opts.namespace, ...(opts.workload ? { workload: opts.workload } : {}), windowMinutes: opts.minutes,
    errors: null, warns: null, services: [], exceptions: null, exceptionClasses: null, timeline: null, gaps: [],
  };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const key = `${cachePrefix(bearerToken)}:loki-insights:${clusterId.toLowerCase()}:${selector}:${opts.minutes}:${opts.at ?? "now"}`;
  const hit = insightCache.get(key);
  if (hit) return hit;
  const wait = backingOff(cfg);
  if (wait) return { ...base, ...wait };
  const running = insightInflight.get(key);
  if (running) return running;
  const job = (async (): Promise<LogInsightsResponse> => {
    const q = insightQueries(selector, opts.minutes);
    const time = String(BigInt(endMs) * 1_000_000n);
    const step = Math.max(10, Math.round((opts.minutes * 60) / BUCKETS));
    let firstError: unknown = null;
    const vec = (query: string) => lokiGet<{ data?: { result?: VecRow[] } }>(cfg, "/loki/api/v1/query", { query, time })
      .then((r) => (r.truncated ? null : r.body.data?.result ?? [])).catch((e: unknown) => { firstError ??= e; return null; });
    const [errors, warns, exceptions, timeline] = await Promise.all([
      vec(q.errors), vec(q.warns), vec(q.exceptions),
      lokiGet<{ data?: { result?: MatrixRow[] } }>(cfg, "/loki/api/v1/query_range", {
        query: q.timeline, start: String(BigInt(endMs - opts.minutes * 60_000) * 1_000_000n), end: time, step: `${step}s`,
      }).then((r) => (r.truncated ? null : r.body.data?.result ?? [])).catch((e: unknown) => { firstError ??= e; return null; }),
    ]);
    // Nothing answered: the Loki state (and its backoff when busy) — not four gaps over empty numbers
    if (!errors && !warns && !exceptions && !timeline) return { ...base, ...(await classify(cfg, firstError ?? new Error("Loki did not answer"))) };
    const result: LogInsightsResponse = { ...base, ...summarizeInsights({ errors, warns, exceptions, timeline }, { minutes: opts.minutes, endMs }) };
    // A partial answer is asked again soon
    insightCache.set(key, result, result.gaps.length ? 10_000 : undefined);
    return result;
  })().finally(() => insightInflight.delete(key));
  insightInflight.set(key, job);
  return job;
}

// ── One pod's lines (AKS 모니터링 › 로그) ──

/**
 * Ask Loki to keep the kinds of labels apart (Loki ≥ 3.0): the stream then carries the indexed labels only and each
 * value a third element `{ structuredMetadata, parsed }` — what Grafana's log details show as two groups. An older
 * Loki ignores the header: everything is in the stream and nothing is claimed to be structured metadata.
 */
const CATEGORIZE = { "X-Loki-Response-Encoding-Flags": "categorize-labels" };
const MAX_LABELS = 30;
const MAX_LABEL_VALUE = 300;

/** Pure: label pairs for the response — names as Loki has them, values redacted and cut, a bounded number */
export function safeLabels(src: unknown): { labels: Record<string, string>; redactions: number } {
  const labels: Record<string, string> = {};
  let redactions = 0;
  if (!src || typeof src !== "object" || Array.isArray(src)) return { labels, redactions };
  for (const [k, v] of Object.entries(src as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_LABELS)) {
    if (typeof v !== "string" || !/^[A-Za-z_][\w.-]{0,99}$/.test(k)) continue;
    const r = redactLogLine(v.length > MAX_LABEL_VALUE ? `${v.slice(0, MAX_LABEL_VALUE)}…` : v);
    redactions += r.n;
    labels[k] = r.line;
  }
  return { labels, redactions };
}

/** Pure: a Loki streams answer → pod log entries, oldest first, each with its labels · structured metadata · level */
export function podEntries(body: LokiStreams, pod: string): { lines: PodLogEntry[]; redactions: number } {
  let redactions = 0;
  const lines: PodLogEntry[] = [];
  for (const st of body.data?.result ?? []) {
    const indexed = safeLabels(st.stream);
    for (const v of st.values ?? []) {
      // With categorize-labels the third element is { structuredMetadata, parsed }; without it, absent (or flat)
      const extra = (v[2] ?? {}) as { structuredMetadata?: unknown } & Record<string, unknown>;
      const meta = safeLabels(extra.structuredMetadata);
      const p = parseLogLine(st.stream ?? {}, v[0], v[1] ?? "", { ...(typeof extra.level === "string" ? { level: extra.level } : {}), ...meta.labels });
      redactions += p.redactions + meta.redactions;
      const stream = st.stream?.stream;
      lines.push({
        timestamp: p.line.time, podName: st.stream?.pod ?? pod, containerName: st.stream?.container ?? "", logMessage: p.line.text,
        stream: stream === "stdout" || stream === "stderr" ? stream : "unknown",
        tsNs: v[0], level: p.line.level, labels: indexed.labels,
        ...(Object.keys(meta.labels).length ? { metadata: meta.labels } : {}), ...(p.line.traceId ? { traceId: p.line.traceId } : {}),
      });
    }
    redactions += indexed.redactions;
  }
  lines.sort((a, b) => (BigInt(a.tsNs ?? "0") < BigInt(b.tsNs ?? "0") ? -1 : BigInt(a.tsNs ?? "0") > BigInt(b.tsNs ?? "0") ? 1 : 0));
  return { lines, redactions };
}

/** Lines of context on each side, and how far around the line they are looked for */
export const CONTEXT_MAX_LINES = 50;
const CONTEXT_SPAN_NS = 3_600_000_000_000n;

/**
 * The lines before and after one line of the same pod (the pod-log gate is the route's): two reads around the line's
 * own timestamp — backward up to it, forward from it — within an hour each side. The line itself is not repeated.
 */
export async function getLogContext(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace: string; pod: string; container?: string; tsNs: string; lines: number },
): Promise<LogContextResponse> {
  assertSignedInForCluster(env, bearerToken);
  for (const v of [opts.namespace, opts.pod, ...(opts.container ? [opts.container] : [])]) {
    if (!NAME.test(v)) throw new HttpError(400, "invalid_name", "namespace / pod / container is not a Kubernetes name");
  }
  if (!/^\d{16,20}$/.test(opts.tsNs)) throw new HttpError(400, "invalid_time", "ts must be a nanosecond timestamp");
  const base: LogContextResponse = { clusterId, generatedAt: new Date().toISOString(), state: "ok", before: [], after: [], redactions: 0 };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const wait = backingOff(cfg);
  if (wait) return { ...base, ...wait };
  const n = String(Math.min(Math.max(opts.lines, 1), CONTEXT_MAX_LINES));
  const ts = BigInt(opts.tsNs);
  const selector = `{namespace="${opts.namespace}", pod="${opts.pod}"${opts.container ? `, container="${opts.container}"` : ""}}`;
  try {
    const [b, a] = await Promise.all([
      // Loki's range is [start, end): end = ts leaves the line itself out; start = ts + 1 does the same going forward
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: selector, start: String(ts - CONTEXT_SPAN_NS), end: String(ts), limit: n, direction: "backward" }, READ_TIMEOUT_MS, CATEGORIZE),
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: selector, start: String(ts + 1n), end: String(ts + CONTEXT_SPAN_NS), limit: n, direction: "forward" }, READ_TIMEOUT_MS, CATEGORIZE),
    ]);
    const before = podEntries(b.body, opts.pod), after = podEntries(a.body, opts.pod);
    return { ...base, before: before.lines.slice(-Number(n)), after: after.lines.slice(0, Number(n)), redactions: before.redactions + after.redactions };
  } catch (e) {
    return { ...base, ...(await classify(cfg, e)) };
  }
}

const podLogCache = new CacheManager<{ state: LokiState; message?: string; lines: PodLogEntry[]; redactions: number; truncated: boolean }>(50, 10_000);

/**
 * A pod's lines from Loki (the same gate as kubelet logs — the route checks it): `{namespace, pod[, container]}`
 * built from validated names, newest `limit` lines in the window, returned oldest first like a tail. The container
 * label is the collector's (Alloy `loki.source.kubernetes` sets namespace · pod · container).
 */
export async function getPodLogsFromLoki(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace: string; pod: string; container?: string; minutes: number; limit: number; at?: number },
): Promise<{ state: LokiState | "notConfigured"; message?: string; retryAt?: string; lines: PodLogEntry[]; redactions: number; truncated: boolean }> {
  assertSignedInForCluster(env, bearerToken);
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { state: "notConfigured", lines: [], redactions: 0, truncated: false };
  for (const v of [opts.namespace, opts.pod, ...(opts.container ? [opts.container] : [])]) {
    if (!NAME.test(v)) throw new HttpError(400, "invalid_name", "namespace / pod / container is not a Kubernetes name");
  }
  const selector = `{namespace="${opts.namespace}", pod="${opts.pod}"${opts.container ? `, container="${opts.container}"` : ""}}`;
  const limit = Math.min(Math.max(opts.limit, 1), MAX_LINES);
  const key = `${cachePrefix(bearerToken)}:loki-pod:${clusterId.toLowerCase()}:${selector}:${opts.minutes}:${limit}:${opts.at ?? "now"}`;
  const hit = podLogCache.get(key);
  if (hit) return hit;
  const wait = backingOff(cfg);
  if (wait) return { ...wait, lines: [], redactions: 0, truncated: false };
  try {
    const res = await lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: selector, ...range(opts.minutes, opts.at), limit: String(limit), direction: "backward" }, READ_TIMEOUT_MS, CATEGORIZE);
    const { lines, redactions } = podEntries(res.body, opts.pod);
    const out = { state: "ok" as const, lines: lines.slice(-limit), redactions, truncated: res.truncated };
    podLogCache.set(key, out);
    return out;
  } catch (e) {
    return { ...(await classify(cfg, e)), lines: [], redactions: 0, truncated: false };
  }
}

// ── Hubble drops from hubble-flow-exporter ──

const label = (e: HubbleFlow["source"], ip?: string) =>
  e.namespace ? `${e.namespace}/${e.workloadName || e.podName}` : e.labels["reserved:world"] !== undefined || e.identity === 2 ? `world${ip ? ` (${ip})` : ""}` : ip ?? `identity ${e.identity}`;

/** Pure: exporter lines → drops grouped by source → destination, port, reason; relay status lines are skipped */
export function summarizeLokiDrops(lines: string[]): { drops: LokiDropsResponse["drops"]; flowLines: number } {
  const flowLines = lines.filter((l) => l.includes('"flow"'));
  const flows = parseHubbleJsonOutput(flowLines.join("\n")).filter((f) => f.verdict === "DROPPED");
  const map = new Map<string, LokiDropsResponse["drops"][number]>();
  for (const f of flows) {
    const source = label(f.source, f.sourceIp);
    const destination = label(f.destination, f.destinationIp);
    const reason = f.dropReasonDesc || "unknown";
    const k = [source, destination, f.destinationPort, f.l4Protocol, reason].join("|");
    const row = map.get(k) ?? { source, destination, port: f.destinationPort, protocol: f.l4Protocol, reason, count: 0, lastSeen: f.time };
    row.count++;
    if (f.time > row.lastSeen) row.lastSeen = f.time;
    map.set(k, row);
  }
  return { drops: [...map.values()].sort((a, b) => b.count - a.count).slice(0, 50), flowLines: flowLines.length };
}

const dropCache = new CacheManager<LokiDropsResponse>(20, 30_000);
/** Flow lines read per window (newest first) — more than this and the response says `truncated` */
export const DROP_LINE_LIMIT = 2000;

/**
 * `at` = the window's end (epoch seconds) for a past range — Loki keeps the exporter's drops for days, unlike the
 * agents' buffers and the Hubble UI sample (now only); the AMW cross-check is a "now" figure, so it is skipped then
 */
export async function getLokiDrops(
  env: Env, bearerToken: string | undefined, clusterId: string, minutes: number,
  amwDrops: () => Promise<number | null>, at?: number,
): Promise<LokiDropsResponse> {
  if (!(DROP_WINDOWS as readonly number[]).includes(minutes)) throw new HttpError(400, "invalid_window", `window must be one of ${DROP_WINDOWS.join(", ")}`);
  assertSignedInForCluster(env, bearerToken);
  const base: LokiDropsResponse = {
    clusterId, generatedAt: new Date().toISOString(), state: "ok", windowMinutes: minutes, drops: [], flowLines: 0, relayErrors: 0, pipelineBroken: null,
    ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
  };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const key = `${cachePrefix(bearerToken)}:loki-drops:${clusterId.toLowerCase()}:${minutes}:${at ?? "now"}`;
  const hit = dropCache.get(key);
  if (hit) return hit;
  const wait = backingOff(cfg);
  if (wait) return { ...base, ...wait };
  try {
    const [lines, relay, amw] = await Promise.all([
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: '{job="hubble-flows"} |= "\\"flow\\":"', ...range(minutes, at), limit: String(DROP_LINE_LIMIT), direction: "backward" }),
      lokiGet<LokiVector>(cfg, "/loki/api/v1/query", { query: `sum(count_over_time({job="hubble-flows"} |= "NODE_ERROR" [${minutes}m]))`, time: String(at === undefined ? nowNs() : BigInt(at) * 1_000_000_000n) }).catch(() => null),
      at === undefined ? amwDrops().catch(() => null) : Promise.resolve(null),
    ]);
    // Over the body limit the answer is not parsed at all: that is "too much to read", not "no flow lines"
    if (lines.truncated) return { ...base, state: "failed", message: `more than ${MAX_BODY / 1_000_000} MB of drop lines in ${minutes} minutes — pick a shorter window` };
    const all = (lines.body.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1] ?? ""));
    const { drops, flowLines } = summarizeLokiDrops(all);
    const result: LokiDropsResponse = {
      ...base, drops, flowLines,
      // The newest DROP_LINE_LIMIT lines only: the counts are a floor, not the window's total
      ...(all.length >= DROP_LINE_LIMIT ? { truncated: true } : {}),
      relayErrors: Math.round(Number(relay?.body.data?.result?.[0]?.value?.[1] ?? 0)),
      // Hubble counted drops (AMW) but the exporter shipped none → the exporter / relay pipeline is broken
      pipelineBroken: amw === null ? null : amw > 0 && flowLines === 0,
    };
    dropCache.set(key, result);
    return result;
  } catch (e) {
    return { ...base, ...(await classify(cfg, e)) };
  }
}
