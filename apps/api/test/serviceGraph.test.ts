// 서비스 (APM) › 서비스 맵 — the trace pipeline's service graph (vendor-neutral `traces_service_graph_*` series) as an
// APM service map. Shapes as measured on stg 2026-11-16 (33 client → server pairs: root-span callers "user" →
// services, direct calls, messaging incl. a self call; one pair with 60 failures and p95 in the 10 s bucket).
// Synthetic service names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PromRow } from "../src/services/hubbleMetrics.js";
import { aggregateServiceGraph, edgeKindOf, serviceGraphQueries } from "../src/services/serviceGraph.js";
import * as mapNs from "../../web/src/lib/apmServiceMap.ts";

const M = ((mapNs as unknown as { default?: typeof mapNs }).default ?? mapNs) as typeof mapNs;
const row = (metric: Record<string, string>, value: number): PromRow => ({ metric, value }) as PromRow;

const REQ = [
  row({ client: "user", server: "gateway", connection_type: "virtual_node", server_k8s_namespace_name: "app" }, 3165),
  row({ client: "user", server: "report", connection_type: "virtual_node", server_k8s_namespace_name: "app" }, 1560),
  row({ client: "gateway", server: "orders", connection_type: "", server_k8s_namespace_name: "app" }, 416),
  row({ client: "gateway", server: "users", connection_type: "" }, 381),
  row({ client: "orders", server: "orders", connection_type: "messaging_system" }, 58),
  row({ client: "orders", server: "billing", connection_type: "messaging_system", server_k8s_namespace_name: "pay" }, 34),
  row({ client: "orders", server: "legacy", connection_type: "" }, 2),
  row({ client: "orders", server: "gone", connection_type: "" }, 0),
];
const FAILED = [row({ client: "user", server: "report" }, 60)];
const BUCKETS = [
  ...[[0.1, 1400], [1, 1450], [10, 1560], ["+Inf", 1560]].map(([le, v]) => row({ client: "user", server: "report", le: String(le) }, v as number)),
  ...[[0.1, 410], [1, 416], [10, 416], ["+Inf", 416]].map(([le, v]) => row({ client: "gateway", server: "orders", le: String(le) }, v as number)),
];
const WORKLOADS = [
  row({ namespace: "app", deployment: "gateway" }, 1), row({ namespace: "app", deployment: "orders" }, 1), row({ namespace: "app", deployment: "report" }, 1),
  row({ namespace: "pay", deployment: "billing" }, 1), row({ namespace: "other", deployment: "billing" }, 1),
  row({ namespace: "a", deployment: "users" }, 1), row({ namespace: "b", deployment: "users" }, 1),
];
const RAW = { requests: REQ, failed: FAILED, buckets: BUCKETS, resets: [row({}, 0)], workloads: WORKLOADS };

test("queries: vendor-neutral service-graph names, the window's increase, scoped; the failed label summed (failures included)", () => {
  const q = serviceGraphQueries('cluster="c1"', 'cluster="c1"', 60);
  assert.match(q.requests!, /^sum by \(client, server, connection_type, server_k8s_namespace_name\) \(increase\(traces_service_graph_request_total\{cluster="c1"\}\[60m\]\)\)$/);
  assert.doesNotMatch(q.requests!, /failed=/, "the total sums both failed values — failures are part of the requests");
  assert.match(q.failed!, /traces_service_graph_request_failed_total\{cluster="c1"\}\[60m\]/);
  assert.match(q.buckets!, /traces_service_graph_request_server_seconds_bucket/);
  assert.match(q.resets!, /resets\(traces_service_graph_request_total/);
  assert.deepEqual(["", "virtual_node", "messaging_system", "database", "x"].map(edgeKindOf), ["direct", "virtual", "messaging", "database", "other"]);
});

test("aggregate: edges with rate · failures · p95 bucket; nodes with in/out and the workload only when unambiguous", () => {
  const g = aggregateServiceGraph(RAW, 60);
  assert.equal(g.edges.length, 7, "an edge with no request in the window is not drawn");
  const report = g.edges.find((e) => e.client === "user" && e.server === "report")!;
  assert.deepEqual([report.kind, report.failed, report.errorRate, report.p95, report.p99], ["virtual", 60, 0.03846, { le: 10 }, { le: 10 }]);
  assert.equal(report.rate, 0.4333);
  const orders = g.edges.find((e) => e.client === "gateway" && e.server === "orders")!;
  assert.deepEqual([orders.kind, orders.p95], ["direct", { le: 0.1 }]);
  assert.equal(g.edges.find((e) => e.server === "legacy")!.lowTraffic, true, "under 20 requests: shown, not judged");
  assert.deepEqual(g.buckets, [0.1, 1, 10]);

  const node = (s: string) => g.nodes.find((n) => n.service === s)!;
  assert.equal(node("user").entry, true, "the client of root spans: a caller outside the traces");
  assert.equal(node("gateway").entry, false);
  assert.deepEqual(node("report").inbound, { requests: 1560, failed: 60, errorRate: 0.03846 });
  assert.deepEqual(node("orders").outbound, { requests: 94, failed: 0 });
  assert.deepEqual(node("orders").workload, { namespace: "app", name: "orders", kind: "Deployment" });
  // two "billing" workloads, but the pipeline named the server's namespace → that one
  assert.deepEqual(node("billing").workload, { namespace: "pay", name: "billing", kind: "Deployment" });
  // two "users" and no namespace on the series → none (never a guess)
  assert.equal(node("users").workload, null);
  assert.equal(node("legacy").workload, null);
  assert.equal(g.resets, 0);
  // a query that did not answer: its values are "not read", not zero
  const noDur = aggregateServiceGraph(RAW, 60, new Set(["buckets", "failed", "resets"]));
  assert.deepEqual([noDur.edges[0]!.p95, noDur.edges[0]!.errorRate, noDur.resets], [null, null, null]);
});

test("web map: callers outside the traces on the left, namespaces as boxes, steps left → right, failures ▲ (no red)", () => {
  const g = aggregateServiceGraph(RAW, 60);
  const map = M.buildApmMap({ ...g, windowMinutes: 60 });
  const card = (id: string) => map.cards.find((c) => c.id === id)!;
  assert.equal(card("user").kind, "entry");
  assert.equal(map.boxes.find((b) => b.kind === "laneIn") !== undefined, true);
  assert.ok(card("user").x < card("gateway").x && card("gateway").x < card("orders").x, "left → right = the way requests go");
  assert.equal(card("report").status, "warn", "failures are a fact (▲), not a danger verdict — there is no target");
  assert.ok(map.cards.every((c) => c.status !== "danger"));
  assert.equal(card("orders").parent, "ns:app");
  assert.equal(card("users").namespace, "", "no namespace from the pipeline or a unique workload → the unnamed box");
  const link = (id: string) => map.links.find((l) => l.id === id)!;
  assert.equal(link("user>report").tone, "fail");
  assert.equal(link("orders>billing").tone, "async");
  assert.equal(link("orders>orders").tone, "async", "a service consuming its own queue keeps its line");
  assert.ok(link("user>gateway").width > link("orders>legacy").width, "width = rate");
  assert.deepEqual([map.totals.failingLinks, map.totals.failed], [1, 60]);

  const failing = M.buildApmMap({ ...g, windowMinutes: 60 }, { failing: true });
  assert.deepEqual(failing.cards.map((c) => c.id).sort(), ["report", "user"]);
  const search = M.buildApmMap({ ...g, windowMinutes: 60 }, { search: "billing" });
  assert.deepEqual(search.cards.map((c) => c.id).sort(), ["billing", "orders"], "the match and who it talks to");
  const { inbound } = M.apmLinksOf(map, "report");
  assert.equal(inbound[0]!.edge.failed, 60);
});

test("wiring: the route, the view in the 서비스 (APM) tab, the strings", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(read("../src/routes/observability.ts"), /"\/api\/observability\/service-map"[\s\S]{0,400}getServiceGraph\(/);
  const tab = read("../../web/src/app/observability/components/SloTab.tsx");
  // the service map opens first — APM's landing view; only a copied trace link (?trace=, 2026-11-18) opens the traces
  assert.match(tab, /useState<View>\(linkedTrace \? "traces" : "map"\)/, "the service map opens first — APM's landing view");
  assert.match(tab, /<ServiceMapView clusterId=\{clusterId\}/);
  const all = read("../../web/src/lib/i18nOps.ts") + read("../../web/src/lib/i18nMessages.ts");
  assert.match(all, /"obs\.tab\.slo": \{ ko: "서비스 \(APM\)"/);
  for (const k of ["ob.slo.view.map", "ob.apm.loading", "ob.apm.notInstrumented", "ob.apm.notInstrumentedHint", "ob.apm.entry", "ob.apm.entryHint", "ob.apm.laneIn", "ob.apm.noNamespace", "ob.apm.noWorkload",
    "ob.apm.in", "ob.apm.out", "ob.apm.failed", "ob.apm.summary", "ob.apm.failingLinks", "ob.apm.resets", "ob.apm.resetsHint", "ob.apm.gaps", "ob.apm.kind.direct", "ob.apm.kind.virtual",
    "ob.apm.kind.messaging", "ob.apm.kind.database", "ob.apm.kind.other", "ob.apm.why.ok", "ob.apm.why.warn", "ob.apm.howMeasured", "ob.apm.howMeasuredHint", "ob.apm.window"]) {
    assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  }
});
