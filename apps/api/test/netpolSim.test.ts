import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetEdge, NetNode, NetworkInsight } from "@aud/types";
import { analyzePolicies, isSystemNamespace, type PolicyInventory } from "../src/services/policyAnalyzer.js";
import { buildNetpolModel, cnpIsolates, normalizeCiliumPolicy, normalizeK8sPolicy } from "../src/services/netpolModel.js";
import * as simMod from "../../web/src/lib/netpolSim.ts";
const S = ((simMod as { default?: typeof simMod }).default ?? simMod) as typeof simMod;

// Synthetic cluster: app/web → app/api (8080), app/api → db/postgres (5432), app/api → kube-dns (udp/53),
// app/api → a Key Vault (443, PE IP), app/web → the Internet (443), node → app/web (kubelet probe)
function inventory(): PolicyInventory {
  const w = (namespace: string, name: string, labels: Record<string, string>) =>
    ({ kind: "Deployment" as const, namespace, name, replicas: 1, podLabels: labels, containers: [], serviceAccountName: name });
  return {
    namespaces: [
      { name: "app", labels: { "kubernetes.io/metadata.name": "app", team: "a" } },
      { name: "db", labels: { "kubernetes.io/metadata.name": "db" } },
      { name: "kube-system", labels: { "kubernetes.io/metadata.name": "kube-system" } },
    ],
    pods: [
      { namespace: "app", name: "web-1", labels: { app: "web" } },
      { namespace: "app", name: "api-1", labels: { app: "api" } },
      { namespace: "db", name: "postgres-0", labels: { app: "postgres" } },
      { namespace: "kube-system", name: "coredns-1", labels: { "k8s-app": "kube-dns" } },
    ],
    workloads: [w("app", "web", { app: "web" }), w("app", "api", { app: "api" }), w("db", "postgres", { app: "postgres" }), w("kube-system", "coredns", { "k8s-app": "kube-dns" })],
    networkPolicies: [
      // db: only app/api on 5432 (client-node shape: `_from`)
      { namespace: "db", name: "allow-api", podSelector: {}, policyTypes: ["Ingress"], ingress: [{ _from: [{ namespaceSelector: { matchLabels: { team: "a" } }, podSelector: { matchLabels: { app: "api" } } }], ports: [{ protocol: "TCP", port: 5432 }] }] },
    ],
    ciliumPolicies: [
      // app egress: an audit policy — rules, but enableDefaultDeny egress false
      { namespace: "app", name: "app-egress-audit", specs: [{ endpointSelector: {}, egress: [{ toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } }], toPorts: [{ ports: [{ port: "53", protocol: "UDP" }], rules: { dns: [{ matchPattern: "*" }] } }] }], enableDefaultDeny: { egress: false } }] },
      // app/api ingress: only from app/web on 8080
      { namespace: "app", name: "api-ingress", specs: [{ endpointSelector: { matchLabels: { app: "api" } }, ingress: [{ fromEndpoints: [{ matchLabels: { app: "web" } }], toPorts: [{ ports: [{ port: "8080", protocol: "TCP" }] }] }] }] },
    ],
    roles: [], bindings: [], hpas: [], vpas: [], pdbs: [], resourceQuotas: [], limitRanges: [],
    capabilities: { vpaInstalled: true, ciliumInstalled: true, unavailable: [] },
  };
}

const node = (id: string, kind: NetNode["kind"], over: Partial<NetNode> = {}): NetNode => ({ id, kind, label: id, sub: "", ...over });
const edge = (from: string, to: string, ports: string[], count = 5, dropped = 0): NetEdge => ({ from, to, ports, count, dropped, cls: "eastwest", serviceTagsMatched: null });
function network(): NetworkInsight {
  return {
    available: true, coverage: null, azureMatched: true, serviceTagsMatched: null,
    nodes: [
      node("app/web", "workload", { namespace: "app" }), node("app/api", "workload", { namespace: "app" }), node("db/postgres", "workload", { namespace: "db" }),
      node("kube-system/coredns", "workload", { namespace: "kube-system" }),
      node("azure:vaults/kv-app", "paas", { host: "kv-app.vault.azure.net", observedIps: ["10.1.2.4"] }),
      node("ext:world", "internet"), node("ext:host", "node"),
    ],
    edges: [
      edge("app/web", "app/api", ["8080"]),
      edge("app/api", "db/postgres", ["5432"]),
      edge("app/api", "kube-system/coredns", ["udp/53"]),
      edge("app/api", "azure:vaults/kv-app", ["443"]),
      edge("app/web", "ext:world", ["443"]),
      edge("ext:host", "app/api", ["8080"]),
      edge("app/web", "db/postgres", ["5432"], 3, 3), // Hubble saw this dropped
    ],
    unmatchedExternal: [{ ip: "203.0.113.10", ports: [443], count: 5, dropped: 0, from: ["app/web"], names: ["api.example.com"] }],
    privateExternal: [],
  };
}

test("netpol model: Kubernetes `_from`, Cilium enableDefaultDeny / toPorts / L7 / entities / FQDN / CIDR / deny", () => {
  const k = normalizeK8sPolicy({ namespace: "db", name: "x", podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [{ _from: [{ ipBlock: { cidr: "10.0.0.0/8", _except: ["10.9.0.0/16"] } }] }], egress: [{}] });
  assert.deepEqual(k.ingress!.rules[0]!.peers, [{ kind: "cidr", cidr: "10.0.0.0/8", except: ["10.9.0.0/16"] }]);
  assert.deepEqual(k.egress!.rules[0]!.peers, [{ kind: "any" }], "an empty rule = every peer");
  assert.equal(normalizeK8sPolicy({ namespace: "n", name: "y", podSelector: {}, egress: [{}] }).egress?.isolates, true, "no policyTypes + egress rules = Egress");
  const [c] = normalizeCiliumPolicy({ namespace: "n", name: "c", specs: [{ endpointSelector: {}, enableDefaultDeny: { egress: false },
    egress: [{ toEntities: ["world"], toFQDNs: [{ matchPattern: "*.example.com" }], toCIDRSet: [{ cidr: "0.0.0.0/0", except: ["10.0.0.0/8"] }], toPorts: [{ ports: [{ port: "443", protocol: "TCP" }], rules: { http: [{}] } }] }, { toServices: [{}] }],
    ingressDeny: [{ fromEntities: ["world"] }] }] });
  assert.equal(c!.egress!.isolates, false, "enableDefaultDeny egress false = audit");
  assert.equal(c!.ingress!.isolates, true, "a deny-only ingress still isolates by default");
  assert.deepEqual(c!.egress!.rules[0]!.peers.map((p) => p.kind), ["cidr", "entity", "fqdn"]);
  assert.equal(c!.egress!.rules[0]!.l7, true);
  assert.deepEqual(c!.egress!.rules[1]!.unsupported, ["toServices"]);
  assert.equal(c!.ingress!.rules[0]!.deny, true);
  assert.equal(cnpIsolates({ ingress: [] }, "ingress"), true);
  assert.equal(cnpIsolates({ ingress: [], enableDefaultDeny: { ingress: false } }, "ingress"), false);
  assert.equal(cnpIsolates({ egress: [] }, "ingress"), false);
});

test("analyzer: an audit Cilium policy (enableDefaultDeny false) is not isolation — badge 'nonEnforcing', insights 'no egress limit' stays", () => {
  const r = analyzePolicies(inventory(), "c1");
  const app = r.namespaces.find((n) => n.name === "app")!;
  assert.equal(app.networkPolicy.egressIsolatedPods, 0, "rules present but enableDefaultDeny egress false — nothing isolated (was 2)");
  assert.equal(app.networkPolicy.ingressIsolatedPods, 1, "api-ingress isolates app/api ingress only");
  assert.deepEqual(r.networkPolicies.find((p) => p.name === "app-egress-audit")!.nonEnforcing, ["Egress"]);
  assert.ok(r.netpol && r.netpol.policies.length === 3 && r.netpol.workloads.find((w) => w.id === "app/api")!.serviceAccount === "api");
});

test("simulation: deployed verdicts with reasons; Hubble's drop agrees; what is unknown stays unknown", () => {
  const model = buildNetpolModel(inventory(), (ns) => isSystemNamespace(ns));
  const sim = S.simulate(model, network(), [], { includeSystem: true });
  const by = (f: string, t: string) => sim.edges.find((x) => x.edge.from === f && x.edge.to === t)!;
  assert.equal(by("app/web", "app/api").before, "allow");
  assert.equal(by("app/web", "app/api").ports[0]!.before.ingress!.reason, "allowed");
  assert.deepEqual(by("app/web", "app/api").ports[0]!.before.ingress!.by, ["cilium:app/api-ingress"]);
  assert.equal(by("app/api", "db/postgres").before, "allow", "namespaceSelector (team=a) + podSelector");
  assert.equal(by("app/web", "db/postgres").before, "deny");
  assert.equal(by("app/web", "db/postgres").ports[0]!.before.ingress!.reason, "noRule");
  assert.equal(by("app/web", "db/postgres").mismatch, false, "the model's deny = Hubble's drop");
  assert.equal(by("ext:host", "app/api").ports[0]!.before.ingress!.reason, "hostAlways", "kubelet probes always reach");
  assert.equal(by("app/api", "azure:vaults/kv-app").ports[0]!.before.egress!.reason, "notIsolated", "audit egress isolates nothing");
  assert.equal(sim.counts.mismatch, 0);
  const iso = sim.isolation.find((r) => r.namespace === "app")!;
  assert.deepEqual([iso.ingress, iso.egress], [[1, 1], [0, 0]]);
});

test("what-if: enforcing the audit egress policy breaks what it doesn't list; DNS stays; allow-observed repairs it; matrix marks the breaks", () => {
  const model = buildNetpolModel(inventory(), (ns) => isSystemNamespace(ns));
  const net = network();
  const enforce = S.simulate(model, net, [{ op: "enforce", policyId: "cilium:app/app-egress-audit" }], { includeSystem: true });
  const by = (sim: ReturnType<typeof S.simulate>, f: string, t: string) => sim.edges.find((x) => x.edge.from === f && x.edge.to === t)!;
  assert.equal(by(enforce, "app/api", "kube-system/coredns").after, "allow", "the policy's own DNS rule");
  assert.deepEqual(by(enforce, "app/api", "db/postgres").broken, ["5432"]);
  assert.deepEqual(by(enforce, "app/web", "ext:world").broken, ["443"]);
  assert.equal(by(enforce, "app/api", "db/postgres").ports[0]!.after.egress!.reason, "noRule");
  assert.deepEqual(enforce.isolation.find((r) => r.namespace === "app")!.egress, [0, 2], "egress isolation 0 → 2 workloads");
  const m = S.matrixOf(model, net, enforce);
  assert.ok(m.cells.get("ns:app|ns:db")!.broken === 1 && m.cells.get("ns:app|internet")!.broken === 1);
  assert.ok(m.rows[0]!.startsWith("ns:") && m.cols.includes("paas"));

  // Default-deny egress + allow what was observed = nothing that passed today breaks; the dropped one stays dropped
  const draft = S.simulate(model, net, [{ op: "denyAll", namespace: "app", dir: "egress" }, { op: "allowObserved", namespace: "app", dir: "egress" }], { includeSystem: true });
  assert.equal(draft.counts.broken, 0);
  assert.equal(by(draft, "app/web", "ext:world").after, "allow", "the observed Internet IP is allowed by /32");
  // Default-deny egress alone breaks DNS; adding the DNS allow fixes only DNS
  const deny = S.simulate(model, net, [{ op: "denyAll", namespace: "app", dir: "egress" }, { op: "allowDns", namespace: "app" }], { includeSystem: true });
  assert.equal(by(deny, "app/api", "kube-system/coredns").after, "allow");
  assert.equal(by(deny, "app/api", "azure:vaults/kv-app").after, "deny");
  // Turning a policy off opens what it blocked
  const off = S.simulate(model, net, [{ op: "off", policyId: "kubernetes:db/allow-api" }], { includeSystem: true });
  assert.deepEqual(by(off, "app/web", "db/postgres").opened, ["5432"]);
  assert.equal(S.changeKey({ op: "denyAll", namespace: "app", dir: "egress" }), "denyAll:app:egress");
});

test("matching details: CIDR except, FQDN pattern, named ports and unread labels answer unknown — never allow or deny", () => {
  assert.equal(S.inCidr("10.1.2.4", "10.0.0.0/8"), true);
  assert.equal(S.inCidr("192.168.1.1", "10.0.0.0/8"), false);
  assert.equal(S.inCidr("x", "10.0.0.0/8"), null);
  assert.deepEqual(S.parsePort("udp/53"), { protocol: "UDP", port: 53 });
  assert.deepEqual(S.parsePort("443"), { protocol: "TCP", port: 443 });
  const model = buildNetpolModel(inventory(), (ns) => isSystemNamespace(ns));
  model.policies.push({ id: "cilium:app/egress", source: "cilium", name: "egress", namespace: "app", selector: { matchLabels: { app: "web" } },
    ingress: null, egress: { isolates: true, rules: [{ peers: [{ kind: "fqdn", pattern: "*.example.com" }], ports: [] }, { peers: [{ kind: "cidr", cidr: "0.0.0.0/0", except: ["203.0.113.0/24"] }], ports: [{ protocol: "TCP", port: "https" }] }] } });
  const sim = S.simulate(model, network(), [], { includeSystem: true });
  const world = sim.edges.find((x) => x.edge.to === "ext:world")!;
  assert.equal(world.before, "allow", "the DNS name Cilium saw matches *.example.com");
  assert.deepEqual(world.ports[0]!.before.egress!.by, ["cilium:app/egress"]);
  const api = sim.edges.find((x) => x.edge.from === "app/web" && x.edge.to === "app/api")!;
  assert.equal(api.before, "deny", "web egress is now isolated and nothing allows app/api");
  // A pod the model has no labels for: the selection is unknown
  const net = network();
  net.nodes.push(node("app/job-x", "workload", { namespace: "app" }));
  net.edges.push(edge("app/job-x", "ext:world", ["443"]));
  const job = S.simulate(model, net, [], { includeSystem: true }).edges.find((x) => x.edge.from === "app/job-x")!;
  assert.equal(job.before, "unknown");
  assert.equal(job.ports[0]!.before.egress!.reason, "unknownSelection");
});
