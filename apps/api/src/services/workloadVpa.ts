// VPA recommendations next to what a workload asks for now (AKS 모니터링 › 히트맵 패널). The cluster's AMW has no
// VPA series (AKS kube-state-metrics does not export them), so both sides come from the Kubernetes API at the same
// moment: the VerticalPodAutoscaler objects (status.recommendation) and the workload's pod template. Only VPA's own
// semantics are flagged — the target above the limit, the request outside VPA's lower–upper bound — nothing invented.
// Reads use the existing list grants (k8sReadSurface: verticalpodautoscalers · deployments · statefulsets · daemonsets).

import * as k8s from "@kubernetes/client-node";
import type { Env } from "../env.js";
import type { ResourcePair, VpaContainer, WorkloadVpa, WorkloadVpaResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { HttpError } from "../infra/requestParams.js";
import { loadKubeConfig } from "./kubernetes.js";
import { k8sError } from "./aksAccess.js";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};

/** Kubernetes quantity → number ("25m" → 0.025 cores, "1200Mi" → bytes, "1238659775" → bytes, "1e3" → 1000) */
export function parseQuantity(q: unknown): number | null {
  if (typeof q === "number") return Number.isFinite(q) ? q : null;
  if (typeof q !== "string") return null;
  const m = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(q.trim());
  if (!m) return null;
  const mult = m[2] ? SUFFIX[m[2]] : 1;
  return mult === undefined ? null : Number(m[1]) * mult;
}

const pair = (o: unknown): ResourcePair | null => {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  return { cpu: parseQuantity(r.cpu), memory: parseQuantity(r.memory) };
};

type TemplateContainer = { name: string; resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } };
type VpaObject = {
  metadata?: { name?: string; namespace?: string };
  spec?: { targetRef?: { kind?: string; name?: string }; updatePolicy?: { updateMode?: string } };
  status?: {
    recommendation?: { containerRecommendations?: Array<{ containerName?: string; target?: unknown; lowerBound?: unknown; upperBound?: unknown; uncappedTarget?: unknown }> };
    conditions?: Array<{ type?: string; status?: string }>;
  };
};

/** Pure: the VPAs whose targetRef is this workload, each container's recommendation beside its request / limit */
export function vpaForWorkload(vpas: VpaObject[], target: { namespace: string; kind: string; name: string }, containers: TemplateContainer[]): WorkloadVpa[] {
  return vpas
    .filter((v) => v.metadata?.namespace === target.namespace && v.spec?.targetRef?.name === target.name && v.spec?.targetRef?.kind === target.kind)
    .map((v): WorkloadVpa => {
      const recs = v.status?.recommendation?.containerRecommendations ?? [];
      const cond = v.status?.conditions?.find((c) => c.type === "RecommendationProvided");
      const rows: VpaContainer[] = containers.map((c) => {
        const rec = recs.find((x) => x.containerName === c.name);
        const request = pair(c.resources?.requests) ?? { cpu: null, memory: null };
        const limit = pair(c.resources?.limits) ?? { cpu: null, memory: null };
        const row: VpaContainer = {
          name: c.name, request, limit,
          target: pair(rec?.target), lower: pair(rec?.lowerBound), upper: pair(rec?.upperBound), uncapped: pair(rec?.uncappedTarget), notes: [],
        };
        for (const res of ["memory", "cpu"] as const) {
          const t = row.target?.[res] ?? null, lim = limit[res], req = request[res], lo = row.lower?.[res] ?? null, hi = row.upper?.[res] ?? null;
          if (t !== null && lim !== null && t > lim) row.notes.push({ resource: res, kind: "targetOverLimit" });
          if (req !== null && lo !== null && req < lo) row.notes.push({ resource: res, kind: "belowLower" });
          if (req !== null && hi !== null && req > hi) row.notes.push({ resource: res, kind: "aboveUpper" });
        }
        return row;
      });
      return {
        name: v.metadata?.name ?? "", mode: v.spec?.updatePolicy?.updateMode ?? null, containers: rows,
        recommending: cond ? cond.status === "True" : null,
      };
    });
}

type Snapshot = { vpas: VpaObject[] | null; templates: Map<string, TemplateContainer[]> };
const cache = new CacheManager<Snapshot>(20, 60_000);
const inflight = new Map<string, Promise<Snapshot>>();
const KINDS = ["Deployment", "StatefulSet", "DaemonSet"] as const;

async function snapshot(env: Env, bearerToken: string | undefined, clusterId: string): Promise<Snapshot> {
  const key = `${cachePrefix(bearerToken)}:vpa:${clusterId.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const kc = await loadKubeConfig(env, bearerToken, clusterId);
    const custom = kc.makeApiClient(k8s.CustomObjectsApi);
    const apps = kc.makeApiClient(k8s.AppsV1Api);
    const vpaList = custom.listClusterCustomObject({ group: "autoscaling.k8s.io", version: "v1", plural: "verticalpodautoscalers" })
      .then((r) => ((r as { items?: VpaObject[] }).items ?? []))
      .catch((e: unknown) => {
        if ((e as { code?: number }).code === 404) return null; // CRD not installed
        throw k8sError(e);
      });
    const [vpas, deps, sts, dss] = await Promise.all([
      vpaList,
      apps.listDeploymentForAllNamespaces().catch((e: unknown) => { throw k8sError(e); }),
      apps.listStatefulSetForAllNamespaces().catch((e: unknown) => { throw k8sError(e); }),
      apps.listDaemonSetForAllNamespaces().catch((e: unknown) => { throw k8sError(e); }),
    ]);
    const templates = new Map<string, TemplateContainer[]>();
    for (const [kind, list] of [["Deployment", deps], ["StatefulSet", sts], ["DaemonSet", dss]] as const) {
      for (const o of list.items) {
        templates.set(`${kind}/${o.metadata?.namespace}/${o.metadata?.name}`, (o.spec?.template?.spec?.containers ?? []) as TemplateContainer[]);
      }
    }
    const snap = { vpas, templates };
    cache.set(key, snap);
    return snap;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export async function getWorkloadVpa(
  env: Env, bearerToken: string | undefined, clusterId: string, q: { namespace: string; workload: string; kind?: string },
): Promise<WorkloadVpaResponse> {
  if (!NAME.test(q.namespace)) throw new HttpError(400, "invalid_namespace", "namespace is not a Kubernetes name");
  if (!NAME.test(q.workload)) throw new HttpError(400, "invalid_workload", "workload is not a Kubernetes name");
  const kinds = q.kind && (KINDS as readonly string[]).includes(q.kind) ? [q.kind] : [...KINDS];
  const snap = await snapshot(env, bearerToken, clusterId);
  const base = { clusterId, generatedAt: new Date().toISOString() };
  if (snap.vpas === null) return { ...base, state: "noCrd", vpas: [] };
  const vpas = kinds.flatMap((kind) => {
    const containers = snap.templates.get(`${kind}/${q.namespace}/${q.workload}`);
    return containers ? vpaForWorkload(snap.vpas!, { namespace: q.namespace, kind, name: q.workload }, containers) : [];
  });
  return { ...base, state: vpas.length ? "ok" : "none", vpas };
}
