import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHubbleJsonOutput } from "../src/services/hubbleClient.js";
import { dedupeObservations } from "../src/services/hubbleMerge.js";
import { policyJudgement, summarizeEnforceReadiness } from "../src/services/hubbleAudit.js";

// Fixtures shaped like `hubble observe -o jsonpb` on AKS ACNS Cilium 1.19 with the chart's audit policy
// (enableDefaultDeny false) — measured 2026-10-23; names and addresses are placeholders.
const AUDIT_POLICY = {
  name: "aud-dashboard-baseline-audit", namespace: "aud-dashboard", kind: "CiliumNetworkPolicy", revision: "31",
  labels: ["k8s:io.cilium.k8s.policy.derived-from=CiliumNetworkPolicy", "k8s:io.cilium.k8s.policy.name=aud-dashboard-baseline-audit",
    "k8s:io.cilium.k8s.policy.namespace=aud-dashboard"],
};
const ALLOW_ANY_EGRESS = { labels: ["reserved:io.cilium.policy.derived-from=allow-any-egress"], revision: "31" };
const LOCALHOST_INGRESS = { labels: ["reserved:io.cilium.policy.derived-from=allow-localhost-ingress"], revision: "31" };
const POD = { identity: 25841, namespace: "aud-dashboard", pod_name: "aud-dashboard-0", labels: ["k8s:app.kubernetes.io/name=aud-dashboard"], workloads: [{ name: "aud-dashboard", kind: "Deployment" }] };
const WORLD = { identity: 2, labels: ["reserved:world"] };

let seq = 0;
function line(f: Record<string, unknown>): string {
  seq++;
  return JSON.stringify({ flow: {
    time: `2026-10-23T00:45:${String(10 + seq).padStart(2, "0")}.000Z`, verdict: "FORWARDED", Type: "L3_L4", node_name: "node-a",
    IP: { source: "10.0.0.5", destination: "203.0.113.10" }, l4: { TCP: { source_port: 40000 + seq, destination_port: 443, flags: { SYN: true } } },
    source: POD, destination: WORLD, traffic_direction: "EGRESS", ...f,
  } });
}
const verdict = (f: Record<string, unknown>) => line({ event_type: { type: 5 }, ...f });

const arm = verdict({ policy_match_type: 2, egress_allowed_by: [AUDIT_POLICY], destination_names: ["management.azure.com"],
  destination: { identity: 16777234, labels: ["fqdn:management.azure.com", "reserved:world"] } });
const bing = verdict({ policy_match_type: 4, egress_allowed_by: [ALLOW_ANY_EGRESS], destination_names: ["www.bing.com"] });
const probe = verdict({ policy_match_type: 1, traffic_direction: "INGRESS", ingress_allowed_by: [LOCALHOST_INGRESS],
  source: { identity: 1, labels: ["reserved:host"] }, destination: POD, l4: { TCP: { source_port: 55592, destination_port: 3000, flags: { SYN: true } } } });
const trace = line({ event_type: { type: 4 }, destination_names: ["management.azure.com"] });

const parse = (...lines: string[]) => parseHubbleJsonOutput(lines.join("\n"));

test("parser keeps the event kind, match type, allowed-by of the flow's direction and DNS names", () => {
  const [a, b, p, t] = parse(arm, bing, probe, trace);
  assert.equal(a!.eventKind, "policy-verdict");
  assert.equal(a!.policyMatch, 2);
  assert.deepEqual(a!.allowedBy, [{ name: "aud-dashboard-baseline-audit", namespace: "aud-dashboard", kind: "CiliumNetworkPolicy" }]);
  assert.deepEqual(a!.destinationNames, ["management.azure.com"]);
  assert.deepEqual(b!.allowedBy, [{ derivedFrom: "allow-any-egress" }]);
  assert.deepEqual(p!.allowedBy, [{ derivedFrom: "allow-localhost-ingress" }], "ingress reads ingress_allowed_by");
  assert.equal(t!.eventKind, "trace");
  assert.equal(t!.policyMatch, undefined, "trace events carry no match — 'policy-verdict:none' in compact output");
});

test("judgement: named policy = allowed when enforced; allow-any only = blocked when enforced; probes stay allowed", () => {
  const [a, b, p, t] = parse(arm, bing, probe, trace);
  assert.deepEqual(policyJudgement(a!), { kind: "policy", policies: ["aud-dashboard/aud-dashboard-baseline-audit"], basis: "allowedBy" });
  assert.deepEqual(policyJudgement(b!), { kind: "auditOnly", policies: [], basis: "allowedBy" });
  assert.equal(policyJudgement(p!).kind, "default");
  assert.deepEqual(policyJudgement(t!), { kind: "unknown", policies: [], basis: "none" }, "trace events are not judged");
});

test("judgement edge cases: named + allow-any, clusterwide, DROPPED, AUDIT, Cilium without allowed-by", () => {
  const [both, ccnp, dropped, audited, old, oldAll, policyDrop] = parse(
    verdict({ policy_match_type: 2, egress_allowed_by: [ALLOW_ANY_EGRESS, AUDIT_POLICY] }),
    verdict({ policy_match_type: 2, egress_allowed_by: [{ name: "egress-azure", kind: "CiliumClusterwideNetworkPolicy", labels: [] }] }),
    verdict({ verdict: "DROPPED", policy_match_type: 0 }),
    verdict({ verdict: "AUDIT", policy_match_type: 0 }),
    verdict({ policy_match_type: 2 }),
    verdict({ policy_match_type: 4 }),
    line({ event_type: { type: 1 }, verdict: "DROPPED", drop_reason_desc: "POLICY_DENIED" }),
  );
  assert.equal(policyJudgement(both!).kind, "policy");
  assert.deepEqual(policyJudgement(ccnp!).policies, ["cluster/egress-azure"]);
  assert.equal(policyJudgement(dropped!).kind, "dropped");
  assert.deepEqual(policyJudgement(audited!), { kind: "auditOnly", policies: [], basis: "verdict" });
  assert.deepEqual(policyJudgement(old!, false), { kind: "policy", policies: [], basis: "estimate" });
  assert.deepEqual(policyJudgement(oldAll!, false), { kind: "auditOnly", policies: [], basis: "estimate" });
  assert.deepEqual(policyJudgement(old!, true), { kind: "unknown", policies: [], basis: "none" }, "agents report allowed-by: a missing one is unknown, not guessed");
  assert.equal(policyJudgement(policyDrop!).kind, "dropped");
});

test("readiness: counts, allowing policies, and the would-be-blocked list by workload, name and port", () => {
  const r = summarizeEnforceReadiness(parse(arm, arm, bing, bing, bing, probe, trace))!;
  assert.equal(r.verdictEvents, 6);
  assert.equal(r.allowedBySupported, true);
  assert.deepEqual(r.counts, { policy: 2, auditOnly: 3, default: 1, dropped: 0, unknown: 0 });
  assert.deepEqual(r.byPolicy, [{ policy: "aud-dashboard/aud-dashboard-baseline-audit", count: 2 }]);
  assert.equal(r.wouldDrop.length, 1);
  assert.deepEqual({ ...r.wouldDrop[0], lastSeen: "" }, {
    direction: "EGRESS", subject: "aud-dashboard/aud-dashboard", peer: "www.bing.com", peerNames: ["www.bing.com"],
    peerIdentity: 2, port: 443, protocol: "TCP", count: 3, lastSeen: "",
  });
  assert.ok(r.oldest && r.newest && r.oldest <= r.newest);
  assert.equal(summarizeEnforceReadiness(parse(trace)), undefined, "no verdict events: no section");
  const old = summarizeEnforceReadiness(parse(verdict({ policy_match_type: 4 }), verdict({ policy_match_type: 2 })))!;
  assert.equal(old.allowedBySupported, false);
  assert.deepEqual(old.counts, { policy: 1, auditOnly: 1, default: 0, dropped: 0, unknown: 0 }, "estimates from the match type");
});

test("de-duplication keeps a policy-verdict event and the trace event of the same packet", () => {
  const same = { IP: { source: "10.0.0.5", destination: "203.0.113.10" }, l4: { TCP: { source_port: 41000, destination_port: 443, flags: { SYN: true } } }, time: "2026-10-23T00:46:00.000Z" };
  const out = dedupeObservations(parse(
    JSON.stringify({ flow: { ...JSON.parse(verdict({ policy_match_type: 4, egress_allowed_by: [ALLOW_ANY_EGRESS] })).flow, ...same } }),
    JSON.stringify({ flow: { ...JSON.parse(trace).flow, ...same } }),
  ));
  assert.deepEqual(out.map((f) => f.eventKind).sort(), ["policy-verdict", "trace"]);
});
