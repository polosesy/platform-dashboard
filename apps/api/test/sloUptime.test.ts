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
import { bucketMinutes, contributorsOf, uptimeBuckets, uptimeTotals, uriAlternation, UPTIME_BUCKETS } from "../src/services/sloUptime.js";
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
