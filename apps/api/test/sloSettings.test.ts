// AKS 모니터링 › SLO › 설정 — the platform's SLO targets and error-budget resets (API services/sloSettingsStore.ts +
// workloadSlo resetPlans / mergeSloParts / aggregateSlo, web lib/sloSettingsView.ts). A reset counts a service's
// budget from the reset (the parts after it + one small query for the piece before the next part boundary); the
// burn-rate alerts are about now and are never reset; the most specific target wins; a stale save gets 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { SloBudgetReset, SloSettings, SloSettingsResponse } from "@aud/types";
import {
  SLO_MAX_RESETS, SloResetBody, addSloReset, cleanSettings, clearSloSettingsMemory, readSloSettings, removeSloReset, resetFor, settingsDiff,
  validateReset, writeSloSettings,
} from "../src/services/sloSettingsStore.js";
import { aggregateSlo, mergeSloParts, resetPlans, sloQueries, targetsFor, type SloConfig, type SloRaw } from "../src/services/workloadSlo.js";
import * as viewNs from "../../web/src/lib/sloSettingsView.ts";

const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const C = 'cluster="aks-a"';
const CLUSTER = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-a/providers/Microsoft.ContainerService/managedClusters/aks-a";
const DAY = 86_400_000;
const END = Date.parse("2026-11-11T00:00:00Z");
const reset = (service: string, daysAgo: number, id = "a1b2c3d4e5f6"): SloBudgetReset => ({
  id, service, at: new Date(END - daysAgo * DAY).toISOString(), reason: "incident fixed and reviewed", createdAt: new Date(END).toISOString(),
});

// ── targets: the most specific wins ──

test("targets: service (platform) › service (file) › cluster (platform) › file top level › defaults; excluded URIs add up", () => {
  const file: SloConfig = { availability: 0.99, latency: { thresholdMs: 1000, target: 0.95 }, excludeUris: ["/a"], services: { "shop/orders": { availability: 0.995 } } };
  const platform: SloConfig = { availability: 0.999, excludeUris: ["/b"], services: { "shop/pay": { latency: { thresholdMs: 300, target: 0.99 }, excludeUris: ["/c"] } } };
  const orders = targetsFor(file, "shop", "orders", platform);
  assert.deepEqual([orders.availability.target, orders.availability.source], [0.995, "config"], "the service's file value beats the cluster's platform value");
  const pay = targetsFor(file, "shop", "pay", platform);
  assert.deepEqual([pay.availability.target, pay.availability.source], [0.999, "platform"]);
  assert.deepEqual([pay.latency.thresholdMs, pay.latency.source], [300, "platform"]);
  assert.deepEqual([...pay.exclude].sort(), ["/a", "/b", "/c"]);
  const other = targetsFor(file, "shop", "other", platform);
  assert.deepEqual([other.latency.thresholdMs, other.latency.source], [1000, "config"]);
  assert.equal(targetsFor(undefined, "shop", "x", undefined).availability.source, "default");
  // leaving a service out: its platform value over its file value
  assert.equal(targetsFor({ services: { "shop/x": { exclude: true } } }, "shop", "x", { services: { "shop/x": { exclude: false } } }).skip, false);
});

// ── resets as queries ──

test("reset plan: minutes since the reset = whole 3-day parts + the piece before the next boundary; outside the window or ahead = none", () => {
  const plans = resetPlans([reset("shop/orders", 4), reset("shop/old", 31, "000000000001"), reset("*", -0.5, "000000000002")], END, 30);
  assert.equal(plans.length, 1, "older than the window and still ahead are ignored");
  assert.deepEqual([plans[0]!.ageMin, plans[0]!.full, plans[0]!.remMin], [5760, 1, 1440]);
  const q = sloQueries(C, C, 7, ["1.0"], plans);
  assert.match(q["r0:n"]!, /\[1440m\] offset 3d\)/);
  assert.match(q["r0:n"]!, /namespace="shop",application="orders"/, "the piece is filtered to the service — a cheap query");
  assert.match(q["r0:g:1.0"]!, /le="1\.0"/);
  assert.match(q["r0:coverage"]!, /\[1440m:1h\] offset 3d\)/);
  const all = sloQueries(C, C, 7, ["1.0"], resetPlans([reset("*", 1)], END, 7));
  assert.doesNotMatch(all["r0:n"]!, /application=/, "the cluster-wide reset reads every service");
  assert.doesNotMatch(all["r0:n"]!, /offset/, "under 3 days: no offset");
});

test("merge: a reset service sums only the parts after the reset + its piece; others the whole window; a failed piece fails only its services", () => {
  const m = (app: string, status = "200") => ({ namespace: "shop", application: app, uri: "/a", method: "get", status });
  const raw: SloRaw = {
    "n:3d": [{ metric: m("orders"), value: 10 }, { metric: m("batch"), value: 4 }],
    "n:7d#1": [{ metric: m("orders", "500"), value: 100 }, { metric: m("batch"), value: 3 }],
    "n:7d#2": [{ metric: m("orders"), value: 50 }, { metric: m("batch"), value: 2 }],
    "r0:n": [{ metric: m("orders"), value: 7 }],
    "g:3d:1.0": [], "g:7d:1.0#1": [], "g:7d:1.0#2": [], "r0:g:1.0": [],
  };
  const plans = resetPlans([reset("shop/orders", 4)], END, 7);
  const out = mergeSloParts(raw, new Set(), 7, ["1.0"], plans);
  const val = (app: string) => out.raw["n:7d"]!.filter((r) => r.metric.application === app).reduce((s, r) => s + r.value, 0);
  assert.equal(val("orders"), 17, "part 0 (after the reset) + the piece — the incident's 100 failures 4 days ago are gone");
  assert.equal(val("batch"), 9, "no reset: the whole window");
  assert.ok(!out.raw["n:7d"]!.some((r) => r.metric.status === "500"));
  const failed = mergeSloParts(raw, new Set(["r0:n"]), 7, ["1.0"], plans);
  assert.ok(failed.failedPlans.has(0) && !failed.failed.has("n:7d"), "only the reset services fail");
});

test("merge: the newest matching reset counts — a service reset after the cluster-wide one wins, and the unfiltered piece is not double-counted", () => {
  const m = (app: string) => ({ namespace: "shop", application: app, uri: "/a", method: "get", status: "200" });
  const plans = resetPlans([reset("*", 5, "000000000001"), reset("shop/orders", 1, "000000000002")], END, 7);
  assert.deepEqual(plans.map((p) => p.reset.service), ["shop/orders", "*"], "newest first");
  const raw: SloRaw = {
    "n:3d": [{ metric: m("orders"), value: 30 }, { metric: m("batch"), value: 40 }],
    "n:7d#1": [{ metric: m("orders"), value: 1 }, { metric: m("batch"), value: 1 }], "n:7d#2": [],
    "r0:n": [{ metric: m("orders"), value: 8 }],
    "r1:n": [{ metric: m("orders"), value: 99 }, { metric: m("batch"), value: 6 }],
  };
  const out = mergeSloParts(raw, new Set(), 7, [], plans);
  const val = (app: string) => out.raw["n:7d"]!.filter((r) => r.metric.application === app).reduce((s, r) => s + r.value, 0);
  assert.equal(val("orders"), 8, "its own reset a day ago: only its piece");
  assert.equal(val("batch"), 46, "the cluster-wide reset 5 days ago: part 0 + the * piece");
});

test("aggregate: the budget counts from the reset; the burn alerts still page on an ongoing burn; a failed piece = queryFailed for that service only", () => {
  const W = ["5m", "30m", "1h", "6h", "3d", "30d"];
  const rows = (app: string, ok: number, bad: number) => [
    { metric: { namespace: "shop", application: app, uri: "/a", method: "get", status: "200" }, value: ok },
    { metric: { namespace: "shop", application: app, uri: "/a", method: "get", status: "500" }, value: bad },
  ];
  const raw: SloRaw = { coverage: [{ metric: { namespace: "shop", application: "orders" }, value: 720 }, { metric: { namespace: "shop", application: "batch" }, value: 720 }] };
  for (const w of W) raw[`n:${w}`] = [...rows("orders", 10_000, w === "1h" || w === "5m" ? 2_000 : 0), ...rows("batch", 10_000, 0)];
  const plans = resetPlans([reset("shop/orders", 2)], END, 30);
  const res = aggregateSlo(raw, { windowDays: 30, les: [], C, plans });
  const orders = res.services.find((s) => s.application === "orders")!;
  assert.equal(orders.reset?.scope, "service");
  assert.equal(orders.reset?.windowHours, 48);
  assert.deepEqual(orders.coverage, { hours: 48, windowHours: 48 }, "coverage capped at the hours since the reset");
  const av = orders.slis.find((x) => x.kind === "availability")!;
  assert.match(av.expr, /\[2880m\]/, "the PromQL reads the span since the reset");
  assert.equal(av.state, "fastBurn", "a burn happening now still pages after a reset");
  assert.equal(res.services.find((s) => s.application === "batch")!.reset, undefined);
  const failed = aggregateSlo(raw, { windowDays: 30, les: [], C, plans, failedPlans: new Set([0]) });
  assert.equal(failed.services.find((s) => s.application === "orders")!.slis[0]!.state, "queryFailed");
  assert.equal(failed.services.find((s) => s.application === "batch")!.slis[0]!.state, "ok");
});

// ── the store ──

test("store: a save names the revision it edited (stale = conflict); empty fields are dropped; history says what, not values", async () => {
  clearSloSettingsMemory();
  const a = await writeSloSettings(undefined, CLUSTER, { baseRev: 0, settings: { availability: 0.999, services: { "shop/a": { exclude: false, excludeUris: [] } } } }, { by: "Kim" });
  assert.ok(a.ok);
  assert.deepEqual(a.ok && a.doc.settings, { availability: 0.999 }, "a service entry with nothing set is not kept");
  assert.deepEqual(a.ok && [a.doc.rev, a.doc.version, a.doc.history[0]!.detail, a.doc.updatedBy], [1, 1, "availability", "Kim"]);
  const stale = await writeSloSettings(undefined, CLUSTER, { baseRev: 0, settings: {} });
  assert.ok(!stale.ok && stale.error === "conflict");
  const upper = await readSloSettings(undefined, CLUSTER.toUpperCase());
  assert.equal(upper.rev, 1, "the cluster ID is case-insensitive");
  assert.equal(settingsDiff({ windowDays: 30 }, { windowDays: 30, services: { "shop/b": { availability: 0.99 } } }), "services: shop/b");
  assert.deepEqual(cleanSettings({ excludeUris: [], services: {} }), {});
});

test("store: a reset needs a reason, a time between 30 days ago and now; one per service (the new one replaces); undo; version moves, rev does not", async () => {
  clearSloSettingsMemory();
  assert.ok(!SloResetBody.safeParse({ service: "shop/orders", reason: "ab" }).success, "a reason of 3+ characters");
  assert.ok(!SloResetBody.safeParse({ service: "Shop Orders", reason: "valid" }).success, "<namespace>/<application> or *");
  const now = new Date(END);
  assert.ok(!validateReset({ service: "*", reason: "x x x", at: new Date(END + 5 * 60_000).toISOString() }, now).ok, "not ahead");
  assert.ok(!validateReset({ service: "*", reason: "x x x", at: new Date(END - 31 * DAY).toISOString() }, now).ok, "not before the longest window");
  // kept on the minute: the SLO read ends on a minute — a reset at :22 s read at :00 s was "ahead" and left out (stg)
  const sec = new Date(END + 22_000);
  const v = validateReset({ service: "*", reason: "x x x" }, sec);
  assert.ok(v.ok && v.at.getTime() === END);
  assert.equal(resetPlans([{ ...reset("*", 0), at: v.ok ? v.at.toISOString() : "" }], Math.floor(sec.getTime() / 60_000) * 60_000, 30).length, 1, "counts on the very next read");
  const one = await addSloReset(undefined, CLUSTER, { service: "shop/orders", reason: "deploy incident" }, { now, by: "Lee" });
  const two = await addSloReset(undefined, CLUSTER, { service: "shop/orders", reason: "second look", at: new Date(END - DAY).toISOString() }, { now });
  assert.ok(one.ok && two.ok);
  if (!two.ok) return;
  assert.equal(two.doc.resets.length, 1, "the newer reset replaces the service's previous one");
  assert.deepEqual([two.doc.rev, two.doc.version], [0, 2], "a reset never conflicts with a settings edit");
  const undo = await removeSloReset(undefined, CLUSTER, two.doc.resets[0]!.id, { now });
  assert.ok(undo.ok && undo.doc.resets.length === 0);
  assert.deepEqual(undo.ok && undo.doc.history.map((h) => h.action), ["undoReset", "reset", "reset"]);
  const gone = await removeSloReset(undefined, CLUSTER, "ffffffffffff", { now });
  assert.ok(!gone.ok && gone.error === "slo_reset_not_found");
});

test("store: at most SLO_MAX_RESETS per cluster; resetFor takes the newest matching one inside the window", async () => {
  clearSloSettingsMemory();
  const now = new Date(END);
  for (let i = 0; i < SLO_MAX_RESETS; i++) assert.ok((await addSloReset(undefined, CLUSTER, { service: `shop/s${i}`, reason: "bulk test" }, { now })).ok);
  const full = await addSloReset(undefined, CLUSTER, { service: "shop/one-more", reason: "bulk test" }, { now });
  assert.ok(!full.ok && full.error === "slo_reset_full");
  const list = [reset("*", 3, "000000000001"), reset("shop/a", 1, "000000000002"), reset("shop/a", 40, "000000000003")];
  assert.equal(resetFor(list, "shop", "a", END, 30)?.id, "000000000002");
  assert.equal(resetFor(list, "shop", "b", END, 30)?.id, "000000000001");
  assert.equal(resetFor(list, "shop", "b", END, 2), null, "outside a 2-day window");
});

test("store: on disk — one file per cluster named by a hash (no ARM ID in the name), read back after a restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aud-slo-"));
  try {
    const w = await writeSloSettings(dir, CLUSTER, { baseRev: 0, settings: { windowDays: 14 } });
    assert.ok(w.ok);
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^[0-9a-f]{32}\.json$/);
    assert.ok((await readFile(path.join(dir, names[0]!), "utf8")).includes(CLUSTER.toLowerCase()));
    assert.equal((await readSloSettings(dir, CLUSTER)).settings.windowDays, 14);
    assert.equal((await readSloSettings(dir, CLUSTER.replace("aks-a", "aks-b"))).rev, 0, "another cluster starts empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the form (web lib/sloSettingsView) ──

const R: Pick<SloSettingsResponse, "file" | "defaults"> = {
  file: { availability: 0.995, latency: { thresholdMs: 1000, target: 0.99 }, services: { "shop/orders": { availability: 0.99 } } },
  defaults: { windowDays: 30, availability: 0.999, latency: { thresholdMs: 1000, target: 0.99 } },
};

test("form: saved settings ↔ fields round-trip; empty = inherit; one latency half takes the other from what it inherits", () => {
  const s: SloSettings = { windowDays: 14, availability: 0.999, excludeUris: ["/x", "/y"], services: { "shop/pay": { latency: { thresholdMs: 300, target: 0.95 }, exclude: true } } };
  const back = V.settingsOf(V.draftOf(s), R);
  assert.deepEqual(back.errors, []);
  assert.ok(V.sameSettings(back.settings, s));
  const half = V.settingsOf({ ...V.draftOf({}), thresholdMs: "500" }, R);
  assert.deepEqual(half.settings, { latency: { thresholdMs: 500, target: 0.99 } });
  const cleared = V.settingsOf({ ...V.draftOf(s), windowDays: "", availability: "", excludeUris: "", services: { "shop/pay": { ...V.EMPTY_SERVICE } } }, R);
  assert.deepEqual(cleared.settings, {}, "a cleared form saves nothing — everything inherits again");
  const bad = V.settingsOf({ ...V.draftOf({}), thresholdMs: "1.5", availability: "2" }, R);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ["cluster.availability", "cluster.thresholdMs"]);
});

test("form: what an empty field inherits = what the API would compute (targetsFor) — the hint never lies", () => {
  const platform: SloSettings = { availability: 0.9995, latency: { thresholdMs: 500, target: 0.995 } };
  for (const key of ["shop/orders", "shop/other"]) {
    const [ns, app] = key.split("/") as [string, string];
    const api = targetsFor(R.file as SloConfig, ns, app, platform as SloConfig);
    const web = V.inherited(R, platform, key);
    assert.deepEqual([web.availability.v, web.availability.source], [api.availability.target, api.availability.source], key);
    assert.deepEqual([web.latency.v.thresholdMs, web.latency.source], [api.latency.thresholdMs, api.latency.source], key);
  }
  assert.deepEqual(V.inherited(R, {}).availability, { v: 0.995, source: "config" }, "the cluster's own field inherits the file");
  assert.deepEqual(V.inheritedWindow(R), { v: 30, source: "default" });
});

test("form: the services listed — measured first, then names only in the settings or the file; resets end when they leave the window", () => {
  const measured = [{ namespace: "shop", application: "pay" }, { namespace: "shop", application: "" }] as never;
  const rows = V.serviceRows(measured, { file: R.file, settings: { services: { "ops/batch": { exclude: true } } } });
  assert.deepEqual(rows.map((r) => [r.key, !!r.measured]), [["shop/pay", true], ["ops/batch", false], ["shop/orders", false]]);
  const x = reset("shop/pay", 2);
  assert.deepEqual(V.resetState(x, END, 30), { active: true, endsAt: Date.parse(x.at) + 30 * DAY, future: false });
  assert.equal(V.resetState(x, END + 29 * DAY, 30).active, false);
  const justNow = { ...x, at: new Date(END + 60_000).toISOString() };
  assert.deepEqual([V.resetState(justNow, END, 30).active, V.resetState(justNow, END, 30).future], [true, false], "the viewer's clock a minute behind: not 'scheduled'");
  const t = (k: string, v?: Record<string, string | number>) => `${k}:${JSON.stringify(v)}`;
  assert.equal(V.spanLabel(t, 50.5), 'ob.slo.span.dh:{"days":2,"hours":2}');
  assert.equal(V.spanLabel(t, 5), 'ob.slo.span.h:{"days":0,"hours":5}');
});

// ── wiring: routes gated, every dynamic key translated, events live under the heatmap ──

test("routes: read signed-in, change operator-only; every key built at runtime exists in ko/en", () => {
  const routes = readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8");
  assert.match(routes, /router\.get\("\/api\/observability\/slo\/settings"/);
  for (const m of ['put("/api/observability/slo/settings"', 'post("/api/observability/slo/resets"', 'delete("/api/observability/slo/resets"']) {
    assert.ok(routes.includes(`${m}, requireRole(env, "operator")`), m);
  }
  const ops = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const has = (k: string) => new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`).test(ops);
  const ui = readFileSync(new URL("../../web/src/app/observability/components/SloSettings.tsx", import.meta.url), "utf8");
  const codes = [.../const ERR_CODES = new Set\(\[([^\]]+)\]/.exec(ui)![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(codes.length >= 5);
  for (const k of [...codes.map((c) => `ob.slo.set.err.${c}`), "ob.slo.set.err.other",
    ...["platform", "config", "default"].flatMap((s) => [`ob.slo.set.src.${s}`, `ob.slo.g.source.${s}`]),
    ...["settings", "reset", "undoReset"].map((a) => `ob.slo.set.action.${a}`)]) assert.ok(has(k), k);
});

test("K8s events are a section of 클러스터 · 워크로드 (under the heatmap), not a tab of their own", () => {
  const page = readFileSync(new URL("../../web/src/app/observability/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /const TABS: Tab\[\] = \[[^\]]*"events"/);
  assert.match(page, /tab === "overview" && <WorkloadHeatmap [^\n]+\n\s+\{tab === "overview" && <EventsSection /);
  const msgs = readFileSync(new URL("../../web/src/lib/i18nMessages.ts", import.meta.url), "utf8");
  assert.doesNotMatch(msgs, /"obs\.tab\.events"/);
});
