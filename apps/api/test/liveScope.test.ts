import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec, LiveDiagramSnapshot } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as scopeNs from "../../web/src/lib/liveScope.ts";
import * as formatNs from "../../web/src/lib/format.ts";

const scope = ((scopeNs as unknown as { default?: typeof scopeNs }).default ?? scopeNs) as typeof scopeNs;
const fmt = ((formatNs as unknown as { default?: typeof formatNs }).default ?? formatNs) as typeof formatNs;
const { scopeSpec, scopeCoverage, edgeLayer, isDirectedEdge, isInferredEdge, DEFAULT_EDGE_LAYERS, scopeImpacts, impactView } = scope;

// ── synthetic diagram: two VNets in Korea Central, one in East US, PaaS + Internet outside ──

const group = (id: string, parentId?: string, location = "koreacentral"): DiagramNodeSpec => ({
  id, label: id, icon: parentId ? "subnet" : "vnet", nodeType: "group", parentId, location, bindings: {},
});
const res = (id: string, parentId?: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({
  id, label: id, icon: "vm", parentId, location: "koreacentral", bindings: {}, ...extra,
});
const edge = (id: string, source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({
  id, source, target, bindings: {}, ...extra,
});

const SPEC: DiagramSpec = {
  version: "1", id: "t", name: "t", createdAt: "", updatedAt: "", groups: [],
  settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" },
  nodes: [
    group("vnet-a"), group("snet-a1", "vnet-a"),
    res("vm-a", "snet-a1"), res("pe-a", "snet-a1", { icon: "privateEndpoint", resourceKind: "privateEndpoint" }),
    group("vnet-b"), group("snet-b1", "vnet-b"), res("vm-b", "snet-b1"), res("lb-b", "snet-b1", { resourceKind: "lb" }),
    group("vnet-us", undefined, "eastus"), group("snet-us", "vnet-us", "eastus"), res("vm-us", "snet-us", { location: "eastus" }),
    res("kv", undefined, { icon: "keyVault", resourceKind: "keyVault" }),
    res("pg", undefined, { icon: "postgres", resourceKind: "postgres" }),
    res("inet-a", undefined, { icon: "internet", resourceKind: "internet" }),
    res("pip-a", undefined, { icon: "publicIP", resourceKind: "publicIP" }),
  ],
  edges: [
    edge("pl", "pe-a", "kv", { edgeKind: "privateLink" }),
    edge("out", "vm-a", "inet-a", { edgeKind: "outbound-internet" }),
    edge("lb-route", "lb-b", "vm-a", { edgeKind: "routes", flowType: "ingress" }), // cross-VNet backend
    edge("guess", "vm-a", "pg", { edgeKind: "inferred", evidence: "inferred" }),
    edge("guess-us", "vm-us", "vm-a", { evidence: "inferred" }),
    edge("pip", "pip-a", "vm-a", { edgeKind: "network" }),
    edge("b-internal", "lb-b", "vm-b", { edgeKind: "routes" }),
  ],
};

test("selected VNet: its contents + configured neighbours; another VNet's resource is a ghost, not its VNet", () => {
  const out = scopeSpec(SPEC, new Set(["vnet-a"]));
  const ids = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["inet-a", "kv", "lb-b", "pe-a", "pip-a", "snet-a1", "vm-a", "vnet-a"]);
  // exactly one top-level group box
  assert.deepEqual(out.nodes.filter((n) => n.nodeType === "group" && !n.parentId).map((n) => n.id), ["vnet-a"]);
  const ghost = out.nodes.find((n) => n.id === "lb-b")!;
  assert.equal(ghost.parentId, undefined);
  assert.equal(ghost.metadata?.ghostOf, "vnet-b");
  // guesses never widen the scope (pg, vm-us stay out); their edges vanish with the endpoints
  assert.ok(!ids.includes("pg") && !ids.includes("vm-us"));
  assert.deepEqual(out.edges.map((e) => e.id).sort(), ["lb-route", "out", "pip", "pl"]);
});

test("guesses widen the scope only when the inferred layer asks for it", () => {
  const out = scopeSpec(SPEC, new Set(["vnet-a"]), new Set(), { includeInferred: true });
  const ids = out.nodes.map((n) => n.id);
  assert.ok(ids.includes("pg"));
  // a guessed neighbour inside another VNet is a ghost like any other
  assert.equal(out.nodes.find((n) => n.id === "vm-us")?.metadata?.ghostOf, "vnet-us");
  assert.ok(out.edges.some((e) => e.id === "guess") && out.edges.some((e) => e.id === "guess-us"));
});

test("scope does not depend on edge order", () => {
  const ref = JSON.stringify(scopeSpec(SPEC, new Set(["vnet-a"])).nodes.map((n) => n.id).sort());
  let seed = 7;
  for (let i = 0; i < 50; i++) {
    const edges = [...SPEC.edges].sort(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5);
    const out = scopeSpec({ ...SPEC, edges }, new Set(["vnet-a"]));
    assert.equal(JSON.stringify(out.nodes.map((n) => n.id).sort()), ref);
  }
});

test("each VNet alone yields exactly one top-level group", () => {
  for (const v of ["vnet-a", "vnet-b", "vnet-us"]) {
    const tops = scopeSpec(SPEC, new Set([v])).nodes.filter((n) => n.nodeType === "group" && !n.parentId);
    assert.deepEqual(tops.map((n) => n.id), [v]);
  }
});

test("region filter keeps other regions' resources out", () => {
  const out = scopeSpec(SPEC, new Set(), new Set(["koreacentral"]));
  assert.ok(!out.nodes.some((n) => n.location === "eastus"));
  assert.ok(out.nodes.some((n) => n.id === "vnet-a") && out.nodes.some((n) => n.id === "vnet-b"));
});

test("nothing selected → whole diagram", () => {
  assert.equal(scopeSpec(SPEC, new Set()), SPEC);
});

test("edge layers: one per edge, guesses off by default", () => {
  const byId = new Map(SPEC.nodes.map((n) => [n.id, n]));
  const layer = (id: string) => edgeLayer(SPEC.edges.find((e) => e.id === id)!, byId);
  assert.equal(layer("pl"), "privateLink");
  assert.equal(layer("out"), "egress");
  assert.equal(layer("lb-route"), "config"); // backend routing is configuration, not Internet inbound
  assert.equal(edgeLayer({ id: "in", source: "inet-a", target: "lb-b", bindings: {}, flowType: "ingress" }, byId), "ingress");
  assert.equal(layer("guess"), "inferred");
  assert.equal(layer("guess-us"), "inferred"); // evidence alone marks a guess
  assert.equal(layer("pip"), "publicIp");
  assert.equal(layer("b-internal"), "config");
  assert.equal(DEFAULT_EDGE_LAYERS.has("inferred"), false);
  assert.equal(DEFAULT_EDGE_LAYERS.has("publicIp"), false);
});

test("old saved specs: edgeKind inferred without evidence is still a guess", () => {
  assert.equal(isInferredEdge({ edgeKind: "inferred" }), true);
  assert.equal(isInferredEdge({ edgeKind: "network" }), false);
});

test("arrowheads only where direction means something", () => {
  assert.equal(isDirectedEdge({ edgeKind: "routes" }), true);
  assert.equal(isDirectedEdge({ edgeKind: "privateLink" }), true);
  assert.equal(isDirectedEdge({ edgeKind: "outbound-internet" }), true);
  assert.equal(isDirectedEdge({ edgeKind: "peering" }), false);
  assert.equal(isDirectedEdge({ edgeKind: "network" }), false);
  assert.equal(isDirectedEdge({ edgeKind: "natgw-association" }), false);
  assert.equal(isDirectedEdge({ edgeKind: "inferred", flowType: "dependency" }), false);
});

test("coverage counts only what is in view, and only measured edges", () => {
  const view = scopeSpec(SPEC, new Set(["vnet-a"]));
  const withBinding = { ...view, nodes: view.nodes.map((n) => (n.id === "vm-a" ? { ...n, azureResourceId: "/x", bindings: { cpu: { source: "monitor" as const, metric: "Percentage CPU" } } } : n)) };
  const snap = {
    nodes: [{ id: "vm-a", health: "ok", healthScore: 1, metrics: { cpu: 12 }, activeAlertIds: [] }],
    edges: [
      { id: "out", status: "normal", metrics: { throughputBps: 1000 }, trafficLevel: "low", activeAlertIds: [], metricsSource: "measured" },
      { id: "pl", status: "normal", metrics: {}, trafficLevel: "none", activeAlertIds: [] },
    ],
  } as unknown as LiveDiagramSnapshot;
  assert.deepEqual(scopeCoverage(withBinding, snap), { nodesWithBindings: 1, nodesWithMetrics: 1, configuredEdges: 4, edgesWithTraffic: 1 });
});

test("formatBitsPerSec", () => {
  assert.equal(fmt.formatBitsPerSec(12_500_000), "12.5 Mbps");
  assert.equal(fmt.formatBitsPerSec(2_000_000), "2 Mbps");
  assert.equal(fmt.formatBitsPerSec(800), "800 bps");
  assert.equal(fmt.formatBitsPerSec(1_500), "1.5 Kbps");
  assert.equal(fmt.formatBitsPerSec(undefined), "-");
});

// ── Fault impact in view: the toolbar count and the canvas dimming read the same scoped list ──

test("an impact whose failing resource is outside the view never dims the view", () => {
  const view = new Set(["vm-a", "lb-a"]);
  const elsewhere = [{ sourceNodeId: "vm-other", severity: "critical" as const, trigger: "metric" as const, affectedNodeIds: ["lb-a"], affectedEdgeIds: ["e1"] }];
  const scoped = scopeImpacts(elsewhere, view);
  assert.equal(scoped.length, 0, "toolbar shows (0)");
  assert.equal(impactView(scoped).active, false, "and nothing is dimmed");
  assert.equal(impactView([]).active, false, "toggle off → empty list → nothing dimmed");
});

test("an impact in view keeps only neighbours in view and marks roles", () => {
  const view = new Set(["vm-a", "lb-a"]);
  const scoped = scopeImpacts([{ sourceNodeId: "vm-a", severity: "critical", trigger: "alert", affectedNodeIds: ["lb-a", "vm-elsewhere"], affectedEdgeIds: ["e1"] }], view);
  assert.deepEqual(scoped[0]!.affectedNodeIds, ["lb-a"]);
  const v = impactView(scoped);
  assert.equal(v.active, true);
  assert.equal(v.roles.get("vm-a"), "source");
  assert.equal(v.roles.get("lb-a"), "affected");
  assert.ok(v.edgeIds.has("e1"));
  assert.equal(scopeImpacts(undefined, view).length, 0);
});
