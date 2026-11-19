// 수집 상태 › 수집기 신호 (2026-11-19): services/collectorTrends.ts (per-pod series → per collector, the four verdicts)
// and web lib/collectorView.ts (charts, units, axis). Measured on stg (my token): 2 collectors (3 pods) over 1 h and 6 h —
// the module's newest point = an independent instant query for 13 signals (rwSent · rwFailed · logSent · spanIn ·
// spanOut · cpu · mem · memLimit), restarts read as the cumulative count (increase() over one 60 s step read nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CollectorSignal } from "@aud/types";
import { collectorVerdicts, combine, LIMIT_NEAR, podAlternation, QUEUE_FULL, SIGNALS, stepFor } from "../src/services/collectorTrends.js";
import { RW_LAG_SECONDS } from "../src/services/observabilityStack.js";
import * as cNs from "../../web/src/lib/collectorView.ts";

const V = ((cNs as unknown as { default?: typeof cNs }).default ?? cNs) as typeof cNs;
const sig = (id: string, values: number[] | null, unit: CollectorSignal["unit"] = "perSecond"): CollectorSignal => ({
  id, unit, series: values ? values.map((v, i) => [i * 60_000, v] as [number, number]) : null,
  now: values?.length ? values[values.length - 1]! : null, max: values?.length ? Math.max(...values) : null,
});
const sigs = (...xs: CollectorSignal[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
const verdict = (s: Record<string, CollectorSignal>, id: string) => collectorVerdicts(s).find((v) => v.id === id)!;

test("range: about 120 points, never under the 60 s scrape; pods as a literal alternation", () => {
  assert.deepEqual([30, 60, 360, 1440, 10080].map(stepFor), [60, 60, 180, 720, 5040]);
  assert.equal(podAlternation(["b", "a.x", "a.x"]), String.raw`a\\.x|b`, "the dot escaped twice: a PromQL string literal reads \\\\. as the regex \\.");
  // every signal's query is scoped to the cluster and the pods
  for (const [id, s] of Object.entries(SIGNALS)) assert.match(s.q('cluster="c"', 'pod=~"p"', "300s", "60s"), /cluster="c"[^}]*pod=~"p"/, id);
});

test("combine: a collector = its pods — rates summed, lag / ratios the worst pod; no pod with the series = null (not 0)", () => {
  const rows = [
    { metric: { pod: "a" }, values: [[0, 1], [60_000, 2]] as Array<[number, number]> },
    { metric: { pod: "b" }, values: [[0, 3], [60_000, 1]] as Array<[number, number]> },
    { metric: { pod: "other" }, values: [[0, 100]] as Array<[number, number]> },
  ];
  assert.deepEqual(combine(rows, new Set(["a", "b"]), "sum"), [[0, 4], [60_000, 3]]);
  assert.deepEqual(combine(rows, new Set(["a", "b"]), "max"), [[0, 3], [60_000, 2]]);
  assert.equal(combine(rows, new Set(["z"]), "sum"), null);
});

test("verdicts: facts with the values that decided them — nothing measured = unknown, never ok", () => {
  assert.deepEqual(collectorVerdicts({}).map((v) => v.state), ["unknown", "unknown", "unknown", "unknown"]);
  // throughput: samples come in, none go out
  assert.equal(verdict(sigs(sig("rwIn", [100, 100]), sig("rwSent", [100, 0])), "throughput").state, "warn");
  assert.equal(verdict(sigs(sig("rwIn", [100]), sig("rwSent", [99])), "throughput").state, "ok");
  // errors: any failure in the range (the max), not only now
  const e = verdict(sigs(sig("rwFailed", [0, 3, 0]), sig("logDropped", [0])), "errors");
  assert.deepEqual([e.state, e.reasons], ["warn", [{ key: "rwFailed", value: 3 }]]);
  // saturation: lag over RW_LAG_SECONDS · desired shards over max · queue at QUEUE_FULL
  assert.equal(verdict(sigs(sig("rwLag", [RW_LAG_SECONDS], "seconds")), "saturation").state, "ok", "at the rule = ok");
  assert.equal(verdict(sigs(sig("rwLag", [RW_LAG_SECONDS + 1], "seconds")), "saturation").state, "warn");
  assert.equal(verdict(sigs(sig("rwShardsDesired", [9], "count"), sig("rwShardsMax", [8], "count")), "saturation").reasons[0]!.key, "rwShards");
  assert.equal(verdict(sigs(sig("queueSize", [QUEUE_FULL * 1000], "count"), sig("queueCap", [1000], "count")), "saturation").state, "warn");
  // resources: memory at LIMIT_NEAR, restarts in the range (cumulative count rises), OOM; no limit = no ratio
  const r = verdict(sigs(sig("cpu", [0.1], "cores"), sig("mem", [LIMIT_NEAR * 100], "bytes"), sig("memLimit", [100], "bytes"), sig("restarts", [4, 4, 6], "count")), "resources");
  assert.deepEqual(r.reasons.map((x) => [x.key, x.value]), [["memNear", LIMIT_NEAR], ["restarts", 2]]);
  assert.equal(verdict(sigs(sig("cpu", [8], "cores"), sig("mem", [1], "bytes")), "resources").state, "ok", "no limit series: no ratio, no verdict from it");
});

test("view: charts by what the collector carries; units; a round axis top; scrape job states", () => {
  assert.deepEqual(V.chartsOf({ pipelines: ["logs"] }).map((x) => x.chart.id), ["logFlow", "logP95", "logRetries", "cpu", "mem", "restarts"]);
  for (const g of Object.values(V.CHARTS)) for (const c of g) for (const id of [...c.lines, ...(c.limit ? [c.limit] : [])]) assert.ok(SIGNALS[id], `${c.id}: ${id} is an API signal`);
  assert.deepEqual([V.valueText(1234, "perSecond"), V.valueText(0.046, "cores"), V.valueText(1.5 * 1024 ** 3, "bytes"), V.valueText(0.25, "seconds"), V.valueText(0.987, "ratio"), V.valueText(null, "count")],
    ["1.2k/s", "46m", "1.5 GiB", "250 ms", "98.7%", "—"]);
  assert.deepEqual([0, 0.7, 3, 120, 121, 999].map((x) => V.niceMax(x)), [1, 1, 5, 200, 200, 1000]);
  assert.equal(V.niceMax(1024 ** 3, "bytes"), 1024 ** 3, "bytes in 1024 steps: 1 GiB, not 2·10⁹");
  assert.equal(V.niceMax(600 * 1024 ** 2, "bytes"), 1024 ** 3);
  // a limit far over the data is said, not drawn (shards max 50 over 2 shards); a near one sets the axis
  assert.deepEqual([V.limitOnAxis(3, 50), V.limitOnAxis(600, 1024), V.limitOnAxis(0, 5), V.limitOnAxis(3, null)], [false, true, true, false]);
  assert.deepEqual([{ upRatio: 1, down: 0 }, { upRatio: 0.98, down: 0 }, { upRatio: 1, down: 1 }, { upRatio: 0, down: 3 }, { upRatio: null, down: 0 }].map(V.jobState), ["ok", "warn", "warn", "danger", "unknown"]);
});
