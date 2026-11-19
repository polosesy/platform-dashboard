// 모니터링 › 프로필 (2026-11-19) — Pyroscope through the customer's Grafana (services/grafanaProfiles.ts) and the
// visualizations (web lib/profileView.ts). Shapes as measured on stg: profile types process_cpu / alloc_in_new_tlab
// bytes · objects (Java, javaspy, jfr_event itimer, 16 services), a profile = one flamegraph frame of level · value ·
// self · label (enum) rows — 5,187–6,503 rows, self sum = root, value = self + children for every row (0 off).
// The synthetic tree below is small enough to work out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ProfileTree } from "@aud/types";
import { languageOfSpy, profileTypeOf, selectorOf, seriesOfFrames, treeOfFrame } from "../src/services/grafanaProfiles.js";
import * as pNs from "../../web/src/lib/profileView.ts";
import * as navNs from "../../web/src/lib/navConfig.ts";

const P = ((pNs as unknown as { default?: typeof pNs }).default ?? pNs) as typeof pNs;
const N = ((navNs as unknown as { default?: typeof navNs }).default ?? navNs) as typeof navNs;

const STG_TYPES = ["memory:alloc_in_new_tlab_bytes:bytes:space:bytes", "memory:alloc_in_new_tlab_objects:count:space:bytes", "process_cpu:cpu:nanoseconds:cpu:nanoseconds"];
const OTHER_TYPES = ["wall:wall:nanoseconds:wall:nanoseconds", "memory:inuse_space:bytes:space:bytes", "memory:inuse_objects:count:space:bytes", "memory:alloc_space:bytes:space:bytes",
  "mutex:contentions:count:mutex:count", "mutex:delay:nanoseconds:mutex:count", "block:delay:nanoseconds:block:count", "goroutine:goroutine:count:goroutine:count", "exceptions:exceptions:count:exceptions:count", "x:y:z:a:b"];

test("profile types: kinds from Pyroscope's IDs; the web copy = the API's; spies → languages; selectors only from valid names", () => {
  assert.deepEqual(STG_TYPES.map((id) => profileTypeOf(id).kind), ["allocBytes", "allocCount", "cpu"]);
  assert.deepEqual(OTHER_TYPES.map((id) => profileTypeOf(id).kind), ["wall", "heapBytes", "heapCount", "allocBytes", "lockCount", "lockTime", "blockTime", "goroutines", "exceptions", "other"]);
  for (const id of [...STG_TYPES, ...OTHER_TYPES]) assert.deepEqual(P.profileTypeOf(id), profileTypeOf(id), id);
  assert.deepEqual([languageOfSpy("javaspy"), languageOfSpy("gospy"), languageOfSpy("dotnetspy"), languageOfSpy("nope"), languageOfSpy(null)], ["java", "go", "dotnet", null, null]);
  assert.equal(selectorOf("orders-api"), '{service_name="orders-api"}');
  assert.equal(selectorOf("orders-api", "shop"), '{service_name="orders-api", namespace="shop"}');
  assert.throws(() => selectorOf('x"}'), /invalid_service|A service name/);
  assert.throws(() => selectorOf("ok", "Bad_NS"), /namespace/);
});

// total(100) ─ A(60, self 10) ─ B(50, self 30) ─ C(20, self 20)
//            └ D(40, self 5)  ─ B(35, self 15) ─ B(20, self 20)   ← recursion B → B
const names = ["total", "com.shop.A.run", "com.shop.B.work", "java.util.HashMap.get", "libjvm.so.D"];
const T: ProfileTree = { level: [0, 1, 2, 3, 1, 2, 3], value: [100, 60, 50, 20, 40, 35, 20], self: [0, 10, 30, 20, 5, 15, 20], label: [0, 1, 2, 3, 4, 2, 2], names };
const frame = (t: ProfileTree) => ({ results: { A: { frames: [{ schema: { name: "response", meta: { preferredVisualisationType: "flamegraph" }, fields: [
  { name: "level", type: "number" }, { name: "value", type: "number" }, { name: "self", type: "number" }, { name: "label", type: "enum", config: { type: { enum: { text: t.names } } } },
] }, data: { values: [t.level, t.value, t.self, t.label] } }] } } });

test("Grafana's answers → a tree (flamegraph frame) and series (metric frames with group labels)", () => {
  assert.deepEqual(treeOfFrame(frame(T)), T);
  assert.equal(treeOfFrame({ results: { A: { frames: [] } } }), null);
  assert.equal(treeOfFrame({ results: { A: { error: "deadline_exceeded" } } }), null);
  const m = { results: { A: { frames: [{ schema: { fields: [{ name: "time", type: "time" }, { name: "cpu", type: "number", labels: { service_name: "orders-api", pyroscope_spy: "javaspy" } }] }, data: { values: [[1000, 16000], [0.1, 0.2]] } }] } } };
  assert.deepEqual(seriesOfFrames(m), [{ labels: { service_name: "orders-api", pyroscope_spy: "javaspy" }, points: [{ t: 1000, v: 0.1 }, { t: 16000, v: 0.2 }] }]);
});

test("flame graph: a node starts where its previous sibling ended; zoom = the node fills the width; narrow nodes dropped", () => {
  const all = P.flameRects(T);
  assert.deepEqual(all.rects.map((r) => [r.name.split(".").pop(), r.level, r.x, r.w]), [["total", 0, 0, 1], ["run", 1, 0, 0.6], ["work", 2, 0, 0.5], ["get", 3, 0, 0.2], ["D", 1, 0.6, 0.4], ["work", 2, 0.6, 0.35], ["work", 3, 0.6, 0.2]]);
  assert.equal(all.depth, 4);
  const z = P.flameRects(T, 4);
  assert.deepEqual(z.ancestors, [0]);
  assert.deepEqual(z.rects.map((r) => [r.i, r.level, r.x, r.w]), [[4, 0, 0, 1], [5, 1, 0, 0.875], [6, 2, 0, 0.5]]);
  assert.deepEqual(P.flameRects(T, 0, 0.25).rects.map((r) => r.i), [0, 1, 2, 4, 5], "under a quarter of the width: left out");
});

test("top functions: self sums every node; total counts a function once per call path (recursion not twice); the sum of selves = the root", () => {
  const rows = P.topFunctions(T);
  assert.deepEqual(rows.map((r) => [r.name.split(".").pop(), r.self, r.total]), [["work", 65, 85], ["get", 20, 20], ["run", 10, 60], ["D", 5, 40]]);
  assert.equal(rows.reduce((a, r) => a + r.self, 0), T.value[0]);
  // call graph: caller → callee weights from the tree; the butterfly leaves the self edge (B → B) out
  const edges = P.callEdges(T);
  const w = (a: string, b: string) => edges.find((e) => e.caller.endsWith(a) && e.callee.endsWith(b))?.value;
  assert.deepEqual([w("run", "work"), w("work", "get"), w("D", "work"), w("work", "work")], [50, 20, 35, 20]);
  assert.ok(!edges.some((e) => e.caller === "total"), "the synthetic root is not a caller");
  const b = P.butterfly(edges, "com.shop.B.work");
  assert.deepEqual(b.callers.map((e) => [e.caller.split(".").pop(), e.value]), [["run", 50], ["D", 35]]);
  assert.deepEqual(b.callees.map((e) => [e.callee.split(".").pop(), e.value]), [["get", 20]]);
});

test("compare: shares of each window's total by call path (windows of different length compare); function deltas in pp", () => {
  // the earlier window: twice as long, D's branch smaller
  const B: ProfileTree = { level: [0, 1, 2, 3, 1, 2], value: [200, 160, 100, 40, 40, 40], self: [0, 60, 60, 40, 0, 40], label: [0, 1, 2, 3, 4, 2], names };
  const d = P.shareDiff(T, B);
  assert.deepEqual(d.slice(0, 5), [0, -20, 0, 0, 20], "A 60% vs 80% = −20 pp; D 40% vs 20% = +20 pp");
  assert.equal(d[6], 20, "a path only in the picked window: its whole share");
  const f = P.functionDiff(T, B);
  assert.deepEqual(f.map((x) => [x.name.split(".").pop(), x.deltaPp]), [["work", 15], ["run", -20], ["D", 5]].sort((a, z) => Math.abs(z[1] as number) - Math.abs(a[1] as number)));
});

test("frames, units, the series' units, per-language coverage, the thread timeline", () => {
  assert.deepEqual(["libjvm.so.JavaThread::run", "./usr/lib/x86_64-linux-gnu/libc.so.6", "java.util.HashMap.get", "jdk.internal.misc.Unsafe.park", "com.shop.B.work", "runtime.mallocgc", "[unknown]"].map(P.frameKind),
    ["native", "native", "runtime", "runtime", "code", "runtime", "native"]);
  assert.equal(P.shortName("com.shop.B.work"), "B.work");
  assert.deepEqual([P.valueText(6_540_000_000, "nanoseconds"), P.valueText(2_500_000, "nanoseconds"), P.valueText(716_547_312, "bytes"), P.valueText(1357, "count")],
    [{ n: "6.54", unit: "s" }, { n: "2.50", unit: "ms" }, { n: "683", unit: "MB" }, { n: "1,357", unit: "" }]);
  // measured on stg: Σ series × step (× 1e9 for cores) ≈ the root total
  assert.ok(Math.abs(P.seriesUnit("nanoseconds").toTotal(0.43733, 15) - 6.54e9) / 6.54e9 < 0.01);
  assert.ok(Math.abs(P.seriesUnit("bytes").toTotal(47_839_725.87, 15) - 716_547_312) / 716_547_312 < 0.01);
  assert.equal(P.seriesUnit("count").toTotal(1359, 15), 1359);
  const java = P.languageCoverage("java", new Set(["cpu", "allocBytes", "allocCount"]));
  assert.deepEqual(java.filter((r) => r.state === "collected").map((r) => r.key), ["cpu", "allocations", "allocatedMemory"]);
  assert.deepEqual(java.filter((r) => r.state === "noPyroscope").map((r) => r.key), ["classLoad", "fileIo", "socketIo"]);
  assert.deepEqual(java.filter((r) => r.state === "notCollected").map((r) => r.key), ["liveHeap", "wallTime", "thrownExceptions", "lock"]);
  assert.equal(P.hasThreadLabel(["app_name", "cluster", "collector", "jfr_event", "namespace", "pyroscope_spy", "service_name"]), false, "stg: no thread label");
  assert.equal(P.hasThreadLabel(["thread_name"]), true);
  // every Datadog type key has its words (ko · en), every kind too
  const msgs = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  for (const lang of Object.keys(P.DD_TYPES) as Array<keyof typeof P.DD_TYPES>) {
    assert.ok(msgs.includes(`"ob.pf.lang.${lang}"`), lang);
    for (const d of P.DD_TYPES[lang]) assert.ok(msgs.includes(`"ob.pf.dd.${d.key}"`), d.key);
  }
  for (const d of P.DD_TYPES.java) assert.ok(msgs.includes(`"ob.pf.enable.java.${d.key}"`), `java enable ${d.key}`);
  // checked against grafana.com/docs/pyroscope (Java SDK, 2026-11-19): the lock threshold is in NANOSECONDS (a "10ms"
  // hint was wrong), several events at once need PYROSCOPE_FORMAT=jfr, live objects = PYROSCOPE_ALLOC_LIVE
  const hint = (k: string) => new RegExp(`"ob\\.pf\\.enable\\.java\\.${k}": \\{ ko: "([^"]+)"`).exec(msgs)![1]!;
  assert.match(hint("lock"), /PYROSCOPE_PROFILER_LOCK=10000000(?!\d)/);
  assert.doesNotMatch(hint("lock"), /LOCK=10ms/);
  assert.match(hint("lock"), /PYROSCOPE_FORMAT=jfr/);
  assert.match(hint("allocations"), /PYROSCOPE_PROFILER_ALLOC=512k/);
  assert.match(hint("liveHeap"), /PYROSCOPE_ALLOC_LIVE=true/);
  assert.match(hint("wallTime"), /PYROSCOPE_PROFILER_EVENT=wall/);
});

test("menu: the monitoring views carry the time range between them — nowhere else", () => {
  const q = "?range=6h&to=1795050000000&refresh=1m&wl=shop/web";
  assert.equal(N.navHref("/observability/logs", "/observability", q), "/observability/logs?range=6h&to=1795050000000&refresh=1m");
  assert.equal(N.navHref("/observability", "/observability/profiles", "?range=1h"), "/observability?range=1h");
  assert.equal(N.navHref("/observability/logs", "/observability", ""), "/observability/logs");
  assert.equal(N.navHref("/kubernetes", "/observability", q), "/kubernetes", "another page keeps its own range");
  assert.equal(N.navHref("/observability/logs", "/security", "?range=6h"), "/observability/logs", "from elsewhere: the plain link");
  assert.equal(N.navHref("/observabilityx", "/observability", q), "/observabilityx");
});

test("routes: profiles are operator-only (function names are the team's code) — the same door as traces", () => {
  const src = readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8");
  assert.match(src, /router\.get\("\/api\/observability\/profiles", requireRole\(env, "operator"\)/);
  assert.match(src, /router\.get\("\/api\/observability\/profile", requireRole\(env, "operator"\)/);
  const reg = readFileSync(new URL("../src/infra/connectionRegistry.ts", import.meta.url), "utf8");
  assert.match(reg, /profiles: z\.boolean\(\)\.optional\(\)/, "opt-in per connection");
});
