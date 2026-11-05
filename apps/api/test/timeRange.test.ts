import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import * as trm from "../../web/src/lib/timeRange.ts";
import { HEAT_WINDOWS, cpuStep, heatmapQueries } from "../src/services/workloadHeatmap.js";
import { DROP_WINDOWS, LOG_WINDOWS } from "../src/services/lokiLogs.js";
import { runAll } from "../src/services/observabilityStack.js";
import { MAX_PAST_SECONDS, queryPastTime } from "../src/infra/requestParams.js";
import type { PrometheusFetcher } from "../src/infra/azureClientFactory.js";

const tr = ((trm as { default?: typeof trm }).default ?? trm) as typeof trm;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 5, 3, 0, 0); // 12:00 KST

test("time range: URL parse — presets and <n>m/h/d spans (5 min – 30 days); junk = 1 h; an end is put on its minute", () => {
  assert.deepEqual(tr.parseRange(null, null), { span: 60, to: null });
  assert.deepEqual(tr.parseRange("2w", "yesterday"), { span: 60, to: null });
  assert.deepEqual(tr.parseRange("90m", null), { span: 90, to: null });
  assert.equal(tr.parseRange("4m", null).span, 60, "under 5 minutes");
  assert.equal(tr.parseRange("31d", null).span, 60, "over 30 days");
  assert.deepEqual(tr.parseRange("6h", String(NOW - 3 * 3600_000 + 59_000)), { span: 360, to: NOW - 3 * 3600_000 });
  // With the clock: an end within a minute of now is now; older than 30 days is 30 days back
  assert.equal(tr.parseRange("1h", String(NOW - 30_000), NOW).to, null);
  assert.equal(tr.parseRange("1h", String(NOW - 90 * 1440 * MIN), NOW).to, NOW - tr.MAX_BACK_MS);
  assert.deepEqual([tr.formatSpan(60), tr.formatSpan(90), tr.formatSpan(2160), tr.formatSpan(4320)], ["1h", "90m", "36h", "3d"]);
  for (const m of [5, 47, 90, 2160, 43200]) assert.equal(tr.parseSpan(tr.formatSpan(m)), m, `round trip ${m}`);
  assert.equal(tr.presetOf({ span: 60, to: null }), "1h");
  assert.equal(tr.presetOf({ span: 60, to: NOW - 60 * MIN }), null, "a past range reads from ~ to");
  assert.equal(tr.presetOf({ span: 90, to: null }), null);
});

test("time range: ‹‹ / ›› move half the span (Grafana); forward stops at now — relative again", () => {
  const r: trm.TimeRange = { span: 60, to: null };
  const back = tr.shiftRange(r, -1, NOW);
  assert.deepEqual(back, { span: 60, to: NOW - 30 * MIN });
  assert.deepEqual(tr.shiftRange(back, -1, NOW), { span: 60, to: NOW - 60 * MIN });
  assert.deepEqual(tr.shiftRange(back, 1, NOW), { span: 60, to: null }, "back to now: auto refresh resumes");
  assert.equal(tr.isAbsolute(back), true);
  // Never past 30 days back
  const far = tr.shiftRange({ span: 43200, to: NOW - tr.MAX_BACK_MS + 10 * MIN }, -1, NOW);
  assert.equal(far.to, NOW - tr.MAX_BACK_MS);
  assert.equal(tr.canShiftBack({ span: 43200, to: NOW - tr.MAX_BACK_MS }, NOW), false);
  assert.equal(tr.canShiftBack(r, NOW), true);
});

test("time range: ⊖ = the next quick range wider than this one, around the same middle; the end never passes now", () => {
  assert.deepEqual(tr.zoomOut({ span: 60, to: null }, NOW), { span: 180, to: null });
  // 10:00–11:00 → 3 h around 10:30 = 09:00–12:00 … but 12:00 is now → relative
  assert.deepEqual(tr.zoomOut({ span: 60, to: NOW - 60 * MIN }, NOW), { span: 180, to: null });
  // 08:00–09:00 → 07:00–10:00
  assert.deepEqual(tr.zoomOut({ span: 60, to: NOW - 180 * MIN }, NOW), { span: 180, to: NOW - 120 * MIN });
  assert.deepEqual(tr.zoomOut({ span: 90, to: null }, NOW), { span: 180, to: null }, "a typed 90 min → 3 h");
  assert.equal(tr.canZoomOut({ span: 43200, to: null }), false);
  assert.deepEqual(tr.zoomOut({ span: 43200, to: null }, NOW), { span: 43200, to: null });
});

test("time range: a typed from–to — minutes, 5 min – 30 days, not the future, not ending before 30 days ago", () => {
  assert.deepEqual(tr.customRange(NOW - 150 * MIN, NOW - 60 * MIN, NOW), { span: 90, to: NOW - 60 * MIN });
  assert.deepEqual(tr.customRange(NOW - 90 * MIN, NOW, NOW), { span: 90, to: null }, "ending now = relative");
  assert.deepEqual(tr.customRange(NaN, NOW, NOW), { error: "invalid" });
  assert.deepEqual(tr.customRange(NOW - 10 * MIN, NOW - 20 * MIN, NOW), { error: "order" });
  assert.deepEqual(tr.customRange(NOW - 3 * MIN, NOW, NOW), { error: "short" });
  assert.deepEqual(tr.customRange(NOW - 31 * 1440 * MIN, NOW - MIN * 2, NOW), { error: "long" });
  assert.deepEqual(tr.customRange(NOW, NOW + 10 * MIN, NOW), { error: "future" });
  assert.deepEqual(tr.customRange(NOW - 32 * 1440 * MIN, NOW - 31 * 1440 * MIN, NOW), { error: "old" });
  // datetime-local round trip (local time, minutes)
  assert.equal(tr.fromLocalInput(tr.toLocalInput(NOW - 37 * MIN)), NOW - 37 * MIN);
  assert.ok(Number.isNaN(tr.fromLocalInput("2026-11-05")));
});

test("time range: each panel says when it reads another span — heatmap ≤ 24 h, maintenance whole days ≥ 1, logs", () => {
  for (const p of tr.RANGE_PRESETS) {
    const m = tr.PRESET_MINUTES[p];
    const h = tr.heatWindowFor({ span: m, to: null });
    assert.equal(h.value, Math.min(m, 1440), p);
    assert.equal(h.differs, m > 1440 ? "max" : null, p);
    const d = tr.maintDaysFor({ span: m, to: null });
    assert.equal(d.value, Math.max(1, Math.ceil(m / 1440)), p);
    assert.equal(d.differs, m < 1440 ? "min" : null, p);
  }
  assert.deepEqual(tr.heatWindowFor({ span: 90, to: null }), { value: 180, differs: "round" }, "a typed span: the nearest wider window");
  assert.deepEqual(tr.maintDaysFor({ span: 2160, to: null }), { value: 2, differs: "round" });
  assert.deepEqual(tr.fitWindow({ span: 1440, to: null }, tr.WORKLOAD_LOG_WINDOWS), { value: 360, differs: "max" }, "the stream: ≤ 6 h");
  assert.deepEqual(tr.fitWindow({ span: 5, to: null }, [15, 60]), { value: 15, differs: "min" });
  assert.deepEqual(tr.podLogMinutesFor({ span: 2880, to: null }), { value: 1440, differs: "max" });
  assert.deepEqual(tr.podLogMinutesFor({ span: 90, to: null }), { value: 90, differs: null });
  assert.deepEqual([...tr.HEAT_WINDOWS], [...HEAT_WINDOWS], "web and API heatmap windows are one list");
  assert.deepEqual([...tr.WORKLOAD_LOG_WINDOWS], [...LOG_WINDOWS], "web and API log-stream windows are one list");
  assert.deepEqual([...tr.LOKI_DROP_WINDOWS], [...DROP_WINDOWS], "web and API Loki drop windows are one list");
  assert.deepEqual(tr.fitWindow({ span: 180, to: Date.UTC(2026, 10, 4, 3, 0) }, tr.LOKI_DROP_WINDOWS).value, 360, "a past 3 h → the 6 h drop window");
  assert.equal(tr.atParam({ span: 60, to: null }), undefined);
  assert.equal(tr.atParam({ span: 60, to: NOW - 60 * MIN }), String((NOW - 60 * MIN) / 1000));
});

test("time range: Grafana keys — t then ← / → / z within a second; never while typing or with a modifier", () => {
  const k = (key: string, extra: Record<string, unknown> = {}) => ({ key, ...extra });
  assert.equal(tr.timeKey(k("t"), null, NOW), "arm");
  assert.equal(tr.timeKey(k("ArrowLeft"), NOW - 500, NOW), "back");
  assert.equal(tr.timeKey(k("ArrowRight"), NOW - 500, NOW), "forward");
  assert.equal(tr.timeKey(k("z"), NOW - 500, NOW), "zoomOut");
  assert.equal(tr.timeKey(k("ArrowLeft"), NOW - 1500, NOW), null, "too late");
  assert.equal(tr.timeKey(k("ArrowLeft"), null, NOW), null, "not armed");
  assert.equal(tr.timeKey(k("t", { target: { tagName: "INPUT" } }), null, NOW), null, "typing");
  assert.equal(tr.timeKey(k("t", { target: { isContentEditable: true } }), null, NOW), null);
  assert.equal(tr.timeKey(k("z", { ctrlKey: true }), NOW - 100, NOW), null, "Ctrl+Z is undo");
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
