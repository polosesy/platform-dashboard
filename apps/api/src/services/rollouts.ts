// 서비스 (APM) › 배포 — deployment tracking: each rollout (a Deployment's new ReplicaSet), the image it brought, and the
// same-name service's server spans 30 minutes before vs after (Datadog deployment tracking, Dynatrace release compare).
//
// Measured on stg 2026-11-16: kube_replicaset_created 280 series (one collector), 70 created in 7 days; owners from
// kube_replicaset_owner; images from kube_pod_container_info (pods only — an old ReplicaSet with no pods has no image, so
// the previous image is read at the rollout time minus a minute, from the Deployment's pods then).
//
// Rules: a rollout = a new ReplicaSet owned by a Deployment, created in the window (rolling back to an existing
// ReplicaSet creates none — not shown, said in the view); the most recent MAX_COMPARED are compared, the rest counted.
// Before / after = increase over 30 minutes ending at the rollout and at rollout + 30 m (shorter when that is the
// future), server spans of the trace service of exactly the Deployment's name, /actuator apart; p95 = the bucket holding
// it (RED's rule). No verdict: the numbers side by side.

import type { Env } from "../env.js";
import type { Rollout, RolloutRed, RolloutsResponse, StackQueryGap } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getPrometheusFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { resolvePrometheusTarget } from "./prometheusCollector.js";
import { metricsStateOf, type PromRow } from "./hubbleMetrics.js";
import { pickScope, promString, scopeMatchers } from "./promScope.js";
import { runAll } from "./observabilityStack.js";
import { quantileBucket } from "./workloadRed.js";

const QUERY_TIMEOUT_MS = 20_000;
export const MAX_COMPARED = 10;
const COMPARE_MIN = 30;
const SERVER = 'span_kind=~"(?i)(span_kind_)?server"';
const NOT_ACTUATOR = 'span_name!~"(?i).*actuator.*"';

/** The window's queries (kube-state-metrics within `K`) */
export function rolloutQueries(K: string, end: number, days: number): Record<string, string> {
  const k = (m: string, extra = "") => `${m}{${[K, extra].filter(Boolean).join(",")}}`;
  return {
    created: `max by (namespace, replicaset) (${k("kube_replicaset_created")}) > ${end - days * 86400}`,
    owners: `group by (namespace, replicaset, owner_name) (${k("kube_replicaset_owner", 'owner_kind="Deployment"')})`,
    podOwners: `group by (namespace, pod, owner_name) (${k("kube_pod_owner", 'owner_kind="ReplicaSet"')})`,
    // image_spec = what the pod spec asked for ("reg/path/repo:tag@sha256:…"); `image` is the status form, "repo:<sha256 hex>"
    // for a digest-pinned pod (stg 2026-11-16: 50 of 52 pods) — unreadable as a version
    images: `group by (namespace, pod, container, image, image_spec) (${k("kube_pod_container_info")})`,
    services: `group by (service_name) (traces_spanmetrics_calls_total)`,
  };
}
/** Spans of one service over `minutes` ending at the evaluation time (`S` = the spanmetrics scope) */
export function compareQueries(S: string, service: string, minutes: number): { calls: string; buckets: string } {
  const sel = `{${[S, SERVER, NOT_ACTUATOR, `service_name=${promString(service)}`].filter(Boolean).join(",")}}`;
  return {
    calls: `sum by (status_code) (increase(traces_spanmetrics_calls_total${sel}[${minutes}m]))`,
    buckets: `sum by (le) (increase(traces_spanmetrics_duration_seconds_bucket${sel}[${minutes}m]))`,
  };
}

const leOf = (s: string | undefined): number | null => (s === undefined ? null : /^\+?inf$/i.test(s) ? Infinity : Number.isFinite(Number(s)) ? Number(s) : null);
/** Pure: requests · errors · p95 from a calls and a buckets answer (null when there was no request) */
export function redOf(calls: PromRow[] | null, buckets: PromRow[] | null): RolloutRed | null {
  if (!calls) return null;
  const requests = calls.reduce((n, r) => n + r.value, 0);
  if (!(requests > 0)) return { requests: 0, errors: 0, errorRate: null, p95: null };
  const errors = calls.filter((r) => /error$/i.test(r.metric.status_code ?? "")).reduce((n, r) => n + r.value, 0);
  const cum = new Map<number, number>();
  for (const r of buckets ?? []) { const le = leOf(r.metric.le); if (le !== null) cum.set(le, (cum.get(le) ?? 0) + r.value); }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { requests: round(requests), errors: round(errors), errorRate: Math.round((errors / requests) * 1e5) / 1e5, p95: buckets ? quantileBucket(cum, 0.95) : null };
}

/** Pure: the rollouts in the window, most recent first — new ReplicaSets owned by a Deployment, with today's images */
export function rolloutsOf(raw: Record<string, PromRow[]>, services: ReadonlySet<string>): Array<Omit<Rollout, "previousImages" | "before" | "after" | "afterMinutes">> {
  const owner = new Map<string, string>();
  for (const r of raw.owners ?? []) if (r.metric.namespace && r.metric.replicaset && r.metric.owner_name) owner.set(`${r.metric.namespace}/${r.metric.replicaset}`, r.metric.owner_name);
  const rsOfPod = new Map<string, string>();
  for (const r of raw.podOwners ?? []) if (r.metric.namespace && r.metric.pod && r.metric.owner_name) rsOfPod.set(`${r.metric.namespace}/${r.metric.pod}`, r.metric.owner_name);
  const imagesOfRs = new Map<string, Map<string, string>>();
  for (const r of raw.images ?? []) {
    const rs = rsOfPod.get(`${r.metric.namespace}/${r.metric.pod}`);
    const image = r.metric.image_spec || r.metric.image;
    if (!rs || !r.metric.container || !image) continue;
    const k = `${r.metric.namespace}/${rs}`;
    (imagesOfRs.get(k) ?? imagesOfRs.set(k, new Map()).get(k)!).set(r.metric.container, image);
  }
  const out = [];
  for (const r of raw.created ?? []) {
    const ns = r.metric.namespace, rs = r.metric.replicaset;
    if (!ns || !rs) continue;
    const dep = owner.get(`${ns}/${rs}`);
    if (!dep) continue;
    const imgs = [...(imagesOfRs.get(`${ns}/${rs}`) ?? new Map()).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([container, image]) => ({ container, image }));
    out.push({ namespace: ns, deployment: dep, replicaset: rs, at: new Date(r.value * 1000).toISOString(), images: imgs, service: services.has(dep) ? dep : null });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.deployment < b.deployment ? -1 : 1));
}

/**
 * Pure: the container images of the pods owned by `replicasets` (a Deployment's ReplicaSets other than the new one, by
 * kube_replicaset_owner — never by a name prefix: "orders-" would also catch "orders-api") at one instant
 */
export function deploymentImagesAt(podOwners: PromRow[], images: PromRow[], namespace: string, replicasets: ReadonlySet<string>): Array<{ container: string; image: string }> {
  const pods = new Set(podOwners.filter((r) => r.metric.namespace === namespace && replicasets.has(r.metric.owner_name ?? "")).map((r) => r.metric.pod));
  const m = new Map<string, string>();
  for (const r of images) {
    const image = r.metric.image_spec || r.metric.image;
    if (r.metric.namespace === namespace && pods.has(r.metric.pod) && r.metric.container && image) m.set(r.metric.container, image);
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([container, image]) => ({ container, image }));
}

const cache = new CacheManager<RolloutsResponse>(30, 5 * 60_000);
const inflight = new Map<string, Promise<RolloutsResponse>>();

export async function getRollouts(env: Env, bearerToken: string | undefined, clusterId: string, days: 1 | 7, at?: number): Promise<RolloutsResponse> {
  const key = `${cachePrefix(bearerToken)}:rollouts:${clusterId.toLowerCase()}:${days}:${at ?? "now"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = collect(env, bearerToken, clusterId, days, at).then((r) => {
    if (r.metricsState === "ok") cache.set(key, r, r.gaps?.length ? 15_000 : undefined);
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function collect(env: Env, bearerToken: string | undefined, clusterId: string, days: 1 | 7, at?: number): Promise<RolloutsResponse> {
  const base: RolloutsResponse = {
    clusterId, generatedAt: new Date().toISOString(), ...(at !== undefined ? { at: new Date(at * 1000).toISOString() } : {}),
    windowDays: days, metricsState: "ok", rollouts: [], more: 0, buckets: [], queries: {},
  };
  const target = await resolvePrometheusTarget(env, bearerToken, clusterId);
  if (target.state !== "ok") return { ...base, metricsState: target.state, ...(target.message ? { message: target.message } : {}) };
  try {
    const fetcher = await getPrometheusFetcherAuto(env, bearerToken, clusterId);
    const end = at ?? Math.floor(Date.now() / 1000);
    const aks = clusterId.split("/").pop() ?? "";
    const scopeRun = await runAll(fetcher, target.endpoint, {
      ksm: "group by (cluster, job, collector) (kube_replicaset_created)",
      spans: "group by (cluster, collector) (traces_spanmetrics_calls_total)",
    }, 2, String(end), QUERY_TIMEOUT_MS);
    if (scopeRun.gaps.some((g) => g.query === "ksm")) throw scopeRun.firstError;
    const ks = pickScope((scopeRun.rows.ksm ?? []).map((r) => ({ cluster: r.metric.cluster, job: r.metric.job, collector: r.metric.collector })), aks);
    if (ks === "ambiguous") return { ...base, metricsState: "ambiguousCluster" };
    if (ks === null) return base;
    const K = scopeMatchers(ks);
    const ss = pickScope((scopeRun.rows.spans ?? []).map((r) => ({ cluster: r.metric.cluster, collector: r.metric.collector })), aks);
    const S = ss && ss !== "ambiguous" ? scopeMatchers(ss, false) : null;
    const q = rolloutQueries(K, end, days);
    if (S !== null) q.services = `group by (service_name) (traces_spanmetrics_calls_total{${S}})`;
    else delete (q as Partial<typeof q>).services;
    const run = await runAll(fetcher, target.endpoint, q, 4, String(end), QUERY_TIMEOUT_MS);
    if (run.gaps.some((g) => g.query === "created" || g.query === "owners")) throw run.firstError;
    const gaps: StackQueryGap[] = [...run.gaps];
    const services = new Set((run.rows.services ?? []).map((r) => r.metric.service_name).filter((x): x is string => !!x));
    const all = rolloutsOf(run.rows, services);
    const compared = all.slice(0, MAX_COMPARED);

    // Per rollout: the Deployment's images a minute before, and the service's spans before / after
    const buckets = new Set<number>();
    const rollouts: Rollout[] = await Promise.all(compared.map(async (r0) => {
      let r: typeof r0 & { imagesAt?: "rollout" } = r0;
      const t = Math.floor(Date.parse(r.at) / 1000);
      const afterMinutes = Math.max(0, Math.min(COMPARE_MIN, Math.floor((end - t) / 60)));
      const prevRun = await runAll(fetcher, target.endpoint, {
        podOwners: q.podOwners.replace("kube_pod_owner{", `kube_pod_owner{namespace=${promString(r.namespace)},`),
        images: q.images.replace("kube_pod_container_info{", `kube_pod_container_info{namespace=${promString(r.namespace)},`),
      }, 2, String(t - 60), QUERY_TIMEOUT_MS);
      const older = new Set((run.rows.owners ?? []).filter((o) => o.metric.namespace === r.namespace && o.metric.owner_name === r.deployment && o.metric.replicaset !== r.replicaset).map((o) => o.metric.replicaset!));
      const previousImages = prevRun.gaps.length ? null : deploymentImagesAt(prevRun.rows.podOwners ?? [], prevRun.rows.images ?? [], r.namespace, older);
      // A rollout replaced since (no pod now): the image it ran, read 3 minutes after it was created
      if (!r.images.length) {
        const thenRun = await runAll(fetcher, target.endpoint, {
          podOwners: q.podOwners.replace("kube_pod_owner{", `kube_pod_owner{namespace=${promString(r.namespace)},`),
          images: q.images.replace("kube_pod_container_info{", `kube_pod_container_info{namespace=${promString(r.namespace)},`),
        }, 2, String(Math.min(end, t + 180)), QUERY_TIMEOUT_MS);
        if (!thenRun.gaps.length) r = { ...r, images: deploymentImagesAt(thenRun.rows.podOwners ?? [], thenRun.rows.images ?? [], r.namespace, new Set([r.replicaset])), imagesAt: "rollout" as const };
      }
      if (!r.service || S === null) return { ...r, previousImages, before: null, after: null, afterMinutes };
      const before = compareQueries(S, r.service, COMPARE_MIN);
      const after = afterMinutes >= 1 ? compareQueries(S, r.service, afterMinutes) : null;
      const [b, a] = await Promise.all([
        runAll(fetcher, target.endpoint, before, 2, String(t), QUERY_TIMEOUT_MS),
        after ? runAll(fetcher, target.endpoint, after, 2, String(t + afterMinutes * 60), QUERY_TIMEOUT_MS) : Promise.resolve(null),
      ]);
      for (const x of [...(b.rows.buckets ?? []), ...(a?.rows.buckets ?? [])]) { const le = leOf(x.metric.le); if (le !== null && le !== Infinity) buckets.add(le); }
      const pick = (run2: typeof b | null, k: "calls" | "buckets") => (!run2 || run2.gaps.some((g) => g.query === k) ? null : run2.rows[k] ?? []);
      return { ...r, previousImages, before: redOf(pick(b, "calls"), pick(b, "buckets")), after: a ? redOf(pick(a, "calls"), pick(a, "buckets")) : null, afterMinutes };
    }));
    const shown = { created: q.created, owners: q.owners, ...(S !== null ? compareQueries(S, "<service>", COMPARE_MIN) : {}) };
    return { ...base, rollouts, more: all.length - compared.length, buckets: [...buckets].sort((x, y) => x - y), queries: shown, ...(gaps.length ? { gaps } : {}) };
  } catch (e) {
    if (e instanceof HttpError && e.code === "signin_required") throw e;
    const { state, message } = metricsStateOf(e);
    return { ...base, metricsState: state, message };
  }
}
