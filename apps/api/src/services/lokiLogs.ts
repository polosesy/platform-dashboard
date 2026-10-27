// The cluster's own Loki, read in-cluster (connections file `aks.observability.loki`): a workload's log stream and
// Hubble drops shipped by hubble-flow-exporter (`{job="hubble-flows"}`).
//
// Rules (docs/deployment/kubernetes.md): the API builds every LogQL itself from validated Kubernetes names — a query
// string never comes from the browser; workload logs pass the same gate as kubelet pod logs (operator role +
// `aks.podLogNamespaces`); lines are redacted (logRedaction.ts) and capped (500 lines · 4 KB a line · 2 MB a
// response · 15 s). Loki often sits behind the customer's monitor-namespace policy: a refused / timed-out
// connection is state "unreachable" with the rule to add — never sample lines.

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
export const LOG_WINDOWS = [15, 60, 360] as const;
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

const NET = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|aborted|timeout|fetch failed/i;
export function lokiStateOf(e: unknown): { state: LokiState; message: string } {
  const message = safeMessage(e);
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  return { state: NET.test(`${message} ${cause?.code ?? ""} ${cause?.message ?? ""}`) ? "unreachable" : "failed", message };
}

async function lokiGet<T>(cfg: { url: string; tenant?: string }, path: string, params: Record<string, string>): Promise<{ body: T; truncated: boolean }> {
  const res = await fetch(`${cfg.url}${path}?${new URLSearchParams(params)}`, {
    headers: { Accept: "application/json", ...(cfg.tenant ? { "X-Scope-OrgID": cfg.tenant } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Loki ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const truncated = text.length > MAX_BODY;
  return { body: JSON.parse(truncated ? "{}" : text) as T, truncated };
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const range = (minutes: number) => ({ start: String(nowNs() - BigInt(minutes) * 60_000_000_000n), end: String(nowNs()) });

const logCache = new CacheManager<WorkloadLogsResponse>(50, 15_000);

export async function getWorkloadLogs(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { namespace: string; workload: string; pods?: string[]; errorsOnly: boolean; minutes: number },
): Promise<WorkloadLogsResponse> {
  if (!(LOG_WINDOWS as readonly number[]).includes(opts.minutes)) throw new HttpError(400, "invalid_window", `minutes must be one of ${LOG_WINDOWS.join(", ")}`);
  const selector = workloadSelector(opts.namespace, opts.workload, opts.pods);
  const base: WorkloadLogsResponse = { clusterId, generatedAt: new Date().toISOString(), state: "ok", lines: [], exceptions: [], truncated: false, redactions: 0, windowMinutes: opts.minutes };
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { ...base, state: "notConfigured" };
  const key = `${cachePrefix(bearerToken)}:loki-logs:${clusterId.toLowerCase()}:${selector}:${opts.errorsOnly}:${opts.minutes}`;
  const hit = logCache.get(key);
  if (hit) return hit;
  const q = logQueries(selector, opts.errorsOnly, opts.minutes);
  try {
    const [lines, exc] = await Promise.all([
      lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: q.lines, ...range(opts.minutes), limit: String(MAX_LINES), direction: "backward" }),
      lokiGet<LokiVector>(cfg, "/loki/api/v1/query", { query: q.exceptions, time: String(nowNs()) }).catch(() => null),
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
    return { ...base, ...lokiStateOf(e) };
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
  opts: { namespace: string; pod: string; container?: string; minutes: number; limit: number },
): Promise<{ state: LokiState | "notConfigured"; message?: string; lines: PodLogEntry[]; redactions: number; truncated: boolean }> {
  const cfg = lokiConfig(env, clusterId);
  if (!cfg) return { state: "notConfigured", lines: [], redactions: 0, truncated: false };
  for (const v of [opts.namespace, opts.pod, ...(opts.container ? [opts.container] : [])]) {
    if (!NAME.test(v)) throw new HttpError(400, "invalid_name", "namespace / pod / container is not a Kubernetes name");
  }
  const selector = `{namespace="${opts.namespace}", pod="${opts.pod}"${opts.container ? `, container="${opts.container}"` : ""}}`;
  const limit = Math.min(Math.max(opts.limit, 1), MAX_LINES);
  const key = `${cachePrefix(bearerToken)}:loki-pod:${clusterId.toLowerCase()}:${selector}:${opts.minutes}:${limit}`;
  const hit = podLogCache.get(key);
  if (hit) return hit;
  try {
    const res = await lokiGet<LokiStreams>(cfg, "/loki/api/v1/query_range", { query: selector, ...range(opts.minutes), limit: String(limit), direction: "backward" });
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
    return { ...lokiStateOf(e), lines: [], redactions: 0, truncated: false };
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
    return { ...base, ...lokiStateOf(e) };
  }
}
