// AKS 클러스터 (구성 · 리소스) — the view model behind the page (pure).
//
// The page answers "what is there and how is it set" (docs/architecture/kubernetes-ia.md): the cluster's Azure
// configuration on top, then the objects grouped by what they are. State ("is it healthy") lives in AKS 모니터링 —
// a workload row links there (`monitoringHref`), and the monitoring panel links back (`configHref`).

import type { AksClusterConfigResponse, KubernetesObject, KubernetesObjectKind } from "@aud/types";

export type KindGroup = "workloads" | "network" | "config" | "storage" | "batch" | "cluster";
export const KIND_GROUPS: Record<KindGroup, KubernetesObjectKind[]> = {
  workloads: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod"],
  network: ["Service", "Ingress"],
  config: ["ConfigMap", "Secret"],
  storage: ["PersistentVolumeClaim"],
  batch: ["Job", "CronJob"],
  cluster: ["Node", "Namespace"],
};
export const GROUP_ORDER: KindGroup[] = ["workloads", "network", "batch", "config", "storage", "cluster"];

const GROUP_OF = new Map<KubernetesObjectKind, KindGroup>(
  (Object.entries(KIND_GROUPS) as [KindGroup, KubernetesObjectKind[]][]).flatMap(([g, kinds]) => kinds.map((k) => [k, g] as const)),
);
export const groupOfKind = (kind: KubernetesObjectKind): KindGroup => GROUP_OF.get(kind) ?? "cluster";

export type ObjectFilter = { group: KindGroup | ""; kind: KubernetesObjectKind | ""; namespace: string; query: string };
export const NO_OBJECT_FILTER: ObjectFilter = { group: "", kind: "", namespace: "", query: "" };

const passes = (o: KubernetesObject, f: ObjectFilter, skip?: "group") => {
  if (skip !== "group" && f.group && groupOfKind(o.kind) !== f.group) return false;
  if (skip !== "group" && f.kind && o.kind !== f.kind) return false;
  if (f.namespace && o.namespace !== f.namespace) return false;
  const q = f.query.trim().toLowerCase();
  return !q || o.name.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q);
};

export function filterObjects(objects: KubernetesObject[], f: ObjectFilter): KubernetesObject[] {
  return objects.filter((o) => passes(o, f));
}

/** Objects per group within the other filters (namespace · text) — the chips' numbers; groups with none are left out */
export function groupCounts(objects: KubernetesObject[], f: ObjectFilter): { group: KindGroup; n: number }[] {
  const n = new Map<KindGroup, number>();
  for (const o of objects) if (passes(o, f, "group")) n.set(groupOfKind(o.kind), (n.get(groupOfKind(o.kind)) ?? 0) + 1);
  return GROUP_ORDER.filter((g) => n.has(g)).map((group) => ({ group, n: n.get(group)! }));
}

/** Kinds present in a group (for the kind picker), in the group's order, with counts within namespace · text */
export function kindCounts(objects: KubernetesObject[], f: ObjectFilter): { kind: KubernetesObjectKind; n: number }[] {
  const n = new Map<KubernetesObjectKind, number>();
  for (const o of objects) {
    if (!passes(o, { ...f, kind: "" }, undefined)) continue;
    n.set(o.kind, (n.get(o.kind) ?? 0) + 1);
  }
  const order = GROUP_ORDER.flatMap((g) => KIND_GROUPS[g]);
  return order.filter((k) => n.has(k)).map((kind) => ({ kind, n: n.get(kind)! }));
}

/** The kinds AKS 모니터링 draws as workloads — a row of these opens that workload's signals there */
const MONITORED: ReadonlySet<KubernetesObjectKind> = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/** AKS 모니터링 with this workload's panel open (`?wl=<namespace>/<name>`), or null for other kinds */
export function monitoringHref(o: Pick<KubernetesObject, "kind" | "namespace" | "name">): string | null {
  return MONITORED.has(o.kind) && o.namespace && o.name ? `/observability?wl=${encodeURIComponent(`${o.namespace}/${o.name}`)}` : null;
}

/** AKS 클러스터 filtered to one workload's objects (the monitoring panel's "구성 보기") */
export function configHref(namespace: string, name: string): string {
  return `/kubernetes?ns=${encodeURIComponent(namespace)}&q=${encodeURIComponent(name)}`;
}

/** Pure: `?wl=` → "<namespace>/<name>" when it has that shape (a Kubernetes namespace and object name), else null */
export function parseWorkloadParam(search: string): string | null {
  const v = new URLSearchParams(search).get("wl") ?? "";
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\/[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(v) ? v : null;
}

/** Pure: `?ns=&q=` for the objects table — names only (no markup, bounded length) */
export function parseObjectParams(search: string): Pick<ObjectFilter, "namespace" | "query"> {
  const p = new URLSearchParams(search);
  const clean = (v: string | null) => (v && /^[-a-z0-9.]{1,253}$/.test(v) ? v : "");
  return { namespace: clean(p.get("ns")), query: clean(p.get("q")) };
}

export type UpgradeState = "upToDate" | "patch" | "minor" | "unknown";
/**
 * Pure: where the control plane stands against what ARM offers — a newer patch of the same minor, only a newer
 * minor, nothing newer; unknown when the upgrade list was not read. Preview versions do not count.
 */
export function upgradeState(v: AksClusterConfigResponse["version"]): { state: UpgradeState; to: string | null } {
  if (!v.upgrades || !v.current) return { state: "unknown", to: null };
  const stable = v.upgrades.filter((u) => !u.preview).map((u) => u.version);
  if (!stable.length) return { state: "upToDate", to: null };
  const minor = (x: string) => x.split(".").slice(0, 2).join(".");
  const patch = stable.filter((x) => minor(x) === minor(v.current!));
  return patch.length ? { state: "patch", to: patch[patch.length - 1]! } : { state: "minor", to: stable[stable.length - 1]! };
}

/** Pure: node pools whose Kubernetes version differs from the control plane (an upgrade in progress or left behind) */
export function poolsBehind(c: Pick<AksClusterConfigResponse, "version" | "pools">): string[] {
  const cur = c.version.current;
  return cur ? c.pools.filter((p) => p.version && p.version !== cur).map((p) => p.name) : [];
}

/** Pure: total nodes and the autoscaler's ceiling (null when no pool autoscales) */
export function nodeTotals(pools: AksClusterConfigResponse["pools"]): { nodes: number; max: number | null } {
  const nodes = pools.reduce((s, p) => s + (p.count ?? 0), 0);
  return { nodes, max: pools.some((p) => p.autoscale) ? pools.reduce((s, p) => s + (p.autoscale?.max ?? p.count ?? 0), 0) : null };
}
