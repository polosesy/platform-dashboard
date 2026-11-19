import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceSpan } from "@aud/types";
import * as tvNs from "../../web/src/lib/traceView.ts";

const TV = ((tvNs as unknown as { default?: typeof tvNs }).default ?? tvNs) as typeof tvNs;

// Synthetic spans (2026-11-18 — the trace detail's flame graph · exec time · span list). On 15 real stg traces (75 spans)
// the exec time equalled an independent BigInt event sweep over the raw OTLP JSON exactly; 3 traces of 3.5–4.7k spans
// (cut to 2,000) laid out in 5–16 ms with no overlap. These tests pin the same properties.
const span = (id: string, parent: string | null, service: string, offsetMs: number, durationMs: number, extra: Partial<TraceSpan> = {}): TraceSpan => ({
  spanId: id, parentId: parent, service, namespace: "shop", pod: null, name: `op-${id}`, kind: "server", offsetMs, durationMs, status: "ok", attributes: [], events: [], ...extra,
});

// root (web, 0–100) → api (10–80) → two parallel db calls (20–50, 30–60) + a later cache call (65–75); an async job past the end
const trace = [
  span("r", null, "web", 0, 100),
  span("a", "r", "api", 10, 70),
  span("d1", "a", "db", 20, 30),
  span("d2", "a", "db", 30, 30),
  span("c", "a", "cache", 65, 10),
  span("j", "r", "worker", 90, 40, { status: "error" }),
];

test("exec time: own time = length minus the union of the children (parallel children once); shares add up to 100 %", () => {
  const e = TV.execTimeByService(trace);
  const by = Object.fromEntries(e.map((x) => [x.service, x.selfMs]));
  // web: 100 − union(api 10–80, job 90–100 clipped) = 100 − 80 = 20
  assert.equal(by.web, 20);
  // api: 70 − union(20–50, 30–60, 65–75) = 70 − (40 + 10) = 20
  assert.equal(by.api, 20);
  assert.equal(by.db, 60, "each db span has no children: 30 + 30");
  assert.equal(by.cache, 10);
  assert.equal(by.worker, 40, "the async job runs past the root — its own time still counts");
  assert.equal(Number(e.reduce((n, x) => n + x.share, 0).toFixed(12)), 1);
  assert.deepEqual(e.map((x) => x.service), ["db", "worker", "api", "web", "cache"], "most own time first, then by name");
});

test("flame layout: every span below its parent, overlapping spans never share a row", () => {
  const { blocks, rows } = TV.flameLayout(trace, 130);
  const row = Object.fromEntries(blocks.map((b) => [b.span.spanId, b.row]));
  assert.equal(blocks.length, trace.length);
  assert.equal(row.r, 0);
  assert.equal(row.a, 1);
  assert.equal(row.j, 1, "the job does not overlap api (90 > 80) — same row as its sibling");
  assert.equal(row.d1, 2);
  assert.equal(row.d2, 3, "d2 overlaps d1 → the next free row");
  assert.equal(row.c, 2, "the cache call starts after d1 ends — back on the first free row");
  assert.equal(rows, 4);
  for (const b of blocks) for (const o of blocks) {
    if (b !== o && b.row === o.row) assert.ok(b.span.offsetMs >= o.span.offsetMs + o.span.durationMs || o.span.offsetMs >= b.span.offsetMs + b.span.durationMs, `${b.span.spanId} overlaps ${o.span.spanId}`);
  }
  // a span whose parent is missing (not received) starts at the top
  assert.equal(TV.flameLayout([span("x", "gone", "s", 0, 5)]).blocks[0]!.row, 0);
});

test("flame window: zoom to a span keeps what overlaps it, clipped to the window; a sliver stays inside the right edge", () => {
  const { blocks } = TV.flameLayout(trace, 130);
  const whole = TV.flameWindow(blocks, 130, null);
  assert.equal(whole.length, trace.length);
  for (const b of whole) assert.ok(b.leftPct >= 0 && b.leftPct + b.widthPct <= 100 + 1e-9, `${b.span.spanId} inside 0-100 %`);
  const z = TV.flameWindow(blocks, 130, { from: 20, to: 50 }); // the d1 call
  const at = Object.fromEntries(z.map((b) => [b.span.spanId, b]));
  assert.deepEqual(Object.keys(at).sort(), ["a", "d1", "d2", "r"], "the cache call (65-75) and the job (90-130) are outside");
  assert.deepEqual([at.d1!.leftPct, at.d1!.widthPct], [0, 100]);
  assert.deepEqual([Math.round(at.d2!.leftPct * 1000) / 1000, Math.round(at.d2!.widthPct * 1000) / 1000], [33.333, 66.667], "d2 (30-60) cut at the window's end");
  const end = TV.flameWindow(TV.flameLayout([span("e", null, "s", 99.99, 0)], 100).blocks, 100, null)[0]!;
  assert.ok(end.leftPct + end.widthPct <= 100 + 1e-9 && end.widthPct >= 0.3, "a zero-length span at the end: a sliver, inside");
});

test("span list: service × name groups, most total time first, errors counted", () => {
  const g = TV.spanGroups([...trace, span("d3", "a", "db", 70, 5, { name: "op-d1", status: "error" })]);
  const db = g.find((x) => x.service === "db" && x.name === "op-d1")!;
  assert.deepEqual({ count: db.count, totalMs: db.totalMs, maxMs: db.maxMs, errors: db.errors, first: db.first }, { count: 2, totalMs: 35, maxMs: 30, errors: 1, first: "d1" });
  assert.equal(g.reduce((n, x) => n + x.count, 0), trace.length + 1);
  assert.equal(g[0]!.service, "web", "100 ms total first");
});

test("span filter: every word in name / service / attribute; errors only", () => {
  const s = span("q", null, "orders-api", 0, 1, { name: "GET /orders/{id}", attributes: [{ key: "http.response.status_code", value: "503" }] });
  assert.ok(TV.spanMatches(s, "orders 503"));
  assert.ok(TV.spanMatches(s, "STATUS_CODE"), "case-insensitive, keys too");
  assert.ok(!TV.spanMatches(s, "orders 404"));
  assert.ok(!TV.spanMatches(s, "", true), "errors only");
  assert.ok(TV.spanMatches({ ...s, status: "error" }, "", true));
});

test("attributes: a tree by dotted keys, and nested JSON for copying", () => {
  const attrs = [{ key: "http.request.method", value: "POST" }, { key: "http.route", value: "/api/orders" }, { key: "db.system", value: "postgresql" }, { key: "http", value: "x" }];
  const tree = TV.attrTree(attrs);
  assert.deepEqual(tree.map((n) => n.key), ["db", "http"]);
  const http = tree.find((n) => n.key === "http")!;
  assert.equal(http.value, "x");
  assert.deepEqual(http.children.map((n) => n.path), ["http.request", "http.route"]);
  assert.deepEqual(JSON.parse(TV.attrJson(attrs)), { db: { system: "postgresql" }, http: { "": "x", request: { method: "POST" }, route: "/api/orders" } });
});

test("request line: OpenTelemetry semantic conventions, new names before old; no method = no line", () => {
  assert.deepEqual(TV.httpSummary(span("h", null, "s", 0, 1, { attributes: [{ key: "http.request.method", value: "POST" }, { key: "url.path", value: "/api/orders" }, { key: "http.response.status_code", value: "201" }] })),
    { method: "POST", target: "/api/orders", status: 201 });
  assert.deepEqual(TV.httpSummary(span("o", null, "s", 0, 1, { attributes: [{ key: "http.method", value: "GET" }, { key: "http.target", value: "/x" }, { key: "http.status_code", value: "500" }] })),
    { method: "GET", target: "/x", status: 500 });
  assert.equal(TV.httpSummary(span("n", null, "s", 0, 1)), null);
  assert.ok(TV.TRACE_ID.test("4bf92f3577b34da6a3ce929d0e0e4736") && !TV.TRACE_ID.test("x' or 1=1"));
  assert.equal(TV.traceLink("https://aud.example", "abc"), "https://aud.example/observability/services?trace=abc");
});

test("colour by service: slots in order of first appearance (root first), the 6th on = other; one hue = accent", () => {
  const slots = TV.serviceSlots(trace, 130);
  assert.deepEqual([...slots], [["web", 1], ["api", 2], ["db", 3], ["cache", 4], ["worker", 5]], "waterfall order: r(web) a(api) d1(db) … j(worker)");
  const seven = [...trace, span("x1", "r", "six", 95, 1), span("x2", "r", "seven", 96, 1)];
  const s7 = TV.serviceSlots(seven, 130);
  assert.equal(s7.get("six"), 0);
  assert.equal(s7.get("seven"), 0, "beyond five = other (slate), never a generated hue");
  assert.equal(s7.get("web"), 1, "adding services never repaints the ones before");
  assert.equal(TV.slotVar(3, "service"), "var(--series3-rgb)");
  assert.equal(TV.slotVar(0, "service"), "var(--slate-rgb)");
  assert.equal(TV.slotVar(3, "none"), "var(--accent-rgb)");
  assert.equal(TV.SERIES_SLOTS, 5);
});
