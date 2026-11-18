import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubbleServiceMapResponse, ServiceGraphResponse } from "@aud/types";
import * as dNs from "../../web/src/lib/apmDiscovery.ts";
import * as mNs from "../../web/src/lib/apmServiceMap.ts";

const D = ((dNs as unknown as { default?: typeof dNs }).default ?? dNs) as typeof dNs;
const M = ((mNs as unknown as { default?: typeof mNs }).default ?? mNs) as typeof mNs;

// Synthetic (2026-11-18 — 계측 없는 서비스 발견): Hubble workloads joined to trace services by exact names only.
const gnode = (service: string, ns: string | null, workload: string | null, entry = false): ServiceGraphResponse["nodes"][number] => ({
  service, entry, namespace: ns, workload: workload ? { namespace: ns!, name: workload, kind: "Deployment" } : null,
  inbound: { requests: 10, failed: 0, errorRate: 0 }, outbound: { requests: 0, failed: 0 },
});
const gedge = (client: string, server: string): ServiceGraphResponse["edges"][number] => ({ client, server, kind: "direct", requests: 10, rate: 0.1, failed: 0, errorRate: 0, p95: null, p99: null, lowTraffic: false });
const hnode = (ns: string, name: string, type: "workload" | "world" = "workload", flows = 100, dropped = 0) => ({
  id: `${ns}/${name}`, namespace: ns, workloadName: name, identity: 1, podCount: 2, serviceType: type, labels: {}, connectedTo: [],
  metrics: { totalFlows: flows, forwardedFlows: flows - dropped, droppedFlows: dropped, httpRequestsTotal: 0, httpErrorCount: 0, avgLatencyMs: null },
});
const hedge = (s: string, t: string, flows = 50, dropped = 0, port = 8080) => ({
  id: `${s}->${t}:${port}`, sourceId: s, destinationId: t, protocol: "TCP", port, bidirectional: false,
  metrics: { flowCount: flows, droppedCount: dropped, httpRequestCount: 0, httpErrorRate: 0, avgLatencyMs: null, flowsPerSecond: null }, verdict: "FORWARDED",
});
const graph = { nodes: [gnode("user", null, null, true), gnode("web", "shop", "web"), gnode("orders-svc", "shop", "orders"), gnode("pay", "shop", null)], edges: [gedge("user", "web"), gedge("web", "orders-svc")] };
const hubble = {
  totalFlowsAnalyzed: 1234, timeWindowMinutes: 5,
  nodes: [hnode("shop", "web"), hnode("shop", "orders"), hnode("shop", "pay"), hnode("shop", "cache-redis", "workload", 300, 4), hnode("shop", "legacy-cron"),
    hnode("kube-system", "coredns"), hnode("", "world", "world")],
  edges: [hedge("shop/web", "shop/orders"), hedge("shop/orders", "shop/cache-redis", 80, 4, 6379), hedge("shop/web", "shop/pay", 20), hedge("shop/legacy-cron", "shop/web", 5),
    hedge("shop/web", "kube-system/coredns", 900, 0, 53), hedge("shop/orders", "/world", 7)],
} as unknown as HubbleServiceMapResponse;

test("discovery: trace services matched by workload (graph) or a unique same name; the rest are discovered", () => {
  const n = D.discoverFromNetwork(graph, hubble);
  assert.equal(n.matched, 3, "web (graph workload) · orders (graph workload of orders-svc) · pay (unique same name)");
  assert.deepEqual(n.cards.map((c) => c.id), ["net:shop/cache-redis", "net:shop/legacy-cron"], "kube-system is out of the traced scope; world is not a workload");
  assert.deepEqual(n.cards[0], { id: "net:shop/cache-redis", namespace: "shop", workload: "cache-redis", flows: 300, dropped: 4, pods: 2 });
  // links: a discovered end, or two traced services with no trace edge (web→pay); web→orders has a trace edge already
  assert.deepEqual(n.links.map((l) => `${l.source}>${l.target}:${l.port}`), ["net:shop/legacy-cron>web:8080", "orders-svc>net:shop/cache-redis:6379", "web>pay:8080"]);
  assert.deepEqual(n.sample, { flows: 1234, windowMinutes: 5, namespaces: 1 });
  const all = D.discoverFromNetwork(graph, hubble, "all");
  assert.ok(all.cards.some((c) => c.id === "net:kube-system/coredns"), "all namespaces: coredns too");
  assert.ok(all.links.some((l) => l.target === "net:kube-system/coredns" && l.flows === 900));
});

test("the map: discovered cards in their namespace box, network links apart (no requests), failing-only hides them", () => {
  const net = D.discoverFromNetwork(graph, hubble);
  const map = M.buildApmMap({ ...graph, windowMinutes: 60 }, {}, net);
  const disc = map.cards.filter((c) => c.kind === "discovered");
  assert.deepEqual(disc.map((c) => [c.name, c.status, c.parent, c.h]).sort(), [["cache-redis", "stale", "disc:shop", M.DISC_CARD_H], ["legacy-cron", "stale", "disc:shop", M.DISC_CARD_H]],
    "small cards in the namespace's dashed 'not instrumented' box");
  assert.equal(map.boxes.find((b) => b.id === "disc:shop")!.members, 2);
  assert.equal(map.boxes.find((b) => b.id === "ns:shop")!.members, 5, "3 services + the 2 in its 'not instrumented' box");
  assert.equal(map.totals.discovered, 2);
  assert.equal(map.totals.netLinks, 3);
  assert.equal(map.totals.links, 2, "trace links counted apart from network links");
  assert.equal(map.links.find((l) => l.id === "web>pay")!.net!.flows, 20);
  assert.equal(map.links.find((l) => l.id === "web>pay")!.edge.requests, 0, "a network link carries no request count");
  assert.equal(M.buildApmMap({ ...graph, windowMinutes: 60 }, { failing: true }, net).totals.netLinks, 0);
  assert.equal(M.buildApmMap({ ...graph, windowMinutes: 60 }).totals.discovered, 0, "no discovery = the map as before");
});

test("the map (2nd pass): traced services keep their places; a namespace without traces = one card until opened; nothing lost", () => {
  const plain = M.buildApmMap({ ...graph, windowMinutes: 60 });
  const all = D.discoverFromNetwork(graph, hubble, "all");
  const map = M.buildApmMap({ ...graph, windowMinutes: 60 }, {}, all);
  const at = (m: typeof map) => Object.fromEntries(m.cards.filter((c) => c.kind === "service" || c.kind === "entry").map((c) => [c.id, [c.x, c.y]]));
  assert.deepEqual(at(map), at(plain), "switching discovery on does not move a traced service");
  // kube-system holds no traced service → one card in the lane of closed namespaces
  const g = map.cards.find((c) => c.id === "nsg:kube-system")!;
  assert.deepEqual([g.kind, g.members, g.net, g.parent], ["nsGroup", 1, { flows: 100, dropped: 0, pods: 2 }, "lane:untraced"]);
  assert.equal(map.links.find((l) => l.id === "web>nsg:kube-system")!.net!.flows, 900, "the connection goes to the namespace card");
  // conservation: every discovered workload is a card or counted in its namespace card; every flow is on a line
  assert.equal(map.totals.discovered, all.cards.length);
  assert.equal(map.totals.closedNamespaces, 1);
  const flows = (links: { net?: { flows: number } }[]) => links.reduce((n, l) => n + (l.net?.flows ?? 0), 0);
  assert.equal(flows(map.links), all.links.reduce((n, l) => n + l.flows, 0), "no flow lost when ends are folded into a namespace card");
  // opened: its workloads as small cards in their own box, the lane gone
  const open = M.buildApmMap({ ...graph, windowMinutes: 60 }, { open: new Set(["kube-system"]) }, all);
  assert.deepEqual(open.cards.filter((c) => c.namespace === "kube-system").map((c) => [c.id, c.kind, c.parent]), [["net:kube-system/coredns", "discovered", "nso:kube-system"]]);
  assert.equal(open.boxes.some((b) => b.kind === "untraced"), false);
  assert.equal(open.totals.discovered, all.cards.length);
  // two connections into the same closed namespace are summed into one line (busiest port kept, count said)
  const two = { ...all, cards: [...all.cards, { id: "net:kube-system/metrics", namespace: "kube-system", workload: "metrics", flows: 10, dropped: 1, pods: 1 }],
    links: [...all.links, { source: "web", target: "net:kube-system/metrics", flows: 30, dropped: 1, port: 443, protocol: "TCP" }] };
  const merged = M.buildApmMap({ ...graph, windowMinutes: 60 }, {}, two).links.find((l) => l.id === "web>nsg:kube-system")!;
  assert.deepEqual(merged.net, { flows: 930, dropped: 1, port: 53, protocol: "TCP", merged: 2 });
});
