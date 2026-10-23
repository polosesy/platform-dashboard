// The customer's own observability pipeline, read from metrics already in the cluster's Azure Monitor workspace
// (AKS 모니터링 › 관측 스택): Alloy collectors (remote write, components, config, Loki/OTLP/Pyroscope writers),
// Loki, Tempo, Pyroscope (seen through its sender), kube-state-metrics freshness, scrape targets (`up`).
//
// SRE rules: every value is a query result (the PromQL travels with it); no series = "unknown" / "notDetected",
// never 0; states are facts (failed > 0, lag, stale, down), not invented SLO thresholds. Windows are 10 minutes —
// at least 4 scrapes at 60 s (stg) and 30 s (prd). Nothing is read from Loki, Tempo, Pyroscope or Grafana:
// the connection's `aks.observability.grafana` only builds links into Grafana Explore.

import type { Env } from "../env.js";
import type { ObservabilityStackResponse, StackCheck, StackCheckId, StackComponent, StackComponentKind, StackState } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getPrometheusFetcherAuto, type PrometheusFetcher } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
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
export function aggregateStack(raw: StackRaw, C: string): Pick<ObservabilityStackResponse, "components" | "targets" | "downTargets"> {
  const q = stackQueries(C);
  const check = (id: StackCheckId, value: number | null, unit: StackCheck["unit"], state: (v: number) => StackState): StackCheck =>
    ({ id, value: value === null ? null : Math.round(value * 1000) / 1000, unit, state: value === null ? "unknown" : state(value), promql: q[CHECK_QUERY[id]] });
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
    const add = (c: StackCheck | null) => { if (c && (c.value !== null || g.kind === "alloy")) checks.push(c); };
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
        if (v !== null) checks.push(check(id, v, unit, st));
      }
    }
    if (g.kind === "loki") add(check("lokiIngest", sumOf(raw.lokiIngest, pods), "bytesPerSecond", ok));
    if (g.kind === "tempo") {
      add(check("tempoSpans", sumOf(raw.tempoSpans, pods), "perSecond", ok));
      add(check("tempoDiscarded", sumOf(raw.tempoDiscarded, pods), "perSecond", bad));
    }
    components.push({ kind: g.kind, name: g.name, namespace: g.namespace, state: rollup(checks.map((c) => c.state)), pods: g.pods.sort((a, b) => (a.pod < b.pod ? -1 : 1)), checks });
  }

  // Pyroscope exposes no build info here: seen only through what the Alloy collectors send it
  const profiles = raw.profilesSent.length ? raw.profilesSent.reduce((a, r) => a + r.value, 0) : null;
  if (profiles !== null) {
    components.push({ kind: "pyroscope", name: "pyroscope", namespace: null, pods: [],
      state: profiles > 0 ? "ok" : "unknown", checks: [check("profilesSent", profiles, "bytesPerSecond", ok)] });
  }

  // Scrape targets
  const targets = raw.upTotal.map((r) => {
    const job = r.metric.job ?? "";
    return { job, total: Math.round(r.value), down: Math.round(raw.upDown.find((d) => d.metric.job === job)?.value ?? 0) };
  }).sort((a, b) => b.down - a.down || (a.job < b.job ? -1 : 1));
  const downTargets = raw.upDownList.map((r) => ({ job: r.metric.job ?? "", namespace: r.metric.namespace ?? null, pod: r.metric.pod ?? null }))
    .sort((a, b) => (`${a.job}${a.namespace}${a.pod}` < `${b.job}${b.namespace}${b.pod}` ? -1 : 1)).slice(0, 50);

  // Collectors seen as scrape jobs (kube-state-metrics, node-exporter, Hubble, ama-metrics)
  const ksmAge = raw.ksmAge[0]?.value ?? null;
  for (const t of targets) {
    const kind = JOB_KIND.find(([re]) => re.test(t.job))?.[1];
    if (!kind) continue;
    const pods = raw.upPods.filter((r) => r.metric.job === t.job && r.metric.pod).map((r) => ({ pod: r.metric.pod!, version: null }));
    const checks: StackCheck[] = [check("targetsDown", t.down, "count", (v) => (v >= t.total && t.total > 0 ? "down" : v > 0 ? "degraded" : "ok"))];
    if (kind === "kubeStateMetrics") checks.push(check("ksmAge", ksmAge, "seconds", (v) => (v > KSM_STALE_SECONDS ? "stale" : "ok")));
    if (kind === "hubble" && raw.ciliumUnreachable?.length) checks.push(check("ciliumUnreachable", raw.ciliumUnreachable[0]!.value, "count", bad));
    const ns = pods.map((p) => nsOfPod.get(p.pod)).find(Boolean) ?? null;
    components.push({ kind, name: t.job, namespace: ns, state: rollup(checks.map((c) => c.state)), pods, checks });
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
};

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

async function runAll(fetcher: PrometheusFetcher, endpoint: string, queries: Record<string, string>, limit = 4): Promise<Record<string, PromRow[]>> {
  const names = Object.keys(queries);
  const out: Record<string, PromRow[]> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, async () => {
    while (next < names.length) {
      const n = names[next++]!;
      out[n] = rowsOf(await fetcher.query(endpoint, queries[n]!));
    }
  }));
  return out;
}

const cache = new CacheManager<ObservabilityStackResponse>(20, 60_000);
const inflight = new Map<string, Promise<ObservabilityStackResponse>>();

export async function getObservabilityStack(env: Env, bearerToken: string | undefined, clusterId: string): Promise<ObservabilityStackResponse> {
  const key = `${cachePrefix(bearerToken)}:obs-stack:${clusterId.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId).then((r) => { if (r.metricsState === "ok") cache.set(key, r); return r; }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
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
    const scope = pickScope(rowsOf(await fetcher.query(target.endpoint, "group by (cluster) (up)")).map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
    if (scope === null) return { ...base, metricsState: "noHubbleMetrics" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    const C = scopeMatchers(scope, false);
    const raw = (await runAll(fetcher, target.endpoint, stackQueries(C))) as StackRaw;
    return { ...base, cluster: scope.cluster, metricsState: "ok", ...aggregateStack(raw, C) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
