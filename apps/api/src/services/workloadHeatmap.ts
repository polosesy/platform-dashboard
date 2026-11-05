// Workload heatmap (AKS 모니터링 › 워크로드 › 히트맵) — the customer's Grafana "container map" as one map, from the
// cluster's Azure Monitor workspace. One tile per workload (every one — their Grafana stat panels dropped tiles),
// each signal coloured by the customer's own thresholds; the worst pod sets the value.
//
// Rules: queried per pod, grouped by workload in TypeScript with kube-state-metrics owners (workloadOwners.ts);
// `max by` where two collectors could double a series. Java/Spring signals (Micrometer jvm_*, hikaricp_*, http_*)
// are "notInstrumented" for workloads that do not expose them; a family absent from the workspace is "notMeasured";
// a pod without a memory limit / CPU request has no ratio — its usage is shown as bytes / cores with no colour
// ("noBaseline": AKS-managed cilium and acns-security-agent set none). A DaemonSet no node matches (Windows-only on a
// Linux cluster, retina-agent beside Cilium) and a Deployment scaled to 0 are "stopped" with the reason in `code`,
// and every other cell says "no pods" — not "not measured". Never 0 for "no series".
// A query that does not answer (timeout, throttling) is a gap: only the signals that need it say "queryFailed", the
// rest stand; the workload list itself (owners, replicas) failing fails the map. AKS-managed workloads (their own
// labels, from the Kubernetes list the VPA panel reads — best effort) keep their CPU / memory but leave the strip.

import type { Env } from "../env.js";
import type { HeatCell, HeatLevel, HeatMetric, HeatWorkload, StackQueryGap, WorkloadHeatmapResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { clusterConnection, getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { ownerIndex, resolveWorkload, type OwnerRow } from "./workloadOwners.js";
import { runAll as runIsolated } from "./observabilityStack.js";
import { aksManagedWorkloads } from "./workloadVpa.js";

export const HEAT_METRICS: HeatMetric[] = ["ready", "memory", "cpu", "cpuNow", "restarts", "oldGen", "jvmHeadroom", "http5xx", "logErrors", "poolUsage", "poolPending"];
/** Lenses: shown and coloured on their own view, not in the workload's level or the flag strip (cpuNow repeats CPU) */
export const LENS_METRICS: HeatMetric[] = ["cpuNow"];
/** The signals a workload's overall level and the red-flag strip are made of */
export const VERDICT_METRICS: HeatMetric[] = HEAT_METRICS.filter((m) => !LENS_METRICS.includes(m));
/** CPU 지금 = the customer's Grafana container map tile: 15-minute average, judged from 100m of use */
export const CPU_NOW_MINUTES = 15;

/** The customer's map thresholds (Grafana container map; JVM / alert standards) — warn at ≥ warn, danger at ≥ danger */
export const HEAT_THRESHOLDS: Record<HeatMetric, { warn: number; danger: number }> = {
  ready: { warn: 1, danger: 0 }, // special: ready/desired < 1 = warn, 0 = danger, 0/0 = stopped
  memory: { warn: 0.8, danger: 0.9 },
  // special: p95 / request ≥ 1.5 (and ≥ 100m) = warn only — danger is CPU pressure (CPU_PRESSURE), see cpuLevel
  cpu: { warn: 1.5, danger: 1.5 },
  // the Grafana container map's CPU tile: < 100% green · 100–150% yellow · ≥ 150% red (a lens — see LENS_METRICS)
  cpuNow: { warn: 1, danger: 1.5 },
  restarts: { warn: 1, danger: 5 },
  oldGen: { warn: 0.7, danger: 0.85 },
  // special (lower is worse): under the band max(100Mi, 10% of the limit) = warn, under −band (or < 0 while it is
  // happening) = danger — see jvmHeadroomLevel
  jvmHeadroom: { warn: 100 * 1024 * 1024, danger: 0 },
  http5xx: { warn: 0.005, danger: 0.01 },
  logErrors: { warn: 1, danger: 50 },
  poolUsage: { warn: 0.7, danger: 0.9 },
  poolPending: { warn: 1, danger: 1 },
};

/**
 * CPU without a limit is never throttled: running over the request borrows idle node CPU — harm shows only as time
 * spent waiting for a CPU (PSI) or, with a limit, CFS throttling. Over the request is a capacity-planning warn, and
 * only from 100m up (a 50m request at 80m is no load). Measured on a stg cluster 2026-11-05: PSI p95 ≤ 3.4% everywhere.
 */
export const CPU_PRESSURE = { floorCores: 0.1, psiWarn: 0.05, psiDanger: 0.1, throttleWarn: 0.1, throttleDanger: 0.25 };
/** A container's first 10 minutes (JIT warm-up, 5-minute rate catching up) do not count toward the window's p95 */
export const WARMUP_SECONDS = 600;
/** Fewer requests in the window than this: the 5xx share is shown, not judged (1 of 3 is not 33% errors) */
export const HTTP_MIN_REQUESTS = 20;
const Mi = 1024 * 1024;
/** Room native memory grows into under load (signal-service malloc arenas +73Mi in one burst, 2026-11-04) */
export const jvmBand = (limit: number) => Math.max(100 * Mi, 0.1 * limit);
/**
 * Native memory looks back a day whatever the window: glibc hands malloc arenas back, so "now" can sit below what the
 * pod already reached (stg 2026-11-05, three Spring apps: 322 → 394Mi, 365 → 430Mi, 92 → 125Mi)
 */
export const NATIVE_PEAK_MINUTES = 1440;
/** How long the Kubernetes workload list (AKS-managed labels) may hold the map up — after that it fills the cache */
export const MANAGED_WAIT_MS = 1500;
/** Signals AKS runs for us: shown, but nothing to change on our side → not in the flag strip */
const MANAGED_EXEMPT: HeatMetric[] = ["cpu", "cpuNow", "memory"];

/** The red-flag strip: which level counts (their strip: memory 90%+, any restart, pool 80%+ …) */
const FLAG_AT: Record<HeatMetric, HeatLevel[]> = {
  ready: ["danger"], memory: ["danger"], cpu: ["danger"], cpuNow: [], restarts: ["warn", "danger"], oldGen: ["danger"], jvmHeadroom: ["danger"],
  http5xx: ["danger"], logErrors: ["warn", "danger"], poolUsage: ["danger"], poolPending: ["danger"],
};

/** The workload list: without these there is no map (an error, not a map of gaps) */
export const CORE_QUERIES = ["active", "podOwners", "rsOwners", "deployReady", "deployDesired", "stsReady", "stsDesired", "dsReady", "dsDesired"];
/** The queries a signal cannot be judged without — one of them missing = queryFailed (the others only thin the panel) */
export const SIGNAL_NEEDS: Partial<Record<HeatMetric, string[]>> = {
  memory: ["memRatio", "memWs"], cpu: ["cpuUsage", "cpuP95", "cpuRequest", "cpuPsi"], cpuNow: ["cpuNow15", "cpuRequest"], restarts: ["restarts"], oldGen: ["oldGen"],
  jvmHeadroom: ["jvmHeapMax", "podMemLimit", "jvmHeapCommitted", "jvmNonheapCommitted", "memRss"],
  http5xx: ["http5xx", "httpAll"], logErrors: ["logErrors"], poolUsage: ["poolUsage"], poolPending: ["poolPending"],
};
/** The query whose rows say which workloads have a Java/Spring signal at all */
const PRESENCE: Partial<Record<HeatMetric, string>> = { oldGen: "oldGen", jvmHeadroom: "jvmHeapMax", http5xx: "httpAll", poolUsage: "poolUsage", poolPending: "poolPending" };

/** Families whose absence makes a metric "notMeasured" for everyone (cAdvisor/KSM ones are always expected) */
const FAMILY: Partial<Record<HeatMetric, string>> = {
  oldGen: "jvm_memory_usage_after_gc", jvmHeadroom: "jvm_memory_max_bytes", http5xx: "http_server_requests_seconds_count",
  poolUsage: "hikaricp_connections_active", poolPending: "hikaricp_connections_pending",
};

export type LogErrorsConfig = { metric: string; podLabel: string };

/** Subquery step: 1 minute up to an hour (5 – 60 points), 5 minutes (the rate's own width) beyond (36 – 288) */
export const cpuStep = (windowMinutes: number) => (windowMinutes <= 60 ? "1m" : "5m");

export function heatmapQueries(C: string, windowMinutes: number, logErrors?: LogErrorsConfig): Record<string, string> {
  const w = `[${windowMinutes}m]`;
  const sel = (m: string, extra = "") => `${m}{${[C, extra].filter(Boolean).join(",")}}`;
  const ctr = 'container!="",container!="POD"';
  // Containers started less than WARMUP_SECONDS before each step drop out of that step (a restarted container too)
  const warm = `unless on (namespace, pod, container) (time() - max by (namespace, pod, container) (${sel("kube_pod_container_state_started")}) < ${WARMUP_SECONDS})`;
  const sub = `[${windowMinutes}m:${cpuStep(windowMinutes)}]`;
  const cpu5m = `sum by (namespace, pod) (rate(${sel("container_cpu_usage_seconds_total", ctr)}[5m]) ${warm})`;
  const psi5m = `max by (namespace, pod) (rate(${sel("container_pressure_cpu_waiting_seconds_total", ctr)}[5m]) ${warm})`;
  const oomReason = sel("kube_pod_container_status_last_terminated_reason", 'reason="OOMKilled"');
  const oomAt = sel("kube_pod_container_status_last_terminated_timestamp");
  const q: Record<string, string> = {
    // One count per family: `a or b` drops b's series whose labels equal a's (vector matching ignores the name)
    ...Object.fromEntries(Object.values(FAMILY).map((m) => [`family:${m}`, `count(${sel(m)})`])),
    active: `max by (namespace, pod) (${sel("kube_pod_status_phase", 'phase=~"Running|Pending"')}) > 0`,
    podOwners: `group by (namespace, pod, owner_kind, owner_name) (${sel("kube_pod_owner")})`,
    rsOwners: `group by (namespace, replicaset, owner_kind, owner_name) (${sel("kube_replicaset_owner")})`,
    memWs: `max by (namespace, pod, container) (${sel("container_memory_working_set_bytes", 'container!="",container!="POD"')})`,
    memRatio: `max by (namespace, pod, container) (${sel("container_memory_working_set_bytes", 'container!="",container!="POD"')}) / on (namespace, pod, container) (max by (namespace, pod, container) (${sel("kube_pod_container_resource_limits", 'resource="memory"')}) > 0)`,
    memRss: `max by (namespace, pod) (${sel("container_memory_rss", ctr)})`,
    // The window's highest working set per container (shown beside the level, which stays on now)
    memPeak: `max by (namespace, pod, container) (max_over_time(${sel("container_memory_working_set_bytes", ctr)}${w}))`,
    // CPU over the window: the 5-minute rate's p95 / max across it and the plain average; the ratio is taken in
    // TypeScript (one heavy subquery, not two). cpuUsage = the last 5 minutes, warm-up included
    cpuUsage: `sum by (namespace, pod) (rate(${sel("container_cpu_usage_seconds_total", ctr)}[5m]))`,
    cpuP95: `quantile_over_time(0.95, (${cpu5m})${sub})`,
    cpuMax: `max_over_time((${cpu5m})${sub})`,
    cpuAvg: `sum by (namespace, pod) (rate(${sel("container_cpu_usage_seconds_total", ctr)}${w}))`,
    cpuRequest: `sum by (namespace, pod) (max by (namespace, pod, container) (${sel("kube_pod_container_resource_requests", 'resource="cpu"')})) > 0`,
    // CPU 지금: the last 15 minutes' average (the Grafana container map tile), and the window's steps where the 5-minute
    // rate stayed over the request (× the step = minutes) — warm-up included: this is what the pod used
    cpuNow15: `sum by (namespace, pod) (rate(${sel("container_cpu_usage_seconds_total", ctr)}[${CPU_NOW_MINUTES}m]))`,
    cpuOverSteps: `count_over_time((sum by (namespace, pod) (rate(${sel("container_cpu_usage_seconds_total", ctr)}[5m])) > on (namespace, pod) (sum by (namespace, pod) (max by (namespace, pod, container) (${sel("kube_pod_container_resource_requests", 'resource="cpu"')})) > 0))${sub})`,
    cpuPsi: `quantile_over_time(0.95, (${psi5m})${sub})`,
    // CFS series exist only for containers with a CPU limit
    cpuThrottle: `sum by (namespace, pod) (rate(${sel("container_cpu_cfs_throttled_periods_total", ctr)}${w})) / on (namespace, pod) (sum by (namespace, pod) (rate(${sel("container_cpu_cfs_periods_total", ctr)}${w})) > 0)`,
    restarts: `sum by (namespace, pod) (max by (namespace, pod, container) (changes(${sel("kube_pod_container_status_restarts_total")}${w})))`,
    notReady: `max by (namespace, pod) (${sel("kube_pod_status_ready", 'condition="false"')})`,
    // OOMKilled inside the window (the reason stays until the next termination — days); a KSM without the
    // timestamp keeps the old meaning
    oom: `max by (namespace, pod) ((${oomReason} and on (namespace, pod, container) (${oomAt} > time() - ${windowMinutes * 60})) or (${oomReason} unless on (namespace, pod, container) ${oomAt}))`,
    deployReady: `max by (namespace, deployment) (${sel("kube_deployment_status_replicas_ready")})`,
    deployDesired: `max by (namespace, deployment) (${sel("kube_deployment_spec_replicas")})`,
    stsReady: `max by (namespace, statefulset) (${sel("kube_statefulset_status_replicas_ready")})`,
    stsDesired: `max by (namespace, statefulset) (${sel("kube_statefulset_replicas")})`,
    dsReady: `max by (namespace, daemonset) (${sel("kube_daemonset_status_number_ready")})`,
    dsDesired: `max by (namespace, daemonset) (${sel("kube_daemonset_status_desired_number_scheduled")})`,
    oldGen: `max by (namespace, pod) (${sel("jvm_memory_usage_after_gc")})`,
    // JVM headroom: heap max = the pools with a defined maximum (G1 eden/survivor report -1), the pod's largest
    // container memory limit (JVM pods measured had one container with a limit), non-heap = metaspace + code cache …,
    // direct = NIO buffers (mapped ones are file pages); `max by … id` where two collectors could double a pool
    jvmHeapMax: `sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_memory_max_bytes", 'area="heap"')}) > 0)`,
    // Serial / Parallel keep two survivor spaces but the pool reports one (-Xmx = eden + 2 × survivor + old): count it
    // again. G1's survivor is region-based, reports max -1 and committed as a whole — the regex (anchored) leaves it out
    jvmSurvivorMax: `max by (namespace, pod) (${sel("jvm_memory_max_bytes", 'area="heap",id=~"(?i)(ps )?survivor space"')}) > 0`,
    jvmSurvivorCommitted: `max by (namespace, pod) (${sel("jvm_memory_committed_bytes", 'area="heap",id=~"(?i)(ps )?survivor space"')})`,
    jvmNonheap: `sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_memory_used_bytes", 'area="nonheap"')}))`,
    jvmHeapCommitted: `sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_memory_committed_bytes", 'area="heap"')}))`,
    jvmNonheapCommitted: `sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_memory_committed_bytes", 'area="nonheap"')}))`,
    jvmDirect: `sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_buffer_memory_used_bytes", 'id="direct"')}))`,
    // Native over the last day = RSS − (heap + non-heap committed + direct) at each 5-minute step, highest; pool ids
    // differ between the two families, so `or` is a plain union here. JVM pods only (the right side exists only there)
    jvmNativePeak: `max_over_time((clamp_min(max by (namespace, pod) (${sel("container_memory_rss", ctr)}) - on (namespace, pod) (sum by (namespace, pod) (max by (namespace, pod, id) (${sel("jvm_memory_committed_bytes", 'area=~"heap|nonheap"')}) or max by (namespace, pod, id) (${sel("jvm_buffer_memory_used_bytes", 'id="direct"')}))), 0))[${NATIVE_PEAK_MINUTES}m:5m])`,
    podAge: `time() - max by (namespace, pod) (${sel("kube_pod_start_time")})`,
    podMemLimit: `max by (namespace, pod) (${sel("kube_pod_container_resource_limits", 'resource="memory"')})`,
    // Requests over the window (not a 5-minute rate: the window chosen applies, and the count sets the minimum)
    http5xx: `sum by (namespace, pod) (increase(${sel("http_server_requests_seconds_count", 'status=~"5..",uri!~"/actuator.*"')}${w}))`,
    httpAll: `sum by (namespace, pod) (increase(${sel("http_server_requests_seconds_count", 'uri!~"/actuator.*"')}${w}))`,
    poolUsage: `max by (namespace, pod, pool) (${sel("hikaricp_connections_active")}) / on (namespace, pod, pool) (max by (namespace, pod, pool) (${sel("hikaricp_connections_max")}) > 0)`,
    poolPending: `max by (namespace, pod, pool) (${sel("hikaricp_connections_pending")})`,
  };
  if (logErrors) {
    // Per series: the rise over the window, counting a series that started inside it in full (their "v3" form —
    // increase() under-counts series replaced when a pod restarts); then by the app pod the counter names
    const m = sel(logErrors.metric);
    q.logErrors = `sum by (namespace, ${logErrors.podLabel}) (clamp_min(max_over_time(${m}${w}) - (${m} offset ${windowMinutes}m or 0 * max_over_time(${m}${w})), 0))`;
  }
  return q;
}

/**
 * JVM headroom (lower is worse) against the band: short by more than the band = danger (configDeficit — a full heap
 * crosses the limit whatever the estimate's error) · short at all while memory ≥ 80%, Old Gen ≥ 70% or an OOM in the
 * window = danger (imminent) · under the band = warn (marginal) — native memory grows into it under load
 */
export function jvmHeadroomLevel(headroom: number, band: number, imminent: boolean): { level: HeatLevel; code?: HeatCell["code"] } {
  if (headroom < -band) return { level: "danger", code: "configDeficit" };
  if (headroom < 0 && imminent) return { level: "danger", code: "imminent" };
  if (headroom < band) return { level: "warn", code: "marginal" };
  return { level: "ok" };
}

export type CpuFacts = NonNullable<HeatCell["cpu"]>;

/**
 * CPU: danger = pressure only (PSI p95 ≥ 10% or throttled ≥ 25% — whatever the ratio, starving under the request is
 * worse) · warn = p95 ≥ 1.5 × request at ≥ 100m, or PSI 5–10%, or throttled 10–25% · over the request under 100m =
 * belowFloor (ok) · no p95 (only warming-up containers in the window) = warmingUp · no request = noBaseline unless
 * there is pressure
 */
export function cpuLevel(f: CpuFacts): { level: HeatLevel; value: number | null; code?: HeatCell["code"] } {
  const P = CPU_PRESSURE;
  const pressure: HeatLevel = (f.psi ?? 0) >= P.psiDanger || (f.throttle ?? 0) >= P.throttleDanger ? "danger"
    : (f.psi ?? 0) >= P.psiWarn || (f.throttle ?? 0) >= P.throttleWarn ? "warn" : "ok";
  if (f.p95 === null) return { level: pressure === "ok" ? "noBaseline" : pressure, value: null, code: "warmingUp" };
  if (f.request === null) return pressure === "ok" ? { level: "noBaseline", value: null, code: "noRequest" } : { level: pressure, value: null };
  const ratio = f.p95 / f.request;
  if (pressure === "danger") return { level: "danger", value: ratio };
  if (ratio >= HEAT_THRESHOLDS.cpu.warn) return f.p95 >= P.floorCores ? { level: "warn", value: ratio } : { level: pressure, value: ratio, code: "belowFloor" };
  return { level: pressure, value: ratio };
}

export function levelOf(metric: HeatMetric, value: number): HeatLevel {
  const t = HEAT_THRESHOLDS[metric];
  return value >= t.danger ? "danger" : value >= t.warn ? "warn" : "ok";
}

const RANK: Record<HeatLevel, number> = { danger: 4, warn: 3, ok: 2, noBaseline: 1, stopped: 1, noTraffic: 0, notInstrumented: 0, notMeasured: 0 };

export type HeatRaw = Record<string, PromRow[]>;

/** Pure: per-pod rows → one tile per workload with every signal, worst pod first */
export function aggregateHeatmap(raw: HeatRaw, opts: { logErrors?: LogErrorsConfig; managed?: Set<string> | null; failed?: Set<string>; windowMinutes?: number } = {}):
  Pick<WorkloadHeatmapResponse, "workloads" | "flags" | "missing"> {
  const families = new Set(Object.keys(raw).filter((k) => k.startsWith("family:") && (raw[k]?.length ?? 0) > 0).map((k) => k.slice(7)));
  // Completed / failed pods (Jobs, `az aks command invoke` runs) are not part of a workload's readiness
  const active = raw.active ? new Set(raw.active.map((r) => `${r.metric.namespace}/${r.metric.pod}`)) : null;
  const isActive = (ns?: string, pod?: string) => !active || active.has(`${ns}/${pod}`);
  const owners = ownerIndex(
    (raw.podOwners ?? []).map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.pod ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
    (raw.rsOwners ?? []).map((r) => ({ namespace: r.metric.namespace ?? "", name: r.metric.replicaset ?? "", ownerKind: r.metric.owner_kind ?? "", ownerName: r.metric.owner_name ?? "" }) as OwnerRow),
  );
  type Acc = HeatWorkload & { podMap: Map<string, HeatWorkload["pods"][number]> };
  const map = new Map<string, Acc>();
  const blankCells = (): Record<HeatMetric, HeatCell> =>
    Object.fromEntries(HEAT_METRICS.map((m) => [m, { value: null, level: "notMeasured" as HeatLevel }])) as Record<HeatMetric, HeatCell>;
  const ensure = (namespace: string, workload: string, kind: string | null, basis: "owner" | "pattern"): Acc => {
    const key = `${namespace}/${workload}`;
    let w = map.get(key);
    if (!w) {
      w = { namespace, workload, kind, basis, replicas: { ready: null, desired: null }, worst: "notMeasured", cells: blankCells(), pods: [], podMap: new Map() };
      map.set(key, w);
    } else if (w.basis === "pattern" && basis === "owner") Object.assign(w, { kind, basis });
    return w;
  };
  // A pod that is no longer running (Succeeded / Failed, or replaced inside the window) still has series in the
  // window's queries: it may add to its workload's counters (log ERRORs) but never makes a tile or a pod row —
  // `az aks command invoke` runs were showing up as "? 미측정" workloads
  const podOf = (namespace: string | undefined, pod: string | undefined) => {
    if (!namespace || !pod) return null;
    const ref = resolveWorkload(`${namespace}/${pod}`, owners);
    if (!ref) return null;
    if (!isActive(namespace, pod)) {
      const w = map.get(`${ref.namespace}/${ref.workload}`);
      return w ? { w, p: { pod, ready: null, restarts: null, memory: null, cpu: null, oom: false, memBytes: null, cpuCores: null } } : null;
    }
    const w = ensure(ref.namespace, ref.workload, ref.kind, ref.basis);
    let p = w.podMap.get(pod);
    if (!p) { p = { pod, ready: null, restarts: null, memory: null, cpu: null, oom: false, memBytes: null, cpuCores: null }; w.podMap.set(pod, p); }
    return { w, p };
  };

  // Replicas — the workload list includes ones with no pods (0/0 = stopped, 0/N = down)
  const replicas = (readyRows: PromRow[] = [], desiredRows: PromRow[] = [], label: string, kind: string) => {
    for (const d of desiredRows) {
      const ns = d.metric.namespace ?? "";
      const name = d.metric[label] ?? "";
      if (!ns || !name) continue;
      const w = ensure(ns, name, kind, "owner");
      w.kind = kind;
      w.replicas = { ready: Math.round(readyRows.find((r) => r.metric.namespace === ns && r.metric[label] === name)?.value ?? 0), desired: Math.round(d.value) };
    }
  };
  replicas(raw.deployReady, raw.deployDesired, "deployment", "Deployment");
  replicas(raw.stsReady, raw.stsDesired, "statefulset", "StatefulSet");
  replicas(raw.dsReady, raw.dsDesired, "daemonset", "DaemonSet");
  for (const r of raw.podOwners ?? []) if (isActive(r.metric.namespace, r.metric.pod)) podOf(r.metric.namespace, r.metric.pod);

  // Per-pod facts
  for (const r of raw.notReady ?? []) {
    if (!isActive(r.metric.namespace, r.metric.pod)) continue;
    const x = podOf(r.metric.namespace, r.metric.pod);
    if (x) x.p.ready = r.value < 1;
  }
  for (const r of raw.oom ?? []) { const x = podOf(r.metric.namespace, r.metric.pod); if (x && r.value >= 1) x.p.oom = true; }
  for (const r of raw.restarts ?? []) { const x = podOf(r.metric.namespace, r.metric.pod); if (x) x.p.restarts = Math.round(r.value); }
  const memByPod = new Map<string, number>();
  for (const r of raw.memRatio ?? []) {
    const k = `${r.metric.namespace}/${r.metric.pod}`;
    memByPod.set(k, Math.max(memByPod.get(k) ?? 0, r.value));
  }
  // Working set per pod = the sum of its containers (shown as bytes when there is no limit to divide by)
  const memBytes = new Map<string, number>();
  for (const r of raw.memWs ?? []) {
    const k = `${r.metric.namespace}/${r.metric.pod}`;
    memBytes.set(k, (memBytes.get(k) ?? 0) + r.value);
  }
  // The window's peak: the pod's highest container ratio (or bytes without a limit)
  const limitByCtr = new Map((raw.memRatio ?? []).map((r) => [`${r.metric.namespace}/${r.metric.pod}/${r.metric.container}`, r.value]));
  const wsByCtr = new Map((raw.memWs ?? []).map((r) => [`${r.metric.namespace}/${r.metric.pod}/${r.metric.container}`, r.value]));
  const peakByPod = new Map<string, { ratio: number | null; bytes: number }>();
  for (const r of raw.memPeak ?? []) {
    const k = `${r.metric.namespace}/${r.metric.pod}`, c = `${k}/${r.metric.container}`;
    // the container's limit = its working set now / its ratio now; without a limit the peak is bytes only
    const ratioNow = limitByCtr.get(c), wsNow = wsByCtr.get(c);
    const ratio = ratioNow && wsNow ? r.value / (wsNow / ratioNow) : null;
    const cur = peakByPod.get(k);
    if (!cur || (ratio ?? -1) > (cur.ratio ?? -1) || (ratio === null && cur.ratio === null && r.value > cur.bytes)) peakByPod.set(k, { ratio, bytes: r.value });
  }
  for (const k of new Set([...memBytes.keys(), ...memByPod.keys()])) {
    const [ns, pod] = k.split("/");
    const x = podOf(ns, pod);
    if (x) { x.p.memory = memByPod.get(k) ?? null; x.p.memBytes = memBytes.get(k) ?? null; }
  }
  // CPU per pod over the window — the verdict (cpuLevel) reads all of it; the pod row shows p95 / request
  const byPod = (rows: PromRow[] | undefined) => new Map((rows ?? []).map((r) => [`${r.metric.namespace}/${r.metric.pod}`, r.value]));
  const cpuSeries = { now: byPod(raw.cpuUsage), p95: byPod(raw.cpuP95), avg: byPod(raw.cpuAvg), max: byPod(raw.cpuMax),
    request: byPod(raw.cpuRequest), psi: byPod(raw.cpuPsi), throttle: byPod(raw.cpuThrottle) };
  const now15ByPod = byPod(raw.cpuNow15);
  // The over-request steps came in the window's subquery step (1 min up to an hour, else 5) — minutes = steps × step
  const stepMin = opts.windowMinutes !== undefined && opts.windowMinutes > 60 ? 5 : 1;
  const overByPod = byPod(raw.cpuOverSteps);
  const cpuByPod = new Map<string, CpuFacts>();
  for (const k of new Set([...cpuSeries.now.keys(), ...cpuSeries.p95.keys()])) {
    const [ns, pod] = k.split("/");
    const x = podOf(ns, pod);
    if (!x) continue;
    const f = Object.fromEntries(Object.entries(cpuSeries).map(([n, m]) => [n, m.get(k) ?? null])) as CpuFacts;
    cpuByPod.set(k, f);
    x.p.cpu = f.p95 !== null && f.request ? f.p95 / f.request : null;
    x.p.cpuCores = f.p95 ?? f.now;
  }
  for (const [k, avg15] of now15ByPod) {
    const [ns, pod] = k.split("/");
    const x = podOf(ns, pod);
    if (!x) continue;
    const request = cpuSeries.request.get(k) ?? null;
    x.p.cpuNow = request ? avg15 / request : null;
  }

  // Per-pod signals that only some workloads expose (worst pod / worst pool)
  const worstBy = (rows: PromRow[] | undefined, set: (w: Acc, v: number, pod: string, pool?: string) => void) => {
    for (const r of rows ?? []) {
      const x = podOf(r.metric.namespace, r.metric.pod);
      if (x) set(x.w, r.value, r.metric.pod!, r.metric.pool);
    }
  };
  const raise = (metric: HeatMetric) => (w: Acc, v: number, pod: string, pool?: string) => {
    const c = w.cells[metric];
    if (c.value === null || v > c.value) w.cells[metric] = { value: v, level: levelOf(metric, v), worstPod: pod, ...(pool ? { pool } : {}) };
  };
  worstBy(raw.oldGen, raise("oldGen"));
  worstBy(raw.poolUsage, raise("poolUsage"));
  worstBy(raw.poolPending, raise("poolPending"));

  // JVM headroom per running pod: what is left of the container memory limit when the heap grows to its max beside
  // the memory outside it — non-heap committed (metaspace, code cache), direct buffers and native memory (RSS minus
  // what the JVM accounts for: thread stacks, malloc arenas, JIT, GC tables). SerialGC / ParallelGC keep a heap they
  // grew, so the max is where a busy pod ends up. The workload shows its worst pod; no limit = nothing to judge
  const limitByPod = byPod(raw.podMemLimit);
  const jvmSeries = { nonheapUsed: byPod(raw.jvmNonheap), heapCommitted: byPod(raw.jvmHeapCommitted), nonheapCommitted: byPod(raw.jvmNonheapCommitted),
    direct: byPod(raw.jvmDirect), rss: byPod(raw.memRss) };
  const nativePeakByPod = byPod(raw.jvmNativePeak);
  const survivorMaxByPod = byPod(raw.jvmSurvivorMax);
  const survivorCommittedByPod = byPod(raw.jvmSurvivorCommitted);
  const ageByPod = byPod(raw.podAge);
  const oldGenByPod = byPod(raw.oldGen);
  // RSS missing (a collector without it): the largest container's working set (file pages make it a little high)
  const wsMax = new Map<string, number>();
  for (const r of raw.memWs ?? []) { const k = `${r.metric.namespace}/${r.metric.pod}`; wsMax.set(k, Math.max(wsMax.get(k) ?? 0, r.value)); }
  for (const r of raw.jvmHeapMax ?? []) {
    if (!isActive(r.metric.namespace, r.metric.pod)) continue;
    const x = podOf(r.metric.namespace, r.metric.pod);
    if (!x) continue;
    const key = `${r.metric.namespace}/${r.metric.pod}`;
    const limit = limitByPod.get(key);
    const cell = x.w.cells.jvmHeadroom;
    if (limit === undefined || limit <= 0) {
      if (cell.value === null) x.w.cells.jvmHeadroom = { value: null, level: "noBaseline", code: "noLimit", worstPod: r.metric.pod! };
      continue;
    }
    const get = (n: keyof typeof jvmSeries) => jvmSeries[n].get(key) ?? null;
    // The second survivor space (Serial / Parallel) — in -Xmx and, once touched, in RSS; 0 for G1
    const survivorCommitted = survivorCommittedByPod.get(key) ?? 0;
    const heapMax = r.value + (survivorMaxByPod.get(key) ?? 0);
    const [nonheapUsed, nonheapCommitted, direct] = [get("nonheapUsed"), get("nonheapCommitted"), get("direct")];
    const heapCommitted = get("heapCommitted") === null ? null : get("heapCommitted")! + survivorCommitted;
    const rss = get("rss") ?? wsMax.get(key) ?? null;
    const outside = (nonheapCommitted ?? nonheapUsed ?? 0) + (direct ?? 0);
    const native = rss !== null && heapCommitted !== null ? Math.max(0, rss - heapCommitted - outside) : null;
    const peak = nativePeakByPod.get(key);
    const nativePeak = peak === undefined ? null : Math.max(0, peak - survivorCommitted);
    const age = ageByPod.get(key);
    const observedHours = age === undefined ? null : Math.min(NATIVE_PEAK_MINUTES / 60, Math.max(0, age / 3600));
    const headroom = limit - (heapMax + outside + Math.max(native ?? 0, nativePeak ?? 0));
    const band = jvmBand(limit);
    const imminent = (memByPod.get(key) ?? 0) >= HEAT_THRESHOLDS.memory.warn || (oldGenByPod.get(key) ?? 0) >= HEAT_THRESHOLDS.oldGen.warn || x.p.oom;
    const { level, code } = jvmHeadroomLevel(headroom, band, imminent);
    const partial = [get("heapCommitted"), nonheapCommitted, direct, get("rss")].some((v) => v === null);
    if (cell.value === null || RANK[level] > RANK[cell.level] || (RANK[level] === RANK[cell.level] && headroom < cell.value)) {
      x.w.cells.jvmHeadroom = { value: headroom, level, ...(code ? { code } : {}), worstPod: r.metric.pod!,
        jvm: { limit, heapMax, nonheapUsed, heapCommitted, nonheapCommitted, direct, rss, native, nativePeak, observedHours, band, ...(partial ? { partial } : {}) } };
    }
  }

  // 5xx share per workload over the window (all its pods' traffic, not the worst pod); under HTTP_MIN_REQUESTS the
  // share is shown without a verdict
  const http = new Map<Acc, { err: number; all: number; worstPod?: string; worst: number }>();
  for (const r of raw.httpAll ?? []) {
    const x = podOf(r.metric.namespace, r.metric.pod);
    if (!x) continue;
    const h = http.get(x.w) ?? { err: 0, all: 0, worst: -1 };
    h.all += r.value;
    const err = (raw.http5xx ?? []).find((e) => e.metric.namespace === r.metric.namespace && e.metric.pod === r.metric.pod)?.value ?? 0;
    h.err += err;
    if (err > h.worst) { h.worst = err; h.worstPod = r.metric.pod; }
    http.set(x.w, h);
  }
  for (const [w, h] of http) {
    const requests = Math.round(h.all);
    const worst = h.err > 0 && h.worstPod ? { worstPod: h.worstPod } : {};
    w.cells.http5xx = h.all <= 0 ? { value: null, level: "noTraffic" }
      : h.all < HTTP_MIN_REQUESTS ? { value: h.err / h.all, level: "noTraffic", code: "lowTraffic", requests, ...worst }
      : { value: h.err / h.all, level: levelOf("http5xx", h.err / h.all), requests, ...worst };
  }

  // Log ERROR events per workload (the Alloy counter names the app pod in its own label)
  if (opts.logErrors) {
    const label = opts.logErrors.podLabel;
    const per = new Map<Acc, { n: number; worstPod?: string; worst: number }>();
    for (const r of raw.logErrors ?? []) {
      const x = podOf(r.metric.namespace, r.metric[label]);
      if (!x) continue;
      const e = per.get(x.w) ?? { n: 0, worst: -1 };
      e.n += r.value;
      if (r.value > e.worst) { e.worst = r.value; e.worstPod = r.metric[label]; }
      per.set(x.w, e);
    }
    for (const w of map.values()) {
      const e = per.get(w);
      const n = Math.round(e?.n ?? 0);
      w.cells.logErrors = { value: n, level: n > 0 ? levelOf("logErrors", n) : "ok", ...(n > 0 && e?.worstPod ? { worstPod: e.worstPod } : {}) };
    }
  }

  const workloads: HeatWorkload[] = [];
  for (const w of map.values()) {
    const pods = [...w.podMap.values()];
    // Ready
    if (w.replicas.desired !== null) {
      const { ready, desired } = w.replicas;
      w.cells.ready = desired === 0 ? { value: null, level: "stopped" }
        : { value: (ready ?? 0) / desired, level: (ready ?? 0) >= desired ? "ok" : (ready ?? 0) === 0 ? "danger" : "warn" };
    } else if (pods.some((p) => p.ready !== null)) {
      const notReady = pods.filter((p) => p.ready === false).length;
      w.replicas = { ready: pods.length - notReady, desired: pods.length };
      w.cells.ready = { value: (pods.length - notReady) / Math.max(1, pods.length), level: notReady === 0 ? "ok" : notReady === pods.length ? "danger" : "warn" };
    }
    // Memory / CPU: worst pod; a pod measured without a limit / request has no ratio — its usage, uncoloured
    const worstPod = (pick: (p: HeatWorkload["pods"][number]) => number | null | undefined) =>
      pods.filter((p) => pick(p) != null).sort((a, b) => pick(b)! - pick(a)!)[0];
    const oom = pods.some((p) => p.oom) ? { oom: true } : {};
    const m = worstPod((p) => p.memory);
    const mAbs = worstPod((p) => p.memBytes);
    const peakOf = (pod: string) => { const v = peakByPod.get(`${w.namespace}/${pod}`); return v ? { peak: v } : {}; };
    w.cells.memory = m ? { value: m.memory, level: levelOf("memory", m.memory!), worstPod: m.pod, ...(m.memBytes != null ? { abs: m.memBytes } : {}), ...oom, ...peakOf(m.pod) }
      : mAbs ? { value: null, level: "noBaseline", code: "noLimit", worstPod: mAbs.pod, abs: mAbs.memBytes!, ...oom, ...peakOf(mAbs.pod) }
      : w.cells.memory;
    // CPU: the pod with the worst verdict, then the highest p95 ratio (or p95 cores when there is no request)
    let cpuWorst: { cell: HeatCell; rank: number; key: number } | null = null;
    for (const p of pods) {
      const f = cpuByPod.get(`${w.namespace}/${p.pod}`);
      if (!f) continue;
      const v = cpuLevel(f);
      const abs = f.p95 ?? f.now;
      const cell: HeatCell = { value: v.value, level: v.level, ...(v.code ? { code: v.code } : {}), worstPod: p.pod, ...(abs !== null ? { abs } : {}), cpu: f };
      const rank = RANK[v.level];
      const key = v.value ?? abs ?? 0;
      if (!cpuWorst || rank > cpuWorst.rank || (rank === cpuWorst.rank && key > cpuWorst.key)) cpuWorst = { cell, rank, key };
    }
    if (cpuWorst) w.cells.cpu = cpuWorst.cell;
    // CPU 지금 (lens): the highest 15-minute average / request; over the request under 100m of use = shown uncoloured
    // (belowFloor — a 50m request at 0.1 core reads 200%, no load), under the request = OK whatever the cores (an idle
    // service is green, not grey); no request = cores only
    let nowWorst: { cell: HeatCell; rank: number; key: number } | null = null;
    for (const p of pods) {
      const k = `${w.namespace}/${p.pod}`;
      const avg15 = now15ByPod.get(k);
      if (avg15 === undefined) continue;
      const request = cpuSeries.request.get(k) ?? null;
      const over = overByPod.get(k);
      const facts = { avg15, now5: cpuSeries.now.get(k) ?? null, request, overMinutes: over === undefined ? (raw.cpuOverSteps ? 0 : null) : over * stepMin, windowMinutes: opts.windowMinutes ?? 0 };
      const ratio = request ? avg15 / request : null;
      const cell: HeatCell = ratio === null ? { value: null, level: "noBaseline", code: "noRequest", worstPod: p.pod, abs: avg15, cpuNow: facts }
        : ratio >= HEAT_THRESHOLDS.cpuNow.warn && avg15 < CPU_PRESSURE.floorCores ? { value: ratio, level: "noBaseline", code: "belowFloor", worstPod: p.pod, abs: avg15, cpuNow: facts }
        : { value: ratio, level: levelOf("cpuNow", ratio), worstPod: p.pod, abs: avg15, cpuNow: facts };
      const rank = cell.code ? 0 : RANK[cell.level];
      const key = ratio ?? avg15;
      if (!nowWorst || rank > nowWorst.rank || (rank === nowWorst.rank && key > nowWorst.key)) nowWorst = { cell, rank, key };
    }
    if (nowWorst) w.cells.cpuNow = nowWorst.cell;
    const r = worstPod((p) => p.restarts);
    const totalRestarts = pods.reduce((a, p) => a + (p.restarts ?? 0), 0);
    if (pods.some((p) => p.restarts !== null)) {
      w.cells.restarts = { value: totalRestarts, level: totalRestarts > 0 ? levelOf("restarts", totalRestarts) : "ok", ...(totalRestarts > 0 && r ? { worstPod: r.pod } : {}) };
    }
    // Java/Spring signals: present in the workspace but not here = not instrumented
    for (const metric of ["oldGen", "jvmHeadroom", "http5xx", "poolUsage", "poolPending"] as HeatMetric[]) {
      if (w.cells[metric].value !== null || w.cells[metric].level === "noTraffic" || w.cells[metric].level === "noBaseline") continue;
      w.cells[metric] = { value: null, level: families.has(FAMILY[metric]!) ? "notInstrumented" : "notMeasured" };
    }
    // A query the signal needs did not answer: neither its value nor "not measured" / OK is known. A Java signal of a
    // workload without it stays "not instrumented" unless the failed query is the one that shows who has it
    for (const metric of HEAT_METRICS) {
      if (!SIGNAL_NEEDS[metric]?.some((q) => opts.failed?.has(q))) continue;
      const presence = PRESENCE[metric];
      if (w.cells[metric].level === "notInstrumented" && !(presence && opts.failed?.has(presence))) continue;
      w.cells[metric] = { value: null, level: "notMeasured", code: "queryFailed" };
    }
    if (opts.managed && w.kind && opts.managed.has(`${w.kind}/${w.namespace}/${w.workload}`)) w.managed = true;
    // Nothing to run (0 desired, no pods): say why on readiness, "no pods" on the rest — not "not measured", not OK
    if (w.replicas.desired === 0 && pods.length === 0) {
      for (const k of HEAT_METRICS) w.cells[k] = { value: null, level: "stopped", code: "noPods" };
      w.cells.ready = { value: null, level: "stopped", code: w.kind === "DaemonSet" ? "noNodes" : "scaledToZero" };
    }
    const measured = VERDICT_METRICS.map((k) => w.cells[k].level);
    w.worst = measured.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "notMeasured" as HeatLevel);
    if (w.worst === "notMeasured" && w.cells.ready.level === "stopped") w.worst = "stopped";
    pods.sort((a, b) => (b.memory ?? -1) - (a.memory ?? -1) || (a.pod < b.pod ? -1 : 1));
    const { podMap, ...rest } = w;
    void podMap;
    workloads.push({ ...rest, pods });
  }
  workloads.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : RANK[b.worst] - RANK[a.worst] || (a.workload < b.workload ? -1 : 1)));

  const missing = HEAT_METRICS.filter((m) => (FAMILY[m] && !families.has(FAMILY[m]!)) || (m === "logErrors" && !opts.logErrors));
  const unknown = (m: HeatMetric) => missing.includes(m) || !!SIGNAL_NEEDS[m]?.some((q) => opts.failed?.has(q));
  const flags = VERDICT_METRICS.map((metric) => ({
    metric,
    count: unknown(metric) ? null
      : workloads.filter((w) => FLAG_AT[metric].includes(w.cells[metric].level) && !(w.managed && MANAGED_EXEMPT.includes(metric))).length,
  }));
  return { workloads, flags, missing };
}

// ── Collection ──

type PromResponse = { status?: string; data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }; error?: string };
const rowsOf = (resp: unknown): PromRow[] => {
  const r = resp as PromResponse;
  if (r?.status && r.status !== "success") throw new Error(`Prometheus query failed: ${r.error ?? r.status}`);
  return (r?.data?.result ?? []).map((x) => ({ metric: x.metric ?? {}, value: Number(x.value?.[1] ?? 0) })).filter((x) => Number.isFinite(x.value));
};

/** The time picker's quick ranges up to a day (web lib/timeRange.ts HEAT_WINDOWS — a test keeps them equal) */
export const HEAT_WINDOWS = [5, 15, 30, 60, 180, 360, 720, 1440] as const;
const cache = new CacheManager<WorkloadHeatmapResponse>(40, 30_000);
/** A map with gaps is kept briefly: the next refresh may answer in full */
const PARTIAL_TTL_MS = 15_000;
/** A map of the past does not change: kept longer (‹‹ / ›› go back and forth over the same ends) */
const PAST_TTL_MS = 10 * 60_000;
const inflight = new Map<string, Promise<WorkloadHeatmapResponse>>();

/** `at` = the window's end (epoch seconds, on a minute — infra queryPastTime) for a view of the past; none = now */
export async function getWorkloadHeatmap(env: Env, bearerToken: string | undefined, clusterId: string, windowMinutes: number, at?: number): Promise<WorkloadHeatmapResponse> {
  if (!(HEAT_WINDOWS as readonly number[]).includes(windowMinutes)) throw new HttpError(400, "invalid_window", `window must be one of ${HEAT_WINDOWS.join(", ")} minutes`);
  const key = `${cachePrefix(bearerToken)}:heatmap:${clusterId.toLowerCase()}:${windowMinutes}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, windowMinutes, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? PARTIAL_TTL_MS : at !== undefined ? PAST_TTL_MS : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, windowMinutes: number, at?: number): Promise<WorkloadHeatmapResponse> {
  const obs = clusterConnection(env, clusterId).connection.aks?.observability;
  const logErrors = obs?.logErrors ? { metric: obs.logErrors.metric, podLabel: obs.logErrors.podLabel ?? "exported_pod" } : undefined;
  const base: WorkloadHeatmapResponse = {
    clusterId, generatedAt: new Date().toISOString(), windowMinutes, ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    metricsState: "ok", cluster: null, thresholds: HEAT_THRESHOLDS,
    flags: [], workloads: [], missing: [],
    grafana: obs?.grafana ? { endpoint: obs.grafana.endpoint.replace(/\/+$/, ""), datasources: obs.grafana.datasources ?? {} } : null,
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    // Every query at the window's end: `[W]`, offsets and time() then read the past window (the AKS-managed set below is
    // today's labels — they do not move)
    const time = at === undefined ? undefined : String(at);
    const scope = pickScope(rowsOf(await fetcher.query(target.endpoint, "group by (cluster) (kube_pod_owner)", time)).map((r) => ({ cluster: r.metric.cluster })), clusterId.split("/").pop() ?? "");
    if (scope === null) return { ...base, metricsState: "noHubbleMetrics" };
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (logErrors) promString(logErrors.metric); // validated by the schema; control characters refused here too
    // The AKS-managed set comes from the Kubernetes API beside the queries — at most MANAGED_WAIT_MS of waiting
    const managedJob = aksManagedWorkloads(env, bearerToken, clusterId, MANAGED_WAIT_MS);
    const run = await runIsolated(fetcher, target.endpoint, heatmapQueries(scopeMatchers(scope, false), windowMinutes, logErrors), undefined, time);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (CORE_QUERIES.some((q) => failed.has(q))) throw run.firstError;
    const managed = await managedJob;
    const gaps: StackQueryGap[] = run.gaps;
    return {
      ...base, cluster: scope.cluster, ...aggregateHeatmap(run.rows, { logErrors, managed, failed, windowMinutes }),
      ...(gaps.length ? { gaps } : {}), managedState: managed ? "ok" : "unknown",
    };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
