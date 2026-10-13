import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
  PolicyInsightsResponse,
  PostureAlert,
  PostureRecommendation,
  PostureResourceRef,
  SecurityPostureResponse,
} from "@aud/types";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as ns from "../../web/src/lib/riskJoin.ts";

const m = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const { joinRisk, armParts } = m;

// ── synthetic subscription (fake IDs only) ──
const SUBID = "11111111-2222-3333-4444-555555555555";
const SUB = `/subscriptions/${SUBID}`;
const rid = (rg: string, type: string, name: string) => `${SUB}/resourceGroups/${rg}/providers/${type}/${name}`;
const AKS = rid("rg-aks", "Microsoft.ContainerService/managedClusters", "aks1");
const VMSS = rid("MC_rg-aks", "Microsoft.Compute/virtualMachineScaleSets", "aks-pool1");
const LB_K8S = rid("MC_rg-aks", "Microsoft.Network/loadBalancers", "kubernetes");
const LB_APP = rid("MC_rg-aks", "Microsoft.Network/loadBalancers", "lb-app");
const LB_UNK = rid("MC_rg-aks", "Microsoft.Network/loadBalancers", "lb-unk");
const KV = rid("rg-data", "Microsoft.KeyVault/vaults", "kv-app");
const ST = rid("rg-data", "Microsoft.Storage/storageAccounts", "st1");
// Two workspaces whose names differ only inside a GUID with the same last 4 characters → same masked key
const WS1 = rid("rg-logs", "Microsoft.OperationalInsights/workspaces", "ws-aaaaaaaa-0000-0000-0000-00000000abcd");
const WS2 = rid("rg-logs", "Microsoft.OperationalInsights/workspaces", "ws-bbbbbbbb-0000-0000-0000-00000000abcd");
const LAW = rid("DefaultResourceGroup-EUS", "Microsoft.OperationalInsights/workspaces", `DefaultWorkspace-${SUBID}-EUS`);
const pip = (n: string) => rid("MC_rg-aks", "Microsoft.Network/publicIPAddresses", n);

function graph(): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}) =>
    nodes.push({ id, kind, name, location: "koreacentral", azureId: id, resourceGroup: id.split("/")[4], ...extra });
  let k = 0;
  const e = (source: string, target: string, kind: ArchitectureEdge["kind"]) => edges.push({ id: `e${k++}`, source, target, kind });
  n(AKS, "aks", "aks1");
  n(VMSS, "vmss", "aks-pool1");
  e(AKS, VMSS, "connects");
  n(LB_K8S, "lb", "kubernetes", { metadata: { inboundRules: 0 } }); // AKS outbound SNAT only
  n(LB_APP, "lb", "lb-app", { metadata: { inboundRules: 2 } });
  n(LB_UNK, "lb", "lb-unk"); // rules not listed
  for (const lb of [LB_K8S, LB_APP, LB_UNK]) {
    e(lb, VMSS, "routes");
    const p = pip(`pip-${lb.split("/").pop()}`);
    n(p, "publicIP", p.split("/").pop()!, { metadata: { attachedTo: lb } });
  }
  n(KV, "keyVault", "kv-app");
  n(ST, "storage", "st1");
  n(WS1, "logAnalytics", WS1.split("/").pop()!);
  n(WS2, "logAnalytics", WS2.split("/").pop()!);
  n(LAW, "logAnalytics", LAW.split("/").pop()!);
  return { generatedAt: "2026-10-13T00:00:00Z", nodes, edges, source: "azure" };
}

const ref = (name: string, resourceGroup: string, armType?: string): PostureResourceRef =>
  ({ name, resourceGroup, type: armType?.split("/").pop() ?? "resource", ...(armType ? { armType } : {}) });
const rec = (key: string, severity: PostureRecommendation["severity"], samples: PostureResourceRef[], unhealthy = samples.length): PostureRecommendation =>
  ({ key, title: `rec ${key}`, severity, domain: "other", threats: [], unhealthy, healthy: 0, samples, portalUrl: "" });
const alert = (id: string, resources: PostureResourceRef[]): PostureAlert =>
  ({ id, title: `alert ${id}`, severity: "High", status: "Active", detectedAt: "2026-10-13T00:00:00Z", description: "", resources });

function posture(): SecurityPostureResponse {
  return {
    generatedAt: "2026-10-13T00:00:00Z",
    source: "azure",
    score: null,
    controls: [],
    compliance: [],
    plans: [],
    gaps: [],
    recommendations: [
      rec("kv", "High", [ref("KV-APP", "RG-DATA", "microsoft.keyvault/vaults")]), // case-insensitive
      rec("pool", "Medium", [ref("aks-pool1", "MC_rg-aks", "microsoft.compute/virtualmachinescalesets")]), // absorbed → AKS
      rec("ws", "High", [ref("ws-…abcd", "rg-logs", "microsoft.operationalinsights/workspaces")]), // two candidates
      rec("user", "High", [{ name: "jane.doe", type: "azureiamuser", resourceGroup: "" }], 9), // not ARM, truncated
      rec("st-other-rg", "Medium", [ref("st1", "rg-other", "microsoft.storage/storageaccounts")]), // RG differs
      rec("recovery", "Low", [ref("kv-app", "rg-data", "microsoft.recoveryservices/vaults")]), // type differs
      rec("no-provider", "Low", [{ name: "kv-app", type: "vaults", resourceGroup: "rg-data" }]), // colliding, no provider
      rec("law", "Low", [ref(`DefaultWorkspace-…5555-EUS`, "DefaultResourceGroup-EUS", "microsoft.operationalinsights/workspaces")]),
    ],
    alerts: [
      alert("a-k8s-lb", [ref("kubernetes", "MC_rg-aks", "microsoft.network/loadbalancers")]),
      alert("a-app-lb", [ref("lb-app", "MC_rg-aks", "microsoft.network/loadbalancers")]),
      alert("a-aks", [ref("aks1", "rg-aks", "microsoft.containerservice/managedclusters")]),
      alert("a-vmss-instance", [ref("0", "MC_rg-aks", "microsoft.compute/virtualmachinescalesets/virtualmachines")]),
      alert("a-unk-lb", [ref("lb-unk", "MC_rg-aks", "microsoft.network/loadbalancers")]),
    ],
  };
}

function insights(over: Partial<PolicyInsightsResponse["network"]> = {}): PolicyInsightsResponse {
  const node = (id: string, label: string, extra = {}) => ({ id, kind: "paas" as const, label, sub: "", ...extra });
  return {
    clusterId: AKS.toLowerCase(),
    generatedAt: "2026-10-13T00:00:00Z",
    factors: [], rows: [], riskDict: [], matrix: [],
    issues: [
      { id: "i-local", sev: "crit", kind: "local", title: "local accounts", owner: "", ownerGroup: "azure", findingIds: [], extraEvidence: [], nodes: [], edges: [], actions: [] },
      {
        id: "i-exfil", sev: "warn", kind: "exfil", title: "exfil to key vault", owner: "", ownerGroup: "mine", findingIds: [], extraEvidence: [], edges: [], actions: [],
        nodes: [{ id: "az", col: 3, row: 0, type: "azure", label: "kv-app", sub: "", facts: [], refs: ["azure:vaults/kv-app"] }],
      },
    ],
    network: {
      available: true, coverage: null, edges: [], unmatchedExternal: [], azureMatched: true,
      nodes: [
        node("azure:vaults/kv-app", "kv-app"),
        node("azure:storageaccounts/st1", "st1", { sharedIpWith: ["stother"] }),
        node("azure:storageaccounts/st-elsewhere", "st-elsewhere"),
        node("azure:storageaccounts/st-norg", "st-norg"),
      ],
      ...over,
    },
    containment: {
      subscription: null, resourceGroup: "rg-aks",
      cluster: { name: "aks1", location: "koreacentral", k8sVersion: "1.30", nodes: 3, privateCluster: false, authorizedIpRanges: null, localAccounts: true, entraIntegrated: true, azureRbac: false, outboundType: "loadBalancer" },
      resources: [
        { id: "azure:vaults/kv-app", name: "kv-app", type: "Key Vault", armType: "microsoft.keyvault/vaults", resourceGroup: "rg-data" },
        { id: "azure:storageaccounts/st1", name: "st1", type: "Storage", armType: "microsoft.storage/storageaccounts", resourceGroup: "rg-data" },
        { id: "azure:storageaccounts/st-elsewhere", name: "st-elsewhere", type: "Storage", armType: "microsoft.storage/storageaccounts", resourceGroup: "rg-x" },
        { id: "azure:storageaccounts/st-norg", name: "st-norg", type: "Storage", armType: "storageaccounts", resourceGroup: "" },
      ],
    },
    kbom: { platform: [], items: [], summary: { images: 0, registries: [], drift: 0, snapshot: 0, publicPull: 0, digestPinned: 0 } },
    gaps: [],
  } as unknown as PolicyInsightsResponse;
}

const run = (o: { p?: SecurityPostureResponse; g?: ArchitectureGraph; i?: PolicyInsightsResponse; cluster?: string } = {}) =>
  joinRisk({ posture: o.p ?? posture(), graph: o.g ?? graph(), insights: o.i ?? insights(), clusterArmId: o.cluster ?? AKS });
const rowOf = (r: ReturnType<typeof run>, name: string) => r.rows.find((x) => x.name === name);

test("armParts: rg, provider/type, child types, name", () => {
  assert.deepEqual(armParts(KV), { rg: "rg-data", full: "microsoft.keyvault/vaults", last: "vaults", name: "kv-app" });
  assert.equal(armParts(`${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s`)?.full, "microsoft.network/virtualnetworks/subnets");
  assert.equal(armParts(SUB), null);
  assert.equal(armParts("internet:koreacentral"), null);
});

test("cluster row: ID match, every issue, node-pool recommendations via the absorbed scale set", () => {
  const r = run();
  const aks = rowOf(r, "aks1")!;
  assert.ok(aks);
  assert.deepEqual(aks.links.map((l) => `${l.rel}:${l.ev}`).sort(), ["cluster:cfg", "nodepool:cfg"]);
  assert.deepEqual(aks.issues.map((i) => i.id).sort(), ["i-exfil", "i-local"]);
  assert.deepEqual(aks.recs.map((x) => x.key), ["pool"]);
  assert.deepEqual(aks.alerts.map((a) => a.id), ["a-aks"]);
});

test("keys: case-insensitive match; different RG or provider does not link; duplicates are ambiguous", () => {
  const r = run();
  const kv = rowOf(r, "kv-app")!;
  assert.deepEqual(kv.recs.map((x) => x.key), ["kv"], "KV-APP / RG-DATA links; Recovery Services 'vaults' and provider-less 'vaults' do not");
  assert.ok(!r.rows.some((x) => x.recs.some((y) => y.key === "st-other-rg")), "same name in another RG never links");
  assert.ok(!r.rows.some((x) => x.recs.some((y) => y.key === "ws")));
  assert.equal(r.coverage.ambiguous, 2, "masked duplicate workspace + colliding type without provider");
  assert.equal(r.coverage.nonArmSamples, 1);
  assert.equal(r.coverage.truncatedRecs, 1);
  assert.equal(r.coverage.armSamples, 7);
  assert.equal(r.coverage.matchedSamples, 3, "kv, pool, DefaultWorkspace (masked on both sides)");
});

test("egress: observed PaaS links with obs, shared IP is unk and listed apart, unmatched targets are counted", () => {
  const r = run();
  const kv = rowOf(r, "kv-app")!;
  assert.deepEqual(kv.links, [{ rel: "egress", ev: "obs" }]);
  assert.deepEqual(kv.issues.map((i) => i.id), ["i-exfil"], "only issues whose path references this node");
  const st = rowOf(r, "st1")!;
  assert.deepEqual(st.links, [{ rel: "egress", ev: "unk" }]);
  assert.equal(st.uncertain, true);
  assert.ok(r.rows.indexOf(st) > r.rows.findIndex((x) => !x.uncertain), "uncertain rows come last");
  assert.ok(r.rows.slice(r.rows.indexOf(st)).every((x) => x.uncertain));
  assert.equal(r.unlinked.egressTargets, 2, "other subscription + RG unknown");
});

test("LB rows: inbound rules → entry (cfg); 0 rules → backend only; no rule data → unk", () => {
  const r = run();
  assert.deepEqual(rowOf(r, "lb-app")!.links, [{ rel: "entry", ev: "cfg" }]);
  assert.equal(rowOf(r, "lb-app")!.internet, "cfg");
  assert.deepEqual(rowOf(r, "kubernetes")!.links, [{ rel: "backend", ev: "cfg" }]);
  assert.equal(rowOf(r, "kubernetes")!.internet, null, "public IP with no inbound rule is not an internet entry");
  assert.deepEqual(rowOf(r, "lb-unk")!.links, [{ rel: "entry", ev: "unk" }]);
  assert.equal(rowOf(r, "lb-unk")!.internet, "unk");
  assert.equal(rowOf(r, "lb-unk")!.uncertain, true);
});

test("stats count distinct evidence only; unlinked numbers are kept", () => {
  const r = run();
  assert.equal(r.mode, "live");
  assert.deepEqual(r.stats, { issues: 2, linkedAssets: 3, highRecs: 1, linkedAlerts: 2 });
  assert.deepEqual(r.unlinked, { highRecs: 2, issues: 1, alerts: 1, egressTargets: 2 });
  assert.deepEqual(r.gaps, []);
  // A recommendation on several linked resources counts once
  const p = posture();
  p.recommendations.push(rec("multi", "High", [ref("kv-app", "rg-data", "microsoft.keyvault/vaults"), ref("lb-app", "MC_rg-aks", "microsoft.network/loadbalancers")]));
  assert.equal(run({ p }).stats.highRecs, 2);
});

test("sample data on either side → sample mode, no rows", () => {
  const p = posture();
  p.source = "mock";
  assert.equal(run({ p }).mode, "sample");
  assert.deepEqual(run({ p }).rows, []);
  const g = graph();
  g.source = "mock";
  assert.deepEqual(run({ g }).rows, []);
});

test("gaps: Hubble off, Azure matching failed, cluster missing from the graph, posture sections", () => {
  assert.deepEqual(run({ i: insights({ available: false }) }).gaps, ["hubble"]);
  assert.deepEqual(run({ i: insights({ azureMatched: false }) }).gaps, ["azureMatch"]);
  const missing = run({ cluster: rid("rg-aks", "Microsoft.ContainerService/managedClusters", "other") });
  assert.ok(missing.gaps.includes("clusterNotInGraph"));
  assert.ok(!missing.rows.some((x) => x.links.some((l) => l.rel === "cluster" || l.rel === "entry" || l.rel === "backend")));
  const p = posture();
  p.gaps = [{ section: "recommendations", message: "x" }, { section: "alerts", message: "y" }];
  assert.deepEqual(run({ p }).gaps, ["recommendations", "alerts"]);
  const i = insights();
  i.gaps = ["Kubernetes rbac"];
  assert.deepEqual(run({ i }).gaps, ["insightsPartial"]);
});

// Recommendation keys are Defender assessment definition IDs (the same in every tenant) — the fixture uses plain keys
test("result carries no ARM or subscription IDs, names are masked", () => {
  const text = JSON.stringify(run());
  assert.ok(!/\/subscriptions\//i.test(text));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text));
});
