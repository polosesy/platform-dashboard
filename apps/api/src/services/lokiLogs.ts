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
import type { HubbleFlow, LogLine, LokiDropsResponse, LokiState, PodLogEntry, WorkloadLogsResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection } from "../infra/azureClientFactory.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { redactLogLine } from "./logRedaction.js";
import { parseHubbleJsonOutput } from "./hubbleClient.js";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const MAX_LINES = 500;
const MAX_LINE_BYTES = 4096;
const MAX_BODY = 2 * 1024 * 1024;
/** A workload's stream (every pod of it): up to 6 h — the time picker's quick ranges below that (web WORKLOAD_LOG_WINDOWS) */
export const LOG_WINDOWS = [5, 15, 30, 60, 180, 360] as const;
export const DROP_WINDOWS = [60, 360, 1440] as const;

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
async function lokiGet<T>(cfg: { url: string; tenant?: string }, path: string, params: Record<string, string>, timeoutMs = READ_TIMEOUT_MS): Promise<{ body: T; truncated: boolean }> {
  const res = await fetch(`${cfg.url}${path}?${new URLSearchParams(params)}`, {
    headers: { Accept: "application/json", ...(cfg.tenant ? { "X-Scope-OrgID": cfg.tenant } : {}) },
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

// ── One pod's lines (AKS 모니터링 › 로그) ──

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
    const res = await lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: selector, ...range(opts.minutes, opts.at), limit: String(limit), direction: "backward" });
    let redactions = 0;
    const lines: PodLogEntry[] = [];
    for (const st of res.body.data?.result ?? []) {
      for (const v of st.values ?? []) {
        const p = parseLogLine(st.stream ?? {}, v[0], v[1] ?? "", v[2]);
        redactions += p.redactions;
        const stream = st.stream?.stream;
        lines.push({ timestamp: p.line.time, podName: opts.pod, containerName: st.stream?.container ?? "", logMessage: p.line.text, stream: stream === "stdout" || stream === "stderr" ? stream : "unknown" });
      }
    }
    lines.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
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

export async function getLokiDrops(
  env: Env, bearerToken: string | undefined, clusterId: string, minutes: number,
  amwDrops: () => Promise<number | null>,
): Promise<LokiDropsResponse> {
  if (!(DROP_WINDOWS as readonly number[]).includes(minutes)) throw new HttpError(400, "invalid_window", `window must be one of ${DROP_WINDOWS.join(", ")}`);
  const base: LokiDropsResponse = { clusterId, generatedAt: new Date().toISOString(), state: "ok", windowMinutes: minutes, drops: [], flowLines: 0, relayErrors: 0, pipelineBroken: null };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const key = `${cachePrefix(bearerToken)}:loki-drops:${clusterId.toLowerCase()}:${minutes}`;
  const hit = dropCache.get(key);
  if (hit) return hit;
  const wait = backingOff(cfg);
  if (wait) return { ...base, ...wait };
  try {
    const [lines, relay, amw] = await Promise.all([
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: '{job="hubble-flows"} |= "\\"flow\\":"', ...range(minutes), limit: "2000", direction: "backward" }),
      lokiGet<LokiVector>(cfg, "/loki/api/v1/query", { query: `sum(count_over_time({job="hubble-flows"} |= "NODE_ERROR" [${minutes}m]))`, time: String(nowNs()) }).catch(() => null),
      amwDrops().catch(() => null),
    ]);
    const all = (lines.body.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1] ?? ""));
    const { drops, flowLines } = summarizeLokiDrops(all);
    const result: LokiDropsResponse = {
      ...base, drops, flowLines,
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
