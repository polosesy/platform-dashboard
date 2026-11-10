import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLO_DEFAULTS, SLO_PART_DAYS, SLO_TIERS, aggregateSlo, effectiveBucket, mergeSloParts, sliExpr, sloPartKey, sloQueries, sloWindowParts, targetsFor,
  type SloConfig, type SloRaw,
} from "../src/services/workloadSlo.js";

// Shapes measured in a customer Azure Monitor workspace (Micrometer http_server_requests_seconds, 2026-11-05):
// grouped by namespace, application, uri, method, status; bucket boundaries include exact 0.1 · 0.3 · 0.5 · 1.0 · 3.0.
// Names are placeholders.
const C = 'cluster="aks-a"';
const WINDOWS = ["5m", "30m", "1h", "6h", "3d", "30d"];
type Row = { app: string; uri: string; method?: string; status: string; n: number; fast?: number };

/** Every window gets the same rows unless a window overrides them */
function raw(rows: Row[], over: Record<string, Row[]> = {}, extra: SloRaw = {}): SloRaw {
  const out: SloRaw = {};
  for (const w of WINDOWS) {
    const rs = over[w] ?? rows;
    const m = (x: Row) => ({ namespace: "shop", application: x.app, uri: x.uri, method: x.method ?? "get", status: x.status });
    out[`n:${w}`] = rs.map((x) => ({ metric: m(x), value: x.n }));
    out[`g:${w}:1.0`] = rs.map((x) => ({ metric: { ...m(x), le: "1.0" }, value: x.fast ?? x.n }));
  }
  out.coverage = [...new Set(rows.map((x) => x.app))].map((app) => ({ metric: { namespace: "shop", application: app }, value: 720 }));
  out.deployments = [{ metric: { namespace: "shop", deployment: "orders" }, value: 2 }, { metric: { namespace: "shop", deployment: "batch" }, value: 1 }];
  out.statefulsets = [];
  return { ...out, ...extra };
}
const agg = (r: SloRaw, cfg?: SloConfig, failed?: Set<string>) => aggregateSlo(r, { cfg, windowDays: 30, les: ["1.0"], C, failed });
const svc = (res: ReturnType<typeof agg>, app: string) => res.services.find((s) => s.application === app)!;
const sli = (res: ReturnType<typeof agg>, app: string, kind: "availability" | "latency") => svc(res, app).slis.find((s) => s.kind === kind)!;

test("availability: not 5xx / all · budget used against the target · the default is marked", () => {
  const res = agg(raw([{ app: "orders", uri: "/orders", status: "200", n: 99_950 }, { app: "orders", uri: "/orders", status: "500", n: 50 }]));
  const a = sli(res, "orders", "availability");
  assert.equal(a.events, 100_000);
  assert.equal(a.bad, 50);
  assert.ok(Math.abs(a.sli! - 0.9995) < 1e-9);
  assert.equal(a.budgetUsed, 0.5); // 50 of (1 − 0.999) × 100 000 = 100
  assert.equal(a.targetSource, "default");
  assert.equal(a.target, SLO_DEFAULTS.availability);
  assert.equal(a.state, "ok");
  assert.equal(a.achievable, 0.9995);
  assert.match(a.expr, /status=~"5\.\."/);
  assert.equal(svc(res, "orders").workload, "orders");
});

test("latency: over the bucket boundary = bad, 1xx not counted · exhausted names the URI that spent it", () => {
  const res = agg(raw([
    { app: "gateway", uri: "/api/**", status: "200", n: 9_000, fast: 8_990 },
    { app: "gateway", uri: "/public/*/webhooks/**", method: "post", status: "200", n: 1_000, fast: 100 },
    { app: "gateway", uri: "/ws", status: "101", n: 500, fast: 0 }, // a websocket upgrade is not a slow request
  ]));
  const l = sli(res, "gateway", "latency");
  assert.equal(l.events, 10_000);
  assert.equal(l.bad, 910);
  assert.equal(l.budgetUsed, 9.1); // 910 of 1 % × 10 000
  assert.equal(l.effectiveMs, 1000);
  assert.deepEqual(l.topBad[0], { uri: "/public/*/webhooks/**", method: "post", bad: 900, events: 1000 });
  const s = svc(res, "gateway");
  // every window has the same share here, so the page-level burn also fires: fastBurn outranks exhausted
  assert.equal(l.state, "fastBurn");
  assert.ok(s.advice.some((a) => a.id === "exhausted" && a.sli === "latency"));
  assert.ok(s.advice.some((a) => a.id === "topBad" && a.params?.uri === "/public/*/webhooks/**" && a.params?.share === 99));
  assert.equal(s.workload, null); // no Deployment named gateway
});

test("a URI the team excludes (a webhook that waits on purpose) counts nowhere", () => {
  const rows: Row[] = [
    { app: "gateway", uri: "/api/**", status: "200", n: 9_000, fast: 8_990 },
    { app: "gateway", uri: "/public/*/webhooks/**", method: "post", status: "200", n: 1_000, fast: 100 },
  ];
  const res = agg(raw(rows), { services: { "shop/gateway": { excludeUris: ["/public/*/webhooks/**"] } } });
  const l = sli(res, "gateway", "latency");
  assert.equal(l.events, 9_000);
  assert.equal(l.bad, 10);
  assert.equal(l.state, "ok");
  assert.equal(sli(res, "gateway", "availability").events, 9_000);
});

test("burn rate: page when 1 h and 5 m both burn over 14.4× · a burn that stopped does not page", () => {
  const steady: Row[] = [{ app: "orders", uri: "/o", status: "200", n: 1_000_000 }];
  const burning = agg(raw(steady, {
    "1h": [{ app: "orders", uri: "/o", status: "200", n: 900 }, { app: "orders", uri: "/o", status: "503", n: 100 }],
    "5m": [{ app: "orders", uri: "/o", status: "200", n: 90 }, { app: "orders", uri: "/o", status: "503", n: 10 }],
  }));
  const a = sli(burning, "orders", "availability");
  assert.equal(a.burn.find((b) => b.window === "1h")!.rate, 100); // 10 % bad / 0.1 % allowed
  assert.equal(a.alerts.find((x) => x.id === "page1h")!.firing, true);
  assert.equal(a.state, "fastBurn");
  assert.ok(svc(burning, "orders").advice.some((x) => x.id === "fastBurn" && x.params?.alerts === "page1h"));

  const stopped = agg(raw(steady, {
    "1h": [{ app: "orders", uri: "/o", status: "200", n: 900 }, { app: "orders", uri: "/o", status: "503", n: 100 }],
    "5m": [{ app: "orders", uri: "/o", status: "200", n: 100 }],
  }));
  assert.equal(sli(stopped, "orders", "availability").alerts.find((x) => x.id === "page1h")!.firing, false);
});

test("too few requests in the long window: the alert is not judged (one failure is not a 100× burn)", () => {
  const res = agg(raw([{ app: "orders", uri: "/o", status: "200", n: 1_000_000 }], {
    "1h": [{ app: "orders", uri: "/o", status: "200", n: 40 }, { app: "orders", uri: "/o", status: "500", n: 1 }],
    "5m": [{ app: "orders", uri: "/o", status: "500", n: 1 }],
  }));
  const a = sli(res, "orders", "availability");
  assert.equal(a.alerts.find((x) => x.id === "page1h")!.firing, null);
  assert.equal(a.state, "ok");
});

test("low traffic: one bad request would use the whole budget — shown, not judged", () => {
  const res = agg(raw([{ app: "rare", uri: "/x", status: "200", n: 30 }]));
  const a = sli(res, "rare", "availability");
  assert.equal(a.state, "lowTraffic");
  assert.equal(a.achievable, null);
  assert.ok(svc(res, "rare").advice.some((x) => x.id === "lowTraffic"));
});

test("bucket boundary: the largest at or under the threshold — a threshold between boundaries says so", () => {
  const les = ["0.1", "0.3", "1.0", "3.0", "+Inf"];
  assert.deepEqual(effectiveBucket(les, 1000), { le: "1.0", ms: 1000 });
  assert.equal(effectiveBucket(les, 500)!.le, "0.3");
  assert.equal(effectiveBucket(les, 50), null);
  const r = raw([{ app: "orders", uri: "/o", status: "200", n: 10_000 }]);
  r["g:30d:0.3"] = r["g:30d:1.0"]!.map((x) => ({ ...x, metric: { ...x.metric, le: "0.3" } }));
  const res = aggregateSlo(r, { cfg: { latency: { thresholdMs: 500, target: 0.99 } }, windowDays: 30, les: ["0.3"], C });
  const l = sli(res, "orders", "latency");
  assert.equal(l.effectiveMs, 300);
  assert.equal(l.targetSource, "config");
  assert.ok(svc(res, "orders").advice.some((x) => x.id === "thresholdNotBucket" && x.params?.counted === 300));
});

test("no histogram: latency is noData with the setting to turn on — availability still stands", () => {
  const r = raw([{ app: "orders", uri: "/o", status: "200", n: 10_000 }]);
  for (const k of Object.keys(r)) if (k.startsWith("g:")) delete r[k];
  const res = agg(r);
  assert.equal(sli(res, "orders", "latency").state, "noData");
  assert.equal(sli(res, "orders", "latency").bad, null);
  assert.equal(sli(res, "orders", "availability").state, "ok");
  assert.ok(svc(res, "orders").advice.some((x) => x.id === "noHistogram"));
});

test("a failed query: only the values that need it say queryFailed", () => {
  const res = agg(raw([{ app: "orders", uri: "/o", status: "200", n: 10_000 }]), undefined, new Set(["g:30d:1.0", "n:1h"]));
  assert.equal(sli(res, "orders", "latency").state, "queryFailed");
  assert.equal(sli(res, "orders", "latency").sli, null);
  const a = sli(res, "orders", "availability");
  assert.equal(a.state, "ok");
  assert.equal(a.burn.find((b) => b.window === "1h")!.rate, null);
  assert.equal(a.alerts.find((x) => x.id === "page1h")!.firing, null);
});

test("coverage, untagged series, uninstrumented workloads, order (worst first), excluded services", () => {
  const r = raw([
    { app: "orders", uri: "/o", status: "200", n: 100_000 },
    { app: "gateway", uri: "/g", status: "500", n: 1_000 }, { app: "gateway", uri: "/g", status: "200", n: 99_000 },
    { app: "", uri: "/u", status: "200", n: 5_000 },
  ]);
  r.coverage = [{ metric: { namespace: "shop", application: "orders" }, value: 240 }];
  const res = agg(r, { services: { "shop/skipme": { exclude: true } } });
  assert.equal(res.services[0]!.application, "gateway");
  assert.ok(svc(res, "orders").advice.some((x) => x.id === "partialData" && x.params?.days === 10));
  assert.ok(svc(res, "").advice.some((x) => x.id === "noApplication"));
  assert.deepEqual(res.uninstrumented, [{ namespace: "shop", name: "batch", kind: "Deployment" }]);
  assert.equal(targetsFor({ services: { "shop/skipme": { exclude: true } } }, "shop", "skipme").skip, true);
});

test("queries: one grouping for both SLIs, /actuator never counted, the SLO window and every burn window", () => {
  const q = sloQueries(C, 'cluster="aks-a"', 30, ["1.0"]);
  for (const w of WINDOWS.filter((x) => x !== "30d")) {
    assert.match(q[`n:${w}`]!, new RegExp(`sum by \\(namespace, application, uri, method, status\\).*\\[${w}\\]`));
    assert.match(q[`g:${w}:1.0`]!, /le="1\.0"/);
  }
  assert.ok(Object.values(q).filter((x) => x.includes("http_server")).every((x) => x.includes('uri!~"/actuator.*"')));
  assert.match(sliExpr(C, "latency", "shop", "orders", 30, "1.0"), /status!~"1\.\."/);
});

// 2026-11-09 stg: `increase(…[30d])` over every service read 6,898 series (501 alive now) → Azure Monitor 429 "Query
// cost=27939 exceeds max limit=15000" on every try. The window is read in 3-day parts (part 0 = the 3d burn window).
test("the SLO window: never one long range — 3-day parts with offsets, part 0 reused, no gap or overlap", () => {
  assert.deepEqual(sloWindowParts(7), [{ range: "3d", offset: "" }, { range: "3d", offset: " offset 3d" }, { range: "1d", offset: " offset 6d" }]);
  for (const d of [7, 14, 28, 30]) {
    const parts = sloWindowParts(d);
    assert.equal(parts.reduce((s, p) => s + parseInt(p.range, 10), 0), d, `${d} days covered exactly`);
    assert.ok(parts.every((p) => parseInt(p.range, 10) <= SLO_PART_DAYS));
    const q = sloQueries(C, 'cluster="aks-a"', d, ["1.0"]);
    for (const [name, expr] of Object.entries(q)) {
      for (const m of expr.matchAll(/\[(\d+)d(?::1h)?\]/g)) assert.ok(Number(m[1]) <= SLO_PART_DAYS, `${name} reads ${m[1]} days in one query`);
    }
    assert.equal(q[`n:${d}d`], undefined, "no single-window query");
    assert.equal(sloPartKey(`n:${d}d`, d, 0), "n:3d", "part 0 is the burn window's query");
    // PromQL: the offset follows the range selector — `[3d] offset 3d`, never inside the brackets
    assert.match(q[sloPartKey(`g:${d}d:1.0`, d, parts.length - 1)]!, new RegExp(`\\[\\d+d\\] offset ${(parts.length - 1) * 3}d\\)`));
    assert.ok(Object.values(q).every((x) => !/\[[^\]]*offset/.test(x)), "no offset inside a range selector");
    assert.equal(Object.keys(q).filter((k) => k.startsWith("coverage#")).length, parts.length);
  }
});

test("the SLO window's parts sum per label set; one failed part fails the value (never a partial window)", () => {
  const m = (uri: string) => ({ namespace: "shop", application: "orders", uri, method: "get", status: "200" });
  const rawParts: SloRaw = { "n:3d": [{ metric: m("/a"), value: 10 }], "n:7d#1": [{ metric: m("/a"), value: 5 }, { metric: m("/b"), value: 1 }], "n:7d#2": [{ metric: m("/a"), value: 2 }],
    "g:3d:1.0": [{ metric: { ...m("/a"), le: "1.0" }, value: 9 }], "g:7d:1.0#1": [], "g:7d:1.0#2": [],
    "coverage#0": [{ metric: { namespace: "shop", application: "orders" }, value: 72 }], "coverage#1": [{ metric: { namespace: "shop", application: "orders" }, value: 70 }] };
  const ok = mergeSloParts(rawParts, new Set(["coverage#2"]), 7, ["1.0"]);
  assert.deepEqual(ok.raw["n:7d"]!.map((r) => [r.metric.uri, r.value]), [["/a", 17], ["/b", 1]]);
  assert.equal(ok.raw["g:7d:1.0"]![0]!.value, 9);
  assert.ok(ok.failed.has("coverage") && !ok.failed.has("n:7d"), "a coverage part failing only drops coverage");
  assert.ok(mergeSloParts(rawParts, new Set(["n:7d#1"]), 7, ["1.0"]).failed.has("n:7d"));
});

// ── web lib/sloView.ts (pure) ──
import * as svm from "../../web/src/lib/sloView.ts";
const sv = ((svm as { default?: typeof svm }).default ?? svm) as typeof svm;

test("view: percent digits, target text, budget in requests, burn text, alert levels", () => {
  assert.equal(sv.pctText(0.999561), "99.956%");
  assert.equal(sv.pctText(0.95712), "95.7%");
  assert.equal(sv.pctText(null), "—");
  assert.equal(sv.targetText(0.999), "99.9%");
  assert.equal(sv.targetText(0.9995), "99.95%");
  const res = agg(raw([{ app: "orders", uri: "/o", status: "200", n: 265_000 }, { app: "orders", uri: "/o", status: "500", n: 116 }]));
  const a = sli(res, "orders", "availability");
  assert.deepEqual(sv.budgetOf(a), { allowed: 265, used: 116, left: 149, usedPct: 44 });
  assert.equal(sv.burnText(14.4), "×14.4");
  assert.equal(sv.burnText(0.44), "×0.44");
  assert.equal(sv.burnText(140), "×140");
  assert.equal(sv.alertLevel({ id: "ticket3d", factor: 1, long: "3d", short: "6h", firing: true }), "warn");
  assert.equal(sv.alertLevel({ id: "page1h", factor: 14.4, long: "1h", short: "5m", firing: null }), "unknown");
  assert.deepEqual(sv.sliLabelParams(sli(res, "orders", "latency")), { ms: "1s" });
  const counts = sv.sloCounts(res.services);
  assert.equal(counts.ok + counts.warn + counts.danger + counts.neutral + counts.unknown, res.services.length);
  assert.equal(sv.filterServices(res.services, "problems", "").length, counts.danger + counts.warn);
});

test("view: a missed default target is orange (watch), a missed team target is red", () => {
  const rows: Row[] = [{ app: "gw", uri: "/a", status: "200", n: 10_000, fast: 9_000 }];
  const byDefault = agg(raw(rows)).services[0]!;
  const byTeam = agg(raw(rows), { latency: { thresholdMs: 1000, target: 0.99 } }).services[0]!;
  assert.equal(byDefault.state, byTeam.state); // the API's verdict is the same — only the colour differs
  assert.equal(sv.serviceLevel(byDefault), "warn");
  assert.equal(sv.serviceLevel(byTeam), "danger");
});

test("guide: the config draft starts one tier under the met tiers — the file's shape, defaults on top, one service per line", () => {
  const res = agg(raw([{ app: "gw", uri: "/a", status: "200", n: 10_000, fast: 9_000 }]));
  const s = res.services[0]!;
  const draft = sv.sloConfigDraft({ windowDays: 30, defaults: { availability: 0.999, latency: { thresholdMs: 1000, target: 0.99 } }, services: res.services });
  assert.ok(draft.startsWith(`"aks": {`), "a fragment to paste into the connection entry");
  const parsed = JSON.parse(`{${draft}}`) as { aks: { observability: { slo: Record<string, unknown> & { services?: Record<string, { availability?: number; latency?: { thresholdMs: number; target: number } }> } } } };
  const slo = parsed.aks.observability.slo;
  assert.deepEqual({ w: slo.windowDays, a: slo.availability, l: slo.latency }, { w: 30, a: 0.999, l: { thresholdMs: 1000, target: 0.99 } });
  const entry = slo.services?.[`${s.namespace}/gw`];
  assert.deepEqual(entry?.latency, { thresholdMs: 1000, target: 0.9 }, "90 % within 1 s met the lowest tier — it stays");
  assert.equal(entry?.availability, 0.9995, "no 5xx met the top tier 99.99 % — the draft asks one tier less (room in the budget)");
  assert.equal(draft.split("\n").filter((l) => l.includes(`"${s.namespace}/gw"`)).length, 1, "one line per service");
  // A service whose draft equals the top level adds nothing
  const none = sv.sloConfigDraft({ windowDays: 30, defaults: { availability: 0.9995, latency: { thresholdMs: 1000, target: 0.9 } }, services: res.services });
  assert.ok(!JSON.parse(`{${none}}`).aks.observability.slo.services);
  assert.equal(sv.draftTarget(0.999), 0.995);
  assert.equal(sv.draftTarget(0.9), 0.9);
  assert.equal(sv.msText(1000), "1s");
  assert.equal(sv.msText(300), "300ms");
});

test("guide: the tiers equal the API's; common thresholds name the boundary actually counted; boundaries without look-alikes", () => {
  assert.deepEqual([...sv.SLO_TIERS], [...SLO_TIERS]);
  // Micrometer-like: exact 0.1 · 0.3 · 0.5 · 1 · 3 plus default-histogram boundaries
  const h = sv.bucketHints([0.001, 0.001048576, 0.001398101, 0.1, 0.268435456, 0.3, 0.5, 1, 1.789569706, 3, Number.POSITIVE_INFINITY]);
  const pick = (ms: number) => h.picks.find((p) => p.ms === ms)!;
  assert.deepEqual(pick(1000), { ms: 1000, countedMs: 1000, exact: true });
  assert.equal(pick(2000).exact, false);
  assert.ok(Math.abs(pick(2000).countedMs! - 1789.569706) < 1e-6, "2 s is counted at 1.79 s");
  assert.ok(Math.abs(pick(200).countedMs! - 100) < 1e-9, "200 ms is counted at 100 ms");
  assert.equal(h.all.filter((x) => x === "1ms").length, 1, "1.000 / 1.048 / 1.398 ms read alike — shown once");
  assert.equal(sv.bucketHints([]).picks[0]!.countedMs, null);
});
