import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import * as trm from "../../web/src/lib/timeRange.ts";
import { HEAT_WINDOWS, cpuStep, heatmapQueries } from "../src/services/workloadHeatmap.js";
import { runAll } from "../src/services/observabilityStack.js";
import { MAX_PAST_SECONDS, queryPastTime } from "../src/infra/requestParams.js";
import type { PrometheusFetcher } from "../src/infra/azureClientFactory.js";

const tr = ((trm as { default?: typeof trm }).default ?? trm) as typeof trm;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 3, 0, 0); // 12:00 KST

test("time range: URL parse — unknown preset / end are the defaults; an end is put on its minute", () => {
  assert.deepEqual(tr.parseRange(null, null), { preset: "1h", to: null });
  assert.deepEqual(tr.parseRange("2w", "yesterday"), { preset: "1h", to: null });
  assert.deepEqual(tr.parseRange("6h", String(NOW - 3 * 3600_000 + 59_000)), { preset: "6h", to: NOW - 3 * 3600_000 });
  // With the clock: an end within a minute of now is now; older than 30 days is 30 days back
  assert.equal(tr.parseRange("1h", String(NOW - 30_000), NOW).to, null);
  assert.equal(tr.parseRange("1h", String(NOW - 90 * 1440 * MIN), NOW).to, NOW - tr.MAX_BACK_MS);
});

test("time range: ‹‹ / ›› move half the span (Grafana); forward stops at now — relative again", () => {
  const r: trm.TimeRange = { preset: "1h", to: null };
  const back = tr.shiftRange(r, -1, NOW);
  assert.deepEqual(back, { preset: "1h", to: NOW - 30 * MIN });
  assert.deepEqual(tr.shiftRange(back, -1, NOW), { preset: "1h", to: NOW - 60 * MIN });
  assert.deepEqual(tr.shiftRange(back, 1, NOW), { preset: "1h", to: null }, "back to now: auto refresh resumes");
  assert.equal(tr.isAbsolute(back), true);
  // Never past 30 days back
  const far = tr.shiftRange({ preset: "30d", to: NOW - tr.MAX_BACK_MS + 10 * MIN }, -1, NOW);
  assert.equal(far.to, NOW - tr.MAX_BACK_MS);
  assert.equal(tr.canShiftBack({ preset: "30d", to: NOW - tr.MAX_BACK_MS }, NOW), false);
  assert.equal(tr.canShiftBack(r, NOW), true);
});

test("time range: ⊖ = the next preset around the same middle; the end never passes now", () => {
  assert.deepEqual(tr.zoomOut({ preset: "1h", to: null }, NOW), { preset: "3h", to: null });
  // 10:00–11:00 → 3 h around 10:30 = 09:00–12:00 … but 12:00 is now → relative
  assert.deepEqual(tr.zoomOut({ preset: "1h", to: NOW - 60 * MIN }, NOW), { preset: "3h", to: null });
  // 08:00–09:00 → 07:00–10:00
  assert.deepEqual(tr.zoomOut({ preset: "1h", to: NOW - 180 * MIN }, NOW), { preset: "3h", to: NOW - 120 * MIN });
  assert.equal(tr.canZoomOut({ preset: "30d", to: null }), false);
  assert.deepEqual(tr.zoomOut({ preset: "30d", to: null }, NOW), { preset: "30d", to: null });
});

test("time range: each panel says when it reads another span — heatmap ≤ 24 h, maintenance ≥ 1 day", () => {
  for (const p of tr.RANGE_PRESETS) {
    const m = tr.PRESET_MINUTES[p];
    const h = tr.heatWindowFor({ preset: p, to: null });
    assert.equal(h.value, Math.min(m, 1440), p);
    assert.equal(h.differs, m > 1440 ? "max" : null, p);
    const d = tr.maintDaysFor({ preset: p, to: null });
    assert.equal(d.value, Math.max(1, Math.ceil(m / 1440)), p);
    assert.equal(d.differs, m < 1440 ? "min" : null, p);
  }
  assert.deepEqual([...tr.HEAT_WINDOWS], [...HEAT_WINDOWS], "web and API heatmap windows are one list");
  assert.equal(tr.atParam({ preset: "1h", to: null }), undefined);
  assert.equal(tr.atParam({ preset: "1h", to: NOW - 60 * MIN }), String((NOW - 60 * MIN) / 1000));
});

test("time range: auto refresh is off or ≥ 30 s (the heatmap's server cache) — unknown is off", () => {
  for (const v of tr.REFRESH_INTERVALS) assert.ok(v === "off" ? tr.INTERVAL_MS[v] === 0 : tr.INTERVAL_MS[v] >= 30_000, v);
  assert.equal(tr.parseInterval("5s"), "off");
  assert.equal(tr.parseInterval("1m"), "1m");
});

test("time range API: `at` = epoch seconds in the past on a minute; near now = now; future / too old / junk = 400", () => {
  const req = (at?: string) => ({ query: at === undefined ? {} : { at } }) as unknown as Request;
  const nowS = NOW / 1000;
  assert.equal(queryPastTime(req(), "at", NOW), undefined);
  assert.equal(queryPastTime(req(String(nowS - 30)), "at", NOW), undefined, "within a minute = now");
  assert.equal(queryPastTime(req(String(nowS - 3600 - 17)), "at", NOW), nowS - 3660);
  for (const bad of ["abc", String(nowS + 600), String(nowS - MAX_PAST_SECONDS - 60), "-1"]) {
    assert.throws(() => queryPastTime(req(bad), "at", NOW), (e: { status?: number; code?: string }) => e.status === 400 && e.code === "invalid_time", bad);
  }
});

test("time range API: a view of the past evaluates every heatmap query at its end; short windows step 1 min", async () => {
  const times: Array<string | undefined> = [];
  const fetcher: PrometheusFetcher = {
    query: async (_e, _q, time) => { times.push(time); return { status: "success", data: { result: [] } }; },
    queryRange: async () => ({ status: "success", data: { result: [] } }),
  };
  const qs = heatmapQueries('cluster="a"', 5);
  await runAll(fetcher, "https://x", qs, 4, "1762300800");
  assert.equal(times.length, Object.keys(qs).length);
  assert.ok(times.every((t) => t === "1762300800"));
  times.length = 0;
  await runAll(fetcher, "https://x", { a: "up" });
  assert.deepEqual(times, [undefined], "now: no time parameter");
  assert.equal(cpuStep(5), "1m");
  assert.match(qs.cpuP95!, /\[5m:1m\]/);
  assert.equal(cpuStep(720), "5m");
});
