import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as ns from "../../web/src/lib/archModel.ts";
import { mockArchitectureGraph } from "../src/mockData.js";

const m = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const { buildArchModel, layoutArch, initialCollapsed, defaultRegion, internetId, searchArch, labelWidth, ARCH, INTERNET_TILE } = m;

// ── synthetic subscription (fake IDs only) ──
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const rid = (rg: string, type: string, name: string) => `${SUB}/resourceGroups/${rg}/providers/${type}/${name}`.toLowerCase();
const VNET_A = rid("rg1", "microsoft.network/virtualnetworks", "vnet-a");
const VNET_B = rid("rg2", "microsoft.network/virtualnetworks", "vnet-b");
const A1 = `${VNET_A}/subnets/a1`, A2 = `${VNET_A}/subnets/a2`, B1 = `${VNET_B}/subnets/b1`;
const nicId = (n: string) => rid("rg1", "microsoft.network/networkinterfaces", n);
const vmId = (n: string) => rid("rg1", "microsoft.compute/virtualmachines", n);
const pipId = (n: string) => rid("rg1", "microsoft.network/publicipaddresses", n);
const nsgId = (n: string) => rid("rg1", "microsoft.network/networksecuritygroups", n);
const LB_PUB = rid("rg1", "microsoft.network/loadbalancers", "lb-pub");
const LB_INT = rid("rg1", "microsoft.network/loadbalancers", "lb-int");
const APPGW = rid("rg1", "microsoft.network/applicationgateways", "agw");
const AKS = rid("rg2", "microsoft.containerservice/managedclusters", "aks1");
const VMSS = rid("mc_rg2", "microsoft.compute/virtualmachinescalesets", "aks-pool1");
const PE = rid("rg1", "microsoft.network/privateendpoints", "pe-kv");
const KV = rid("rg2", "microsoft.keyvault/vaults", "kv1");
const NAT = rid("rg1", "microsoft.network/natgateways", "nat1");
const FD = rid("rg1", "microsoft.network/frontdoors", "fd1");
const ODD = rid("rg1", "microsoft.foo/bars", "odd1");

function fixture(): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, location = "koreacentral", extra: Partial<ArchitectureNode> = {}) =>
    nodes.push({ id, kind, name, location, azureId: id, resourceGroup: id.split("/")[4], ...extra });
  let k = 0;
  const e = (source: string, target: string, kind: ArchitectureEdge["kind"]) => edges.push({ id: `e${k++}`, source, target, kind });

  n(SUB, "subscription", "sub");
  n(`${SUB}/resourcegroups/rg1`, "resourceGroup", "rg1");
  n(`${SUB}/resourcegroups/rg2`, "resourceGroup", "rg2");
  e(SUB, `${SUB}/resourcegroups/rg1`, "contains");
  n(VNET_A, "vnet", "vnet-a", "koreacentral", { endpoint: "10.0.0.0/16" });
  n(VNET_B, "vnet", "vnet-b", "eastus", { endpoint: "10.9.0.0/16" });
  n(A1, "subnet", "a1", "koreacentral", { endpoint: "10.0.1.0/24" });
  n(A2, "subnet", "a2", "koreacentral", { endpoint: "10.0.2.0/24" });
  n(B1, "subnet", "b1", "eastus", { endpoint: "10.9.1.0/24" });
  e(VNET_A, A1, "contains"); e(VNET_A, A2, "contains"); e(VNET_B, B1, "contains");

  // vm1: one NIC in a1, NIC-level NSG, public IP
  n(nicId("nic1"), "nic", "nic1", "koreacentral", { endpoint: "10.0.1.4" });
  n(vmId("vm1"), "vm", "vm1");
  e(A1, nicId("nic1"), "attached-to"); e(nicId("nic1"), vmId("vm1"), "bound-to");
  // vm2: two NICs in a1 and a2
  n(nicId("nic2a"), "nic", "nic2a"); n(nicId("nic2b"), "nic", "nic2b");
  n(vmId("vm2"), "vm", "vm2");
  e(A1, nicId("nic2a"), "attached-to"); e(A2, nicId("nic2b"), "attached-to");
  e(nicId("nic2a"), vmId("vm2"), "bound-to"); e(nicId("nic2b"), vmId("vm2"), "bound-to");
  // 7 VMs in a2 → stack (more than STACK_AT)
  for (let i = 3; i <= 9; i++) {
    n(nicId(`nic${i}`), "nic", `nic${i}`); n(vmId(`vm${i}`), "vm", `vm${i}`);
    e(A2, nicId(`nic${i}`), "attached-to"); e(nicId(`nic${i}`), vmId(`vm${i}`), "bound-to");
  }
  // NIC without a VM, with a public IP and its own NSG
  n(nicId("nicx"), "nic", "nicx");
  e(A1, nicId("nicx"), "attached-to");

  // NSGs: subnet, VM NIC, VM-less NIC, unused
  n(nsgId("nsg1"), "nsg", "nsg1"); n(nsgId("nsg2"), "nsg", "nsg2"); n(nsgId("nsg3"), "nsg", "nsg3"); n(nsgId("nsg4"), "nsg", "nsg4");
  e(nsgId("nsg1"), A1, "network"); e(nsgId("nsg2"), nicId("nic1"), "network"); e(nsgId("nsg3"), nicId("nicx"), "network");

  // Public IPs: VM, public LB, VM-less NIC, NAT, unused, owner not in graph
  n(pipId("pip-vm1"), "publicIP", "pip-vm1", "koreacentral", { endpoint: "20.0.0.1", metadata: { absorbed: true, attachedTo: nicId("nic1") } });
  n(pipId("pip-lb"), "publicIP", "pip-lb", "koreacentral", { endpoint: "20.0.0.2", metadata: { absorbed: true, attachedTo: LB_PUB } });
  n(pipId("pip-x"), "publicIP", "pip-x", "koreacentral", { endpoint: "20.0.0.3", metadata: { absorbed: true, attachedTo: nicId("nicx") } });
  n(pipId("pip-nat"), "publicIP", "pip-nat", "koreacentral", { endpoint: "20.0.0.4", metadata: { attachedTo: NAT } });
  n(pipId("pip-unused"), "publicIP", "pip-unused", "koreacentral", { metadata: { unused: true } });
  n(pipId("pip-vpn"), "publicIP", "pip-vpn", "koreacentral", { metadata: { absorbed: true, attachedTo: rid("rg1", "microsoft.network/virtualnetworkgateways", "gw1") } });

  // Public LB (no subnet) → vm1 and the AKS pool (both directions of the SNAT pair)
  n(LB_PUB, "lb", "lb-pub", "koreacentral", { endpoint: "20.0.0.2" });
  e(LB_PUB, nicId("nic1"), "routes");
  // Internal LB in a2, App Gateway in a1
  n(LB_INT, "lb", "lb-int"); e(A2, LB_INT, "connects");
  n(APPGW, "appGateway", "agw"); e(A1, APPGW, "connects");

  // AKS without vnetSubnetId → placed by its node pool's subnet (b1)
  n(AKS, "aks", "aks1", "eastus", { metadata: { agentPoolProfiles: [{ name: "pool1" }] } });
  n(VMSS, "vmss", "aks-pool1", "eastus");
  e(AKS, VMSS, "connects"); e(B1, VMSS, "network");
  e(LB_PUB, VMSS, "routes"); e(VMSS, LB_PUB, "routes");

  // Private Endpoint in a1 → Key Vault in eastus
  n(PE, "privateEndpoint", "pe-kv", "koreacentral", { endpoint: "10.0.1.9" });
  n(KV, "keyVault", "kv1", "eastus");
  e(A1, PE, "network"); e(PE, KV, "privateLink");

  // NAT on a2
  n(NAT, "natGateway", "nat1");
  e(A2, NAT, "network"); e(NAT, pipId("pip-nat"), "network");

  // Peering, PaaS stack, global and an unmapped kind
  e(VNET_A, VNET_B, "peering");
  for (let i = 1; i <= 5; i++) n(rid("rg1", "microsoft.storage/storageaccounts", `st${i}`), "storage", `st${i}`);
  n(FD, "frontDoor", "fd1", "global");
  n(ODD, "unknown", "odd1");
  return { generatedAt: "2026-01-01T00:00:00Z", nodes, edges };
}

const graph = fixture();
const model = buildArchModel(graph);

test("partition: every graph node lands in exactly one bucket", () => {
  assert.equal(model.accounting.size, graph.nodes.length);
  for (const n of graph.nodes) assert.ok(model.accounting.has(n.id.toLowerCase()), n.id);
  const by = (as: string) => [...model.accounting].filter(([, v]) => v.as === as).map(([id]) => id);
  assert.deepEqual(by("omitted").length, 2, "2 resource groups");
  assert.deepEqual(by("container").sort(), [SUB.toLowerCase(), A1, A2, B1, VNET_A, VNET_B].sort(), "the subscription is the outer frame");
  // counted = unused NSG, unused public IP, public IP whose owner is not in the graph
  assert.deepEqual(by("counted").sort(), [nsgId("nsg4"), pipId("pip-unused"), pipId("pip-vpn")].sort());
  assert.equal(model.accounting.get(VMSS)?.into, AKS);
  assert.equal(model.accounting.get(nicId("nic1"))?.into, vmId("vm1"));
  assert.equal(model.accounting.get(nicId("nicx"))?.into, A1, "VM-less NIC is counted on its subnet");
  assert.equal(model.accounting.get(pipId("pip-x"))?.into, A1);
  assert.equal(model.accounting.get(pipId("pip-nat"))?.into, NAT);
});

test("placement: subnets, lanes, regions", () => {
  const r = (id: string) => model.resources.get(id)!;
  assert.equal(r(vmId("vm1")).subnetId, A1);
  assert.deepEqual([r(vmId("vm2")).subnetId, r(vmId("vm2")).extraSubnets], [A1, [A2]]);
  assert.equal(r(AKS).subnetId, B1, "AKS without vnetSubnetId follows its node pool scale set");
  assert.deepEqual(r(AKS).nodePools, ["aks-pool1"]);
  assert.equal(r(LB_INT).subnetId, A2);
  assert.equal(r(APPGW).subnetId, A1);
  assert.equal(r(PE).subnetId, A1);
  const kc = model.regions.find((x) => x.key === "koreacentral")!;
  const eu = model.regions.find((x) => x.key === "eastus")!;
  assert.deepEqual(kc.edge.sort(), [LB_PUB, NAT].sort(), "public LB and NAT sit in the edge lane");
  assert.equal(kc.paas.data.length, 5);
  assert.deepEqual(kc.paas.other, [ODD], "unmapped kinds go to PaaS › other");
  assert.deepEqual(eu.paas.security, [KV]);
  assert.deepEqual(model.global, [FD]);
  assert.equal(defaultRegion(model), "koreacentral");
});

test("public IPs and NSGs become badges; unknown owners are listed with the type from the ID", () => {
  assert.deepEqual(model.resources.get(vmId("vm1"))!.publicIps, ["20.0.0.1"]);
  assert.deepEqual(model.resources.get(LB_PUB)!.publicIps, ["20.0.0.2"]);
  assert.deepEqual(model.subnets.get(A1)!.publicIps, ["20.0.0.3"]);
  assert.deepEqual(model.subnets.get(A1)!.nsgs, ["nsg1", "nsg3"]);
  assert.equal(model.subnets.get(A1)!.otherNics, 1);
  assert.deepEqual(model.resources.get(vmId("vm1"))!.nsgs, ["nsg2"]);
  const kc = model.regions.find((x) => x.key === "koreacentral")!;
  assert.deepEqual(kc.unusedNsgs.map((x) => x.name), ["nsg4"]);
  assert.deepEqual(kc.unusedPublicIps.map((x) => x.name), ["pip-unused"]);
  assert.deepEqual(kc.unresolvedPublicIps.map((x) => [x.name, x.detail]), [["pip-vpn", "virtualnetworkgateways"]]);
});

test("lines: configuration relationships only, NAT is egress-only, SNAT pair is one line", () => {
  const kinds = (k: string) => model.edges.filter((e) => e.kind === k).map((e) => `${e.source}->${e.target}`);
  assert.deepEqual(kinds("ingress"), [`${internetId("koreacentral")}->${LB_PUB}`]);
  assert.deepEqual(kinds("exposure"), [`${internetId("koreacentral")}->${vmId("vm1")}`]);
  assert.deepEqual(kinds("routes").sort(), [`${LB_PUB}->${AKS}`, `${LB_PUB}->${vmId("vm1")}`].sort());
  assert.deepEqual(kinds("privateLink"), [`${PE}->${KV}`]);
  assert.equal(kinds("peering").length, 1);
  assert.deepEqual(kinds("outbound"), [`${A2}->${NAT}`]);
  assert.deepEqual(kinds("egress"), [`${NAT}->${internetId("koreacentral")}`], "NAT with a public IP → the Internet (configuration)");
  assert.ok(!model.edges.some((e) => e.target === NAT && (e.kind === "exposure" || e.kind === "ingress")));
  for (const e of model.edges) assert.ok(!["contains", "attached-to", "bound-to"].includes(e.kind));
});

type Rect = { x: number; y: number; w: number; h: number };
const inside = (c: Rect, p: Rect) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function checkGeometry(L: ReturnType<typeof layoutArch>) {
  const byId = new Map(L.shapes.map((s) => [s.id, s]));
  assert.equal(byId.size, L.shapes.length, "shape ids are unique");
  for (const s of L.shapes) {
    if (s.parent) assert.ok(inside(s, byId.get(s.parent)!), `${s.id} inside ${s.parent}`);
  }
  const siblings = new Map<string, typeof L.shapes>();
  for (const s of L.shapes) (siblings.get(s.parent ?? "") ?? siblings.set(s.parent ?? "", []).get(s.parent ?? "")!).push(s);
  for (const list of siblings.values())
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlap(list[i]!, list[j]!), `${list[i]!.id} vs ${list[j]!.id}`);
  for (const e of L.edges) {
    assert.ok(byId.has(e.source) && byId.has(e.target), e.id);
    assert.notEqual(e.source, e.target);
  }
}

test("region view: nested geometry, stacks, ghosts for other regions", () => {
  const L = layoutArch(model, { region: "koreacentral", collapsed: initialCollapsed(model, "koreacentral"), expandedStacks: new Set() });
  checkGeometry(L);
  const ids = new Set(L.shapes.map((s) => s.id));
  assert.ok(ids.has(`stack:${A2}:vm`), "7 VMs in one subnet stack");
  assert.ok(ids.has(`stack:paas:data:koreacentral:storage`), "5 storage accounts stack in the lane");
  assert.ok(ids.has(`ghost:${KV}`) && ids.has(`ghost:${VNET_B}`), "other-region ends shown as ghosts");
  assert.ok(ids.has(INTERNET_TILE) && !ids.has(internetId("koreacentral")), "one Internet tile, not one per region");
  assert.ok(!ids.has(AKS), "eastus resources are not drawn in the koreacentral view");
  // Default layers: no VM exposure line, ingress yes
  assert.ok(L.edges.some((e) => e.kind === "ingress"));
  assert.ok(!L.edges.some((e) => e.kind === "exposure"));
  const vm2 = L.shapes.find((s) => s.id === vmId("vm2"))!;
  assert.equal(vm2.parent, A1);
});

test("expanding a stack shows its members; collapsing a VNet rolls lines up to it", () => {
  const open = layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set([`stack:${A2}:vm`]) });
  checkGeometry(open);
  assert.equal(open.shapes.filter((s) => s.parent === A2 && s.shape === "tile" && s.id.includes("virtualmachines")).length, 7);
  const closed = layoutArch(model, { region: "koreacentral", collapsed: new Set([VNET_A]), expandedStacks: new Set() });
  checkGeometry(closed);
  const pill = closed.shapes.find((s) => s.id === VNET_A)!;
  assert.equal(pill.shape, "pill");
  const routes = closed.edges.filter((e) => e.kind === "routes");
  assert.deepEqual(routes.map((e) => `${e.source}->${e.target}`).sort(), [`${LB_PUB}->${VNET_A}`, `${LB_PUB}->ghost:${AKS}`].sort(), "vm1 line rolls up to the collapsed VNet; AKS (eastus) is a ghost");
  assert.ok(closed.edges.every((e) => e.source !== e.target));
});

test("an expanded stack keeps its slot as a fold tile: same spot, no edges, not exported", () => {
  const STACK = `stack:${A2}:vm`;
  const shut = layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
  const open = layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set([STACK]) });
  const stack = shut.shapes.find((s) => s.id === STACK)!;
  const fold = open.shapes.find((s) => s.id === `fold:${STACK}`)!;
  assert.ok(fold && fold.shape === "fold", "fold tile drawn");
  if (fold.shape !== "fold") return;
  assert.equal(fold.ref, STACK);
  assert.equal(fold.n, 7);
  assert.equal(fold.parent, A2);
  assert.deepEqual({ x: fold.x, y: fold.y, w: fold.w, h: fold.h }, { x: stack.x, y: stack.y, w: stack.w, h: stack.h }, "the click target stays where the stack was");
  assert.ok(![...open.shownAt.values()].some((v) => v.startsWith("fold:")), "nothing is shown at a fold tile");
  assert.ok(open.edges.every((e) => !e.source.startsWith("fold:") && !e.target.startsWith("fold:")));
  // A run at or below the threshold has no stack, so an expanded id for it draws no fold
  const small = layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set([`stack:${A1}:vm`]) });
  assert.ok(!small.shapes.some((s) => s.shape === "fold"));
  // Lanes too (PaaS group)
  const LANE = "stack:paas:data:koreacentral:storage";
  const lane = layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set([LANE]) });
  checkGeometry(lane);
  assert.equal(lane.shapes.find((s) => s.id === `fold:${LANE}`)?.parent, "paas:data:koreacentral");
});

test("all-regions view: every VNet starts collapsed; geometry still valid", () => {
  const col = initialCollapsed(model, "all");
  assert.deepEqual([...col].sort(), [VNET_A, VNET_B].sort());
  const L = layoutArch(model, { region: "all", collapsed: col, expandedStacks: new Set() });
  checkGeometry(L);
  assert.equal(L.offscreen.length, 0);
  assert.ok(L.shapes.filter((s) => s.shape === "pill").length === 2);
});

test("deterministic: input order does not change the layout", () => {
  const shuffled: ArchitectureGraph = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
  const a = layoutArch(buildArchModel(graph), { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
  const b = layoutArch(buildArchModel(shuffled), { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
  assert.deepEqual(JSON.stringify(a.shapes), JSON.stringify(b.shapes));
  assert.deepEqual(JSON.stringify(a.edges), JSON.stringify(b.edges));
});

test("any node kind is placed exactly once without throwing", () => {
  const kinds = ["subscription", "resourceGroup", "vnet", "subnet", "nsg", "nic", "vm", "vmss", "lb", "appGateway", "frontDoor", "trafficManager", "aks", "containerApp", "privateEndpoint", "storage", "sql", "cosmosDb", "redis", "postgres", "keyVault", "appInsights", "logAnalytics", "firewall", "functionApp", "appService", "serviceBus", "eventHub", "dns", "publicIP", "natGateway", "unknown", "somethingNew"];
  const g: ArchitectureGraph = { generatedAt: "x", edges: [], nodes: kinds.map((k, i) => ({ id: `${SUB}/resourcegroups/r/providers/x/y/n${i}`, kind: k as ArchitectureNode["kind"], name: `n${i}`, location: "westeurope" })) };
  const mm = buildArchModel(g);
  assert.equal(mm.accounting.size, kinds.length);
  const L = layoutArch(mm, { region: "all", collapsed: new Set(), expandedStacks: new Set() });
  checkGeometry(L);
});

test("search and header width helpers", () => {
  assert.deepEqual(searchArch(model, "20.0.0.1"), [vmId("vm1")]);
  assert.ok(searchArch(model, "10.0.2.0/24").includes(A2));
  assert.deepEqual(searchArch(model, "   "), []);
  assert.equal(labelWidth("a", undefined, 0, 220), 220);
  assert.equal(labelWidth("x".repeat(500), "10.0.0.0/16", 0, 220), 640);
  assert.ok(labelWidth("가나다라", undefined, 0, 0) > labelWidth("abcd", undefined, 0, 0));
  assert.equal(ARCH.STACK_AT, 6);
});

// ── Category filter (표시 범위) ──
const { filterArchModel, archCategoryOf, categoryCounts, ARCH_CATEGORIES } = m;
const cat = (...c: Parameters<typeof archCategoryOf>[0][]) => new Set(c as ns.ArchCategory[]);

test("filter: no filter (null or all nine) returns the same model and the same layout", () => {
  for (const c of [null, new Set(ARCH_CATEGORIES)]) {
    const v = filterArchModel(model, c);
    assert.equal(v.model, model);
    assert.equal(v.active, false);
  }
  const opts = { region: "koreacentral", collapsed: new Set<string>(), expandedStacks: new Set<string>() };
  assert.deepEqual(JSON.stringify(layoutArch(filterArchModel(model, null).model, opts).shapes), JSON.stringify(layoutArch(model, opts).shapes));
});

test("filter: categories partition the tiles; unknown kinds are 'other', PE is network", () => {
  const seen = new Map<string, string>();
  for (const c of ARCH_CATEGORIES) {
    for (const r of model.resources.values()) if (archCategoryOf(r.node.kind) === c) {
      assert.ok(!seen.has(r.id), `${r.id} in two categories`);
      seen.set(r.id, c);
    }
  }
  assert.equal(seen.size, model.resources.size);
  assert.equal(archCategoryOf("somethingNew"), "other");
  assert.equal(archCategoryOf("privateEndpoint"), "network");
  const counts = categoryCounts(model, "all");
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), model.resources.size);
});

test("filter compute: LB kept as one-hop context, Key Vault gone, no false ghosts", () => {
  const v = filterArchModel(model, cat("compute"));
  assert.ok(v.active);
  assert.ok(v.context.has(LB_PUB), "LB routes to a VM → context");
  assert.ok(!v.model.regions.some((r) => r.paas.security.includes(KV)));
  assert.equal(v.model.accounting, model.accounting);
  assert.equal(v.model.totals, model.totals);
  assert.equal(v.model.resources, model.resources);
  const L = layoutArch(v.model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
  checkGeometry(L);
  const ghosts = L.shapes.filter((s) => s.shape === "ghost").map((s) => (s as { ref: string }).ref);
  for (const g of ghosts) assert.notEqual(model.resources.get(g)?.region, "koreacentral", `ghost ${g} is in the shown region`);
  assert.ok(!L.shapes.some((s) => s.id === APPGW), "App Gateway (network, no route to compute) is hidden");
  assert.ok(L.edges.some((e) => e.kind === "ingress"), "internet entry to the context LB stays");
});

test("filter security: PE kept as context with its subnet and VNet only; LB is not context (one hop)", () => {
  const v = filterArchModel(model, cat("security"));
  assert.ok(v.context.has(PE));
  assert.ok(!v.context.has(LB_PUB));
  assert.deepEqual([...v.model.subnets.keys()], [A1]);
  assert.deepEqual([...v.model.vnets.keys()], [VNET_A]);
  assert.equal(v.model.subnets.get(A1)!.resources.join(), PE);
  assert.equal(v.hiddenIn.get(A1), model.subnets.get(A1)!.resources.length - 1);
  assert.ok((v.hiddenIn.get(VNET_A) ?? 0) > 0);
  assert.equal(model.subnets.get(A1)!.resources.length > 1, true, "original model untouched");
});

test("filter network: every VNet and subnet stays (peering / CIDR are network information)", () => {
  const v = filterArchModel(model, cat("network"));
  assert.equal(v.model.vnets.size, model.vnets.size);
  assert.equal(v.model.subnets.size, model.subnets.size);
  assert.ok(v.model.edges.some((e) => e.kind === "peering"));
});

test("filter: lines split exactly into kept / crossing / internal; kept lines have shown ends", () => {
  for (const c of ARCH_CATEGORIES) {
    const v = filterArchModel(model, cat(c));
    assert.equal(v.model.edges.length + v.crossing.length + v.internal, model.edges.length, c);
    const L = layoutArch(v.model, { region: "all", collapsed: new Set(), expandedStacks: new Set(), layers: new Set(ns.ARCH_EDGE_KINDS) });
    checkGeometry(L);
  }
});

test("filter: in 'all' view the filtered model does not start fully collapsed", () => {
  const v = filterArchModel(model, cat("compute"));
  assert.equal(initialCollapsed(v.model, "all", 24, true).size, 0);
  assert.equal(initialCollapsed(model, "all").size, 2, "unfiltered all-regions view still collapses every VNet");
});

// ── catalog REG / VMSS-03 / LB-04 rules (docs/architecture/azure-resource-relationships.md) ──


test("example graph: regional services in their region, only Front Door and DNS zones global, PaaS by network mode", () => {
  const model = buildArchModel(mockArchitectureGraph);
  const kinds = (ids: string[]) => ids.map((i) => model.resources.get(i)!.node.kind).sort();
  assert.deepEqual(kinds(model.global), ["dns", "frontDoor"]);
  assert.equal(model.regions.length, 1);
  const reg = model.regions[0]!;
  assert.equal(reg.key, "koreacentral");
  const subnetOf = (name: string) => model.resources.get([...model.resources.keys()].find((k) => model.resources.get(k)!.node.name === name)!)!.subnetId?.split("/").pop();
  assert.equal(subnetOf("agw-sample"), "snet-agw");
  assert.equal(subnetOf("aks-sample"), "snet-aks");
  assert.equal(subnetOf("kubernetes-internal"), "snet-aks");
  assert.equal(subnetOf("pe-sql-orders"), "snet-pe");
  assert.equal(subnetOf("pg-orders"), "snet-db", "PostgreSQL Flexible private access sits in its delegated subnet (PAAS-02)");
  assert.deepEqual(reg.paas.data.map((i) => model.resources.get(i)!.node.name), ["sql-orders"], "SQL logical server in the region's PaaS lane (PAAS-05)");
  assert.deepEqual(reg.paas.security.map((i) => model.resources.get(i)!.node.name), ["kv-sample"]);
  const kinds2 = model.edges.map((e) => e.kind).sort();
  assert.ok(kinds2.includes("ingress"), "Internet → App Gateway public frontend");
  assert.ok(kinds2.includes("privateLink") && kinds2.includes("routes"));
  assert.equal(model.accounting.size, mockArchitectureGraph.nodes.length, "every example node accounted once");
});

test("no location → region unknown (never global); location 'global' → global box", () => {
  const graph: ArchitectureGraph = { generatedAt: "", nodes: [
    { id: KV, kind: "keyVault", name: "kv-noloc" },
    { id: FD, kind: "frontDoor", name: "fd", location: "global" },
    { id: ODD, kind: "storage", name: "st", location: "global" },
  ], edges: [] };
  const model = buildArchModel(graph);
  assert.deepEqual(model.regions.map((r) => r.key), ["unknown"]);
  assert.deepEqual(model.regions[0]!.paas.security, [KV]);
  assert.deepEqual([...model.global].sort(), [FD, ODD].sort());
});

test("Flexible scale set: instance VMs are absorbed into the scale-set tile; their NIC places it; lines land on it", () => {
  const FLEX = rid("rg1", "microsoft.compute/virtualmachinescalesets", "vmss-web");
  const graph: ArchitectureGraph = { generatedAt: "", nodes: [
    { id: VNET_A, kind: "vnet", name: "vnet-a", location: "koreacentral" },
    { id: A1, kind: "subnet", name: "a1", location: "koreacentral" },
    { id: FLEX, kind: "vmss", name: "vmss-web", location: "koreacentral", metadata: { orchestrationMode: "Flexible" } },
    { id: vmId("vmss-web_1"), kind: "vm", name: "vmss-web_1", location: "koreacentral" },
    { id: nicId("vmss-web-nic"), kind: "nic", name: "vmss-web-nic", endpoint: "10.0.1.4", location: "koreacentral" },
    { id: APPGW, kind: "appGateway", name: "agw", location: "koreacentral" },
    { id: LB_PUB, kind: "lb", name: "kubernetes", location: "koreacentral", metadata: { inboundRules: 0 } },
    { id: pipId("pip-k"), kind: "publicIP", name: "pip-k", endpoint: "203.0.113.30", location: "koreacentral", metadata: { attachedTo: LB_PUB } },
  ], edges: [
    { id: "1", kind: "contains", source: VNET_A, target: A1 },
    { id: "2", kind: "attached-to", source: A1, target: nicId("vmss-web-nic") },
    { id: "3", kind: "bound-to", source: nicId("vmss-web-nic"), target: vmId("vmss-web_1") },
    { id: "4", kind: "member-of", source: vmId("vmss-web_1"), target: FLEX },
    { id: "5", kind: "routes", source: APPGW, target: nicId("vmss-web-nic") },
  ] };
  const model = buildArchModel(graph);
  const tile = model.resources.get(FLEX)!;
  assert.equal(tile.subnetId, A1, "placed by the instance NIC");
  assert.deepEqual(tile.instances, ["vmss-web_1"]);
  assert.deepEqual(tile.privateIps, ["10.0.1.4"]);
  assert.ok(!model.resources.has(vmId("vmss-web_1")), "no separate VM tile");
  assert.equal(model.accounting.get(vmId("vmss-web_1"))?.into, FLEX);
  assert.equal(model.accounting.get(nicId("vmss-web-nic"))?.into, FLEX);
  assert.ok(model.edges.some((e) => e.kind === "routes" && e.source === APPGW && e.target === FLEX), "AGW → instance lands on the scale set");
  assert.ok(!model.edges.some((e) => e.kind === "ingress" && e.target === LB_PUB), "an LB with no inbound rule is not an Internet entry (LB-04)");
  assert.equal(model.accounting.get(pipId("pip-k"))?.into, LB_PUB, "its public IP is still shown on it");
});
