// The customer's own observability pipeline, read from metrics already in the cluster's Azure Monitor workspace
// (AKS 모니터링 › 관측 스택): Alloy collectors (remote write, components, config, Loki/OTLP/Pyroscope writers),
// Loki, Tempo, Pyroscope (its sender + the pods behind the Service it writes to), kube-state-metrics freshness,
// scrape targets (`up`), and every component's own pods by Kubernetes readiness (kube-state-metrics).
//
// A sender's "sent > 0" is never a health verdict on its own: stg 2026-10-28 pyroscope-0 was not Ready for 3.5 h
// (21:38–01:14Z) while Alloy kept sending 3.2 profiles/s — the page said "정상".
//
// SRE rules: every value is a query result (the PromQL travels with it); no series = "unknown" / "notDetected",
// never 0; states are facts (failed > 0, lag, stale, down), not invented SLO thresholds. Windows are 10 minutes —
// at least 4 scrapes at 60 s (stg) and 30 s (prd). Nothing is read from Loki, Tempo, Pyroscope or Grafana:
// the connection's `aks.observability.grafana` only builds links into Grafana Explore.
//
// One slow query never takes the page down (stg 2026-10-29: the workspace answered 28 of 29 queries in < 1 s and held
// `prometheus_remote_storage_highest_timestamp_in_seconds` 13–30 s, then 504, five times in a row, then 90 ms — the
// whole tab said "This operation was aborted"). Each query has its own time limit and one retry; a query that still
// does not answer is a gap: only the values built on it read "조회 실패" (never 0 — "0 targets down" would be a lie),
// the rest is shown. A refresh that fails as a whole shows the last complete answer (≤ 15 min) with its time.

import type { Env } from "../env.js";
import type { ObservabilityStackResponse, StackCheck, StackCheckId, StackComponent, StackComponentKind, StackQueryGap, StackState } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import * as k8s from "@kubernetes/client-node";
import { HttpError } from "../infra/requestParams.js";
import { withK8sRetry } from "../infra/k8sRetry.js";
import { loadKubeConfig } from "./kubernetes.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, scopeMatchers } from "./promScope.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";

export const STACK_WINDOW_MINUTES = 10;

/** The queries (C = cluster matcher). Grouped by pod so each value lands on the workload that emitted it */
export function stackQueries(C: string): Record<string, string> {
  const w = `[${STACK_WINDOW_MINUTES}m]`;
  const s = (m: string) => `${m}{${C}}`;
  const byPod = (m: string) => `sum by (pod) (rate(${s(m)}${w}))`;
  return {
    alloyBuild: `group by (namespace, pod, version) (${s("alloy_build_info")})`,
    lokiBuild: `group by (namespace, pod, version) (${s("loki_build_info")})`,
    tempoBuild: `group by (namespace, pod, version) (${s("tempo_build_info")})`,
    rwTotal: byPod("prometheus_remote_storage_samples_total"),
    rwFailed: byPod("prometheus_remote_storage_samples_failed_total"),
    rwLag: `max by (pod) (${s("prometheus_remote_storage_highest_timestamp_in_seconds")}) - max by (pod) (${s("prometheus_remote_storage_queue_highest_sent_timestamp_seconds")})`,
    rwPending: `sum by (pod) (${s("prometheus_remote_storage_samples_pending")})`,
    components: `sum by (pod, health_type) (${s("alloy_component_controller_running_components")})`,
    configLoad: `min by (pod) (${s("alloy_config_last_load_successful")})`,
    logsSent: byPod("loki_write_sent_entries_total"),
    logsDropped: byPod("loki_write_dropped_entries_total"),
    spansAccepted: byPod("otelcol_receiver_accepted_spans_total"),
    spansRefused: byPod("otelcol_receiver_refused_spans_total"),
    spansExportFailed: byPod("otelcol_exporter_send_failed_spans_total"),
    profilesSent: byPod("pyroscope_write_sent_bytes_total"),
    profilesDropped: byPod("pyroscope_write_dropped_profiles_total"),
    // Where the Pyroscope writer sends (its `endpoint` label = the Service URL)
    profilesTarget: `group by (pod, endpoint) (${s("pyroscope_write_sent_bytes_total")})`,
    podReady: `max by (namespace, pod) (kube_pod_status_ready{${C}, condition="true"})`,
    lokiIngest: byPod("loki_distributor_bytes_received_total"),
    tempoSpans: byPod("tempo_distributor_spans_received_total"),
    tempoDiscarded: byPod("tempo_discarded_spans_total"),
    upTotal: `count by (job) (${s("up")})`,
    upDown: `count by (job) (${s("up")} == 0)`,
    upDownList: `group by (job, namespace, pod) (${s("up")} == 0)`,
    upPods: `group by (job, namespace, pod) (${s("up")})`,
    ksmAge: `time() - max(timestamp(${s("kube_node_info")}))`,
    // Nodes a cilium agent cannot reach (health checks) — also what leaves hubble-relay with stale peers
    ciliumUnreachable: `max(${s("cilium_unreachable_nodes")})`,
    podOwners: `group by (namespace, pod, owner_kind, owner_name) (max_over_time(${s("kube_pod_owner")}${w}))`,
    rsOwners: `group by (namespace, replicaset, owner_kind, owner_name) (max_over_time(${s("kube_replicaset_owner")}${w}))`,
  };
}

/** Scrape jobs that are pipeline components (names differ per site — Alloy relabels to the ama-metrics names) */
const JOB_KIND: [RegExp, StackComponentKind][] = [
  [/kube-state-metrics/i, "kubeStateMetrics"],
  [/^node$|node-exporter/i, "nodeExporter"],
  [/hubble/i, "hubble"],
  [/prometheus_collector_health|ama-metrics/i, "amaMetrics"],
];
export const KSM_STALE_SECONDS = 180;
export const RW_LAG_SECONDS = 120;

const SEVERITY: StackState[] = ["ok", "unknown", "notDetected", "degraded", "stale", "down"];
/** Worst state; unknown checks do not hide a measured ok (all unknown → unknown) */
export function rollup(states: StackState[]): StackState {
  const known = states.filter((s) => s !== "unknown");
  if (!known.length) return states.length ? "unknown" : "notDetected";
  return known.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "ok" as StackState);
}

export type StackRaw = Record<keyof ReturnType<typeof stackQueries>, PromRow[]>;

const K8S_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** The Service a Pyroscope writer sends to: `http(s)://<svc>.<ns>[.svc[.cluster.local]]:<port>` → names; else null */
export function pyroscopeTarget(rows: PromRow[]): { service: string; namespace: string; display: string } | null {
  for (const url of [...new Set(rows.map((r) => r.metric.endpoint ?? "").filter(Boolean))].sort()) {
    let host: string, port: string;
    try { const u = new URL(url); host = u.hostname; port = u.port; } catch { continue; }
    const parts = host.toLowerCase().split(".");
    const inCluster = parts.length === 2 || (parts[2] === "svc" && (parts.length === 3 || parts.slice(3).join(".") === "cluster.local"));
    if (inCluster && K8S_NAME.test(parts[0]!) && K8S_NAME.test(parts[1]!)) {
      return { service: parts[0]!, namespace: parts[1]!, display: `${parts[0]}.${parts[1]}${port ? `:${port}` : ""}` };
    }
  }
  return null;
}

/** A Service's endpoints from the Kubernetes API: ready / not-ready pod names */
export type EndpointPods = { ready: string[]; notReady: string[] };

const sumOf = (rows: PromRow[], pods: Set<string>): number | null => {
  const mine = rows.filter((r) => pods.has(r.metric.pod ?? ""));
  return mine.length ? mine.reduce((a, r) => a + r.value, 0) : null;
};
const maxOf = (rows: PromRow[], pods: Set<string>): number | null => {
  const mine = rows.filter((r) => pods.has(r.metric.pod ?? ""));
  return mine.length ? Math.max(...mine.map((r) => r.value)) : null;
};
const minOf = (rows: PromRow[], pods: Set<string>): number | null => {
  const mine = rows.filter((r) => pods.has(r.metric.pod ?? ""));
  return mine.length ? Math.min(...mine.map((r) => r.value)) : null;
};

/** Pure: query results → components, targets, down targets */
export function aggregateStack(
  raw: StackRaw, C: string, extra: { endpointPods?: EndpointPods | null; failed?: ReadonlySet<string> } = {},
): Pick<ObservabilityStackResponse, "components" | "targets" | "downTargets"> {
  const q = stackQueries(C);
  const failed = extra.failed ?? new Set<string>();
  const depsOf = (id: StackCheckId) => CHECK_DEPS[id] ?? [CHECK_QUERY[id]];
  const lost = (id: StackCheckId) => depsOf(id).some((n) => failed.has(n));
  // A check whose query did not answer: not read (unknown + queryFailed) — never the empty result's 0 / "none"
  const check = (id: StackCheckId, value: number | null, unit: StackCheck["unit"], state: (v: number) => StackState, deps = depsOf(id)): StackCheck =>
    deps.some((n) => failed.has(n))
      ? { id, value: null, unit, state: "unknown", promql: q[CHECK_QUERY[id]], queryFailed: true }
      : { id, value: value === null ? null : Math.round(value * 1000) / 1000, unit, state: value === null ? "unknown" : state(value), promql: q[CHECK_QUERY[id]] };
  const ok = (): StackState => "ok";
  const bad = (v: number): StackState => (v > 0 ? "degraded" : "ok");

  // Pod → namespace from any row that has both (owners, up, build info)
  const owners = ownerIndex(
    raw.podOwners.map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.pod ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
    raw.rsOwners.map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.replicaset ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
  );
  const nsOfPod = new Map<string, string>();
  for (const r of [...raw.podOwners, ...raw.upPods, ...raw.alloyBuild, ...raw.lokiBuild, ...raw.tempoBuild]) {
    if (r.metric.pod && r.metric.namespace) nsOfPod.set(r.metric.pod, r.metric.namespace);
  }
  const workloadOf = (pod: string) => {
    const ns = nsOfPod.get(pod);
    const ref = ns ? resolveWorkload(`${ns}/${pod}`, owners) : null;
    return { namespace: ns ?? null, name: ref?.workload ?? pod };
  };

  // Kubernetes readiness of a pod (kube-state-metrics): 1 Ready · 0 not · absent = no series
  const readyOf = new Map<string, number>();
  for (const r of raw.podReady ?? []) if (r.metric.namespace && r.metric.pod) readyOf.set(`${r.metric.namespace}/${r.metric.pod}`, r.value);
  type Readiness = NonNullable<StackComponent["readiness"]>;
  const readiness = (basis: Readiness["basis"], pods: { pod: string; namespace: string | null }[]): Readiness | undefined => {
    const known = pods.map((p) => ({ pod: p.pod, v: p.namespace ? readyOf.get(`${p.namespace}/${p.pod}`) : undefined })).filter((x) => x.v !== undefined);
    if (!known.length) return undefined;
    return {
      basis, ready: known.filter((x) => x.v! >= 1).length, total: known.length,
      notReady: known.filter((x) => x.v! < 1).map((x) => ({ pod: x.pod, since: null })).sort((a, b) => (a.pod < b.pod ? -1 : 1)),
    };
  };
  // Not-Ready pods = degraded (a not-Ready pod can still take writes — stg pyroscope did); no pod behind a Service = down
  const readyCheck = (r: Readiness | undefined): StackCheck | null =>
    r ? check("podsReady", r.total - r.ready, "count", (v) => (r.total === 0 ? "down" : v > 0 ? "degraded" : "ok"))
      : lost("podsReady") ? check("podsReady", null, "count", () => "unknown") : null;

  // Components that report build info, one per workload (two Alloy deployments = two components)
  const groups = new Map<string, { kind: StackComponentKind; name: string; namespace: string | null; pods: { pod: string; version: string | null }[] }>();
  const addBuild = (kind: StackComponentKind, rows: PromRow[]) => {
    for (const r of rows) {
      const pod = r.metric.pod ?? "";
      if (!pod) continue;
      const wl = workloadOf(pod);
      const key = `${kind}|${wl.namespace ?? ""}/${wl.name}`;
      const g = groups.get(key) ?? { kind, name: wl.name, namespace: wl.namespace, pods: [] };
      if (!g.pods.some((p) => p.pod === pod)) g.pods.push({ pod, version: r.metric.version ?? null });
      groups.set(key, g);
    }
  };
  addBuild("alloy", raw.alloyBuild);
  addBuild("loki", raw.lokiBuild);
  addBuild("tempo", raw.tempoBuild);

  const components: StackComponent[] = [];
  for (const g of groups.values()) {
    const pods = new Set(g.pods.map((p) => p.pod));
    const checks: StackCheck[] = [];
    const add = (c: StackCheck | null) => { if (c && (c.value !== null || c.queryFailed || g.kind === "alloy")) checks.push(c); };
    // Remote write (Alloy, Tempo's metrics generator …): failure ratio, lag, pending
    const total = sumOf(raw.rwTotal, pods);
    const failed = sumOf(raw.rwFailed, pods);
    if (total !== null || g.kind === "alloy") {
      add(check("remoteWriteFailed", total === null ? null : total > 0 ? (failed ?? 0) / total : (failed ?? 0) > 0 ? 1 : 0, "ratio",
        (v) => (total === 0 ? "down" : v > 0 ? "degraded" : "ok")));
      add(check("remoteWriteLag", maxOf(raw.rwLag, pods), "seconds", (v) => (v > RW_LAG_SECONDS ? "degraded" : "ok")));
      add(check("remoteWritePending", sumOf(raw.rwPending, pods), "count", ok));
    }
    if (g.kind === "alloy") {
      const unhealthy = raw.components.filter((r) => pods.has(r.metric.pod ?? "") && (r.metric.health_type ?? "") !== "healthy");
      const anyComponents = raw.components.some((r) => pods.has(r.metric.pod ?? ""));
      add(check("componentsUnhealthy", anyComponents ? unhealthy.reduce((a, r) => a + r.value, 0) : null, "count", bad));
      add(check("configLoad", minOf(raw.configLoad, pods), "count", (v) => (v < 1 ? "degraded" : "ok")));
      for (const [id, rows, unit, st] of [
        ["logsSent", raw.logsSent, "perSecond", ok], ["logsDropped", raw.logsDropped, "perSecond", bad],
        ["spansAccepted", raw.spansAccepted, "perSecond", ok], ["spansRefused", raw.spansRefused, "perSecond", bad],
        ["spansExportFailed", raw.spansExportFailed, "perSecond", bad], ["profilesSent", raw.profilesSent, "bytesPerSecond", ok],
      ] as const) {
        const v = sumOf(rows, pods);
        if (v !== null || lost(id)) checks.push(check(id, v, unit, st));
      }
    }
    if (g.kind === "loki") add(check("lokiIngest", sumOf(raw.lokiIngest, pods), "bytesPerSecond", ok));
    if (g.kind === "tempo") {
      add(check("tempoSpans", sumOf(raw.tempoSpans, pods), "perSecond", ok));
      add(check("tempoDiscarded", sumOf(raw.tempoDiscarded, pods), "perSecond", bad));
    }
    const rd = readiness("self", g.pods.map((p) => ({ pod: p.pod, namespace: nsOfPod.get(p.pod) ?? g.namespace })));
    const rc = readyCheck(rd);
    if (rc) checks.unshift(rc);
    components.push({
      kind: g.kind, name: g.name, namespace: g.namespace, state: rollup(checks.map((c) => c.state)),
      pods: g.pods.sort((a, b) => (a.pod < b.pod ? -1 : 1)), checks, ...(rd ? { readiness: rd } : {}),
    });
  }

  // Pyroscope exposes no build info here: the pods behind the Service its Alloy writer sends to (Kubernetes
  // endpoints; without the API, the workload in that namespace named like the Service), plus what the writer sent
  // and dropped. Without its pods, "sent > 0" is not a verdict: state unknown (dropped > 0 still degrades).
  const profiles = raw.profilesSent.length ? raw.profilesSent.reduce((a, r) => a + r.value, 0) : null;
  const target = pyroscopeTarget(raw.profilesTarget ?? []);
  if (profiles !== null || target) {
    const dropped = raw.profilesDropped?.length ? raw.profilesDropped.reduce((a, r) => a + r.value, 0) : null;
    let rd: Readiness | undefined;
    let podNames: string[] = [];
    let fromApi = false;
    if (target && extra.endpointPods) {
      const ep = extra.endpointPods;
      podNames = [...ep.ready, ...ep.notReady];
      rd = { basis: "endpoints", ready: ep.ready.length, total: podNames.length, notReady: ep.notReady.map((pod) => ({ pod, since: null })).sort((a, b) => (a.pod < b.pod ? -1 : 1)) };
      fromApi = true;
    } else if (target) {
      podNames = [...readyOf.keys()].filter((k) => k.startsWith(`${target.namespace}/`)).map((k) => k.slice(target.namespace.length + 1))
        .filter((pod) => resolveWorkload(`${target.namespace}/${pod}`, owners)?.workload === target.service);
      rd = readiness("sameName", podNames.map((pod) => ({ pod, namespace: target.namespace })));
    }
    const checks: StackCheck[] = [];
    // Readiness from the Kubernetes API does not depend on the kube-state-metrics query
    const api = fromApi ? rd : undefined;
    const rc = api ? check("podsReady", api.total - api.ready, "count", (v) => (api.total === 0 ? "down" : v > 0 ? "degraded" : "ok"), []) : readyCheck(rd);
    if (rc) checks.push(rc);
    if (profiles !== null || lost("profilesSent")) checks.push(check("profilesSent", profiles, "bytesPerSecond", ok));
    if (dropped !== null || lost("profilesDropped")) checks.push(check("profilesDropped", dropped, "perSecond", bad));
    const state: StackState = rd ? rollup(checks.map((c) => c.state)) : dropped !== null && dropped > 0 ? "degraded" : "unknown";
    components.push({
      kind: "pyroscope", name: target?.service ?? "pyroscope", namespace: target?.namespace ?? null,
      pods: rd ? [...new Set(podNames)].sort().map((pod) => ({ pod, version: null })) : [], state, checks,
      ...(rd ? { readiness: rd } : {}), ...(target ? { target: target.display } : {}),
    });
  }

  // Scrape targets
  // `count(up == 0)` has no series when nothing is down — but only when the query answered
  const targets = raw.upTotal.map((r) => {
    const job = r.metric.job ?? "";
    return { job, total: Math.round(r.value), down: failed.has("upDown") ? null : Math.round(raw.upDown.find((d) => d.metric.job === job)?.value ?? 0) };
  }).sort((a, b) => (b.down ?? 0) - (a.down ?? 0) || (a.job < b.job ? -1 : 1));
  const downTargets = raw.upDownList.map((r) => ({ job: r.metric.job ?? "", namespace: r.metric.namespace ?? null, pod: r.metric.pod ?? null }))
    .sort((a, b) => (`${a.job}${a.namespace}${a.pod}` < `${b.job}${b.namespace}${b.pod}` ? -1 : 1)).slice(0, 50);

  // Collectors seen as scrape jobs (kube-state-metrics, node-exporter, Hubble, ama-metrics)
  const ksmAge = raw.ksmAge[0]?.value ?? null;
  for (const t of targets) {
    const kind = JOB_KIND.find(([re]) => re.test(t.job))?.[1];
    if (!kind) continue;
    const pods = raw.upPods.filter((r) => r.metric.job === t.job && r.metric.pod).map((r) => ({ pod: r.metric.pod!, version: null }));
    const checks: StackCheck[] = [check("targetsDown", t.down, "count", (v) => (v >= t.total && t.total > 0 ? "down" : v > 0 ? "degraded" : "ok"))];
    const rd = readiness("self", pods.map((p) => ({ pod: p.pod, namespace: nsOfPod.get(p.pod) ?? null })));
    const rc = readyCheck(rd);
    if (rc) checks.push(rc);
    if (kind === "kubeStateMetrics") checks.push(check("ksmAge", ksmAge, "seconds", (v) => (v > KSM_STALE_SECONDS ? "stale" : "ok")));
    if (kind === "hubble" && (raw.ciliumUnreachable?.length || lost("ciliumUnreachable"))) checks.push(check("ciliumUnreachable", raw.ciliumUnreachable?.[0]?.value ?? null, "count", bad));
    const ns = pods.map((p) => nsOfPod.get(p.pod)).find(Boolean) ?? null;
    components.push({ kind, name: t.job, namespace: ns, state: rollup(checks.map((c) => c.state)), pods, checks, ...(rd ? { readiness: rd } : {}) });
  }

  const order: StackComponentKind[] = ["alloy", "loki", "tempo", "pyroscope", "kubeStateMetrics", "nodeExporter", "hubble", "amaMetrics"];
  components.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.name < b.name ? -1 : 1));
  return { components, targets, downTargets };
}

const CHECK_QUERY: Record<StackCheckId, keyof ReturnType<typeof stackQueries>> = {
  remoteWriteFailed: "rwFailed", remoteWriteLag: "rwLag", remoteWritePending: "rwPending", componentsUnhealthy: "components",
  configLoad: "configLoad", logsSent: "logsSent", logsDropped: "logsDropped", spansAccepted: "spansAccepted",
  spansRefused: "spansRefused", spansExportFailed: "spansExportFailed", profilesSent: "profilesSent", lokiIngest: "lokiIngest",
  tempoSpans: "tempoSpans", tempoDiscarded: "tempoDiscarded", targetsDown: "upDown", ksmAge: "ksmAge", ciliumUnreachable: "ciliumUnreachable",
  podsReady: "podReady", profilesDropped: "profilesDropped",
};
/** Checks built on more than one query (default: CHECK_QUERY alone) */
const CHECK_DEPS: Partial<Record<StackCheckId, string[]>> = { remoteWriteFailed: ["rwTotal", "rwFailed"] };

/** When a not-Ready pod was last Ready (7 days, 1-minute steps): that minute's timestamp; no Ready minute → no series */
export function notReadySinceQuery(C: string, namespace: string, pod: string): string {
  const esc = (v: string) => v.replace(/[\\"]/g, (c) => `\\${c}`);
  return `max(max_over_time((timestamp(kube_pod_status_ready{${C}, namespace="${esc(namespace)}", pod="${esc(pod)}", condition="true"} == 1))[7d:1m]))`;
}

/** Grafana Explore for one query on one datasource (links only; https *.grafana.azure.com is enforced by the schema) */
export function grafanaExploreUrl(endpoint: string, datasourceUid: string, expr: string, range = "now-1h"): string {
  const panes = { aud: { datasource: datasourceUid, queries: [{ refId: "A", datasource: { uid: datasourceUid }, expr }], range: { from: range, to: "now" } } };
  return `${endpoint.replace(/\/+$/, "")}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

// ── Collection ──

type PromResponse = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }; error?: string };
const rowsOf = (resp: unknown): PromRow[] => {
  const r = resp as PromResponse;
  if (r?.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
  return (r?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) })).filter((x) => Number.isFinite(x.value));
};

/** Per query: every normal one answers in < 1 s (stg); a stuck one is cut here, well before the page's own limits */
export const STACK_QUERY_TIMEOUT_MS = 12_000;

const errText = (e: unknown) => (e instanceof Error ? `${e.name} ${e.message}` : String(e));
/** Pure: why a query did not answer — timeout (our abort / the workspace's 504), throttled (429), failed */
export function gapReason(e: unknown): StackQueryGap["reason"] {
  const m = errText(e);
  if (/AbortError|aborted|timed? ?out|Prometheus 504\b/i.test(m)) return "timeout";
  if (/Prometheus 429\b/.test(m)) return "throttled";
  return "failed";
}
/** Pure: worth one more try — timeouts, throttling, gateway / network errors; never 4xx answers (same answer again) */
export function isTransient(e: unknown): boolean {
  const m = errText(e);
  if (/Prometheus 4(?!29)\d\d\b/.test(m) || /Prometheus query failed/.test(m)) return false;
  return gapReason(e) !== "failed" || /Prometheus 5\d\d\b|fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(m);
}

/** Run queries (at most `limit` in flight); a query that fails twice is a gap with empty rows, the others stand */
async function runAll(fetcher: PrometheusFetcher, endpoint: string, queries: Record<string, string>, limit = 4): Promise<{ rows: Record<string, PromRow[]>; gaps: StackQueryGap[]; firstError: unknown }> {
  const names = Object.keys(queries);
  const rows: Record<string, PromRow[]> = {};
  const gaps: StackQueryGap[] = [];
  let firstError: unknown = null;
  let next = 0;
  const once = async (n: string) => rowsOf(await fetcher.query(endpoint, queries[n]!, undefined, { timeoutMs: STACK_QUERY_TIMEOUT_MS }));
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, async () => {
    while (next < names.length) {
      const n = names[next++]!;
      try {
        rows[n] = await once(n);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        try {
          if (!isTransient(e)) throw e;
          rows[n] = await once(n);
        } catch (e2) {
          if (e2 instanceof HttpError) throw e2;
          rows[n] = [];
          gaps.push({ query: n, reason: gapReason(e2) });
          firstError ??= e2;
        }
      }
    }
  }));
  gaps.sort((a, b) => (a.query < b.query ? -1 : 1));
  return { rows, gaps, firstError };
}

const cache = new CacheManager<ObservabilityStackResponse>(20, 60_000);
/** The last complete answer per user × cluster — shown (marked stale) when a whole refresh fails */
const lastGood = new CacheManager<ObservabilityStackResponse>(20, 15 * 60_000);
/** The cluster's scope in the workspace changes only when collectors are added / renamed */
const scopeCache = new CacheManager<NonNullable<ReturnType<typeof pickScope>>>(20, 10 * 60_000);
const inflight = new Map<string, Promise<ObservabilityStackResponse>>();
const PARTIAL_TTL_MS = 15_000;

/** Pure: what to answer after a refresh — a whole failure falls back to the last complete answer, marked stale */
export function withFallback(fresh: ObservabilityStackResponse, last: ObservabilityStackResponse | undefined): ObservabilityStackResponse {
  if (fresh.metricsState === "ok" || !last || (fresh.metricsState !== "failed" && fresh.metricsState !== "throttled")) return fresh;
  return { ...last, stale: { failedAt: fresh.generatedAt, state: fresh.metricsState, ...(fresh.message ? { message: fresh.message } : {}) } };
}

export async function getObservabilityStack(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ObservabilityStackResponse> {
  const key = `${cachePrefix(bearerToken)}:obs-stack:${clusterId.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId).then((r) => {
    if (r.metricsState !== "ok") return withFallback(r, lastGood.get(key));
    // A partial answer is retried soon; a complete one is also the fallback for a later failed refresh
    if (r.gaps?.length) cache.set(key, r, PARTIAL_TTL_MS);
    else { cache.set(key, r); lastGood.set(key, r); }
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** A Service's endpoints (Kubernetes API — the reader role's endpoints list); null when the cluster API is not reachable */
async function serviceEndpoints(env: Env, bearerToken: string | undefined, clusterId: string, namespace: string, service: string): Promise<EndpointPods | null> {
  try {
    const kc = await loadKubeConfig(env, bearerToken, clusterId);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const list = await withK8sRetry(() => core.listNamespacedEndpoints({ namespace, fieldSelector: `metadata.name=${service}`, limit: 1 }));
    const ep = list.items[0];
    if (!ep) return null;
    const names = (as?: k8s.V1EndpointAddress[]) => (as ?? []).map((a) => (a.targetRef?.kind === "Pod" ? a.targetRef.name ?? "" : "")).filter(Boolean);
    return {
      ready: [...new Set((ep.subsets ?? []).flatMap((x) => names(x.addresses)))],
      notReady: [...new Set((ep.subsets ?? []).flatMap((x) => names(x.notReadyAddresses)))],
    };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    return null;
  }
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ObservabilityStackResponse> {
  const grafanaCfg = clusterConnection(env, clusterId).connection.aks?.observability?.grafana;
  const base = {
    clusterId, generatedAt: new Date().toISOString(), windowMinutes: STACK_WINDOW_MINUTES, cluster: null as string | null,
    components: [], targets: [], downTargets: [],
    grafana: grafanaCfg ? { endpoint: grafanaCfg.endpoint.replace(/\/+$/, ""), datasources: grafanaCfg.datasources ?? {} } : null,
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    // Cluster only (no job): `up` spans every scrape job — job here is the target kind, not a duplicate collector
    const scopeKey = `${target.endpoint}|${clusterId.toLowerCase()}`;
    let scope = scopeCache.get(scopeKey) ?? null;
    if (!scope) {
      const ask = () => fetcher.query(target.endpoint, "group by (cluster) (up)", undefined, { timeoutMs: STACK_QUERY_TIMEOUT_MS });
      const rows = rowsOf(await ask().catch((e: unknown) => { if (isTransient(e)) return ask(); throw e; }));
      scope = pickScope(rows.map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
      if (scope && scope !== "ambiguous") scopeCache.set(scopeKey, scope);
    }
    if (scope === null) return { ...base, metricsState: "noHubbleMetrics" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    const C = scopeMatchers(scope, false);
    const queries = stackQueries(C);
    const run = await runAll(fetcher, target.endpoint, queries);
    // Nothing answered: that is the workspace failing, not a partial picture
    if (run.gaps.length === Object.keys(queries).length) throw run.firstError;
    const raw = run.rows as StackRaw;
    const failed = new Set(run.gaps.map((g) => g.query));
    const pyro = pyroscopeTarget(raw.profilesTarget ?? []);
    const endpointPods = pyro ? await serviceEndpoints(env, bearerToken, clusterId, pyro.namespace, pyro.service) : null;
    const agg = aggregateStack(raw, C, { endpointPods, failed });
    // Since when the not-Ready pods are not Ready — a few queries, only when some pod is not Ready
    const pending = agg.components.flatMap((c) => (c.readiness?.notReady ?? []).map((n) => ({ n, ns: c.namespace }))).filter((x) => x.ns).slice(0, 10);
    await Promise.all(pending.map(async ({ n, ns }) => {
      try {
        const last = rowsOf(await fetcher.query(target.endpoint, notReadySinceQuery(C, ns!, n.pod), undefined, { timeoutMs: STACK_QUERY_TIMEOUT_MS }))[0]?.value;
        n.since = last ? new Date((last + 60) * 1000).toISOString() : null;
      } catch { /* since stays unknown */ }
    }));
    return { ...base, cluster: scope.cluster, metricsState: "ok", ...agg, ...(run.gaps.length ? { gaps: run.gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
