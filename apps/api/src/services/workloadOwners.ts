// Pod → workload from kube-state-metrics owner series (kube_pod_owner, kube_replicaset_owner) — pure.
// Exact for ReplicaSet → Deployment, StatefulSet, DaemonSet and Job; a pod with no owner series (gone before the
// window, or not scraped) falls back to the name pattern and says so (`basis: "pattern"`). Labels that are not
// `namespace/pod` (IPs, reserved identities, empty) are never turned into workloads.

import type { HubbleWorkloadRef } from "@aud/types";

export type OwnerRow = { namespace: string; name: string; ownerKind: string; ownerName: string };
export type OwnerIndex = { pods: Map<string, OwnerRow>; replicaSets: Map<string, OwnerRow> };

const KIND: Record<string, string> = {
  deployment: "Deployment", replicaset: "ReplicaSet", statefulset: "StatefulSet", daemonset: "DaemonSet",
  job: "Job", cronjob: "CronJob", node: "Node",
};
const kindOf = (k: string): string | null => KIND[k.toLowerCase()] ?? (k && k !== "<none>" ? k : null);

export function ownerIndex(pods: OwnerRow[], replicaSets: OwnerRow[]): OwnerIndex {
  const key = (r: OwnerRow) => `${r.namespace}/${r.name}`;
  return { pods: new Map(pods.map((r) => [key(r), r])), replicaSets: new Map(replicaSets.map((r) => [key(r), r])) };
}

/** `namespace/pod` → parts; anything else (an IP, a reserved identity, "") → null */
export function podLabel(label: string | undefined): { namespace: string; pod: string } | null {
  const m = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z0-9]([-.a-z0-9]*[a-z0-9])?)$/.exec(label ?? "");
  return m ? { namespace: m[1]!, pod: m[3]! } : null;
}

// Kubernetes' random suffixes use only these characters (no vowels — apimachinery rand.String), so a real word
// such as "-redis" is never cut
const R = "[bcdfghjklmnpqrstvwxz2456789]";
const PATTERNS = [new RegExp(`-${R}{6,10}-${R}{5}$`), new RegExp(`-${R}{5}$`), /-\d+$/];

/** The name pattern: Deployment `<name>-<rs hash>-<5>`, DaemonSet/Job `<name>-<5>`, StatefulSet `<name>-<n>` — first match only */
export function workloadFromPodName(pod: string): string {
  for (const re of PATTERNS) if (re.test(pod)) return pod.replace(re, "") || pod;
  return pod;
}

export function resolveWorkload(label: string | undefined, owners: OwnerIndex): HubbleWorkloadRef | null {
  const p = podLabel(label);
  if (!p) return null;
  const owner = owners.pods.get(`${p.namespace}/${p.pod}`);
  if (owner && owner.ownerName && owner.ownerKind !== "<none>") {
    if (owner.ownerKind.toLowerCase() === "replicaset") {
      const rs = owners.replicaSets.get(`${p.namespace}/${owner.ownerName}`);
      if (rs && rs.ownerName && rs.ownerKind !== "<none>") return { namespace: p.namespace, workload: rs.ownerName, kind: kindOf(rs.ownerKind), basis: "owner" };
      return { namespace: p.namespace, workload: owner.ownerName, kind: "ReplicaSet", basis: "owner" };
    }
    return { namespace: p.namespace, workload: owner.ownerName, kind: kindOf(owner.ownerKind), basis: "owner" };
  }
  return { namespace: p.namespace, workload: workloadFromPodName(p.pod), kind: null, basis: "pattern" };
}
