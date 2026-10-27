import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubbleServiceEdge, HubbleServiceNode } from "@aud/types";
import * as ns from "../../web/src/lib/k8sNetMap.ts";

const m = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;

// Synthetic cluster (fake names): Internet → web(app) → api(app) → db(data), api ↔ cache cycle, api → API server
const node = (namespace: string, workloadName: string, serviceType: HubbleServiceNode["serviceType"] = "workload", drops = 0): HubbleServiceNode => ({
  id: `${namespace}/${workloadName}`, namespace, workloadName, identity: 1, podCount: 2, serviceType, labels: {}, connectedTo: [],
  metrics: { totalFlows: 10, forwardedFlows: 10 - drops, droppedFlows: drops, httpRequestsTotal: 0, httpErrorCount: 0, avgLatencyMs: null, dnsQueryCount: 0, dnsErrorCount: 0 },
});
const edge = (s: string, d: string, port: number, verdict: HubbleServiceEdge["verdict"] = "FORWARDED", flows = 10): HubbleServiceEdge => ({
  id: `${s}->${d}:${port}`, sourceId: s, destinationId: d, protocol: "TCP", port, bidirectional: false, verdict,
  metrics: { flowCount: flows, droppedCount: verdict === "DROPPED" ? flows : 0, httpRequestCount: 0, httpErrorRate: 0, avgLatencyMs: null, flowsPerSecond: null },
});
const nodes = [node("", "world", "world"), node("app", "web"), node("app", "api"), node("app", "cache"), node("data", "db", "workload", 3), node("", "kube-apiserver", "kube-apiserver"), node("kube-system", "coredns")];
const edges = [
  edge("/world", "app/web", 443), edge("app/web", "app/api", 8080), edge("app/api", "data/db", 5432, "DROPPED", 3),
  edge("app/api", "app/cache", 6379), edge("app/cache", "app/api", 8080), edge("app/api", "/kube-apiserver", 443), edge("app/api", "/world", 443),
  edge("app/web", "kube-system/coredns", 53),
];

test("request steps: longest path left → right, a cycle shares one step", () => {
  const s = m.requestSteps(["a", "b", "c", "d"], [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "b" }, { source: "c", target: "d" }]);
  assert.deepEqual([...s.entries()].sort(), [["a", 0], ["b", 1], ["c", 1], ["d", 2]]);
});

test("map: Internet split in/out, namespaces as boxes in request order, platform on the right, drops marked", () => {
  const mem = m.remember(m.emptyMemory(), { nodes, edges }, 1000, 60_000);
  const map = m.buildNetMap(mem);
  const card = (id: string) => map.cards.find((c) => c.id === id)!;
  assert.equal(card("/world#in").kind, "internetIn");
  assert.equal(card("/world#out").kind, "internetOut");
  assert.equal(card("/kube-apiserver").kind, "platform");
  assert.ok(card("/world#in").x < card("app/web").x && card("app/web").x < card("app/api").x, "left → right by request step");
  assert.ok(card("/kube-apiserver").x > card("data/db").x, "cluster parts on the right");
  assert.equal(card("data/db").status, "danger");
  assert.equal(map.links.find((l) => l.id.startsWith("app/api->data/db"))!.tone, "drop");
  assert.deepEqual(map.boxes.filter((b) => b.kind === "namespace").map((b) => b.title), ["app", "data", "kube-system"], "system namespaces last");
  assert.equal(card("app/web").parent, "ns:app");
  // no card overlaps another
  for (const a of map.cards) for (const b of map.cards) {
    if (a === b) continue;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
});

test("stability: the same structure lays out the same; a sample without an edge keeps it faded, the TTL forgets it", () => {
  const a = m.buildNetMap(m.remember(m.emptyMemory(), { nodes, edges }, 1000, 60_000));
  const b = m.buildNetMap(m.remember(m.emptyMemory(), { nodes: [...nodes].reverse(), edges: [...edges].reverse() }, 1000, 60_000));
  assert.deepEqual(a.cards.map((c) => [c.id, c.x, c.y]), b.cards.map((c) => [c.id, c.x, c.y]), "input order does not move cards");
  let mem = m.remember(m.emptyMemory(), { nodes, edges }, 1000, 60_000);
  mem = m.remember(mem, { nodes: nodes.filter((n) => n.workloadName !== "cache"), edges: edges.filter((e) => !e.id.includes("cache")) }, 31_000, 60_000);
  const faded = m.buildNetMap(mem);
  assert.equal(faded.cards.find((c) => c.id === "app/cache")!.status, "stale");
  assert.ok(faded.links.filter((l) => l.id.includes("cache")).every((l) => l.stale));
  assert.equal(faded.structure, a.structure, "nothing appeared or disappeared → same layout key");
  mem = m.remember(mem, { nodes: nodes.filter((n) => n.workloadName !== "cache"), edges: [] }, 70_000, 60_000);
  assert.ok(!m.buildNetMap(mem).cards.some((c) => c.id === "app/cache"), "forgotten after the TTL");
});

test("filters: verdict keeps its links and their cards; search keeps the match and the Internet / platform it talks to", () => {
  const mem = m.remember(m.emptyMemory(), { nodes, edges }, 1000, 60_000);
  const dropped = m.buildNetMap(mem, { verdict: "DROPPED" });
  assert.deepEqual(dropped.cards.map((c) => c.id).sort(), ["app/api", "data/db"]);
  const web = m.buildNetMap(mem, { search: "web" });
  assert.deepEqual(web.cards.map((c) => c.id).sort(), ["/world#in", "app/web"]);
  assert.equal(m.shortWorkload("app-orders", "app"), "orders");
  assert.equal(m.shortWorkload("orders", "app"), "orders");
});

test("hub links (cluster DNS · API server · nodes) are marked, counted on the source card and do not order the path", () => {
  const map = m.buildNetMap(m.remember(m.emptyMemory(), { nodes, edges }, 1000, 60_000));
  assert.equal(map.links.find((l) => l.target === "kube-system/coredns")!.hub, "dns");
  assert.equal(map.links.find((l) => l.target === "/kube-apiserver")!.hub, "api");
  assert.equal(map.links.find((l) => l.target === "app/api")!.hub, null);
  const web = map.cards.find((c) => c.id === "app/web")!;
  const api = map.cards.find((c) => c.id === "app/api")!;
  assert.deepEqual([web.hubs, api.hubs], [{ dns: 1, api: 0, node: 0 }, { dns: 0, api: 1, node: 0 }]);
  assert.equal(map.cards.find((c) => c.id === "kube-system/coredns")!.rank, 0, "a DNS hub is not pushed right by every caller");
  assert.equal(m.hubOf({ serviceType: "host", namespace: "", workloadName: "host" }), "node");
});
