// 서비스 (APM) › 오류 · 배포 and RED's week-earlier comparison (docs/architecture/apm-parity.md §4–5, 2026-11-16 3rd pass).
// Shapes as measured on stg: log4j2_events_total (no exception label; logback_events_total had no series — the plan to use
// it was wrong), kube_replicaset_created / _owner / kube_pod_container_info, spanmetrics 7 days back. Synthetic names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PromRow } from "../src/services/hubbleMetrics.js";
import { aggregateErrors, appErrorQueries, hourlyQuery } from "../src/services/appErrors.js";
import { compareQueries, deploymentImagesAt, redOf, rolloutQueries, rolloutsOf } from "../src/services/rollouts.js";
import { aggregateRed, redQueries } from "../src/services/workloadRed.js";
import * as moreNs from "../../web/src/lib/apmMoreView.ts";

const V = ((moreNs as unknown as { default?: typeof moreNs }).default ?? moreNs) as typeof moreNs;
const row = (metric: Record<string, string>, value: number): PromRow => ({ metric, value }) as PromRow;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const END = Date.UTC(2026, 0, 8, 0, 0, 0) / 1000; // a whole hour

test("errors: window counts by level kept to 2 decimals (apps add up to the total), 7-day hourly series → days · first · last · new", () => {
  const q = appErrorQueries("log4j2_events_total", 'cluster="c1",collector="alloy"', 'cluster="c1"', 60);
  assert.match(q.levels!, /sum by \(namespace, application, level\) \(increase\(log4j2_events_total\{cluster="c1",collector="alloy",level=~"\(\?i\)error\|fatal\|warn"\}\[60m\]\)\)/);
  assert.equal(hourlyQuery("log4j2_events_total", 'cluster="c1"'), 'sum by (namespace, application) (increase(log4j2_events_total{cluster="c1",level=~"(?i)error|fatal"}[1h]))');
  const raw = {
    levels: [
      row({ namespace: "app", application: "orders", level: "error" }, 10.4), row({ namespace: "app", application: "orders", level: "warn" }, 300.4),
      row({ namespace: "app", application: "report", level: "warn" }, 430.4), row({ namespace: "app", application: "report", level: "FATAL" }, 1),
    ],
    workloads: [row({ namespace: "app", deployment: "orders" }, 1), row({ namespace: "app", deployment: "report" }, 1), row({ namespace: "other", deployment: "report" }, 1)],
  };
  const h = (hoursAgo: number, v: number): [number, number] => [END - hoursAgo * 3600, v];
  const hourly = [
    { metric: { namespace: "app", application: "orders" }, values: [h(150, 3), h(30, 2), h(1, 5)] },
    { metric: { namespace: "app", application: "report" }, values: [h(5, 1), h(2, 0)] },
  ];
  const apps = aggregateErrors(raw, hourly, END);
  const orders = apps.find((a) => a.application === "orders")!, report = apps.find((a) => a.application === "report")!;
  assert.deepEqual([orders.error, orders.fatal, orders.warn], [10.4, 0, 300.4]);
  assert.equal((orders.warn ?? 0) + (report.warn ?? 0), 730.8, "not 730 from whole-number rounding of each app");
  assert.equal(orders.daily.length, 7);
  assert.equal(orders.daily.reduce((n, d) => n + d.errors, 0), 10, "all three samples fall in the 7 days before the end");
  assert.deepEqual([orders.daily[0]!.day, orders.daily[6]!.day], ["2026-01-01", "2026-01-07"], "an hour-aligned midnight end: the 7 days before it, no empty 'today'");
  assert.equal(orders.firstSeen, new Date((END - 151 * 3600) * 1000).toISOString(), "the hour that ends at the sample");
  assert.equal(orders.lastSeen, new Date((END - 3600) * 1000).toISOString());
  assert.equal(orders.newIn24h, false, "errors before the last day too");
  assert.equal(report.newIn24h, true, "errors only in the last 24 h");
  assert.deepEqual(orders.workload, { namespace: "app", name: "orders", kind: "Deployment" });
  assert.deepEqual(report.workload, { namespace: "app", name: "report", kind: "Deployment" }, "the app's own namespace decides between two");
  assert.equal(apps[0]!.application, "orders", "most errors first");
  // a level query that did not answer: null, never 0
  assert.equal(aggregateErrors({ workloads: [] }, hourly, END, new Set(["levels"]))[0]!.error, null);
  const bars = V.dailyBars(orders);
  assert.equal(Math.max(...bars.map((b) => b.height)), 100);
  assert.deepEqual(V.errorTotals(apps), { apps: 2, withErrors: 2, errors: 11.4, warn: 730.8, isNew: 1 });
});

test("rollouts: new ReplicaSets owned by a Deployment, images of today, the previous images by ownership (never by name prefix)", () => {
  const q = rolloutQueries('cluster="c1"', END, 1);
  assert.match(q.created!, new RegExp(`> ${END - 86400}$`));
  assert.match(q.owners!, /owner_kind="Deployment"/);
  const raw = {
    created: [row({ namespace: "app", replicaset: "orders-7d9f" }, END - 3600), row({ namespace: "app", replicaset: "orders-api-55aa" }, END - 7200), row({ namespace: "app", replicaset: "job-x" }, END - 100)],
    owners: [
      row({ namespace: "app", replicaset: "orders-7d9f", owner_name: "orders" }, 1), row({ namespace: "app", replicaset: "orders-6c5b", owner_name: "orders" }, 1),
      row({ namespace: "app", replicaset: "orders-api-55aa", owner_name: "orders-api" }, 1),
    ],
    podOwners: [row({ namespace: "app", pod: "orders-7d9f-aaaaa", owner_name: "orders-7d9f" }, 1)],
    images: [row({ namespace: "app", pod: "orders-7d9f-aaaaa", container: "app", image: "reg.example.com/team/orders:1.4.0" }, 1)],
  };
  const ro = rolloutsOf(raw, new Set(["orders"]));
  assert.deepEqual(ro.map((r) => [r.deployment, r.replicaset, r.service]), [["orders", "orders-7d9f", "orders"], ["orders-api", "orders-api-55aa", null]], "most recent first; a ReplicaSet without a Deployment owner is no rollout");
  assert.deepEqual(ro[0]!.images, [{ container: "app", image: "reg.example.com/team/orders:1.4.0" }]);
  // a minute before: pods of "orders-6c5b" (orders) and "orders-api-55aa" (another Deployment with the same prefix)
  const before = {
    podOwners: [row({ namespace: "app", pod: "orders-6c5b-bbbbb", owner_name: "orders-6c5b" }, 1), row({ namespace: "app", pod: "orders-api-55aa-ccccc", owner_name: "orders-api-55aa" }, 1)],
    images: [row({ namespace: "app", pod: "orders-6c5b-bbbbb", container: "app", image: "reg.example.com/team/orders:1.3.9" }, 1), row({ namespace: "app", pod: "orders-api-55aa-ccccc", container: "app", image: "reg.example.com/team/orders-api:9.9" }, 1)],
  };
  assert.deepEqual(deploymentImagesAt(before.podOwners, before.images, "app", new Set(["orders-6c5b"])), [{ container: "app", image: "reg.example.com/team/orders:1.3.9" }]);
  const ch = V.imageChanges({ images: ro[0]!.images, previousImages: [{ container: "app", image: "reg.example.com/team/orders:1.3.9" }] });
  assert.deepEqual(ch, [{ container: "app", from: "reg.example.com/team/orders:1.3.9", to: "reg.example.com/team/orders:1.4.0", changed: true }]);
  assert.deepEqual([V.imageTag("reg.example.com/team/orders:1.4.0"), V.imageTag("repo@sha256:0123456789abcdef"), V.imageTag("repo"), V.imageRepo("reg.example.com:5000/team/orders:1")], ["1.4.0", "sha256 · 01234567", "latest", "team/orders"]);
  // stg 2026-11-16: app pods run ":latest@sha256:…" (the digest is the version) and kube-state-metrics' `image` is the
  // status form "repo:<64 hex>" — shown as a short digest, never 64 characters
  const hex = "4b4ec230bc4bedf90d6beaa5b3a3ae559f0834eac7483e922e9e06455688260e";
  assert.equal(V.imageTag(`reg.example.com/team/orders:latest@sha256:${hex}`), "latest · 4b4ec230");
  assert.equal(V.imageTag(`orders:${hex}`), "sha256 · 4b4ec230");
  assert.equal(V.imageTag(`reg.example.com:5000/team/orders:1.2.3@sha256:${hex}`), "1.2.3 · 4b4ec230");
  // rollouts read image_spec (the spec's "repo:tag@digest") over the status `image`
  const spec = rolloutsOf({ ...raw, images: [row({ namespace: "app", pod: "orders-7d9f-aaaaa", container: "app", image: `orders:${hex}`, image_spec: `reg.example.com/team/orders:latest@sha256:${hex}` }, 1)] }, new Set());
  assert.equal(spec[0]!.images[0]!.image, `reg.example.com/team/orders:latest@sha256:${hex}`);

  const cq = compareQueries('cluster="c1"', "orders", 30);
  assert.match(cq.calls, /service_name="orders"/);
  assert.match(cq.calls, /span_name!~"\(\?i\)\.\*actuator\.\*"/);
  const red = redOf([row({ status_code: "STATUS_CODE_ERROR" }, 2), row({ status_code: "STATUS_CODE_UNSET" }, 98)], [row({ le: "0.1" }, 90), row({ le: "1" }, 99), row({ le: "+Inf" }, 100)]);
  assert.deepEqual(red, { requests: 100, errors: 2, errorRate: 0.02, p95: { le: 1 } });
  assert.deepEqual(redOf([], []), { requests: 0, errors: 0, errorRate: null, p95: null });
  assert.equal(redOf(null, null), null, "not read is not zero");
});

test("RED a week earlier: the same window at offset 7d — a fact beside the numbers (null = no series then)", () => {
  const q = redQueries('cluster="c1"', 'cluster="c1"', 60);
  assert.match(q.calls7d!, /\[60m\] offset 7d\)\)$/);
  assert.match(q.buckets7d!, /offset 7d/);
  const raw = {
    calls: [row({ service_name: "orders", span_name: "GET /x", status_code: "STATUS_CODE_UNSET" }, 3600)],
    buckets: [row({ service_name: "orders", span_name: "GET /x", le: "0.1" }, 3600), row({ service_name: "orders", span_name: "GET /x", le: "+Inf" }, 3600)],
    calls7d: [row({ service_name: "orders", status_code: "STATUS_CODE_UNSET" }, 7128), row({ service_name: "orders", status_code: "STATUS_CODE_ERROR" }, 72)],
    buckets7d: [row({ service_name: "orders", le: "0.1" }, 6800), row({ service_name: "orders", le: "1" }, 7200), row({ service_name: "orders", le: "+Inf" }, 7200)],
  };
  const s = aggregateRed(raw, 60).services[0]!;
  assert.deepEqual(s.weekAgo, { requests: 7200, rate: 2, errors: 72, errorRate: 0.01, p95: { le: 1 } });
  assert.equal(V.ratioText(s.rate, s.weekAgo!.rate), "×0.50");
  assert.equal(V.ratioText(3, 0), null);
  assert.equal(aggregateRed({ ...raw, calls7d: [] }, 60).services[0]!.weekAgo, null, "no series a week ago");
  assert.equal(aggregateRed(raw, 60, new Set(["calls7d"])).services[0]!.weekAgo, null, "not read");
});

test("links and tables: '신호 →' opens the workload panel from any tab; a table cell is never block-styled", () => {
  // 2026-11-19: 클러스터 · 워크로드 is its own route (/observability) — a `?wl=` link lands on it from any view
  const page = read("../../web/src/app/observability/ObservabilityView.tsx");
  assert.match(page, /view === "overview" \? \(\s*<>[\s\S]*?<WorkloadHeatmap /, "the heatmap (whose panel `wl` opens) is the overview route's");
  for (const f of ["ErrorsView", "RolloutsView", "RedView", "EndpointsView", "ServiceMapView"]) {
    for (const m of read(`../../web/src/app/observability/components/${f}.tsx`).matchAll(/href=\{`([^`]*)\?wl=/g)) assert.equal(m[1], "/observability", f);
  }
  const heat = read("../../web/src/app/observability/components/WorkloadHeatmap.tsx");
  assert.match(heat, /const wlParam = useSearchParams\(\)\.get\("wl"\);/);
  assert.match(heat, /\}, \[wlParam\]\);/, "re-read on every link, not only at mount");
  // a <td> with display:block (sloCellSub) falls out of the table — 2026-11-16 the errors view's "first / last" columns
  // stacked under one header
  for (const f of ["ErrorsView", "RolloutsView", "DependenciesView", "RedView", "EndpointsView"]) {
    assert.doesNotMatch(read(`../../web/src/app/observability/components/${f}.tsx`), /<td[^>]*className=\{styles\.sloCell(Sub|Main)\}/, f);
  }
});

test("wiring: routes, the two new views, the two-row switcher, the strings", () => {
  const routes = read("../src/routes/observability.ts");
  for (const r of ["/api/observability/app-errors", "/api/observability/rollouts"]) assert.ok(routes.includes(`"${r}"`), r);
  const tab = read("../../web/src/app/observability/components/SloTab.tsx");
  // 2026-11-19: menu items of their own
  for (const v of ["errors", "rollouts", "slo"]) assert.ok(readFileSync(new URL("../../web/src/lib/navConfig.ts", import.meta.url), "utf8").includes(`"/observability/services/${v}"`), v);
  assert.match(tab, /const sloView = apm === "slo";/, "SLO keeps its own sub-views (services · settings · guide)");
  assert.match(read("../../web/src/app/observability/components/RedView.tsx"), /s\.weekAgo/);
  const all = read("../../web/src/lib/i18nOps.ts");
  for (const k of ["ob.slo.view.errors", "ob.slo.view.rollouts", "ob.slo.view.slo", "ob.red.weekAgo", "ob.red.weekAgoHint", "ob.err.title", "ob.err.summary", "ob.err.foot", "ob.ro.title", "ob.ro.foot", "ob.ro.summary"]) {
    assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  }
});
