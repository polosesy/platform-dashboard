// SLO 고도화 (2026-11-19, Datadog Synthetics test suites: the suite SLO with its window and error budget, the Global
// Uptime timeline, Primary Contributors, critical tests): one service's detail (services/sloUptime.ts), the service's own
// window and core endpoints (workloadSlo.ts targetsFor / serviceWindowStarts / aggregateSlo), the settings form
// (web lib/sloSettingsView.ts) and the view helpers (web lib/sloUptimeView.ts).
// Measured on stg (a workflow service): 7 d = 168 one-hour buckets, failed 10 = the whole window's 10, the per-URI
// buckets add up to the bar exactly (10 = 10, 21,976 = 21,976); 30 d = 180 four-hour buckets — the whole-window per-URI
// query was refused by Azure's query cost limit (4,857 series, cost 18,930 > 15,000), the per-URI buckets answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromRow } from "../src/services/hubbleMetrics.js";
import { BURN_GRADES, boardServices, bucketMinutes, contributorsOf, gradeOf, uptimeBuckets, uptimeTotals, uriAlternation, UPTIME_BUCKETS } from "../src/services/sloUptime.js";
import { cleanSettings } from "../src/services/sloSettingsStore.js";
import { aggregateSlo, resetPlans, serviceWindowStarts, targetsFor, type SloConfig } from "../src/services/workloadSlo.js";
import { SloSchema } from "../src/infra/connectionRegistry.js";
import * as vNs from "../../web/src/lib/sloUptimeView.ts";
import * as sNs from "../../web/src/lib/sloSettingsView.ts";

const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;
const S = ((sNs as unknown as { default?: typeof sNs }).default ?? sNs) as typeof sNs;

test("uptime buckets: ~168 over any window; per bucket ok · error (a failure with the SLI under the target) · noData", () => {
  assert.deepEqual([7, 14, 28, 30, 1].map((d) => bucketMinutes(d * 1440)), [60, 120, 240, 240, 60]);
  for (const d of [7, 14, 28, 30]) assert.ok(d * 1440 / bucketMinutes(d * 1440) <= UPTIME_BUCKETS * 1.1, `${d}d`);
  const times = [1, 2, 3, 4, 5].map((h) => h * 3_600_000);
  const total = new Map([[times[0]!, 1000], [times[1]!, 1000], [times[2]!, 0.2], [times[3]!, 10]]);
  const bad = new Map([[times[0]!, 0], [times[1]!, 2], [times[3]!, 0.3]]);
  const b = uptimeBuckets(total, bad, times, 0.999);
  // 1000 ok; 2/1000 = 99.8 % < 99.9 % → error; 0.2 requests = no request; 0.3 failed = not a failure (increase fraction); missing = noData
  assert.deepEqual(b.map((x) => x.state), ["ok", "error", "noData", "ok", "noData"]);
  assert.equal(b[1]!.sli, 0.998);
  const t = uptimeTotals(b, 0.999);
  // the totals keep increase()'s fractions (2.3 failed → shown 2, used 2.3 / 2.01) — a bucket's state ignores them
  assert.deepEqual([t.total, t.bad, t.allowed, t.budgetUsed, t.uptime], [2010, 2, 2.01, 1.144, Math.round((2 / 3) * 10000) / 10000]);
  assert.deepEqual(uptimeTotals([], 0.999), { total: 0, bad: 0, sli: null, allowed: 0, budgetUsed: null, uptime: null });
});

test("primary contributors: failed per endpoint, share of all failed, most first; the count of endpoints that spent budget", () => {
  const r = (method: string, uri: string, value: number): PromRow => ({ metric: { method, uri }, value });
  const c = contributorsOf(
    [r("post", "/a", 7), r("get", "/b", 2), r("get", "/c", 1), r("get", "/d", 0.2)],
    [r("post", "/a", 100), r("get", "/b", 50), r("get", "/c", 10), r("get", "/d", 5)],
  );
  assert.equal(c.consumedBy, 3, "a fraction under half a request is not a failure");
  assert.deepEqual(c.contributors.map((x) => [x.method, x.uri, x.bad, x.total, x.share]), [["POST", "/a", 7, 100, 0.7], ["GET", "/b", 2, 50, 0.2], ["GET", "/c", 1, 10, 0.1]]);
  assert.ok(c.contributors.reduce((a, x) => a + x.share, 0) <= 1 + 1e-9);
  assert.equal(V.topShare(c.contributors, 2), 0.9);
  // URIs go into PromQL as literal alternations — every regex character escaped
  assert.equal(uriAlternation(["/a/{id}", "/b.json", "/c?x"]), "/a/\\{id\\}|/b\\.json|/c\\?x");
});

test("service settings: its own window and core endpoints — the most specific wins; a shorter window = counted from its start", () => {
  const cfg: SloConfig = { windowDays: 30, services: { "shop/orders": { windowDays: 14, onlyUris: ["/file"] } } };
  const platform: SloConfig = { services: { "shop/orders": { windowDays: 7 }, "shop/pay": { onlyUris: ["/pay", "/refund"] } } };
  const o = targetsFor(cfg, "shop", "orders", platform);
  assert.equal(o.windowDays, 7, "the platform's service value over the file's");
  assert.deepEqual([...o.only!], ["/file"], "core endpoints from the file when the platform has none");
  assert.deepEqual([...targetsFor(cfg, "shop", "pay", platform).only!], ["/pay", "/refund"]);
  assert.equal(targetsFor(cfg, "shop", "other", platform).only, null);
  const end = Date.parse("2026-11-19T00:00:00Z");
  const starts = serviceWindowStarts(cfg, platform, 30, end);
  assert.deepEqual(starts.map((s) => [s.service, s.at, s.window]), [["shop/orders", "2026-11-12T00:00:00.000Z", true]]);
  assert.deepEqual(serviceWindowStarts(cfg, { services: { "shop/orders": { windowDays: 30 } } }, 30, end), [], "not shorter than the cluster's: nothing");
  // counted like a reset: 7 days = 2 whole 3-day parts + 1 day
  const plans = resetPlans(starts, end, 30);
  assert.deepEqual([plans[0]!.full, plans[0]!.remMin], [2, 1440]);
  // the schema takes them per service only
  assert.ok(SloSchema.safeParse({ services: { "shop/orders": { windowDays: 7, onlyUris: ["/a"] } } }).success);
  assert.ok(!SloSchema.safeParse({ services: { "shop/orders": { windowDays: 10 } } }).success);
  assert.ok(!SloSchema.safeParse({ onlyUris: ["/a"] }).success, "core endpoints are a service's");
});

test("core endpoints: only they count in the SLO cards; other URIs of that service are left out", () => {
  const row = (uri: string, status: string, value: number): PromRow => ({ metric: { namespace: "shop", application: "pay", uri, method: "POST", status }, value });
  const raw = { "n:30d": [row("/pay", "200", 900), row("/pay", "500", 1), row("/health-check", "500", 50)], "n:5m": [], "n:30m": [], "n:1h": [], "n:6h": [], "n:3d": [] };
  const all = aggregateSlo(raw, { windowDays: 30, les: [], C: "" }).services[0]!.slis.find((x) => x.kind === "availability")!;
  const core = aggregateSlo(raw, { windowDays: 30, les: [], C: "", platform: { services: { "shop/pay": { onlyUris: ["/pay"] } } } }).services[0]!.slis.find((x) => x.kind === "availability")!;
  assert.deepEqual([all.events, all.bad], [951, 51]);
  assert.deepEqual([core.events, core.bad], [901, 1], "the noisy /health-check no longer spends the budget");
});

test("settings form: the service's window and core endpoints round-trip; bad URIs are said; empty = inherit", () => {
  const r = { file: undefined, defaults: { availability: 0.999, latency: { thresholdMs: 1000, target: 0.99 } } } as unknown as Parameters<typeof S.settingsOf>[1];
  const d = S.draftOf({ services: { "shop/orders": { windowDays: 7, onlyUris: ["/a", "/b"] } } });
  assert.equal(d.services["shop/orders"]!.windowDays, "7");
  assert.equal(d.services["shop/orders"]!.onlyUris, "/a\n/b");
  const back = S.settingsOf(d, r);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.settings.services?.["shop/orders"], { windowDays: 7, onlyUris: ["/a", "/b"] });
  const empty = S.settingsOf({ ...d, services: { "shop/orders": { ...S.EMPTY_SERVICE } } }, r);
  assert.equal(empty.settings.services, undefined, "an emptied row = inherit, not an empty override");
});

test("view helpers: budget left never below 0; the SLI axis shows the target and every dip", () => {
  assert.equal(V.budgetLeft({ total: 1, bad: 1, sli: 0, allowed: 0.001, budgetUsed: 3, uptime: 0 }), 0);
  assert.equal(V.budgetLeft({ total: 1000, bad: 0, sli: 1, allowed: 1, budgetUsed: 0.456, uptime: 1 }), 0.544);
  assert.equal(V.budgetLeft({ total: 0, bad: 0, sli: null, allowed: 0, budgetUsed: null, uptime: null }), null);
  const b = (sli: number | null) => ({ t: 0, total: 1, bad: 0, sli, state: "ok" as const });
  assert.deepEqual(V.sliTicks([b(1), b(0.9995)], 0.999), { lo: 0.995, ticks: [0.995, 0.99625, 0.9975, 0.99875, 1] });
  assert.equal(V.sliTicks([b(0.6)], 0.999).lo, 0.5);
  // labels never repeat: 99.500 · 99.625 · … (the first screen read 100 % · 100 % · 99 %)
  assert.equal(V.tickDecimals([0.995, 0.99625, 0.9975, 0.99875, 1]), 3);
  assert.equal(V.tickDecimals([0.5, 0.625, 0.75, 0.875, 1]), 1);
  assert.equal(V.tickDecimals([0.99, 0.9925, 0.995, 0.9975, 1]), 2);
  assert.equal(V.tickDecimals([0, 0.25, 0.5, 0.75, 1]), 0);
  // the uptime tip stays inside the bar (a 390 px screen clipped it at the right)
  assert.deepEqual([V.tipLeft(10, 200, 290), V.tipLeft(150, 200, 290), V.tipLeft(285, 200, 290), V.tipLeft(100, 300, 290)], [0, 50, 90, 0]);
  assert.deepEqual(V.uptimeSegments([b(1), { ...b(null), state: "noData" }, { ...b(0.5), state: "error" }]), { ok: 1, error: 1, noData: 1 });
});

// ── 2026-11-19 (2nd): status-page bars — grades by burn rate, merged bars on narrow screens, the key-services board ──

test("grades: burn = failed share ÷ (1 − target) against the SRE Workbook's 14.4 and 6 — the API's and the web's are one rule", () => {
  assert.deepEqual(BURN_GRADES, { partial: 6, major: 14.4 });
  assert.deepEqual(V.BURN_GRADES, BURN_GRADES, "web thresholds = API thresholds");
  // target 99.9 %: 1 of 1000 = the target exactly (ok) · 2 = ×2 (minor) · 6 = ×6 (partial) · 15 = ×15 (major)
  const g = (bad: number, total = 1000) => gradeOf(total, bad, 0.999);
  assert.deepEqual([g(0).grade, g(0.4).grade, g(1).grade, g(2).grade, g(6).grade, g(14).grade, g(15).grade, g(0, 0.3).grade],
    ["ok", "ok", "ok", "minor", "partial", "partial", "major", "noData"]);
  assert.equal(g(15).burn, 15);
  for (const total of [0, 0.4, 1, 3, 50, 1000, 12345]) for (const bad of [0, 0.3, 1, 2, 7, 40, 900]) for (const target of [0.9, 0.99, 0.999, 0.9999]) {
    assert.deepEqual(V.gradeOf(total, bad, target), gradeOf(total, bad, target), `${total}/${bad}/${target}`);
  }
  // a bucket carries its grade; state stays the two-way answer (error = any grade under ok)
  const b = uptimeBuckets(new Map([[1, 1000], [2, 1000]]), new Map([[1, 2], [2, 20]]), [1, 2], 0.999);
  assert.deepEqual(b.map((x) => [x.state, x.grade, x.burn]), [["error", "minor", 2], ["error", "major", 20]]);
});

test("bars: a narrow row merges neighbouring buckets (counts summed, the worst bucket's grade, newest bar whole) — never under MIN_BAR", () => {
  assert.equal(V.mergeFactor(168, 1300), 1, "a wide row: one bucket per bar");
  assert.equal(V.mergeFactor(168, 290), 3, "a phone: 290 px fits 58 bars of 3 px + 2 px gap");
  assert.ok(168 / 3 * (V.MIN_BAR + V.BAR_GAP) - V.BAR_GAP <= 290);
  const mk = (t: number, total: number, bad: number) => {
    const x = gradeOf(total, bad, 0.999);
    return { t, total, bad, sli: x.sli, burn: x.burn, grade: x.grade, state: x.grade === "noData" ? "noData" as const : x.grade === "ok" ? "ok" as const : "error" as const };
  };
  const buckets = [mk(1, 0, 0), mk(2, 1000, 0), mk(3, 1000, 0), mk(4, 1000, 20), mk(5, 1000, 0), mk(6, 1000, 0), mk(7, 1000, 1)];
  const bars = V.mergeBuckets(buckets, 3, 60, 0.999);
  assert.deepEqual(bars.map((x) => x.buckets), [1, 3, 3], "the oldest bar holds what is left");
  assert.deepEqual(bars.map((x) => x.t), [1, 4, 7]);
  assert.equal(bars.reduce((a, x) => a + x.bad, 0), 21, "failed requests kept");
  assert.equal(bars.reduce((a, x) => a + x.total, 0), 6000, "requests kept");
  // the bar's grade = its worst bucket (the hour with 20 failed was major); the burn is the merged hours' (20 / 3000 = ×6.67)
  assert.deepEqual(bars.map((x) => x.grade), ["noData", "major", "ok"]);
  assert.equal(bars[1]!.burn, 6.67);
  assert.deepEqual(V.mergeBuckets(buckets, 1, 60, 0.999).map((x) => x.grade), buckets.map((x) => x.grade), "k = 1 keeps the API's grades");
  assert.equal(V.uptimeShare(bars), 0.5);
  assert.equal(V.latestGrade(bars), "ok");
  assert.deepEqual(V.gradeCounts(bars), { noData: 1, ok: 1, minor: 0, partial: 0, major: 1 });
});

test("board: the overall row = the worst service per bar (no data only when none had requests); its tip lists the services below ok", () => {
  const bar = (t: number, grade: "ok" | "minor" | "partial" | "major" | "noData", total = 100, bad = 0) => ({ t, from: t - 1, total, bad, sli: null, grade, burn: null, buckets: 1 });
  const o = V.overallBars([
    { key: "shop/a", bars: [bar(1, "ok"), bar(2, "minor", 100, 1), bar(3, "noData", 0)] },
    { key: "shop/b", bars: [bar(1, "noData", 0), bar(2, "major", 100, 9), bar(3, "noData", 0)] },
    { key: "shop/c", bars: [bar(1, "ok")] },
  ]);
  assert.deepEqual(o.map((x) => x.grade), ["ok", "major", "noData"]);
  assert.deepEqual(o[1]!.worst, [{ key: "shop/b", grade: "major" }, { key: "shop/a", grade: "minor" }]);
  assert.deepEqual([o[1]!.total, o[1]!.bad], [200, 10]);
  assert.deepEqual(V.overallBars([]), []);
});

test("board list: the platform's settings › the connection file's; at most 12, each once; the settings form keeps the marked order", () => {
  assert.deepEqual(boardServices({ uptime: { services: ["shop/a", "shop/b"], windowDays: 7 } }, { uptime: { services: ["x/y"] } }), { services: ["shop/a", "shop/b"], windowDays: 7, source: "platform" });
  assert.deepEqual(boardServices({}, { uptime: { services: ["x/y"], windowDays: 14 } }), { services: ["x/y"], windowDays: 14, source: "config" });
  assert.deepEqual(boardServices({ uptime: { services: [], windowDays: 28 } }, undefined), { services: [], windowDays: 28, source: "none" });
  assert.ok(SloSchema.safeParse({ uptime: { services: ["shop/a"], windowDays: 30 } }).success);
  assert.ok(!SloSchema.safeParse({ uptime: { services: ["shop/a", "shop/a"] } }).success, "a service once");
  assert.ok(!SloSchema.safeParse({ uptime: { services: Array.from({ length: 13 }, (_, i) => `shop/s${i}`) } }).success, "at most 12");
  assert.ok(!SloSchema.safeParse({ uptime: { services: ["Not A Key"] } }).success);
  // the form: marked = appended, unmarked = removed, never over 12; an empty board saves nothing
  let list: string[] = [];
  for (const k of ["shop/c", "shop/a", "shop/b"]) list = S.toggleUptime(list, k, true);
  list = S.toggleUptime(list, "shop/a", false);
  assert.deepEqual(list, ["shop/c", "shop/b"]);
  assert.equal(S.toggleUptime(Array.from({ length: 12 }, (_, i) => `shop/s${i}`), "shop/x", true).length, 12);
  const r = { file: undefined, defaults: { availability: 0.999, latency: { thresholdMs: 1000, target: 0.99 } } } as unknown as Parameters<typeof S.settingsOf>[1];
  const d = S.draftOf({ uptime: { services: ["shop/c", "shop/b"], windowDays: 7 } });
  assert.deepEqual(S.settingsOf(d, r).settings.uptime, { services: ["shop/c", "shop/b"], windowDays: 7 });
  assert.equal(S.settingsOf({ ...d, uptime: [], uptimeWindow: "" }, r).settings.uptime, undefined);
  assert.deepEqual(cleanSettings({ uptime: { services: [] } }), {}, "an emptied board is not stored");
  // a key service with no other setting still gets a row in the settings table
  assert.ok(S.serviceRows([], { file: null, settings: { uptime: { services: ["shop/only-board"] } } } as never).some((x) => x.key === "shop/only-board"));
});
