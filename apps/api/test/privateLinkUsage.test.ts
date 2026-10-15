import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramSpec } from "@aud/types";
import { ipInCidr, isPrivateV4, joinPrivateLinkUsage, type PluInput } from "../src/services/privateLinkUsage.js";
import { accessQuery, diagState, flowQuery, scopeFromSpec } from "../src/services/privateLinkUsageCollector.js";

// ── synthetic VNet: app VM + AKS subnet + Private Endpoints to a Key Vault and a Storage account ──
function base(): PluInput {
  return {
    callers: [
      { nodeId: "vm-app", ips: ["10.0.1.4"], vnetId: "vnet" },
      { nodeId: "aks", ips: [], vnetId: "vnet" },
      { nodeId: "vm-spoke", ips: ["10.1.1.4"], vnetId: "spoke" },
    ],
    subnets: [{ nodeId: "snet-aks", vnetId: "vnet", cidr: "10.0.8.0/22", owners: ["aks"] }],
    pes: [
      { peNodeId: "pe-kv", targetNodeId: "kv", vnetId: "vnet", ip: "10.0.7.4", state: "Approved" },
      { peNodeId: "pe-sa", targetNodeId: "sa", vnetId: "vnet", ip: "10.0.7.5", state: "Approved" },
    ],
    nics: [{ ip: "10.0.6.9", nicName: "was-linux-vm01-nic" }, { ip: "10.0.7.4", nicName: "pe-kv-nic", peArmId: "/x/pe-kv" }],
    nodeByArmId: new Map([["/subs/x/vms/vm-app", "vm-app"], ["/subs/x/aks/aks", "aks"]]),
    identities: new Map([["oid-app", [{ armId: "/subs/x/vms/vm-app", name: "vm-app" }]], ["oid-shared", [{ armId: "/subs/x/vms/vm-app", name: "vm-app" }, { armId: "/subs/x/aks/aks", name: "aks" }]]]),
    peerings: new Map([["vnet", new Set(["spoke"])], ["spoke", new Set(["vnet"])]]),
    access: [],
    flows: [],
    peBytes: new Map(),
    sources: [{ source: "kvAudit", targetNodeId: "kv", state: "ok" }, { source: "storageLogs", targetNodeId: "sa", state: "disabled", reason: "noDiagSetting" }, { source: "vnetFlow", state: "disabled", reason: "noFlowLog" }],
  };
}

test("ip helpers", () => {
  assert.ok(isPrivateV4("10.1.2.3") && isPrivateV4("172.16.0.1") && isPrivateV4("172.31.255.1") && isPrivateV4("192.168.0.9"));
  assert.ok(!isPrivateV4("172.32.0.1") && !isPrivateV4("20.1.2.3") && !isPrivateV4("fd00::1"));
  assert.ok(ipInCidr("10.0.9.200", "10.0.8.0/22") && !ipInCidr("10.0.12.1", "10.0.8.0/22"));
});

test("a VM NIC IP in a Key Vault audit row → access usage VM → PE → Key Vault", () => {
  const i = base();
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.1.4", oid: "oid-app", requests: 42, failed: 1, last: "2026-10-14T05:00:00.000Z", ops: ["SecretGet"] }];
  const out = joinPrivateLinkUsage(i);
  assert.equal(out.usages.length, 1);
  const u = out.usages[0]!;
  assert.deepEqual([u.callerNodeId, u.peNodeId, u.targetNodeId, u.grade, u.attribution], ["vm-app", "pe-kv", "kv", "access", "nic"]);
  assert.equal(u.identityName, "vm-app");
  assert.equal(u.evidence[0]!.requests, 42);
  assert.equal(out.endpoints.find((e) => e.peNodeId === "pe-kv")!.activity, "used");
  assert.equal(out.endpoints.find((e) => e.peNodeId === "pe-sa")!.activity, "unknown", "storage logs are off: no evidence either way");
});

test("a source IP in a subnet owned by one AKS cluster → subnetOwner; two owners → ambiguous, no line", () => {
  const i = base();
  i.flows = [{ srcIp: "10.0.9.10", destIp: "10.0.7.4", bytes: 9000, flows: 3, allowed: 3, denied: 0, last: "2026-10-14T05:00:00.000Z", ports: [443] }];
  i.sources = [...i.sources.filter((s) => s.source !== "vnetFlow"), { source: "vnetFlow", state: "ok" }];
  let out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.usages.map((u) => [u.callerNodeId, u.attribution, u.grade]), [["aks", "subnetOwner", "flow"]]);
  i.subnets[0]!.owners = ["aks", "vmss-2"];
  out = joinPrivateLinkUsage(i);
  assert.equal(out.usages.length, 0);
  assert.deepEqual(out.unresolved.map((x) => [x.reason, x.candidates]), [["ambiguous", ["aks", "vmss-2"]]]);
});

test("a NIC without a VM is listed, not drawn (the plexus case)", () => {
  const i = base();
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.6.9", requests: 5 }];
  const out = joinPrivateLinkUsage(i);
  assert.equal(out.usages.length, 0);
  assert.deepEqual(out.unresolved.map((x) => [x.reason, x.nicName]), [["nicNoVm", "was-linux-vm01-nic"]]);
});

test("access and flow for the same pair → one usage, graded access, two evidence entries", () => {
  const i = base();
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.1.4", requests: 3, last: "2026-10-14T04:00:00.000Z" }];
  i.flows = [{ srcIp: "10.0.1.4", destIp: "10.0.7.4", bytes: 100, flows: 1, allowed: 1, denied: 0, last: "2026-10-14T05:00:00.000Z" }];
  const out = joinPrivateLinkUsage(i);
  assert.equal(out.usages.length, 1);
  assert.equal(out.usages[0]!.grade, "access");
  assert.deepEqual(out.usages[0]!.evidence.map((e) => e.source), ["kvAudit", "vnetFlow"]);
  assert.equal(out.usages[0]!.lastSeen, "2026-10-14T05:00:00.000Z");
});

test("public callers are only counted; denied-only flows are listed; identity pins a caller, a shared identity does not", () => {
  const i = base();
  i.access = [
    { targetNodeId: "kv", source: "kvAudit", ip: "20.30.40.50", oid: "oid-app", requests: 7 },
    { targetNodeId: "kv", source: "kvAudit", ip: "20.30.40.51", requests: 2 },
    { targetNodeId: "kv", source: "kvAudit", ip: "", oid: "oid-shared", requests: 1 },
  ];
  i.flows = [{ srcIp: "10.0.1.4", destIp: "10.0.7.5", bytes: 0, flows: 4, allowed: 0, denied: 4 }];
  const out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.publicAccess, [{ targetNodeId: "kv", requests: 9, distinctIps: 2, identityNames: ["vm-app"] }]);
  assert.ok(!JSON.stringify(out).includes("20.30.40"), "public IPs are never listed");
  assert.ok(out.unresolved.some((x) => x.reason === "denied" && x.deniedFlows === 4));
  assert.ok(out.unresolved.some((x) => x.reason === "ambiguous"), "a user-assigned identity on two resources pins nobody");
  const j = base();
  j.access = [{ targetNodeId: "kv", source: "kvAudit", oid: "oid-app", requests: 1 }];
  assert.equal(joinPrivateLinkUsage(j).usages[0]!.attribution, "identity");
});

test("a caller in a peered VNet uses the PE of the target there; no PE reachable → unconfirmed", () => {
  const i = base();
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.1.1.4", requests: 1 }];
  assert.equal(joinPrivateLinkUsage(i).usages[0]!.peNodeId, "pe-kv");
  i.peerings = new Map();
  assert.equal(joinPrivateLinkUsage(i).unresolved[0]!.reason, "peUnconfirmed");
});

test("no use observed only when a source looked and saw nothing", () => {
  const i = base();
  const out = joinPrivateLinkUsage(i);
  assert.equal(out.endpoints.find((e) => e.peNodeId === "pe-kv")!.activity, "noUseObserved");
  i.sources = [{ source: "kvAudit", targetNodeId: "kv", state: "disabled", reason: "noDiagSetting" }];
  assert.equal(joinPrivateLinkUsage(i).endpoints.find((e) => e.peNodeId === "pe-kv")!.activity, "unknown", "logs off → unknown, never 'unused'");
});

test("the same input in any order gives the same output", () => {
  const i = base();
  i.access = [
    { targetNodeId: "kv", source: "kvAudit", ip: "10.0.1.4", requests: 3, last: "2026-10-14T04:00:00.000Z" },
    { targetNodeId: "sa", source: "storageLogs", ip: "10.0.9.7", requests: 9, last: "2026-10-14T03:00:00.000Z" },
    { targetNodeId: "kv", source: "kvAudit", ip: "10.0.6.9", requests: 1 },
  ];
  const ref = JSON.stringify(joinPrivateLinkUsage(i));
  for (let k = 0; k < 10; k++) {
    const s = { ...i, access: [...i.access].sort(() => (k % 2 ? 1 : -1)), pes: [...i.pes].reverse(), callers: [...i.callers].reverse() };
    assert.equal(JSON.stringify(joinPrivateLinkUsage(s)), ref);
  }
});

test("diagnostic settings decide whether a log is read at all", () => {
  const kv = { source: "kvAudit" as const, service: "Key Vault", categories: ["AuditEvent"], groups: ["audit", "allLogs"], scopes: [""] };
  assert.deepEqual(diagState([], kv), { state: "disabled", reason: "noDiagSetting" });
  assert.deepEqual(diagState([{ properties: { logs: [{ category: "AuditEvent", enabled: true }] } }], kv), { state: "disabled", reason: "notToWorkspace" });
  assert.deepEqual(diagState([{ properties: { workspaceId: "/ws", logs: [{ category: "AzurePolicyEvaluationDetails", enabled: true }] } }], kv), { state: "disabled", reason: "categoryOff" });
  assert.deepEqual(diagState([{ properties: { workspaceId: "/ws", logs: [{ categoryGroup: "audit", enabled: true }] } }], kv), { state: "ok" });
});

test("queries quote every value (no injection) and the spec scope finds PEs, callers and subnet owners", () => {
  assert.ok(accessQuery("kvAudit", 'x" | drop').includes('let selfApp = "x\\" | drop";'));
  assert.ok(flowQuery(["10.0.7.4", '1"]); evil']).includes('"1\\"]); evil"'));
  const spec: DiagramSpec = {
    version: "1", id: "auto-x", name: "x", createdAt: "", updatedAt: "", groups: [], settings: { refreshIntervalSec: 30, defaultTimeRange: "5m", layout: "manual" },
    nodes: [
      { id: "vnet", label: "vnet", icon: "vnet", nodeType: "group", bindings: {}, metadata: { peerings: JSON.stringify([{ id: "spoke", name: "spoke" }]) } },
      { id: "spoke", label: "spoke", icon: "vnet", nodeType: "group", bindings: {} },
      { id: "snet-pe", label: "snet-pe", icon: "subnet", nodeType: "group", parentId: "vnet", endpoint: "10.0.7.0/24", bindings: {} },
      { id: "snet-aks", label: "snet-aks", icon: "subnet", nodeType: "group", parentId: "vnet", endpoint: "10.0.8.0/22", bindings: {} },
      { id: "snet-s", label: "snet-s", icon: "subnet", nodeType: "group", parentId: "spoke", endpoint: "10.1.1.0/24", bindings: {} },
      { id: "pe-kv", label: "pe-kv", icon: "privateEndpoint", resourceKind: "privateEndpoint", parentId: "snet-pe", bindings: {}, subResources: [{ id: "n", label: "n", kind: "nic", endpoint: "10.0.7.4" }] },
      { id: "kv", label: "kv", icon: "keyVault", resourceKind: "keyVault", bindings: {}, azureResourceId: "/subscriptions/s/resourceGroups/r/providers/Microsoft.KeyVault/vaults/kv" },
      { id: "aks", label: "aks", icon: "aks", resourceKind: "aks", parentId: "snet-aks", bindings: {} },
      { id: "vm-s", label: "vm-s", icon: "vm", resourceKind: "vm", parentId: "snet-s", bindings: {}, subResources: [{ id: "n2", label: "n2", kind: "nic", endpoint: "10.1.1.4" }] },
    ],
    edges: [{ id: "pl", source: "pe-kv", target: "kv", edgeKind: "privateLink", bindings: {} }],
  };
  const s = scopeFromSpec(spec, "vnet")!;
  assert.deepEqual(s.pes.map((p) => [p.peNodeId, p.targetNodeId, p.ip]), [["pe-kv", "kv", "10.0.7.4"]]);
  assert.deepEqual(s.callers.map((c) => c.nodeId).sort(), ["aks", "vm-s"], "the VNet and its peers");
  assert.deepEqual(s.subnets.find((x) => x.nodeId === "snet-aks")!.owners, ["aks"]);
  assert.equal(scopeFromSpec(spec, "snet-pe"), null, "only a VNet node is accepted");
});

test("serialized output carries no subscription id or object id", () => {
  const i = base();
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.1.4", oid: "11111111-2222-3333-4444-555555555555", requests: 1 }];
  const json = JSON.stringify(joinPrivateLinkUsage(i));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(json) && !json.includes("/subscriptions/") && !json.includes("oid"), json);
});

test("a PE with two lines to the same service is one endpoint", () => {
  const spec: DiagramSpec = {
    version: "1", id: "auto-x", name: "x", createdAt: "", updatedAt: "", groups: [], settings: { refreshIntervalSec: 30, defaultTimeRange: "5m", layout: "manual" },
    nodes: [
      { id: "vnet", label: "vnet", icon: "vnet", nodeType: "group", bindings: {} },
      { id: "snet", label: "snet", icon: "subnet", nodeType: "group", parentId: "vnet", endpoint: "10.0.7.0/24", bindings: {} },
      { id: "pe", label: "pe", icon: "privateEndpoint", resourceKind: "privateEndpoint", parentId: "snet", bindings: {} },
      { id: "sa", label: "sa", icon: "storage", resourceKind: "storage", bindings: {} },
    ],
    edges: [{ id: "a", source: "pe", target: "sa", edgeKind: "privateLink", bindings: {} }, { id: "b", source: "pe", target: "sa", edgeKind: "privateLink", bindings: {} }],
  };
  assert.equal(scopeFromSpec(spec, "vnet")!.pes.length, 1);
});

// ── unidentified callers: one AKS cluster's pools, places outside the scope, internal ranges ──
test("node pools of ONE AKS cluster sharing the subnet → the cluster (aksCluster, pools listed); mixed stays ambiguous", () => {
  const i = base();
  i.subnets[0]!.owners = ["pool-sys", "pool-user"];
  i.clusterOf = new Map([["aks", "aks"], ["pool-sys", "aks"], ["pool-user", "aks"]]);
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.9.10", requests: 5, last: "2026-10-14T05:00:00.000Z" }];
  let out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.usages.map((u) => [u.callerNodeId, u.attribution, u.peNodeId, u.viaNodeIds]), [["aks", "aksCluster", "pe-kv", ["pool-sys", "pool-user"]]]);
  // a plain scale set in the same subnet, or a second cluster → no line
  i.subnets[0]!.owners = ["pool-sys", "vmss-plain"];
  out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.unresolved.map((x) => [x.reason, x.basis]), [["ambiguous", "subnet"]]);
  i.clusterOf = new Map([["pool-sys", "aks"], ["pool-b", "aks-b"]]);
  i.subnets[0]!.owners = ["pool-sys", "pool-b"];
  assert.equal(joinPrivateLinkUsage(i).usages.length, 0);
});

test("a shared identity is reported as such; subnet candidates are not replaced by identity holders", () => {
  const i = base();
  i.subnets[0]!.owners = ["aks", "vmss-2"];
  i.access = [{ targetNodeId: "kv", source: "kvAudit", ip: "10.0.9.10", oid: "oid-shared", requests: 1 }];
  let out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.unresolved.map((x) => [x.reason, x.basis, x.candidates]), [["ambiguous", "subnet", ["aks", "vmss-2"]]]);
  i.access = [{ targetNodeId: "kv", source: "kvAudit", oid: "oid-shared", requests: 1 }];
  out = joinPrivateLinkUsage(i);
  assert.deepEqual(out.unresolved.map((x) => [x.reason, x.basis]), [["ambiguous", "identity"]]);
});

test("addresses outside the scope: another VNet's subnet is named, overlap is not, private / CGNAT are classed — never drawn", () => {
  const i = base();
  i.outerSubnets = [
    { nodeId: "snet-hub-fw", vnetId: "hub", cidr: "10.150.254.0/26", owners: ["fw"] },
    { nodeId: "snet-x", vnetId: "x1", cidr: "10.200.0.0/24", owners: [] },
    { nodeId: "snet-y", vnetId: "x2", cidr: "10.200.0.0/24", owners: [] },
  ];
  i.access = [
    { targetNodeId: "kv", source: "kvAudit", ip: "10.150.254.5", requests: 1 },
    { targetNodeId: "kv", source: "kvAudit", ip: "10.200.0.9", requests: 1 },
    { targetNodeId: "kv", source: "kvAudit", ip: "172.16.4.4", requests: 1 },
    { targetNodeId: "kv", source: "kvAudit", ip: "100.64.1.1", requests: 1 },
  ];
  const out = joinPrivateLinkUsage(i);
  assert.equal(out.usages.length, 0);
  assert.equal(out.publicAccess.length, 0, "100.64/10 is not the public Internet");
  const place = (ip: string) => out.unresolved.find((u) => u.ip === ip)?.place;
  assert.deepEqual(place("10.150.254.5"), { kind: "otherVnet", vnetNodeId: "hub", subnetNodeId: "snet-hub-fw", ownerNodeId: "fw" });
  assert.deepEqual(place("10.200.0.9"), { kind: "overlap", matches: 2 });
  assert.deepEqual(place("172.16.4.4"), { kind: "private" });
  assert.deepEqual(place("100.64.1.1"), { kind: "cgnat" });
});
