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
  assert.deepEqual(disc.map((c) => [c.name, c.status, c.parent]).sort(), [["cache-redis", "stale", "ns:shop"], ["legacy-cron", "stale", "ns:shop"]]);
  assert.equal(map.totals.discovered, 2);
  assert.equal(map.totals.netLinks, 3);
  assert.equal(map.totals.links, 2, "trace links counted apart from network links");
  assert.equal(map.links.find((l) => l.id === "web>pay")!.net!.flows, 20);
  assert.equal(map.links.find((l) => l.id === "web>pay")!.edge.requests, 0, "a network link carries no request count");
  assert.equal(M.buildApmMap({ ...graph, windowMinutes: 60 }, { failing: true }, net).totals.netLinks, 0);
  assert.equal(M.buildApmMap({ ...graph, windowMinutes: 60 }).totals.discovered, 0, "no discovery = the map as before");
});
