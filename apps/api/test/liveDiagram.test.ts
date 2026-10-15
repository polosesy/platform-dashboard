import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
  DiagramEdgeSpec,
  DiagramNodeSpec,
  DiagramSpec,
  HealthRule,
  LiveAlert,
  LiveNode,
} from "@aud/types";
import type { Env } from "../src/env.js";
import { computeHealthScore, resolveNodeHealth, resolveTrafficLevel } from "../src/services/healthCalculator.js";
import { buildFaultImpacts, buildLiveSnapshot, saveDiagramSpec } from "../src/services/liveAggregator.js";
import { inferImplicitEdges } from "../src/services/dependencyInference.js";
import { NODE_BINDINGS } from "../src/services/specGenerator.js";

// ── health: activity rules never decide health ──

const APPGW_RULES: HealthRule[] = [
  { metric: "rps", op: ">", threshold: 0, weight: 0.5 },
  { metric: "latency", op: "<", threshold: 500, weight: 0.5 },
];

test("idle resource (rps = 0) is not critical — activity rules are skipped", () => {
  assert.equal(computeHealthScore({ rps: 0, latency: 120 }, APPGW_RULES), 1);
  const h = resolveNodeHealth({ rps: 0, latency: 120 }, { health: { source: "composite", rules: APPGW_RULES } });
  assert.equal(h.health, "ok");
});

test("only activity metrics → health unknown, not ok and not critical", () => {
  assert.equal(computeHealthScore({ rps: 0, latency: null }, APPGW_RULES), null);
  assert.equal(resolveNodeHealth({ rps: 0 }, { health: { source: "composite", rules: APPGW_RULES } }).health, "unknown");
});

test("a quality rule that fails is still reported", () => {
  assert.equal(resolveNodeHealth({ rps: 50, latency: 2000 }, { health: { source: "composite", rules: APPGW_RULES } }).health, "critical");
});

test("metrics without a composite rule are not evidence of health", () => {
  assert.equal(resolveNodeHealth({ cpu: 12 }, { cpu: { source: "monitor", metric: "Percentage CPU" } }).health, "unknown");
});

// ── fault impact: configured links only ──

const live = (id: string, health: LiveNode["health"] = "ok"): LiveNode => ({ id, health, healthScore: 1, metrics: {}, activeAlertIds: [] });
const edge = (id: string, source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({ id, source, target, bindings: {}, ...extra });

test("impact follows configured links one hop, never guessed / Internet / NAT links", () => {
  const edges = [
    edge("e1", "db", "app", { edgeKind: "privateLink" }),
    edge("e2", "app", "db", { edgeKind: "inferred", evidence: "inferred" }),
    edge("e3", "db", "other", { evidence: "inferred" }), // old spec kind + new evidence
    edge("e4", "db", "internet", { edgeKind: "outbound-internet" }),
    edge("e5", "subnet", "db", { edgeKind: "natgw-association" }),
    edge("e6", "lb", "db", { edgeKind: "routes" }),
    edge("e7", "far", "app", { edgeKind: "network" }),
  ];
  const [impact] = buildFaultImpacts([live("db", "critical"), live("app"), live("lb"), live("far")], edges);
  assert.equal(impact.sourceNodeId, "db");
  assert.equal(impact.trigger, "metric");
  assert.deepEqual(impact.affectedNodeIds.sort(), ["app", "lb"]);
  assert.deepEqual(impact.affectedEdgeIds.sort(), ["e1", "e6"]);
  assert.equal("rippleRadius" in impact, false);
});

test("an active critical alert starts an impact even when metric health is ok", () => {
  const alert: LiveAlert = { id: "a1", severity: "critical", title: "t", resourceId: "r", firedAt: "", summary: "", affectedNodeIds: ["app"], affectedEdgeIds: [] };
  const warning: LiveAlert = { ...alert, id: "a2", severity: "warning", affectedNodeIds: ["db"] };
  const impacts = buildFaultImpacts([live("app"), live("db")], [edge("e1", "app", "db", { edgeKind: "network" })], [alert, warning]);
  assert.deepEqual(impacts.map((i) => [i.sourceNodeId, i.trigger]), [["app", "alert"]]);
});

// ── snapshot: nothing invented when nothing is measured ──

const ENV_OFF = { AZURE_LIVE_DIAGRAM_ENABLED: false } as unknown as Env;

function node(id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec {
  return { id, label: id, icon: "vm", bindings: {}, ...extra };
}

test("snapshot without measurements: no traffic, no assumed power state, coverage says why", async () => {
  const spec: DiagramSpec = {
    version: "1",
    id: "test-live-1",
    name: "t",
    createdAt: "",
    updatedAt: "",
    groups: [],
    settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" as DiagramSpec["settings"]["layout"] },
    nodes: [
      node("vm1", { azureResourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1", resourceKind: "vm", bindings: { cpu: { source: "monitor", metric: "Percentage CPU" } } }),
      node("db1", { resourceKind: "sql" }),
    ],
    edges: [edge("e1", "vm1", "db1", { edgeKind: "network" }), edge("e2", "vm1", "db1", { edgeKind: "inferred", evidence: "inferred" })],
  };
  saveDiagramSpec(spec);
  const snap = await buildLiveSnapshot(ENV_OFF, undefined, spec.id);
  assert.ok(snap);
  assert.equal(snap.dataSource, "azure");
  for (const e of snap.edges) {
    assert.equal(e.trafficLevel, "none");
    assert.equal(e.metricsSource, undefined);
    assert.deepEqual(e.metrics, {});
  }
  assert.equal(snap.nodes.find((n) => n.id === "vm1")?.powerState, undefined);
  assert.equal(snap.topology?.resolvedBindings, 0);
  assert.deepEqual(snap.coverage, {
    nodesWithMetrics: 0,
    nodesWithBindings: 1,
    edgesWithTraffic: 0,
    configuredEdges: 1,
    sources: { metrics: "disabled", traffic: "disabled", alerts: "disabled" },
  });
  assert.equal("heatmap" in snap, false);
});

// ── dependency inference: same region, ≥ 2 signals, no Private Endpoint duplicates ──

const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const res = (id: string, kind: ArchitectureNode["kind"], extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id,
  kind,
  name: id,
  azureId: `${SUB}/resourceGroups/${extra.resourceGroup ?? "rg-app"}/providers/x/${id}`,
  location: "koreacentral",
  resourceGroup: "rg-app",
  ...extra,
});

function infer(nodes: ArchitectureNode[], edges: ArchitectureEdge[] = []) {
  const graph: ArchitectureGraph = { nodes, edges } as ArchitectureGraph;
  return inferImplicitEdges(graph, nodes, new Set(), new Map(nodes.map((n) => [n.id, n.id])));
}

test("same RG + same name prefix in the same region → guessed edge with reasons", () => {
  const out = infer([res("shop-vm", "vm"), res("shop-pg", "postgres")]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].reasons, ["same-rg", "name-prefix"]);
  assert.equal(out[0].metadata.protocol, "TCP/5432");
});

test("one signal alone (only the resource group) is not enough", () => {
  assert.equal(infer([res("web-vm", "vm"), res("orders-db", "sql")]).length, 0);
});

test("different or unknown region → no guess", () => {
  assert.equal(infer([res("shop-vm", "vm"), res("shop-db", "sql", { location: "japaneast" })]).length, 0);
  assert.equal(infer([res("shop-vm", "vm", { location: undefined }), res("shop-db", "sql")]).length, 0);
  // region names are compared without case / spaces
  assert.equal(infer([res("shop-vm", "vm", { location: "Korea Central" }), res("shop-db", "sql")]).length, 1);
});

test("data service reached through a Private Endpoint is not guessed again", () => {
  const nodes = [res("shop-vm", "vm"), res("shop-kv", "keyVault"), res("pe1", "privateEndpoint")];
  assert.equal(infer(nodes, [{ id: "pl", source: "pe1", target: "shop-kv", kind: "privateLink" }]).length, 0);
});

// ── the generator's real binding rules (acceptance cases from the redesign) ──

test("real rules: idle App Gateway / Storage are unknown, a load balancer with a broken data path is critical", () => {
  assert.equal(resolveNodeHealth({ requests: 0, backend: null, errorRate: null }, NODE_BINDINGS.appGateway!).health, "unknown");
  assert.equal(resolveNodeHealth({ transactions: 0, availability: null }, NODE_BINDINGS.storage!).health, "unknown");
  // a few transactions do not judge availability (low-sample guard), enough of them do
  assert.equal(resolveNodeHealth({ transactions: 5, availability: 50 }, NODE_BINDINGS.storage!).health, "unknown");
  assert.equal(resolveNodeHealth({ transactions: 50, availability: 100 }, NODE_BINDINGS.storage!).health, "ok");
  assert.equal(resolveNodeHealth({ transactions: 50, availability: 95 }, NODE_BINDINGS.storage!).health, "warning");
  assert.equal(resolveNodeHealth({ dataPath: 40 }, NODE_BINDINGS.lb!).health, "critical");
});

test("leveled rules: hard thresholds win over a good average", () => {
  // every App Gateway backend down → critical even with no errors
  assert.equal(resolveNodeHealth({ requests: 100, backend: 0, errorRate: 0 }, NODE_BINDINGS.appGateway!).health, "critical");
  assert.equal(resolveNodeHealth({ requests: 100, backend: 50, errorRate: 0 }, NODE_BINDINGS.appGateway!).health, "warning");
  // one failed SNAT connection → warning on an otherwise healthy LB
  assert.equal(resolveNodeHealth({ dataPath: 100, backend: 100, snatFail: 3 }, NODE_BINDINGS.lb!).health, "warning");
  assert.equal(resolveNodeHealth({ cpu: 96, memory: 40 }, NODE_BINDINGS.vm!).health, "critical");
  assert.equal(resolveNodeHealth({ cpu: 90, memory: 40 }, NODE_BINDINGS.vm!).health, "warning");
  assert.equal(resolveNodeHealth({ cpu: 20, memory: 40 }, NODE_BINDINGS.vm!).health, "ok");
  // unleveled "> 0" activity rules are still ignored
  assert.equal(resolveNodeHealth({ rps: 0 }, { health: { source: "composite", rules: [{ metric: "rps", op: ">", threshold: 0, weight: 1 }] } }).health, "unknown");
});

test("traffic level comes from absolute bit/s bands", () => {
  assert.deepEqual([0, 5e4, 5e6, 5e7, 2e8].map((v) => resolveTrafficLevel(v)), ["none", "low", "medium", "high", "burst"]);
  assert.equal(resolveTrafficLevel(undefined), "none");
});
