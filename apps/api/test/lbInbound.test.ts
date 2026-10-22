import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, PrivateLinkUsageResponse } from "@aud/types";
import { joinLbInbound, type PluFlowRow } from "../src/services/privateLinkUsage.js";
import { effectiveBindings, privateFrontendBindings } from "../src/services/specGenerator.js";
import { scopeFromSpec } from "../src/services/privateLinkUsageCollector.js";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as lbNs from "../../web/src/lib/lbInbound.ts";

const W = ((lbNs as unknown as { default?: typeof lbNs }).default ?? lbNs) as typeof lbNs;

// ── a small internal LB scene (synthetic names, RFC 1918 / documentation addresses only) ──
const FE = JSON.stringify([{ name: "fe-int", kind: "private", ip: "10.152.3.20", listeners: [], ruleBound: true }, { name: "fe-pub", kind: "public", ip: "203.0.113.9", listeners: [], ruleBound: true }]);
const node = (id: string, icon: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec =>
  ({ id, label: id, icon, nodeType: "resource", bindings: {}, ...extra } as DiagramNodeSpec);
const nodes: DiagramNodeSpec[] = [
  node("vnet", "vnet", { nodeType: "group" }),
  node("sn-lbi", "subnet", { nodeType: "group", parentId: "vnet", metadata: { prefix: "10.152.3.0/24" } }),
  node("sn-agw", "subnet", { nodeType: "group", parentId: "vnet", metadata: { prefix: "10.152.1.0/24" } }),
  node("sn-aks", "subnet", { nodeType: "group", parentId: "vnet", metadata: { prefix: "10.152.8.0/22" } }),
  node("sn-vm", "subnet", { nodeType: "group", parentId: "vnet", metadata: { prefix: "10.152.5.0/24" } }),
  node("lbi", "lb", { resourceKind: "lb", parentId: "sn-lbi", metadata: { frontends: FE } }),
  node("agw", "appGateway", { resourceKind: "appGateway", parentId: "sn-agw" }),
  node("pool1", "vmss", { resourceKind: "vmss", parentId: "sn-aks", metadata: { archRole: "aks-vmss", aksClusterArmId: "/subscriptions/0/rg/aks1" } }),
  node("pool2", "vmss", { resourceKind: "vmss", parentId: "sn-aks", metadata: { archRole: "aks-vmss", aksClusterArmId: "/subscriptions/0/rg/aks1" } }),
  node("aks", "aks", { resourceKind: "aks", azureResourceId: "/subscriptions/0/rg/aks1" }),
  node("vm1", "vm", { resourceKind: "vm", parentId: "sn-vm", subResources: [{ id: "nic1", kind: "nic", label: "nic1", endpoint: "10.152.5.4" }] as DiagramNodeSpec["subResources"] }),
  node("backend", "vmss", { resourceKind: "vmss", parentId: "sn-vm" }),
];
const edges: DiagramEdgeSpec[] = [
  { id: "e-agw-lb", source: "agw", target: "lbi", edgeKind: "routes", bindings: {} } as DiagramEdgeSpec,
  { id: "e-lb-be", source: "lbi", target: "backend", edgeKind: "routes", bindings: {} } as DiagramEdgeSpec,
];
const spec = { id: "auto-test", name: "t", nodes, edges } as unknown as Parameters<typeof scopeFromSpec>[0];
const scope = scopeFromSpec(spec, "vnet")!;
const flow = (srcIp: string, destIp: string, extra: Partial<PluFlowRow> = {}): PluFlowRow => ({ srcIp, destIp, bytes: 1000, flows: 3, allowed: 3, denied: 0, last: "2026-10-20T06:00:00.000Z", ports: [8080], ...extra });
const input = {
  callers: scope.callers, subnets: scope.subnets, nics: [], nodeByArmId: scope.nodeByArmId, identities: new Map(),
  clusterOf: scope.clusterOf, outerSubnets: scope.outerSubnets, knownCidrs: scope.knownCidrs, sites: scope.sites,
};

test("scope: an internal LB's private frontends (a public frontend is not inbound from inside)", () => {
  assert.deepEqual(scope.lbs, [{ lbNodeId: "lbi", ips: ["10.152.3.20"] }]);
});

test("join: NIC caller, one AKS cluster for its node pools, App Gateway by its dedicated subnet; denied and unknown listed", () => {
  const out = joinLbInbound(input, scope.lbs, [
    flow("10.152.5.4", "10.152.3.20"),
    flow("10.152.8.9", "10.152.3.20"),
    flow("10.152.1.7", "10.152.3.20"),
    flow("10.152.5.99", "10.152.3.20", { allowed: 0, denied: 4 }),
    flow("10.99.0.5", "10.152.3.20"),
    flow("10.152.5.4", "10.0.0.1"), // not an LB frontend: ignored
  ]);
  const by = new Map(out.callers.map((c) => [c.callerNodeId, c]));
  assert.equal(by.get("vm1")?.attribution, "nic");
  assert.equal(by.get("aks")?.attribution, "aksCluster", "node pools of one cluster → that cluster");
  assert.deepEqual(by.get("aks")?.viaNodeIds, ["pool1", "pool2"]);
  assert.equal(by.get("agw")?.attribution, "subnetOwner", "an App Gateway subnet is dedicated");
  assert.deepEqual(by.get("vm1")?.frontendIps, ["10.152.3.20"]);
  assert.equal(by.get("vm1")?.id, "lbi:vm1>lbi");
  assert.deepEqual(out.unresolved.map((u) => u.reason).sort(), ["denied", "notInDiagram"]);
  assert.equal(out.unresolved.find((u) => u.reason === "notInDiagram")?.place?.kind, "private", "an address no subnet holds is placed, never guessed");
  assert.ok(out.callers.every((c) => c.lbNodeId === "lbi"));
});

test("bindings: per private frontend, filtered by FrontendIPAddress and Direction, one hour; public-only LB has none", () => {
  const b = privateFrontendBindings(FE);
  assert.deepEqual(Object.keys(b).sort(), ["feIn0", "feSyn0"]);
  assert.equal(b.feIn0!.metric, "ByteCount");
  assert.equal(b.feSyn0!.metric, "SYNCount");
  assert.equal(b.feIn0!.filter, "FrontendIPAddress eq '10.152.3.20' and Direction eq 'In'");
  assert.equal(b.feIn0!.window, "PT1H");
  assert.deepEqual(privateFrontendBindings(JSON.stringify([{ kind: "public", ip: "203.0.113.9" }])), {});
  assert.deepEqual(privateFrontendBindings("not json"), {});
  const eff = effectiveBindings({ resourceKind: "lb", icon: "lb", bindings: {}, metadata: { frontends: FE } });
  assert.ok(eff.dataPath && eff.feIn0, "the kind's table plus the frontend bindings");
  // never a status input
  assert.ok(!(eff.health?.rules ?? []).some((r) => r.metric.startsWith("fe")));
});

const resp = (callers: boolean): PrivateLinkUsageResponse => ({
  generatedAt: "", windowHours: 24, dataSource: "azure", endpoints: [], usages: [], unresolved: [], publicAccess: [],
  sources: [{ source: "vnetFlow", state: callers ? "ok" : "empty" }],
  lbInbound: {
    frontends: [{ lbNodeId: "lbi", ips: ["10.152.3.20"] }],
    callers: callers ? [{ id: "lbi:vm1>lbi", callerNodeId: "vm1", lbNodeId: "lbi", frontendIps: ["10.152.3.20"], attribution: "nic", evidence: [] }] : [],
    unresolved: [],
  },
});

test("card: the ladder — callers known, traffic with no known source, 0 measured, not measured", () => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lb = byId.get("lbi")!;
  const noAgw = edges.filter((e) => e.source !== "agw");
  const chip = (es: DiagramEdgeSpec[], metrics: Record<string, number | null> | undefined, r: PrivateLinkUsageResponse | null) =>
    W.lbInboundChips(W.lbInboundFacts(lb, es, byId, metrics, r)).map((c) => [c.key, c.vars?.count ?? null]);
  assert.deepEqual(chip(edges, undefined, null), [["ld.lbin.chip.callers", 1]], "the App Gateway's backend pool names the frontend (configuration)");
  assert.deepEqual(chip(edges, undefined, resp(true)), [["ld.lbin.chip.callers", 2]], "configured + observed");
  assert.deepEqual(chip(noAgw, { feIn0: 52_000 }, resp(false)), [["ld.lbin.chip.sourceUnknown", null]]);
  assert.deepEqual(chip(noAgw, { feIn0: 0 }, resp(false)), [["ld.lbin.chip.zeroBytes", null]], "0 bytes is said as LB bytes 0, never 'no inbound'");
  assert.deepEqual(chip(noAgw, { feIn0: null }, null), [["ld.lbin.chip.notMeasured", null]], "null is not 0");
  assert.deepEqual(W.lbInboundChips(W.lbInboundFacts(byId.get("backend")!, edges, byId, {}, null)), [], "not an LB → nothing");
  const pubOnly = { ...lb, metadata: { frontends: JSON.stringify([{ kind: "public", ip: "203.0.113.9" }]) } };
  assert.equal(W.lbInboundFacts(pubOnly, edges, byId, {}, null), null, "a public-only LB has the Internet line instead");
  assert.ok(W.isFrontendInboundKey("feIn0") && W.isFrontendInboundKey("feSyn2") && !W.isFrontendInboundKey("bytesIn"));
});

test("lines: observed callers → LB only when both ends are drawn, in the observed-use layer", () => {
  const lines = W.lbInboundEdges(resp(true), new Set(["vm1", "lbi"]));
  assert.deepEqual(lines.map((l) => [l.source, l.target, l.edgeKind, l.protocol, l.evidence]), [["vm1", "lbi", "privateLinkUsage", "lbFlow", "observed"]]);
  assert.equal(W.lbInboundEdges(resp(true), new Set(["lbi"])).length, 0);
  assert.equal(W.lbInboundEdges(null, new Set(["vm1", "lbi"])).length, 0);
});

test("card: a UDR next hop to this internal LB (configuration) replaces the bytes chip — UDR traffic is not in the LB metrics", () => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lb = byId.get("lbi")!;
  const udr = JSON.stringify({ state: "ok", routeTables: 1, subnets: 2, prefixes: 2, entries: [{ subnet: "snet-app", vnet: "spoke", routeTable: "rt-spoke", prefixes: ["0.0.0.0/0", "10.0.0.0/8"], frontendIp: "10.152.3.20" }] });
  const withUdr = { ...lb, metadata: { ...lb.metadata, udrNextHop: udr } };
  const by2 = new Map(byId).set("lbi", withUdr);
  const noAgw = edges.filter((e) => e.source !== "agw");
  const chips = (es: DiagramEdgeSpec[], n = withUdr) => W.lbInboundChips(W.lbInboundFacts(n, es, by2, { feIn0: 0 }, null)).map((c) => [c.key, c.vars?.count ?? null]);
  assert.deepEqual(chips(noAgw), [["ld.lbin.chip.udr", 2]]);
  assert.deepEqual(chips(edges), [["ld.lbin.chip.callers", 1], ["ld.lbin.chip.udr", 2]]);
  const none = { ...lb, metadata: { ...lb.metadata, udrNextHop: JSON.stringify({ state: "ok", routeTables: 0, subnets: 0, prefixes: 0, entries: [] }) } };
  assert.deepEqual(chips(noAgw, none), [["ld.lbin.chip.zeroBytes", null]], "no UDR → the bytes chip");
  const junk = { ...lb, metadata: { ...lb.metadata, udrNextHop: "{not json" } };
  assert.equal(W.lbInboundFacts(junk, noAgw, by2, {}, null)?.udr, null, "malformed metadata is ignored");
  assert.equal(W.lbInboundFacts(withUdr, noAgw, by2, {}, null)?.frontends[0]?.ruleBound, true, "rule binding of the frontend is carried");
});
