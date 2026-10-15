import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricBinding } from "@aud/types";
import { applyDerived, queryMetricsTolerant, queryResourceMetrics } from "../src/services/metricsCollector.js";
import { NODE_BINDINGS, edgeBindings, effectiveBindings, normalizeSpecBindings } from "../src/services/specGenerator.js";
import type { DiagramSpec } from "@aud/types";

const bucket = (average: number) => [{ timeStamp: "2026-01-01T00:00:00Z", average }];
const vm = Object.entries(NODE_BINDINGS.vm!).filter(([, b]) => b.source === "monitor") as Array<[string, MetricBinding]>;

test("VM memory is 100 − Available Memory Percentage, read with CPU in one request", async () => {
  const calls: string[][] = [];
  const out = await queryMetricsTolerant(vm, async (list) => {
    calls.push(list.map(([, b]) => b.metric!));
    return [["Percentage CPU", bucket(7.4)], ["Available Memory Percentage", bucket(79)], ["Network In Total", [{ timeStamp: "t", total: 1000 }]]];
  }, () => assert.fail("nothing rejected"));
  assert.equal(calls.length, 1);
  assert.equal(out.cpu, 7.4);
  assert.equal(out.memory, 21);
  assert.equal(out.network, 1000);
});

test("a resource without the memory metric keeps its CPU, and the rejected name is reported", async () => {
  const rejected: string[] = [];
  const out = await queryMetricsTolerant(vm, async (list) => {
    if (list.some(([, b]) => b.metric === "Available Memory Percentage")) throw new Error("ARM 400: Failed to find metric configuration");
    return list.map(([, b]) => [b.metric!, b.metric === "Percentage CPU" ? bucket(12) : [{ timeStamp: "t", total: 5 }]] as const);
  }, (m) => rejected.push(m));
  assert.equal(out.cpu, 12);
  assert.equal(out.memory, null, "unmeasured, not 100 % or 0 %");
  assert.deepEqual(rejected, ["Available Memory Percentage"]);
});

test("throttling on the optional metric is not remembered as unsupported", async () => {
  const rejected: string[] = [];
  const out = await queryMetricsTolerant(vm, async (list) => {
    if (list.some(([, b]) => b.metric === "Available Memory Percentage")) throw new Error("ARM 429: Too many requests");
    return [["Percentage CPU", bucket(3)]];
  }, (m) => rejected.push(m));
  assert.equal(out.cpu, 3);
  assert.deepEqual(rejected, []);
});

test("required metrics still fail loudly", async () => {
  const required: Array<[string, MetricBinding]> = [["cpu", { source: "monitor", metric: "Percentage CPU", aggregation: "avg" }]];
  await assert.rejects(queryMetricsTolerant(required, async () => { throw new Error("ARM 403: forbidden"); }, () => undefined), /403/);
});

test("saved specs are measured with the current table (renamed metrics and thresholds reach them)", () => {
  const old = { cpu: { source: "monitor" as const, metric: "percentProcessorTime", aggregation: "avg" as const }, health: { source: "composite" as const, rules: [] } };
  const redis = effectiveBindings({ icon: "redis", resourceKind: "redis", bindings: old });
  assert.ok(redis.load && redis.load.metric === "serverLoad" && !redis.cpu, "Redis card reads server load now");
  assert.equal(Object.values(effectiveBindings({ icon: "sql", resourceKind: "sql", bindings: {}, azureResourceId: "/subscriptions/x/resourceGroups/r/providers/Microsoft.Sql/servers/s" })).filter((b) => b.source === "monitor").length, 0, "a SQL logical server is not measured");
  assert.equal(Object.values(effectiveBindings({ icon: "publicIP", resourceKind: "publicIP", bindings: {}, metadata: { unused: "true" } })).filter((b) => b.source === "monitor").length, 0, "an unused public IP keeps 미사용");
  assert.equal(effectiveBindings({ icon: "custom", resourceKind: "somethingNew", bindings: old }), old, "unknown kinds keep the spec's");
  assert.ok(NODE_BINDINGS.vmss?.memory && NODE_BINDINGS.postgres?.memory, "scale sets and PostgreSQL report memory");
});

test("one request per dimension filter, names encoded, response names matched without case, scale after complement", async () => {
  const urls: string[] = [];
  const fetcher = { async fetchJson<T>(url: string): Promise<T> {
    urls.push(url);
    const names = decodeURIComponent(url.match(/metricnames=([^&]+)/)![1]!).split(",");
    const filtered = url.includes("%24filter") || url.includes("$filter");
    return { value: names.map((n) => ({ name: { value: n.toUpperCase() }, timeseries: [{ data: [{ timeStamp: "t", average: 100, total: filtered ? 600 : 6000 }] }] })) } as T;
  } };
  const v = await queryResourceMetrics(fetcher, "/subscriptions/x/lb", {
    dataPath: { source: "monitor", metric: "VipAvailability", aggregation: "avg" },
    bytesIn: { source: "monitor", metric: "ByteCount", aggregation: "total", filter: "Direction eq 'In'", scale: 8 / 60 },
    req: { source: "monitor", metric: "requests/count", aggregation: "total" },
  });
  assert.equal(urls.length, 2, "unfiltered + one filter");
  const f = urls.find((u) => u.includes("filter"))!;
  assert.ok(f.includes("&$filter=" + encodeURIComponent("Direction eq 'In'")), f);
  assert.ok(urls.some((u) => u.includes("requests%2Fcount")), "metric names are encoded");
  assert.equal(v.dataPath, 100);
  assert.equal(v.bytesIn, 80, "600 B/min × 8/60 = 80 bit/s");
  assert.equal(v.req, 6000);
});

test("derived values: shares, ratios and sums never invent a 0 out of nothing", () => {
  const b = { a: { source: "derived" as const, derive: { op: "share" as const, of: ["h", "u"] as [string, string] } }, r: { source: "derived" as const, derive: { op: "ratio" as const, of: ["f", "t"] as [string, string], minDenominator: 1 } }, s: { source: "derived" as const, derive: { op: "sum" as const, of: ["i", "o"] as [string, string] } } };
  assert.equal(applyDerived(b, { h: 3, u: 1, f: 1, t: 4, i: 2, o: 3 }).a, 75);
  assert.equal(applyDerived(b, { h: 0, u: 0 }).a, null, "0 / 0 → unmeasured, not 0 %");
  assert.equal(applyDerived(b, { f: 0, t: 0 }).r, null, "no requests → no error rate");
  assert.equal(applyDerived(b, { f: 1, t: 4 }).r, 25);
  assert.equal(applyDerived(b, { i: 2, o: 3 }).s, 5);
  assert.equal(applyDerived(b, { i: 2, o: null }).s, null);
});

test("the Internet line is measured on the entry it reaches (LB In bytes / App Gateway received), private links on the PE", () => {
  const nodes = new Map<string, any>([
    ["inet", { icon: "internet", resourceKind: "internet" }], ["lb", { icon: "lb", resourceKind: "lb" }],
    ["agw", { icon: "appGateway", resourceKind: "appGateway", subResources: [{ id: "f", label: "f", kind: "frontendIP", endpoint: "10.0.0.4" }] }],
    ["pe", { icon: "privateEndpoint", resourceKind: "privateEndpoint" }], ["kv", { icon: "keyVault", resourceKind: "keyVault" }], ["vm", { icon: "vm", resourceKind: "vm" }],
  ]);
  const lb = edgeBindings({ source: "inet", target: "lb", flowType: "ingress", edgeKind: "network" }, nodes, new Set(["lb"]));
  assert.equal(lb.bindings.throughput!.metric, "ByteCount");
  assert.equal(lb.bindings.throughput!.filter, "Direction eq 'In'");
  assert.equal(lb.bindings.throughput!.node, "target");
  assert.ok(Math.abs(lb.bindings.throughput!.scale! - 8 / 60) < 1e-12);
  assert.deepEqual(lb.caveats, ["ld.edge.caveat.snat"]);
  const agw = edgeBindings({ source: "inet", target: "agw", flowType: "ingress", edgeKind: "network" }, nodes);
  assert.equal(agw.bindings.throughput!.metric, "BytesReceived");
  assert.deepEqual(agw.caveats, ["ld.edge.caveat.publicPrivateSum"]);
  assert.equal(edgeBindings({ source: "pe", target: "kv", edgeKind: "privateLink" }, nodes).bindings.throughput!.source, "derived");
  assert.deepEqual(edgeBindings({ source: "lb", target: "vm", edgeKind: "routes" }, nodes).bindings, {}, "no per-backend bytes from Azure Monitor");
  for (const kind of Object.keys(NODE_BINDINGS)) for (const b of Object.values(NODE_BINDINGS[kind]!)) assert.ok(!(kind === "appGateway" && b.metric === "ByteCount"), "App Gateway has no ByteCount");
});

test("normalizing a saved spec replaces node and line bindings", () => {
  const spec: DiagramSpec = {
    version: "1", id: "auto-x", name: "x", createdAt: "", updatedAt: "", groups: [], settings: { refreshIntervalSec: 30, defaultTimeRange: "5m", layout: "manual" },
    nodes: [
      { id: "inet", label: "Internet", icon: "internet", resourceKind: "internet", bindings: {} },
      { id: "lb", label: "lb", icon: "lb", resourceKind: "lb", bindings: { throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" } } },
      { id: "vm", label: "vm", icon: "vm", resourceKind: "vm", bindings: {} },
    ],
    edges: [
      { id: "e1", source: "inet", target: "lb", flowType: "ingress", edgeKind: "network", bindings: {} },
      { id: "e2", source: "lb", target: "vm", edgeKind: "routes", bindings: { throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" } } },
      { id: "e3", source: "lb", target: "inet", edgeKind: "outbound-internet", label: "LB SNAT", bindings: {} },
    ],
  };
  const n = normalizeSpecBindings(spec);
  assert.ok(n.nodes.find((x) => x.id === "lb")!.bindings.dataPath);
  assert.equal(n.edges.find((e) => e.id === "e1")!.bindings.throughput!.node, "target");
  assert.deepEqual(n.edges.find((e) => e.id === "e1")!.caveats, ["ld.edge.caveat.snat"]);
  assert.deepEqual(n.edges.find((e) => e.id === "e2")!.bindings, {}, "the old LB total on a backend line is gone");
});
