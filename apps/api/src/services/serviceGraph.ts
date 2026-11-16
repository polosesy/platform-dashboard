// AKS 모니터링 › 서비스 (APM) › 서비스 맵 — who calls whom, from the trace pipeline's service graph in the cluster's
// Azure Monitor workspace. The APM service map (Datadog Service Map, Dynatrace Smartscape, AppDynamics flow map, New
// Relic service map) built from vendor-neutral series: the OpenTelemetry Collector / Grafana Alloy `servicegraph`
// connector and Tempo's metrics-generator write the same names on any cloud.
//
// Rules (stg 2026-11-16: 33 client → server pairs, 28.1k requests and 60 failed in an hour, 0 resets in 10 minutes):
// - An edge is a client span matched with its server span. `traces_service_graph_request_total` carries a `failed`
//   label: both values summed = all requests (failures included); failures = `traces_service_graph_request_failed_total`
//   (equal to the total's failed="true" — measured 60 = 60).
// - connection_type: "" = both sides traced · virtual_node = one side is not (client "user" = a root span: the caller
//   is outside the traced services) · messaging_system · database. Kept as said — never merged into "direct".
// - Duration = the server side's histogram, as the bucket holding the quantile (no interpolation; RED's rule).
// - Fewer than RED_MIN_REQUESTS in the window: shown, not judged. No colour without a target — failures are facts.
// - Trust check: resets() over the window, shown beside the numbers (stg: about one per series in 6 h — a collector
//   restart; increase() handles it).
// - service → workload: the namespace the pipeline put on the server side when it did, else a workload of exactly that
//   name in one namespace only — never a similar name.

import type { Env } from "../env.js";
import type { RedWindow, ServiceGraphEdge, ServiceGraphEdgeKind, ServiceGraphNode, ServiceGraphResponse, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";
import { RED_MIN_REQUESTS, quantileBucket } from "./workloadRed.js";

const QUERY_TIMEOUT_MS = 20_000;
/** Client names the service graph gives a root span's caller */
export const ENTRY_CLIENTS = new Set(["user", "unknown"]);

/** The queries for one window (minutes) within the scope matchers `C` and the kube-state-metrics matcher `ksm` */
export function serviceGraphQueries(C: string, ksm: string, minutes: number): Record<string, string> {
  const sel = C ? `{${C}}` : "";
  const k = (m: string) => `${m}${ksm ? `{${ksm}}` : ""}`;
  return {
    requests: `sum by (client, server, connection_type, server_k8s_namespace_name) (increase(traces_service_graph_request_total${sel}[${minutes}m]))`,
    failed: `sum by (client, server) (increase(traces_service_graph_request_failed_total${sel}[${minutes}m]))`,
    buckets: `sum by (client, server, le) (increase(traces_service_graph_request_server_seconds_bucket${sel}[${minutes}m]))`,
    resets: `sum(resets(traces_service_graph_request_total${sel}[${minutes}m]))`,
    workloads: `group by (namespace, deployment) (${k("kube_deployment_created")}) or group by (namespace, statefulset) (${k("kube_statefulset_created")}) or group by (namespace, daemonset) (${k("kube_daemonset_created")})`,
  };
}

/** Pure: connection_type → the edge kind (unknown values are "other", never "direct") */
export function edgeKindOf(connectionType: string | undefined): ServiceGraphEdgeKind {
  const t = (connectionType ?? "").toLowerCase();
  if (t === "") return "direct";
  if (t === "virtual_node") return "virtual";
  if (t === "messaging_system") return "messaging";
  if (t === "database") return "database";
  return "other";
}

const leOf = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  if (/^\+?inf$/i.test(s)) return Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: nodes and edges from the query rows (`failed` = names of the queries that did not answer) */
export function aggregateServiceGraph(raw: Record<string, PromRow[]>, minutes: number, failedQueries: Set<string> = new Set()): Pick<ServiceGraphResponse, "nodes" | "edges" | "resets" | "buckets"> {
  type Acc = { client: string; server: string; kind: ServiceGraphEdgeKind; ns: string | null; requests: number; failed: number; cum: Map<number, number> };
  const by = new Map<string, Acc>();
  const keyOf = (c: string, s: string) => `${c}\u0000${s}`;
  for (const r of raw.requests ?? []) {
    const c = r.metric.client, s = r.metric.server;
    if (!c || !s || !(r.value >= 0)) continue;
    const k = keyOf(c, s);
    const a = by.get(k) ?? { client: c, server: s, kind: edgeKindOf(r.metric.connection_type), ns: null, requests: 0, failed: 0, cum: new Map() };
    a.requests += r.value;
    a.ns ??= r.metric.server_k8s_namespace_name || null;
    by.set(k, a);
  }
  for (const r of raw.failed ?? []) {
    const a = by.get(keyOf(r.metric.client ?? "", r.metric.server ?? ""));
    if (a) a.failed += r.value;
  }
  const les = new Set<number>();
  for (const r of raw.buckets ?? []) {
    const a = by.get(keyOf(r.metric.client ?? "", r.metric.server ?? ""));
    const le = leOf(r.metric.le);
    if (!a || le === null) continue;
    if (le !== Infinity) les.add(le);
    a.cum.set(le, (a.cum.get(le) ?? 0) + r.value);
  }
  const noDuration = failedQueries.has("buckets");
  const noFailed = failedQueries.has("failed");
  const edges: ServiceGraphEdge[] = [...by.values()]
    .filter((a) => a.requests > 0)
    .map((a) => ({
      client: a.client, server: a.server, kind: a.kind,
      requests: round(a.requests), rate: round(a.requests / (minutes * 60), 4),
      failed: round(a.failed), errorRate: noFailed ? null : round(a.failed / a.requests, 5),
      p95: noDuration ? null : quantileBucket(a.cum, 0.95), p99: noDuration ? null : quantileBucket(a.cum, 0.99),
      lowTraffic: a.requests < RED_MIN_REQUESTS,
    }))
    .sort((x, y) => y.requests - x.requests || cmp(x.client, y.client) || cmp(x.server, y.server));

  // Workloads by name; a service's namespace = the one the pipeline put on its server side
  const named = new Map<string, Array<{ namespace: string; name: string; kind: "Deployment" | "StatefulSet" | "DaemonSet" }>>();
  for (const r of raw.workloads ?? []) {
    const ns = r.metric.namespace;
    const [name, kind] = r.metric.deployment ? [r.metric.deployment, "Deployment" as const] : r.metric.statefulset ? [r.metric.statefulset, "StatefulSet" as const] : r.metric.daemonset ? [r.metric.daemonset, "DaemonSet" as const] : [undefined, undefined];
    if (!ns || !name || !kind) continue;
    named.set(name, [...(named.get(name) ?? []), { namespace: ns, name, kind }]);
  }
  const nsOf = new Map<string, string>();
  for (const a of by.values()) if (a.ns && !nsOf.has(a.server)) nsOf.set(a.server, a.ns);
  const names = new Set(edges.flatMap((e) => [e.client, e.server]));
  const nodes: ServiceGraphNode[] = [...names].sort(cmp).map((service) => {
    const inbound = edges.filter((e) => e.server === service);
    const outbound = edges.filter((e) => e.client === service);
    const inReq = inbound.reduce((n, e) => n + e.requests, 0), inFail = inbound.reduce((n, e) => n + e.failed, 0);
    const ns = nsOf.get(service) ?? null;
    const same = named.get(service) ?? [];
    const inNs = ns ? same.filter((w) => w.namespace === ns) : same;
    return {
      service, entry: ENTRY_CLIENTS.has(service.toLowerCase()) && inbound.length === 0, namespace: ns,
      workload: inNs.length === 1 ? inNs[0]! : null,
      inbound: { requests: round(inReq), failed: round(inFail), errorRate: inReq > 0 && !noFailed ? round(inFail / inReq, 5) : null },
      outbound: { requests: round(outbound.reduce((n, e) => n + e.requests, 0)), failed: round(outbound.reduce((n, e) => n + e.failed, 0)) },
    };
  });
  return { nodes, edges, buckets: [...les].sort((a, b) => a - b), resets: failedQueries.has("resets") ? null : round(raw.resets?.[0]?.value ?? 0) };
}

const cache = new CacheManager<ServiceGraphResponse>(30, 60_000);
const PARTIAL_TTL_MS = 15_000;
const PAST_TTL_MS = 10 * 60_000;
const inflight = new Map<string, Promise<ServiceGraphResponse>>();

/** `at` = the window's end (epoch seconds) for a view of the past; none = now */
export async function getServiceGraph(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<ServiceGraphResponse> {
  const key = `${cachePrefix(bearerToken)}:svcgraph:${clusterId.toLowerCase()}:${minutes}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, minutes, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? PARTIAL_TTL_MS : at !== undefined ? PAST_TTL_MS : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, minutes: RedWindow, at?: number): Promise<ServiceGraphResponse> {
  const base: ServiceGraphResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowMinutes: minutes, metricsState: "ok", instrumented: false, resets: null, nodes: [], edges: [], buckets: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const time = at === undefined ? undefined : String(at);
    // The scope of the service-graph series themselves: two collectors writing them would double every count
    const scopeRun = await runAll(fetcher, target.endpoint, { scope: "group by (cluster, collector) (traces_service_graph_request_total)" }, 1, time, QUERY_TIMEOUT_MS);
    if (scopeRun.gaps.length) throw scopeRun.firstError;
    const scope = pickScope((scopeRun.rows.scope ?? []).map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), clusterId.split("/").pop() ?? "");
    if (scope === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (scope === null) return base; // instrumented: false — the view says what writes the series
    const C = scopeMatchers(scope, false);
    const ksm = scope.cluster !== null ? `cluster=${promString(scope.cluster)}` : "";
    const queries = serviceGraphQueries(C, ksm, minutes);
    const run = await runAll(fetcher, target.endpoint, queries, 4, time, QUERY_TIMEOUT_MS);
    const failed = new Set(run.gaps.map((g) => g.query));
    if (failed.has("requests")) throw run.firstError;
    const gaps: StackQueryGap[] = run.gaps;
    const { workloads: _w, ...shown } = queries;
    return { ...base, instrumented: true, queries: shown, ...aggregateServiceGraph(run.rows, minutes, failed), ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
