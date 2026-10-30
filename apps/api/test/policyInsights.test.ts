import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubbleFlow, HubbleFlowSet } from "@aud/types";
import { analyzePolicies, type InvWorkload, type PolicyInventory } from "../src/services/policyAnalyzer.js";
import {
  buildPolicyInsights,
  combosOf,
  parseImage,
  pickAzureEndpoint,
  rbacRiskKeys,
  type AzureEndpoint,
  type InsightsInput,
} from "../src/services/policyInsights.js";

const CLUSTER = "/subscriptions/x/resourcegroups/rg-aks/providers/microsoft.containerservice/managedclusters/aks1";

function workload(ns: string, name: string, over: Partial<InvWorkload> = {}): InvWorkload {
  return {
    kind: "Deployment", namespace: ns, name, replicas: 2, podLabels: { app: name }, serviceAccountName: name,
    containers: [{ name, requests: { cpu: "10m", memory: "10Mi" }, limits: { memory: "20Mi" } }],
    labels: {},
    security: { hostNetwork: false, hostPID: false, hostIPC: false, hostPaths: [], usesSecrets: false, containers: [{ name, image: `docker.io/acme/${name}:1.0`, init: false, capAdd: [] }] },
    ...over,
  };
}

function inventory(): PolicyInventory {
  return {
    namespaces: [{ name: "app", labels: {} }, { name: "obs", labels: { "pod-security.kubernetes.io/enforce": "baseline" } }, { name: "kube-system", labels: {} }],
    pods: [{ namespace: "app", name: "web-abc", labels: { app: "web" }, phase: "Running" }],
    workloads: [
      // web: root + secret + no egress policy → with observed external egress = exfil
      workload("app", "web", { security: { hostNetwork: false, hostPID: false, hostIPC: false, hostPaths: [], usesSecrets: true, containers: [{ name: "web", image: "acr.azurecr.io/web:1.2-SNAPSHOT", init: false, capAdd: [] }] } }),
      // agent: nodes/proxy + runs as root → takeover
      workload("obs", "agent", { kind: "DaemonSet", replicas: 3 }),
      // locked: non-root, no escalation, automount off
      workload("obs", "locked", { automountServiceAccountToken: false, security: { hostNetwork: false, hostPID: false, hostIPC: false, hostPaths: [], usesSecrets: false, runAsNonRoot: true, containers: [{ name: "locked", image: "registry.k8s.io/locked@sha256:abc", init: false, allowPrivilegeEscalation: false, capAdd: [] }] } }),
      // AKS add-on
      workload("kube-system", "coredns", { labels: { "kubernetes.azure.com/managedby": "aks" } }),
      // scaled to zero → not a row
      workload("app", "idle", { replicas: 0 }),
    ],
    networkPolicies: [{ namespace: "app", name: "web-in", podSelector: { matchLabels: { app: "web" } }, policyTypes: ["Ingress"] }],
    ciliumPolicies: [],
    roles: [
      { kind: "ClusterRole", name: "agent", labels: {}, rules: [{ apiGroups: [""], resources: ["nodes", "nodes/proxy"], verbs: ["get", "list"] }], aggregated: false },
      { kind: "ClusterRole", name: "cluster-admin", labels: {}, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], aggregated: false },
    ],
    bindings: [
      { kind: "ClusterRoleBinding", name: "agent", labels: {}, roleRef: { kind: "ClusterRole", name: "agent" }, subjects: [{ kind: "ServiceAccount", name: "agent", namespace: "obs" }] },
      { kind: "ClusterRoleBinding", name: "aks-cluster-admin-binding", labels: {}, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "User", name: "clusterAdmin" }] },
    ],
    hpas: [], vpas: [], pdbs: [], resourceQuotas: [], limitRanges: [],
    capabilities: { vpaInstalled: false, ciliumInstalled: true, unavailable: [] },
    services: [{ namespace: "app", name: "web", type: "ClusterIP", selector: { app: "web" }, internal: false, ports: ["8080/TCP"] }],
    routes: [],
    nodes: [{ name: "n1", pool: "p1", vmSize: "D2", osImage: "Ubuntu", kernel: "5.15", runtime: "containerd://1.7", kubelet: "v1.33.8", nodeImage: "img-1" }],
  };
}

const ep = (namespace: string, podName: string, labels: Record<string, string>, workloadName = podName, identity = 1000) =>
  ({ namespace, podName, labels, identity, workloadName });
const world = { namespace: "", podName: "", labels: { "reserved:world": "" }, identity: 2, workloadName: "world" };

function flow(src: HubbleFlow["source"], dst: HubbleFlow["destination"], dport: number, over: Partial<HubbleFlow> = {}): HubbleFlow {
  return { time: "2026-10-12T00:00:00Z", source: src, destination: dst, verdict: "FORWARDED", type: "L3_L4", l4Protocol: "TCP", sourcePort: 40000, destinationPort: dport, trafficDirection: "EGRESS", dropReasonDesc: "", isReply: false, nodeName: "n1", summary: "", ...over };
}

const STORAGE_IP = "20.150.4.36";
const endpoints: AzureEndpoint[] = [
  { name: "psql-app", type: "flexibleservers", typeLabel: "PostgreSQL", resourceGroup: "rg-aks", host: "psql-app.postgres.database.azure.com", publicAccess: "Enabled", ips: ["20.194.59.86"] },
  { name: "stprodother", type: "storageaccounts", typeLabel: "Storage", resourceGroup: "rg-prod", host: "stprodother.blob.core.windows.net", publicAccess: "Enabled", ips: [STORAGE_IP] },
  { name: "stagentdata", type: "storageaccounts", typeLabel: "Storage", resourceGroup: "rg-aks", host: "stagentdata.blob.core.windows.net", publicAccess: "Enabled", ips: [STORAGE_IP] },
];

function input(flows: HubbleFlow[] | null, over: Partial<InsightsInput> = {}): InsightsInput {
  const inv = inventory();
  const set: HubbleFlowSet | null = flows ? { flows, coverage: { source: "agents", nodesObserved: 1, nodesTotal: 1, nodes: [], commonSince: null, newest: null, commonWindowMinutes: 1, rawEvents: flows.length, duplicatesRemoved: 0 } } : null;
  return {
    clusterId: CLUSTER, inventory: inv, policy: analyzePolicies(inv, CLUSTER), flows: set,
    azure: { available: true, endpoints, apiServerIps: ["20.200.245.7"] },
    containment: { subscription: "sub-name", resourceGroup: "rg-aks", cluster: { name: "aks1", location: "koreacentral", k8sVersion: "1.33.8", nodes: 1, privateCluster: false, authorizedIpRanges: 0, localAccounts: true, entraIntegrated: false, azureRbac: false, outboundType: "loadBalancer" }, resources: [] },
    gaps: [], now: new Date("2026-10-12T00:00:00Z"),
    ...over,
  };
}

const FLOWS = [
  flow(ep("app", "web-abc", { "k8s:app": "web" }), world, 5432, { destinationIp: "20.194.59.86" }),
  // post-SNAT copy: no pod name, identity labels only
  flow({ namespace: "app", podName: "", labels: { "k8s:app": "web", "k8s:io.kubernetes.pod.namespace": "app" }, identity: 1000, workloadName: "web" }, world, 5432, { destinationIp: "20.194.59.86" }),
  flow(ep("obs", "agent-x", { "k8s:app": "agent" }), world, 443, { destinationIp: STORAGE_IP }),
  flow(ep("obs", "agent-x", { "k8s:app": "agent" }), world, 443, { destinationIp: "20.200.245.7" }),
  flow(ep("obs", "agent-x", { "k8s:app": "agent" }), world, 443, { destinationIp: "20.41.67.112" }),
  flow({ namespace: "", podName: "", labels: {}, identity: 2, workloadName: "world" }, ep("app", "web-abc", { "k8s:app": "web" }), 8080, { sourceIp: "168.63.129.16" }),
  flow(ep("app", "web-abc", { "k8s:app": "web" }), ep("obs", "agent-x", { "k8s:app": "agent" }), 4318),
  // replies never become edges
  flow(ep("obs", "agent-x", { "k8s:app": "agent" }), ep("app", "web-abc", { "k8s:app": "web" }), 40000, { isReply: true }),
];

test("rbacRiskKeys: cluster-admin stands alone; exec via get only is conditional", () => {
  const admin = rbacRiskKeys([{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], "cluster-admin");
  assert.deepEqual(admin.keys, ["clusterAdmin"]);
  const reader = rbacRiskKeys([{ apiGroups: ["*"], resources: ["*"], verbs: ["get", "list", "watch"] }], "reader");
  assert.ok(reader.keys.includes("nodesProxy") && reader.keys.includes("secrets") && reader.keys.includes("wildcard"));
  assert.deepEqual(reader.conditional, ["exec"]);
  const execer = rbacRiskKeys([{ resources: ["pods/exec"], verbs: ["create"] }, { resources: ["pods/exec"], verbs: ["get"] }], "x");
  assert.deepEqual(execer.conditional, []);
  // resourceNames-scoped rules are not broad grants
  assert.deepEqual(rbacRiskKeys([{ resources: ["secrets"], verbs: ["get"], resourceNames: ["one"] }], "x").keys, []);
});

test("parseImage handles registry, tag, digest and docker.io default", () => {
  assert.deepEqual(parseImage("grafana/alloy:v1.11.1"), { repo: "grafana/alloy", registry: "docker.io", tag: "v1.11.1", digest: false });
  assert.deepEqual(parseImage("mcr.microsoft.com/oss/kube:v1"), { repo: "mcr.microsoft.com/oss/kube", registry: "mcr.microsoft.com", tag: "v1", digest: false });
  assert.equal(parseImage("localhost:5000/app:dev").registry, "localhost:5000");
  assert.equal(parseImage("registry.k8s.io/x@sha256:abc").digest, true);
  assert.equal(parseImage("nginx").tag, "latest");
});

test("combosOf: each combination needs all of its factors", () => {
  assert.deepEqual(combosOf({ secret: "x", noEgress: "x" }, {}).map((c) => c.type), []);
  assert.deepEqual(combosOf({ secret: "x", noEgress: "x", extEgress: "x" }, {}).map((c) => c.type), ["exfil"]);
  assert.deepEqual(combosOf({ highRbac: "x", automount: "x", root: "x" }, { highRbac: "crit" }).map((c) => c.type), ["takeover"]);
  assert.deepEqual(combosOf({ highRbac: "x", automount: "x", root: "x" }, { highRbac: "warn" }).map((c) => c.type), ["standing"]);
  assert.deepEqual(combosOf({ exposure: "x", noIngress: "x" }, {}).map((c) => c.type), ["vnet"]);
});

test("pickAzureEndpoint: shared front-end IP prefers the cluster RG and the caller's name", () => {
  const shared = endpoints.filter((e) => e.ips.includes(STORAGE_IP));
  assert.equal(pickAzureEndpoint(shared, "rg-aks", "obs/agent")?.name, "stagentdata");
  assert.equal(pickAzureEndpoint(shared, "rg-other", "obs/agent")?.name, "stagentdata");
  assert.equal(pickAzureEndpoint([shared[0]!], "rg-aks", undefined)?.name, "stprodother");
});

test("rows: factors from pod spec, policies and RBAC; replicas 0 skipped; managed flagged", () => {
  const r = buildPolicyInsights(input(FLOWS));
  const ids = r.rows.map((x) => x.id);
  assert.ok(!ids.includes("app/idle"));
  const web = r.rows.find((x) => x.id === "app/web")!;
  assert.equal(web.cells.noIngress, undefined, "web-in selects web");
  assert.ok(web.cells.noEgress && web.cells.secret && web.cells.root && web.cells.privEsc && web.cells.psa);
  assert.match(web.cells.extEgress!, /psql-app 5432 ×2/);
  const agent = r.rows.find((x) => x.id === "obs/agent")!;
  assert.match(agent.cells.highRbac!, /nodes\/proxy/);
  assert.equal(agent.weights.highRbac, "crit");
  assert.equal(agent.cells.psa, undefined, "obs enforces baseline");
  const locked = r.rows.find((x) => x.id === "obs/locked")!;
  assert.equal(locked.cells.root, undefined);
  assert.equal(locked.cells.privEsc, undefined);
  assert.equal(locked.cells.automount, undefined);
  assert.equal(r.rows.find((x) => x.id === "kube-system/coredns")!.managed, true);
});

test("network: label-matched workloads, SNAT copies merged, replies dropped, platform classified", () => {
  const n = buildPolicyInsights(input(FLOWS)).network;
  assert.equal(n.available, true);
  const e = (from: string, to: string) => n.edges.find((x) => x.from === from && x.to === to);
  assert.equal(e("app/web", "azure:flexibleservers/psql-app")?.count, 2, "pod + post-SNAT copy resolve to one workload");
  assert.equal(e("app/web", "azure:flexibleservers/psql-app")?.cls, "cloud");
  assert.ok(e("obs/agent", "azure:storageaccounts/stagentdata"), "shared IP resolved by RG + name");
  assert.equal(e("obs/agent", "apiserver")?.cls, "control");
  assert.equal(e("obs/agent", "ext:world")?.cls, "internet");
  assert.equal(e("probe:lb", "app/web")?.cls, "platform");
  assert.equal(e("app/web", "obs/agent")?.cls, "eastwest");
  assert.equal(e("obs/agent", "app/web"), undefined, "reply is not an edge");
  assert.deepEqual(n.unmatchedExternal.map((u) => u.ip), ["20.41.67.112"]);
  const st = n.nodes.find((x) => x.id === "azure:storageaccounts/stagentdata")!;
  assert.deepEqual(st.sharedIpWith, ["stprodother"]);
});

test("issues: combos link to generated issues; finding ids exist; actions reference real edges", () => {
  const r = buildPolicyInsights(input(FLOWS));
  const kinds = r.issues.map((i) => i.id);
  assert.deepEqual(kinds, ["local-accounts", "exfil:app/web", "takeover:obs/agent"]);
  for (const row of r.rows) for (const c of row.combos) if (!row.managed) assert.ok(c.issueId && kinds.includes(c.issueId), `${row.id} ${c.type} linked`);
  const fids = new Set(r.rows.length ? buildPolicyInsights(input(FLOWS)).issues.flatMap((i) => i.findingIds) : []);
  const all = new Set(analyzePolicies(inventory(), CLUSTER).findings.map((f) => f.id));
  for (const f of fids) assert.ok(all.has(f), `finding ${f} exists`);
  for (const i of r.issues) {
    const nodeIds = new Set(i.nodes.map((n) => n.id));
    for (const ed of i.edges) assert.ok(nodeIds.has(ed.from) && nodeIds.has(ed.to), `${i.id} edge ${ed.from}>${ed.to}`);
    const actIds = new Set(i.actions.map((a) => a.id));
    for (const ed of i.edges) if (ed.cut) assert.ok(actIds.has(ed.cut), `${i.id} cut ${ed.cut}`);
    for (const a of i.actions) for (const cut of a.cuts) assert.ok(i.edges.some((ed) => `${ed.from}>${ed.to}` === cut), `${i.id} ${a.id} cuts ${cut}`);
  }
  const exfil = r.issues.find((i) => i.id === "exfil:app/web")!;
  assert.ok(exfil.nodes.some((n) => n.label === "psql-app" && n.type === "azure"));
  assert.ok(exfil.actions.some((a) => a.code.includes("psql-app.postgres.database.azure.com")), "FQDN policy uses the matched host");
});

test("no Hubble: network unavailable with reason, no observed factor, no exfil invented", () => {
  const r = buildPolicyInsights(input(null, { flowsError: "HUBBLE_ENABLED=false" }));
  assert.equal(r.network.available, false);
  assert.equal(r.network.reason, "HUBBLE_ENABLED=false");
  assert.ok(r.rows.every((x) => !x.cells.extEgress));
  assert.ok(!r.issues.some((i) => i.kind === "exfil"));
});

test("unknown values stay unknown: no local-accounts issue when ARM was not readable", () => {
  const base = input(FLOWS);
  const r = buildPolicyInsights({ ...base, containment: { ...base.containment, cluster: { ...base.containment.cluster, localAccounts: null, entraIntegrated: null } } });
  assert.ok(!r.issues.some((i) => i.kind === "local"));
});

test("KBOM: registries, snapshot tag, digest pinning, platform rows", () => {
  const k = buildPolicyInsights(input(FLOWS)).kbom;
  assert.ok(k.items.find((i) => i.repo === "acr.azurecr.io/web")!.flags.some((f) => f.key === "snapshot"));
  assert.ok(k.items.find((i) => i.repo === "docker.io/acme/agent")!.flags.some((f) => f.key === "public"));
  assert.equal(k.summary.digestPinned, 1);
  assert.equal(k.platform.find((p) => p.label === "kubelet")!.note, "컨트롤 플레인과 일치");
});

test("lang: English responses carry no Korean text; Korean stays the default", async () => {
  const { withLang } = await import("../src/infra/lang.js");
  const HANGUL = /[가-힣]/;
  const en = withLang("en", () => buildPolicyInsights({ ...input(FLOWS), policy: withLang("en", () => analyzePolicies(inventory(), CLUSTER)) }));
  const text = JSON.stringify(en);
  assert.ok(!HANGUL.test(text), `Korean left in the English response: ${text.match(/.{0,40}[가-힣]+.{0,40}/)?.[0]}`);
  assert.ok(en.issues.length > 0 && en.factors.length > 0, "fixture produces issues and factors");
  // Default (no withLang) is Korean, and the language does not leak out of withLang
  assert.ok(HANGUL.test(JSON.stringify(buildPolicyInsights(input(FLOWS)).factors)));
  assert.ok(HANGUL.test(JSON.stringify(analyzePolicies(inventory(), CLUSTER).findings)));
  assert.throws(() => withLang("en", (async () => 1) as unknown as () => number), /synchronous/);
});

// ── PaaS path vs exposure, service tags, private ranges, dropped attempts (2026-10-28 stg verification, synthetic) ──
// The summary said "public access on → traffic leaves over public IPs" from the setting alone; the cluster really
// reached every PaaS on a Private Endpoint IP. Mongo vCore showed as "unmatched", Microsoft service IPs as unknown,
// a private on-premises IP as Internet egress, and a policy-dropped attempt as egress.
test("network: path from the observed IP, PE NIC match, service tags, private ranges, dropped attempts are not egress", async () => {
  const { buildServiceTagIndex } = await import("../src/services/azureServiceTags.js");
  const tags = buildServiceTagIndex([
    { name: "AzureCloud.koreacentral", properties: { region: "koreacentral", addressPrefixes: ["198.51.100.0/24", "203.0.113.0/24"] } },
    { name: "AzureActiveDirectory", properties: { addressPrefixes: ["198.51.100.128/25"] } },
  ]);
  const eps: AzureEndpoint[] = [
    { name: "psql-app", type: "flexibleservers", armType: "microsoft.dbforpostgresql/flexibleservers", typeLabel: "PostgreSQL", resourceGroup: "rg-aks", host: "psql-app.postgres.database.azure.com", publicAccess: "Enabled", ips: ["10.0.3.5"], peIps: ["10.0.3.5"], network: { defaultAction: "Deny", ipRules: 2, vnetRules: null, source: "firewallRules" }, keyAuth: null },
    // PE only, no host (vCore connection string not readable) — still identified by its PE NIC IP
    { name: "mongo-app", type: "mongoclusters", armType: "microsoft.documentdb/mongoclusters", typeLabel: "Cosmos DB for MongoDB (vCore)", resourceGroup: "rg-aks", host: "", publicAccess: "Disabled", ips: ["10.0.3.6"], peIps: ["10.0.3.6"], network: null, keyAuth: null },
    { name: "redis-app", type: "redisenterprise", armType: "microsoft.cache/redisenterprise", typeLabel: "Azure Managed Redis", resourceGroup: "rg-aks", host: "redis-app.koreacentral.redis.azure.net", publicAccess: "Enabled", ips: ["10.0.3.4"], peIps: ["10.0.3.4"], network: { defaultAction: "Allow", ipRules: null, vnetRules: null, noIpFirewall: true, source: "Azure Managed Redis" }, keyAuth: "on" },
  ];
  const web = ep("app", "web-abc", { "k8s:app": "web" });
  const agent = ep("obs", "agent-x", { "k8s:app": "agent" });
  const flows = [
    flow(web, world, 5432, { destinationIp: "10.0.3.5" }),
    flow(web, world, 10260, { destinationIp: "10.0.3.6" }),
    flow(web, world, 10000, { destinationIp: "10.0.3.4" }),
    flow(web, world, 22, { destinationIp: "192.168.6.10" }),
    flow(web, world, 443, { destinationIp: "198.51.100.130" }),
    flow(agent, world, 443, { destinationIp: "198.51.100.7" }),
    // anonymous usage report blocked by policy: an attempt, not egress
    flow(agent, world, 443, { destinationIp: "192.0.2.50", verdict: "DROPPED", destinationNames: ["stats.example.org"] }),
    flow(agent, world, 443, { destinationIp: "192.0.2.50", verdict: "DROPPED" }),
  ];
  const r = buildPolicyInsights(input(flows, { azure: { available: true, endpoints: eps, apiServerIps: [], serviceTags: tags } }));
  const n = r.network;
  const node = (id: string) => n.nodes.find((x) => x.id === id)!;
  const psql = node("azure:flexibleservers/psql-app");
  assert.equal(psql.path, "private");
  assert.deepEqual(psql.matchedBy, ["peIp"]);
  assert.equal(psql.exposure, "restricted");
  assert.equal(node("azure:mongoclusters/mongo-app").path, "private", "Mongo vCore found by its PE NIC IP");
  assert.equal(node("azure:mongoclusters/mongo-app").exposure, "closed");
  const redis = node("azure:redisenterprise/redis-app");
  assert.equal(redis.exposure, "open", "no IP firewall + public access on = any address, even though the cluster uses the PE");
  assert.equal(redis.path, "private");
  assert.equal(node("svc:AzureActiveDirectory").kind, "azureService", "a named service beats AzureCloud");
  assert.equal(node("svc:AzureCloud").kind, "azureService");
  assert.equal(n.edges.find((e) => e.to === "ext:private")?.cls, "private");
  assert.deepEqual(n.privateExternal.map((u) => u.ip), ["192.168.6.10"]);
  assert.deepEqual(n.unmatchedExternal.map((u) => [u.ip, u.count, u.dropped, u.names]), [["192.0.2.50", 2, 2, ["stats.example.org"]]]);
  assert.equal(n.serviceTagsMatched, true);
  // agent's unmatched destination was only dropped; the AzureCloud one did leave
  assert.doesNotMatch(r.rows.find((x) => x.id === "obs/agent")!.cells.extEgress ?? "", /192\.0\.2\.50|미식별/);
  // every PaaS path is private → no "move to a Private Endpoint" action, no "public" on the path
  const exfil = r.issues.find((i) => i.id === "exfil:app/web");
  assert.ok(exfil, "web still has an exfil path (secret + no egress policy + egress)");
  assert.ok(!exfil.actions.some((a) => a.id.endsWith(":pe")));
  assert.ok(!exfil.edges.some((e) => /공인 IP|공용 주소/.test(e.label ?? "")));
  assert.ok(exfil.edges.some((e) => /사설 IP\(PE\)/.test(e.label ?? "")));
});

test("network: a PaaS reached on its public address keeps the Private Endpoint suggestion with the observed IP", () => {
  const r = buildPolicyInsights(input(FLOWS));
  const psql = r.network.nodes.find((x) => x.id === "azure:flexibleservers/psql-app")!;
  assert.equal(psql.path, "public");
  assert.deepEqual(psql.matchedBy, ["dnsLookup"]);
  assert.equal(psql.exposure, "unknown", "rules not read → unverified, not open");
  const pe = r.issues.find((i) => i.id === "exfil:app/web")!.actions.find((a) => a.id.endsWith(":pe"))!;
  assert.match(pe.desc, /20\.194\.59\.86/);
  assert.equal(r.network.serviceTagsMatched, null, "not attempted");
});

test("standing privilege: split by the heatmap's grade, riskiest first, every account listed, shared permission nodes, '+n' never silent", () => {
  const inv = inventory();
  const hardened = (name: string) => workload("argo", name, { security: { hostNetwork: false, hostPID: false, hostIPC: false, hostPaths: [], usesSecrets: false, runAsNonRoot: true,
    containers: [{ name, image: `registry.example/argo/${name}:1.0`, init: false, allowPrivilegeEscalation: false, capAdd: [] }] } });
  const readers = Array.from({ length: 10 }, (_, i) => `reader-${String(i).padStart(2, "0")}`);
  inv.namespaces.push({ name: "argo", labels: { "pod-security.kubernetes.io/enforce": "restricted" } });
  inv.workloads.push(...["app-controller", "server", "webhooker", ...readers].map(hardened));
  inv.roles.push(
    { kind: "ClusterRole", name: "secret-reader", labels: {}, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "watch"] }], aggregated: false },
    { kind: "ClusterRole", name: "webhooks", labels: {}, rules: [{ apiGroups: ["admissionregistration.k8s.io"], resources: ["mutatingwebhookconfigurations"], verbs: ["create", "update", "patch"] }], aggregated: false },
  );
  const crb = (name: string, role: string) => ({ kind: "ClusterRoleBinding" as const, name, labels: {}, roleRef: { kind: "ClusterRole", name: role }, subjects: [{ kind: "ServiceAccount", name, namespace: "argo" }] });
  inv.bindings.push(crb("app-controller", "cluster-admin"), crb("server", "cluster-admin"), crb("webhooker", "webhooks"), ...readers.map((r) => crb(r, "secret-reader")));
  const r = buildPolicyInsights({ ...input(FLOWS), inventory: inv, policy: analyzePolicies(inv, CLUSTER) });

  const crit = r.issues.find((i) => i.id === "standing:crit")!;
  const warn = r.issues.find((i) => i.id === "standing")!;
  assert.equal(crit.sev, "crit", "a cluster-admin token is not 'caution'");
  assert.equal(warn.sev, "warn");
  assert.deepEqual(crit.members!.map((m) => m.name), ["app-controller", "server", "webhooker"], "riskiest first (most crit permissions), then name");
  assert.equal(warn.members!.length, 10, "every account is a member — none dropped");
  assert.ok(crit.title.length < 120 && !crit.title.includes("app-controller"), "the title is one line; names live in the members table");
  // Every standing row points at the issue that lists it, with the heatmap's grade
  for (const row of r.rows.filter((x) => x.combos.some((c) => c.type === "standing"))) {
    const issue = r.issues.find((i) => i.id === row.combos.find((c) => c.type === "standing")!.issueId)!;
    assert.ok(issue.members!.some((m) => m.rowId === row.id), row.name);
    assert.equal(issue.sev, row.weights.highRbac === "crit" ? "crit" : "warn", `${row.name}: same grade as the heatmap`);
  }
  // Graph: 8 accounts drawn + one "+2" node that names the rest; 10 Secret readers share one permission node
  const drawn = warn.nodes.filter((n) => n.type === "workload");
  assert.equal(drawn.length, 9);
  const more = drawn.find((n) => n.id === "more")!;
  assert.match(more.label, /2/);
  assert.equal(more.facts.length, 2);
  assert.equal(warn.nodes.filter((n) => n.col === 3).length, 1, "one shared permission node");
  assert.equal(crit.nodes.filter((n) => n.col === 3).length, 2, "cluster-admin ×2 share a node, webhook has its own");
  assert.equal(crit.nodes.find((n) => n.type === "impact")!.label, "클러스터 전체");
  // Each drawn account has its cut on a real edge; every member (drawn or not) has an action
  const keys = new Set(warn.edges.map((e) => `${e.from}>${e.to}`));
  for (const a of warn.actions) for (const c of a.cuts) assert.ok(keys.has(c), c);
  assert.equal(warn.actions.length, 10);
  assert.equal(warn.edges.filter((e) => e.cut).length, 8);
});

test("path header: four facts (who · reaches · cuts · evidence) and an evidence line that names its unit (links)", async () => {
  const { issueGlance, insightLabels } = await import("../../web/src/app/policies/insights/model.ts");
  const { MODULES } = await import("../../web/src/lib/i18nMessages.ts");
  const all = Object.assign({}, ...Object.values(MODULES)) as Record<string, { ko: string }>;
  const t = (key: string, vars: Record<string, string | number> = {}) =>
    (all[key]?.ko ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
  const r = buildPolicyInsights(input(FLOWS));
  const take = r.issues.find((i) => i.kind === "takeover")!;
  const g = issueGlance(take);
  assert.equal(g.whoKind, "workloads");
  assert.ok(g.reach.length === 1 && g.cuts >= 1);
  assert.equal(g.unverified, take.edges.filter((e) => e.ev === "unk").length);
  const lb = insightLabels(t);
  assert.match(lb.confOf(take, null), /^선 \d+개 — /, "mixed evidence: count of links, then per kind");
  const permOnly = { ...take, edges: take.edges.map((e) => ({ ...e, ev: "perm" as const })), confNote: undefined };
  assert.equal(lb.confOf(permOnly, null), `선 ${take.edges.length}개 모두 RBAC 권한`);
  assert.ok(lb.evidenceOf(permOnly).some(([, txt]) => txt === `권한 선 ${take.edges.length}`), "card chips say 'lines' too");
});

test("entry point: a scanned vulnerable image fills the takeover path's entry (cfg), the 12th factor and KBOM; no scan = 'unknown' with the reason", () => {
  const base = input(FLOWS);
  const agentImage = "docker.io/acme/agent:1.0";
  const cov = { images: 3, scanned: 1, defender: "ok" as const, sbomMapped: 0, sbom: "ok" as const, pending: 0 };
  const vuln = { image: agentImage, source: "defender" as const, basis: "tag" as const, counts: { critical: 1, high: 3, medium: 0, low: 0 }, exploited: "kev" as const, fixable: 2,
    top: [{ id: "CVE-2026-0001", cve: "CVE-2026-0001", severity: "critical" as const, exploited: "kev" as const, pkg: "openssl", version: "3.0.1", fixed: "3.0.9", url: null }] };
  const r = buildPolicyInsights({ ...base, vulns: { byImage: [vuln], coverage: cov } });
  const agent = r.rows.find((x) => x.name === "agent")!;
  assert.match(agent.cells.vuln!, /치명 1 · 높음 3 · KEV 악용 \(Defender\)/);
  assert.equal(agent.weights.vuln, "crit", "exploited in the wild = critical");
  assert.ok(r.factors.some((f) => f.key === "vuln"));
  const take = r.issues.find((i) => i.kind === "takeover" && i.id.includes("agent"))!;
  const entry = take.nodes.find((n) => n.id === "entry")!;
  assert.equal(entry.unk, undefined);
  assert.match(entry.label, /취약 이미지/);
  assert.match(entry.sub!, /CVE-2026-0001/);
  const edge = take.edges.find((e) => e.from === "entry")!;
  assert.equal(edge.ev, "cfg", "a scan result, not a guess");
  assert.match(edge.label, /CVE 4 · 악용/);
  assert.deepEqual(take.extraEvidence, [["cfg", "진입: CVE 4"]]);
  assert.equal(r.kbom.items.find((i) => i.repo === "docker.io/acme/agent")!.vuln!.exploited, "kev");
  assert.equal(r.kbom.summary.vulnerable, 1);
  assert.equal(r.kbom.summary.scanned, 1);
  // web: not scanned → no cell, and the fact says why (not 'clean')
  const web = r.rows.find((x) => x.name === "web")!;
  assert.equal(web.cells.vuln, undefined);
  // Without any vulnerability source: KBOM says null (not 0), entry unknown with the reason
  const none = buildPolicyInsights(base);
  assert.equal(none.kbom.summary.vulnerable, null);
  const e0 = none.issues.find((i) => i.kind === "takeover")!.edges.find((e) => e.from === "entry")!;
  assert.equal(e0.ev, "unk");
  assert.match(e0.why!, /출처를 읽지 않음/);
  // Sources read but this image not covered → reason names it
  const unscanned = buildPolicyInsights({ ...base, vulns: { byImage: [], coverage: { ...cov, scanned: 0, defender: "noData" } } });
  const why = unscanned.issues.find((i) => i.kind === "takeover")!.edges.find((e) => e.from === "entry")!.why!;
  assert.match(why, /Defender 컨테이너 취약성 결과 0건/);
  assert.match(why, /알려진 오픈소스 이미지/);
});
