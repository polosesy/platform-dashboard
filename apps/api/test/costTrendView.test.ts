import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ns from "../../web/src/lib/costTrendView.ts";

// Cost trend chart (renewal step 2, 2026-11-20): round ticks from 0, sparse date labels in UTC, the average line,
// keyboard steps — and the page uses the chart with a table view (no gradient bars, no number on every bar).
const V = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;

test("niceTicks: from 0 to a round top that covers the max, steps of 1 · 2 · 2.5 · 5 × 10ⁿ", () => {
  assert.deepEqual(V.niceTicks(470), [0, 200, 400, 600]);
  assert.deepEqual(V.niceTicks(1000), [0, 250, 500, 750, 1000]);
  assert.deepEqual(V.niceTicks(37), [0, 10, 20, 30, 40]);
  assert.deepEqual(V.niceTicks(0), [0, 1]);
  assert.deepEqual(V.niceTicks(Number.NaN), [0, 1]);
  for (const max of [1, 3.3, 99, 512, 12_451, 7_000_000]) {
    const t = V.niceTicks(max);
    assert.equal(t[0], 0);
    assert.ok(t[t.length - 1]! >= max, `top covers ${max}`);
    assert.ok(t.length >= 3 && t.length <= 6, `${max} → ${t.length} ticks`);
  }
});

test("labelIndices: one date every 7 days (+ the last when not crowded), months all up to 12", () => {
  assert.deepEqual(V.labelIndices(30, "daily"), [0, 7, 14, 21, 28]); // 29 is one bar after 28 — crowded
  assert.deepEqual(V.labelIndices(20, "daily"), [0, 7, 14, 19]);
  assert.deepEqual(V.labelIndices(1, "daily"), [0]);
  assert.deepEqual(V.labelIndices(0, "daily"), []);
  assert.deepEqual(V.labelIndices(12, "monthly"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(V.labelIndices(13, "monthly"), [0, 2, 4, 6, 8, 10, 12]);
});

test("dates are calendar dates in UTC (a viewer west of UTC must not see the day before)", () => {
  assert.equal(V.dateLabel("2026-11-01", "daily", "en-US"), "11/1");
  assert.equal(V.dateLabel("2026-11-01", "monthly", "en-US"), "Nov");
  assert.equal(V.dateLabel("2026-01-01", "monthly", "en-US"), "Jan 2026");
  assert.match(V.dateLong("2026-11-20", "daily", "ko-KR"), /2026년 11월 20일 금요일/);
  assert.equal(V.dateLabel("bad", "daily", "en-US"), "bad");
});

test("trendSummary: scale top, average, the highest bar", () => {
  const s = V.trendSummary([{ date: "2026-11-01", cost: 100 }, { date: "2026-11-02", cost: 300 }, { date: "2026-11-03", cost: 200 }]);
  assert.equal(s.average, 200);
  assert.equal(s.maxIndex, 1);
  assert.equal(s.total, 600);
  assert.equal(s.top, 300);
  assert.equal(V.trendSummary([]).average, null);
});

test("stepIndex: ←/→ one bar, Home/End the ends, the first arrow lands on today (the last bar)", () => {
  assert.equal(V.stepIndex(null, "ArrowLeft", 5), 4);
  assert.equal(V.stepIndex(null, "ArrowRight", 5), 4);
  assert.equal(V.stepIndex(2, "ArrowLeft", 5), 1);
  assert.equal(V.stepIndex(0, "ArrowLeft", 5), 0);
  assert.equal(V.stepIndex(4, "ArrowRight", 5), 4);
  assert.equal(V.stepIndex(2, "Home", 5), 0);
  assert.equal(V.stepIndex(2, "End", 5), 4);
  assert.equal(V.stepIndex(2, "a", 5), 2);
  assert.equal(V.stepIndex(null, "ArrowLeft", 0), null);
});

test("cost page: the chart has axes, a keyboard layer and a table twin", () => {
  const page = readFileSync(new URL("../../web/src/app/cost/page.tsx", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../../web/src/app/cost/CostTrendChart.tsx", import.meta.url), "utf8");
  assert.match(page, /<CostTrendChart /);
  assert.match(page, /cost\.chart\.showTable/);
  assert.match(chart, /tabIndex=\{0\}/);
  assert.match(chart, /onKeyDown=/);
  assert.match(chart, /aria-live="polite"/);
  assert.match(chart, /styles\.yAxis/);
  assert.match(chart, /styles\.xAxis/);
  assert.doesNotMatch(page, /trendBarLabel/, "no value printed on every bar");
});
