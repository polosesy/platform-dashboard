// APM › 메트릭 (2026-11-19): services/apmMetrics.ts + web lib/apmMetricsView.ts. Measured on stg (my token, 6 h,
// the busiest service): p50 / p95 / p99 at 5 sampled times each = a by-hand bucket count from raw increase() (15 / 15),
// the 5xx share, requests per second and heap at the end = direct instant queries. Found: the workspace writes the
// +Inf bucket as "+inf" — reading only "+Inf" dropped the overflow bucket (every sampled percentile differed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { APM_SIGNALS, errorShare, leOf, percentileSeries, pointsOf } from "../src/services/apmMetrics.js";
import * as vNs from "../../web/src/lib/apmMetricsView.ts";

const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;
const row = (le: string, values: Array<[number, number]>) => ({ metric: { le }, values });

test("bucket bounds: the workspace's \"+inf\" and Prometheus' \"+Inf\" are both infinity", () => {
  assert.deepEqual([leOf("+inf"), leOf("+Inf"), leOf("inf"), leOf("0.25")], [Infinity, Infinity, Infinity, 0.25]);
  assert.ok(Number.isNaN(leOf("x")));
});

test("percentiles: the bound of the bucket that holds it — no interpolation; over the largest bound = the cap; no request = no point", () => {
  // t=1: 100 requests — 60 ≤ 0.1 s, 95 ≤ 0.5 s, 99 ≤ 1 s, 100 over (+inf)
  // t=2: 10 requests, all ≤ 0.1 s · t=3: none
  const rows = [
    row("0.1", [[1, 60], [2, 10], [3, 0]]), row("0.5", [[1, 95], [2, 10], [3, 0]]), row("1", [[1, 99], [2, 10], [3, 0]]), row("+inf", [[1, 100], [2, 10], [3, 0]]),
  ];
  assert.deepEqual(percentileSeries(rows, 0.5).series, [[1, 0.1], [2, 0.1]]);
  assert.deepEqual(percentileSeries(rows, 0.95).series, [[1, 0.5], [2, 0.1]]);
  assert.deepEqual(percentileSeries(rows, 0.99).series, [[1, 1], [2, 0.1]]);
  const over = percentileSeries([row("0.1", [[1, 1], [2, 10]]), row("+inf", [[1, 10], [2, 10]])], 0.95);
  assert.deepEqual([over.series, over.cap, over.overAt], [[[1, 0.1], [2, 0.1]], 0.1, [1]],
    "both points sit at the cap; only t=1 is over it (the chart says '> cap' by time — the first screen said '> 1 s' for a p99 inside the last bucket)");
  assert.deepEqual(percentileSeries(rows, 0.5).bounds, [0.1, 0.5, 1]);
});

test("error share: 5xx / all where there were requests — a step with none has no point (never 0 %)", () => {
  const ok: Array<[number, number]> = [[1, 9], [2, 0]], c4: Array<[number, number]> = [[1, 0.5]], c5: Array<[number, number]> = [[1, 0.5], [2, 0]];
  assert.deepEqual(errorShare(ok, c4, c5), [[1, 0.05]]);
  assert.equal(errorShare(null, null, null), null);
  assert.deepEqual(pointsOf([{ metric: {}, values: [[1, 0.1234567], [2, NaN]] }]), [[1, 0.123457]]);
  assert.equal(pointsOf([]), null);
});

test("queries: every signal scoped to the service (or its pods); HTTP without /actuator; charts name real signals", () => {
  for (const [id, s] of Object.entries(APM_SIGNALS)) {
    const q = s.q('cluster="c",namespace="n",application="a"', 'cluster="c",pod=~"p"', "5m", 300);
    assert.match(q, s.section === "pods" ? /pod=~"p"/ : /application="a"/, id);
    if (q.includes("http_server_requests")) assert.match(q, /uri!~"\/actuator\.\*"/, id);
  }
  const computed = new Set(["errShare", "p50", "p95", "p99"]);
  for (const sec of V.APM_SECTIONS) for (const c of V.APM_CHARTS[sec]) for (const id of [...c.lines, ...(c.limit ? [c.limit] : [])]) {
    assert.ok(computed.has(id) || APM_SIGNALS[id]?.section === sec, `${c.id}: ${id} in ${sec}`);
  }
  const list = [{ namespace: "a", application: "x", rps: 3 }, { namespace: "b", application: "y", rps: 1 }];
  assert.deepEqual(V.pickService(list, "b/y"), { namespace: "b", application: "y" });
  assert.deepEqual(V.pickService(list, "gone/z"), { namespace: "a", application: "x" }, "an unknown one = the busiest");
  assert.equal(V.pickService([], ""), null);
});
