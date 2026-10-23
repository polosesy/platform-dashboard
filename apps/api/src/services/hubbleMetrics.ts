// Hubble without exec, from Hubble metrics in the cluster's Azure Monitor workspace (Managed Prometheus).
//
// What the metrics can say (measured on AKS ACNS, Cilium 1.19, 2026-10-23): every hubble_flows_processed_total series
// carries `source` OR `destination` ("namespace/pod"), never both — so there are no edges: per-workload sent /
// received events, drops by reason, policy_denied, DNS response codes. Pairing sources with destinations would
// invent edges and is not done. Counts are Hubble events at each observation point, not connections. Policy-verdict
// series carry no match / allowed-by, so they cannot tell what enforcing would block (services/hubbleAudit.ts needs
// exec or flow logs). A family absent from the workspace is listed in `missing` and its fields are null, never 0.

import type { Env } from "../env.js";
import type { HubbleMetricsState, HubbleMetricsSummary, HubbleMetricsWorkload, HubbleWorkloadRef } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import { HttpError, safeMessage } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";
import { pickScope, scopeMatchers, type Scope } from "./promScope.js";

export { pickScope, promString, scopeMatchers, type Scope } from "./promScope.js";

export type PromRow = { metric: Record<string, string>; value: number };

/** Windows the view offers (minutes) — anything else is refused, never interpolated */
export const METRICS_WINDOWS = [5, 15, 60, 360] as const;
export function metricsWindow(v: number): number {
  if (!(METRICS_WINDOWS as readonly number[]).includes(v)) throw new HttpError(400, "invalid_window", `window must be one of ${METRICS_WINDOWS.join(", ")} minutes`);
  return v;
}

export function hubbleQueries(scope: Scope, minutes: number): Record<string, string> {
  const S = scopeMatchers(scope);
  const C = scopeMatchers(scope, false);
  const w = `[${metricsWindow(minutes)}m]`;
  const sel = (name: string, extra = "") => `${name}{${[S, extra].filter(Boolean).join(",")}}`;
  return {
    // One count per family: `a or b` drops b's series whose labels equal a's (vector matching ignores the name)
    familyDrops: `count(${sel("hubble_drop_total")})`,
    familyDns: `count(${sel("hubble_dns_responses_total")})`,
    familyLost: `count(${sel("hubble_lost_events_total")})`,
    sides: `sum by (source, destination) (increase(${sel("hubble_flows_processed_total")}${w})) > 0`,
    verdicts: `sum by (verdict) (increase(${sel("hubble_flows_processed_total")}${w}))`,
    protocols: `sum by (protocol) (increase(${sel("hubble_flows_processed_total")}${w}))`,
    policyVerdicts: `sum by (verdict) (increase(${sel("hubble_flows_processed_total", 'type="policyverdict"')}${w}))`,
    drops: `sum by (source, destination, reason) (increase(${sel("hubble_drop_total")}${w})) > 0`,
    dns: `sum by (source, destination, rcode) (increase(${sel("hubble_dns_responses_total")}${w})) > 0`,
    lost: `sum(increase(${sel("hubble_lost_events_total")}${w}))`,
    podOwners: `group by (namespace, pod, owner_kind, owner_name) (max_over_time(kube_pod_owner{${C}}${w}))`,
    rsOwners: `group by (namespace, replicaset, owner_kind, owner_name) (max_over_time(kube_replicaset_owner{${C}}${w}))`,
  };
}

const ROW_LIMIT = 5000;
const round = (n: number) => Math.round(n);
const isNoError = (rcode: string) => /^no[\s_-]?error$/i.test(rcode.trim());

export type MetricsInput = {
  families: Set<string>;
  sides: PromRow[]; verdicts: PromRow[]; protocols: PromRow[]; policyVerdicts: PromRow[];
  drops: PromRow[]; dns: PromRow[]; lost: number | null;
  podOwners: OwnerRow[]; rsOwners: OwnerRow[];
};

type Body = Omit<HubbleMetricsSummary, "clusterId" | "generatedAt" | "windowMinutes" | "state" | "message" | "scope">;

/** Pure: query results → the summary body (workloads by owner or pattern, unattributed kept, nulls for absent families) */
export function aggregateHubbleMetrics(input: MetricsInput): Body {
  const owners = ownerIndex(input.podOwners, input.rsOwners);
  const hasDrops = input.families.has("hubble_drop_total");
  const hasDns = input.families.has("hubble_dns_responses_total");
  const workloads = new Map<string, HubbleMetricsWorkload & { podSet: Set<string> }>();
  const unattributed = { egressEvents: 0, ingressEvents: 0, unlabelledEvents: 0 };
  const wl = (label: string | undefined): (HubbleMetricsWorkload & { podSet: Set<string> }) | null => {
    const ref = resolveWorkload(label, owners);
    if (!ref) return null;
    const key = `${ref.namespace}/${ref.workload}`;
    let w = workloads.get(key);
    if (!w) {
      w = { ...ref, pods: 0, podSet: new Set(), egressEvents: 0, ingressEvents: 0,
        drops: hasDrops ? 0 : null, policyDenied: hasDrops ? 0 : null, dnsErrors: hasDns ? 0 : null };
      workloads.set(key, w);
    } else if (w.basis === "pattern" && ref.basis === "owner") Object.assign(w, ref); // an owner row is better evidence
    w.podSet.add(label!);
    return w;
  };
  const truncated = [input.sides, input.drops, input.dns].some((r) => r.length >= ROW_LIMIT);

  for (const r of input.sides.slice(0, ROW_LIMIT)) {
    // A series names one side; if a future config names both, count it once — as sent — and draw no edge
    if (r.metric.source !== undefined && r.metric.source !== "") {
      const w = wl(r.metric.source);
      if (w) w.egressEvents += r.value; else unattributed.egressEvents += r.value;
    } else if (r.metric.destination !== undefined && r.metric.destination !== "") {
      const w = wl(r.metric.destination);
      if (w) w.ingressEvents += r.value; else unattributed.ingressEvents += r.value;
    } else unattributed.unlabelledEvents += r.value;
  }

  const dropsByReason = new Map<string, number>();
  const policyDenied = new Map<string, HubbleWorkloadRef & { direction: "EGRESS" | "INGRESS"; count: number }>();
  for (const r of input.drops.slice(0, ROW_LIMIT)) {
    const reason = r.metric.reason ?? "unknown";
    dropsByReason.set(reason, (dropsByReason.get(reason) ?? 0) + r.value);
    const egress = !!r.metric.source;
    const w = wl(egress ? r.metric.source : r.metric.destination);
    if (!w) continue;
    w.drops = (w.drops ?? 0) + r.value;
    if (/polic/i.test(reason)) {
      w.policyDenied = (w.policyDenied ?? 0) + r.value;
      const direction = egress ? "EGRESS" : "INGRESS";
      const key = `${direction}|${w.namespace}/${w.workload}`;
      const row = policyDenied.get(key) ?? { namespace: w.namespace, workload: w.workload, kind: w.kind, basis: w.basis, direction, count: 0 };
      row.count += r.value;
      policyDenied.set(key, row);
    }
  }

  // A DNS response is sent by the server: `source` = the DNS server pod, `destination` = the client
  const dnsErrors = new Map<string, HubbleMetricsSummary["dnsErrors"][number]>();
  for (const r of input.dns.slice(0, ROW_LIMIT)) {
    const rcode = r.metric.rcode ?? "";
    if (!rcode || isNoError(rcode)) continue;
    const side = r.metric.destination ? "client" : "server";
    const w = wl(side === "client" ? r.metric.destination : r.metric.source);
    if (!w) continue;
    if (side === "client") w.dnsErrors = (w.dnsErrors ?? 0) + r.value;
    const key = `${side}|${rcode}|${w.namespace}/${w.workload}`;
    const row = dnsErrors.get(key) ?? { rcode, namespace: w.namespace, workload: w.workload, side, count: 0 };
    row.count += r.value;
    dnsErrors.set(key, row);
  }

  const verdict = (rows: PromRow[], v: string) => round(rows.filter((r) => (r.metric.verdict ?? "").toLowerCase() === v).reduce((a, r) => a + r.value, 0));
  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  return {
    missing: [["hubble_drop_total", hasDrops], ["hubble_dns_responses_total", hasDns], ["hubble_lost_events_total", input.lost !== null]]
      .filter(([, ok]) => !ok).map(([n]) => n as string),
    lostEvents: input.lost === null ? null : round(input.lost),
    workloads: [...workloads.values()]
      .map(({ podSet, ...w }) => ({ ...w, pods: podSet.size, egressEvents: round(w.egressEvents), ingressEvents: round(w.ingressEvents),
        drops: w.drops === null ? null : round(w.drops), policyDenied: w.policyDenied === null ? null : round(w.policyDenied),
        dnsErrors: w.dnsErrors === null ? null : round(w.dnsErrors) }))
      .sort((a, b) => b.egressEvents + b.ingressEvents - (a.egressEvents + a.ingressEvents) || (a.workload < b.workload ? -1 : 1)),
    unattributed: { egressEvents: round(unattributed.egressEvents), ingressEvents: round(unattributed.ingressEvents), unlabelledEvents: round(unattributed.unlabelledEvents) },
    byVerdict: { forwarded: verdict(input.verdicts, "forwarded"), dropped: verdict(input.verdicts, "dropped"),
      redirected: verdict(input.verdicts, "redirected"), error: verdict(input.verdicts, "error") },
    protocols: input.protocols.map((r) => ({ protocol: r.metric.protocol ?? "unknown", events: round(r.value) })).filter((p) => p.events > 0)
      .sort((a, b) => b.events - a.events),
    dropsByReason: [...dropsByReason].map(([reason, count]) => ({ reason, count: round(count) })).filter((d) => d.count > 0).sort(byCount),
    policyDenied: [...policyDenied.values()].map((p) => ({ ...p, count: round(p.count) })).filter((p) => p.count > 0).sort(byCount).slice(0, 50),
    policyVerdictEvents: { forwarded: verdict(input.policyVerdicts, "forwarded"), dropped: verdict(input.policyVerdicts, "dropped"),
      redirected: verdict(input.policyVerdicts, "redirected") },
    dnsErrors: [...dnsErrors.values()].map((d) => ({ ...d, count: round(d.count) })).filter((d) => d.count > 0).sort(byCount).slice(0, 50),
    truncated,
  };
}

/** A Prometheus failure as a state the UI names (no sample data for signed-in callers) */
export function metricsStateOf(e: unknown): { state: HubbleMetricsState; message: string } {
  const message = safeMessage(e);
  if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { state: "forbidden", message };
  const status = Number(/^(?:Prometheus|ARM)\s+(\d{3})\b/.exec(message)?.[1] ?? 0);
  if (status === 401 || status === 403) return { state: "forbidden", message };
  if (status === 429) return { state: "throttled", message };
  return { state: "failed", message };
}

// ── Collection ──

type PromResponse = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }; error?: string };

function rowsOf(resp: unknown): PromRow[] {
  const r = resp as PromResponse;
  if (r?.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
  return (r?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) }))
    .filter((x) => Number.isFinite(x.value));
}

/** Run queries, at most `limit` in flight */
async function runAll(fetcher: PrometheusFetcher, endpoint: string, queries: Record<string, string>, limit = 4): Promise<Record<string, PromRow[]>> {
  const names = Object.keys(queries);
  const out: Record<string, PromRow[]> = {};
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const n = names[next++]!;
      out[n] = rowsOf(await fetcher.query(endpoint, queries[n]!));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker));
  return out;
}

const owner = (kindKey: "pod" | "replicaset") => (r: PromRow): OwnerRow => ({
  namespace: r.metric.namespace ?? "", name: r.metric[kindKey] ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "",
});

const summaryCache = new CacheManager<HubbleMetricsSummary>(20, 30_000);
const scopeCache = new CacheManager<Scope | "ambiguous" | null>(20, 10 * 60_000);
const inflight = new Map<string, Promise<HubbleMetricsSummary>>();

export async function getHubbleMetricsSummary(env: Env, bearerToken: string | undefined, clusterId: string, minutes: number): Promise<HubbleMetricsSummary> {
  const windowMinutes = metricsWindow(minutes);
  const key = `${cachePrefix(bearerToken)}:hubble-prom:${clusterId.toLowerCase()}:${windowMinutes}`;
  const cached = summaryCache.get(key);
  if (cached) return cached;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, windowMinutes)
    .then((s) => { if (s.state === "ok") summaryCache.set(key, s); return s; })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function emptySummary(clusterId: string, windowMinutes: number, state: HubbleMetricsState, message?: string): HubbleMetricsSummary {
  return {
    clusterId, generatedAt: new Date().toISOString(), windowMinutes, state, ...(message ? { message } : {}), scope: null,
    missing: [], lostEvents: null, workloads: [], unattributed: { egressEvents: 0, ingressEvents: 0, unlabelledEvents: 0 },
    byVerdict: { forwarded: 0, dropped: 0, redirected: 0, error: 0 }, protocols: [], dropsByReason: [], policyDenied: [],
    policyVerdictEvents: { forwarded: 0, dropped: 0, redirected: 0 }, dnsErrors: [], truncated: false,
  };
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, windowMinutes: number): Promise<HubbleMetricsSummary> {
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return emptySummary(clusterId, windowMinutes, target.state, target.message);
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const scopeKey = `${cachePrefix(bearerToken)}:hubble-scope:${clusterId.toLowerCase()}`;
    let scope = scopeCache.get(scopeKey);
    if (scope === undefined) {
      const rows = rowsOf(await fetcher.query(target.endpoint, "group by (cluster, job, collector) (hubble_flows_processed_total)"));
      scope = pickScope(rows.map((r) => ({ cluster: r.metric.cluster, job: r.metric.job, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
      scopeCache.set(scopeKey, scope);
    }
    if (scope === null) return emptySummary(clusterId, windowMinutes, "noHubbleMetrics");
    if (scope === "ambiguous") return emptySummary(clusterId, windowMinutes, "ambiguousCluster");
    const r = await runAll(fetcher, target.endpoint, hubbleQueries(scope, windowMinutes));
    const families = new Set([
      ...(r.familyDrops!.length ? ["hubble_drop_total"] : []),
      ...(r.familyDns!.length ? ["hubble_dns_responses_total"] : []),
      ...(r.familyLost!.length ? ["hubble_lost_events_total"] : []),
    ]);
    const body = aggregateHubbleMetrics({
      families, sides: r.sides!, verdicts: r.verdicts!, protocols: r.protocols!, policyVerdicts: r.policyVerdicts!,
      drops: r.drops!, dns: r.dns!, lost: families.has("hubble_lost_events_total") ? (r.lost![0]?.value ?? 0) : null,
      podOwners: r.podOwners!.map(owner("pod")), rsOwners: r.rsOwners!.map(owner("replicaset")),
    });
    return { clusterId, generatedAt: new Date().toISOString(), windowMinutes, state: "ok", scope, ...body };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return emptySummary(clusterId, windowMinutes, state, message);
  }
}
