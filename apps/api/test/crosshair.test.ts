// Shared crosshair (2026-11-19): web lib/crosshair.ts — charts on one time axis follow the pointer together; each
// chart snaps to ITS nearest point only within 1.5 × its step (never a far neighbour's value as "at this time").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as xNs from "../../web/src/lib/crosshair.ts";
import * as cNs from "../../web/src/lib/collectorView.ts";
import * as aNs from "../../web/src/lib/apmMetricsView.ts";

const X = ((xNs as unknown as { default?: typeof xNs }).default ?? xNs) as typeof xNs;
const C = ((cNs as unknown as { default?: typeof cNs }).default ?? cNs) as typeof cNs;
const A = ((aNs as unknown as { default?: typeof aNs }).default ?? aNs) as typeof aNs;
const M = 60_000;

test("step = the usual gap (median — one hole does not double it)", () => {
  assert.equal(X.stepOf([0, M, 2 * M, 3 * M, 6 * M, 7 * M]), M);
  assert.equal(X.stepOf([5]), null);
  assert.equal(X.stepOf([]), null);
});

test("snap: nearest own point within 1.5 steps; farther = none; ties go to the earlier point", () => {
  const ts = [0, M, 2 * M, 3 * M];
  assert.equal(X.snapTime(ts, 1.4 * M), M);
  assert.equal(X.snapTime(ts, 1.6 * M), 2 * M);
  assert.equal(X.snapTime(ts, 1.5 * M), M); // tie
  assert.equal(X.snapTime(ts, 4.4 * M), 3 * M); // 1.4 steps past the end — still this chart's last point
  assert.equal(X.snapTime(ts, 4.6 * M), null); // 1.6 steps — no value here
  // a percentile with a gap (no requests 2..8 min): the shared time in the hole reads no value, not the edge's
  const sparse = [0, M, 2 * M, 9 * M, 10 * M];
  assert.equal(X.snapTime(sparse, 5.5 * M), null);
  assert.equal(X.snapTime(sparse, 3 * M), 2 * M);
  assert.equal(X.snapTime([], 0), null);
  assert.equal(X.snapTime([M], M), M); // one point: only an exact hit
  assert.equal(X.snapTime([M], M + 1), null);
});

test("pointer x → time, clamped to the range", () => {
  assert.equal(X.timeAtX(152, 52, 200, 0, 100 * M), 50 * M);
  assert.equal(X.timeAtX(0, 52, 200, 0, 100 * M), 0);
  assert.equal(X.timeAtX(999, 52, 200, 0, 100 * M), 100 * M);
});

test("store: subscribers hear a change once; the same position again is not a change", () => {
  const s = X.createCrosshair();
  let n = 0;
  const off = s.subscribe(() => { n++; });
  s.set({ ms: M, source: "latency" });
  s.set({ ms: M, source: "latency" });
  s.set({ ms: M, source: "heap" });
  s.set(null);
  s.set(null);
  assert.equal(n, 3);
  off();
  s.set({ ms: 2 * M, source: "x" });
  assert.equal(n, 3);
  assert.deepEqual(s.get(), { ms: 2 * M, source: "x" });
});

test("chart ids are unique inside a group (the crosshair's source is the chart id)", () => {
  const ids = (defs: Array<{ id: string }>) => defs.map((d) => d.id);
  const col = Object.values(C.CHARTS).flatMap(ids);
  assert.equal(new Set(col).size, col.length);
  const apm = Object.values(A.APM_CHARTS).flatMap(ids);
  assert.equal(new Set(apm).size, apm.length);
});

test("both metric screens wrap their charts in one CrosshairGroup", () => {
  for (const f of ["ApmMetricsView.tsx", "CollectorSignals.tsx"]) {
    const src = readFileSync(new URL(`../../web/src/app/observability/components/${f}`, import.meta.url), "utf8");
    assert.match(src, /<CrosshairGroup>/, f);
  }
});
