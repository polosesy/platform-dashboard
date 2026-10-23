// What enforcing a network policy would block, read from Cilium's own policy decisions (pure).
//
// In the audit form of a policy (`enableDefaultDeny: false`, deploy/helm/aud-dashboard/templates/networkpolicy.yaml)
// nothing is dropped, and trace events carry no policy match ("policy-verdict:none" in compact output) — so they
// cannot tell. The policy-verdict event Cilium emits for the first packet of every new connection can: since
// Cilium 1.15 it lists the rules that allowed it (egress_allowed_by / ingress_allowed_by). A named policy there =
// allowed when enforced; only the synthetic `allow-any-egress` / `allow-any-ingress` rule (left by
// enableDefaultDeny false, or by no policy at all — match type 4 "all") = blocked once a default-deny policy
// selects the workload. Verified on AKS ACNS Cilium 1.19 (docs/deployment/kubernetes.md, audit → enforce).
// No destination-IP or identity guessing; older agents without allowed-by get a match-type estimate, labelled so.

import type { HubbleEnforceReadiness, HubbleFlow, HubbleJudgementKind, HubblePolicyJudgement, HubblePolicyRef } from "@aud/types";

/** One allowed-by entry: a named policy, or a rule Cilium derived (label `io.cilium.policy.derived-from=…`) */
export function parsePolicyRef(raw: unknown): HubblePolicyRef {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const labels = Array.isArray(r.labels) ? r.labels.map(String) : [];
  const label = (re: RegExp) => labels.map((l) => re.exec(l)?.[1]).find(Boolean);
  const name = typeof r.name === "string" && r.name ? r.name : label(/io\.cilium\.k8s\.policy\.name=(.+)$/);
  const namespace = typeof r.namespace === "string" && r.namespace ? r.namespace : label(/io\.cilium\.k8s\.policy\.namespace=(.+)$/);
  const kind = typeof r.kind === "string" && r.kind ? r.kind : label(/io\.cilium\.k8s\.policy\.derived-from=(.+)$/);
  const derivedFrom = name ? undefined : label(/io\.cilium\.policy\.derived-from=(.+)$/);
  return { ...(name ? { name } : {}), ...(namespace ? { namespace } : {}), ...(kind ? { kind } : {}), ...(derivedFrom ? { derivedFrom } : {}) };
}

const ALLOW_ANY = /^allow-any-(egress|ingress)$/;
/** policy_match_type 4: the wildcard entry — the allow-any rule */
const MATCH_ALL = 4;
const RESERVED: Record<number, string> = { 1: "host", 2: "world", 4: "health", 6: "kube-apiserver", 7: "remote-node", 8: "ingress" };

/** `namespace/name` of a named policy, `cluster/name` for a clusterwide one; null for a derived rule */
export function policyLabel(ref: HubblePolicyRef): string | null {
  if (!ref.name) return null;
  return `${ref.namespace || "cluster"}/${ref.name}`;
}

/**
 * One flow's judgement. `allowedBySupported`: whether the agents report allowed-by at all (any verdict event in
 * the set has it) — a verdict event without it is then `unknown`, not an estimate.
 */
export function policyJudgement(f: HubbleFlow, allowedBySupported = true): HubblePolicyJudgement {
  const none = (kind: HubbleJudgementKind): HubblePolicyJudgement => ({ kind, policies: [], basis: "none" });
  if (f.eventKind !== "policy-verdict") {
    return f.verdict === "DROPPED" && /polic/i.test(f.dropReasonDesc) ? { kind: "dropped", policies: [], basis: "verdict" } : none("unknown");
  }
  if (f.verdict === "DROPPED") return { kind: "dropped", policies: [], basis: "verdict" };
  if (f.verdict === "AUDIT") return { kind: "auditOnly", policies: [], basis: "verdict" }; // per-endpoint PolicyAuditMode
  const refs = f.allowedBy ?? [];
  if (!refs.length) {
    if (allowedBySupported || !f.policyMatch) return none("unknown");
    return { kind: f.policyMatch === MATCH_ALL ? "auditOnly" : "policy", policies: [], basis: "estimate" };
  }
  const named = [...new Set(refs.map(policyLabel).filter((p): p is string => !!p))].sort();
  if (named.length) return { kind: "policy", policies: named, basis: "allowedBy" };
  if (refs.every((r) => ALLOW_ANY.test(r.derivedFrom ?? ""))) return { kind: "auditOnly", policies: [], basis: "allowedBy" };
  return { kind: "default", policies: [], basis: "allowedBy" };
}

const workload = (e: HubbleFlow["source"]) =>
  e.namespace ? `${e.namespace}/${e.workloadName || e.podName}` : RESERVED[e.identity] ?? "";

/** The peer as a reader knows it: DNS names (egress) > workload > reserved identity > IP */
function peerOf(f: HubbleFlow, egress: boolean): { peer: string; names: string[]; identity: number } {
  const side = egress ? f.destination : f.source;
  const names = egress ? f.destinationNames ?? [] : [];
  const ip = egress ? f.destinationIp : f.sourceIp;
  const peer = names.length ? names.join(", ") : workload(side) || ip || `identity ${side.identity}`;
  return { peer, names, identity: side.identity };
}

/** Counts per judgement, allowing policies, and the connections enforcing would block (top 30) */
export function summarizeEnforceReadiness(flows: HubbleFlow[]): HubbleEnforceReadiness | undefined {
  const verdicts = flows.filter((f) => f.eventKind === "policy-verdict" && !f.isReply);
  const policyDrops = flows.filter((f) => f.eventKind !== "policy-verdict" && f.verdict === "DROPPED" && /polic/i.test(f.dropReasonDesc));
  if (!verdicts.length && !policyDrops.length) return undefined;
  const allowedBySupported = verdicts.some((f) => (f.allowedBy?.length ?? 0) > 0);
  const counts: Record<HubbleJudgementKind, number> = { policy: 0, auditOnly: 0, default: 0, dropped: policyDrops.length, unknown: 0 };
  const byPolicy = new Map<string, number>();
  const wouldDrop = new Map<string, HubbleEnforceReadiness["wouldDrop"][number]>();
  for (const f of verdicts) {
    const j = policyJudgement(f, allowedBySupported);
    counts[j.kind]++;
    for (const p of j.policies) byPolicy.set(p, (byPolicy.get(p) ?? 0) + 1);
    if (j.kind !== "auditOnly") continue;
    const egress = f.trafficDirection !== "INGRESS";
    const subject = workload(egress ? f.source : f.destination) || (egress ? f.sourceIp : f.destinationIp) || "";
    const { peer, names, identity } = peerOf(f, egress);
    const key = [f.trafficDirection, subject, peer, f.destinationPort, f.l4Protocol].join("|");
    const row = wouldDrop.get(key);
    if (row) {
      row.count++;
      if (f.time > row.lastSeen) row.lastSeen = f.time;
    } else {
      wouldDrop.set(key, { direction: f.trafficDirection, subject, peer, peerNames: names, peerIdentity: identity,
        port: f.destinationPort, protocol: f.l4Protocol, count: 1, lastSeen: f.time });
    }
  }
  const times = verdicts.map((f) => f.time).filter(Boolean).sort();
  return {
    verdictEvents: verdicts.length,
    oldest: times[0] ?? null,
    newest: times[times.length - 1] ?? null,
    allowedBySupported,
    counts,
    byPolicy: [...byPolicy].map(([policy, count]) => ({ policy, count })).sort((a, b) => b.count - a.count || (a.policy < b.policy ? -1 : 1)),
    wouldDrop: [...wouldDrop.values()].sort((a, b) => b.count - a.count || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)).slice(0, 30),
  };
}
