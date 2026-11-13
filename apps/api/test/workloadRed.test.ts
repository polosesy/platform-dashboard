// AKS 모니터링 › SLO › RED (트레이스) — spanmetrics per service (2026-11-13 stg: 17 services, resets 0 in an hour,
// 1 h rate 0.245/s vs Micrometer 0.244/s; /actuator = 83 % of the server spans).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregateRed, quantileBucket, redQueries, RED_MIN_REQUESTS } from "../src/services/workloadRed.js";
import * as viewNs from "../../web/src/lib/redView.ts";

const view = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const row = (metric: Record<string, string>, value: number) => ({ metric, value });

test("RED queries: server spans only, /actuator kept out of the histogram, resets read over the same window", () => {
  const q = redQueries('cluster="c1",collector="alloy"', 'cluster="c1"', 60);
  assert.match(q.calls!, /increase\(traces_spanmetrics_calls_total\{cluster="c1",collector="alloy",span_kind=~"\(\?i\)\(span_kind_\)\?server"\}\[60m\]\)/);
  assert.match(q.buckets!, /traces_spanmetrics_duration_seconds_bucket\{[^}]*span_name!~"\(\?i\)\.\*actuator\.\*"/);
  assert.match(q.resets!, /resets\(traces_spanmetrics_calls_total\{cluster="c1",collector="alloy"\}\[60m\]\)/);
  assert.match(q.workloads!, /kube_deployment_created\{cluster="c1"\}/);
  assert.ok(!Object.values(q).some((x) => /__name__/.test(x)), "the workspace refuses __name__ matchers");
});

test("RED quantile: the bucket that holds it — never interpolated; above the last boundary is said so", () => {
  const cum = new Map([[0.1, 50], [0.3, 90], [0.5, 99], [1, 100], [Infinity, 100]]);
  assert.deepEqual(quantileBucket(cum, 0.5), { le: 0.1 });
  assert.deepEqual(quantileBucket(cum, 0.95), { le: 0.5 });
  assert.deepEqual(quantileBucket(cum, 0.99), { le: 0.5 });
  assert.deepEqual(quantileBucket(new Map([[0.1, 0], [30, 10], [Infinity, 20]]), 0.95), { le: null }, "> 30 s");
  assert.equal(quantileBucket(new Map([[0.1, 0], [Infinity, 0]]), 0.5), null, "no requests");
});

test("RED aggregate: /actuator apart, errors = status ERROR, workload only by an exact single name", () => {
  const raw = {
    calls: [
      row({ service_name: "gateway", span_name: "http get /api/a", status_code: "status_code_unset" }, 90),
      row({ service_name: "gateway", span_name: "http get /api/a", status_code: "status_code_error" }, 10),
      row({ service_name: "gateway", span_name: "http get /actuator/health", status_code: "status_code_unset" }, 600),
      row({ service_name: "worker", span_name: "http post /jobs", status_code: "STATUS_CODE_OK" }, 5),
      row({ service_name: "orphan", span_name: "http get /x", status_code: "status_code_unset" }, 30),
    ],
    buckets: [
      ...[["0.1", 60], ["0.3", 95], ["0.5", 100], ["+Inf", 100]].map(([le, v]) => row({ service_name: "gateway", span_name: "http get /api/a", le: String(le) }, Number(v))),
    ],
    resets: [row({}, 0)],
    workloads: [
      row({ namespace: "app", deployment: "gateway" }, 1),
      row({ namespace: "app", statefulset: "worker" }, 1), row({ namespace: "batch", deployment: "worker" }, 1),
    ],
  };
  const r = aggregateRed(raw, 60);
  assert.deepEqual(r.services.map((s) => s.service), ["gateway", "orphan", "worker"], "busiest first");
  const g = r.services[0]!;
  assert.equal(g.requests, 100);
  assert.equal(g.errors, 10);
  assert.equal(g.errorRate, 0.1);
  assert.equal(g.actuatorRate, Math.round((600 / 3600) * 1e4) / 1e4);
  assert.deepEqual([g.p50, g.p95, g.p99], [{ le: 0.1 }, { le: 0.3 }, { le: 0.5 }]);
  assert.deepEqual(g.workload, { namespace: "app", name: "gateway", kind: "Deployment" });
  assert.equal(g.endpoints[0]!.name, "http get /api/a");
  const w = r.services.find((s) => s.service === "worker")!;
  assert.equal(w.workload, null);
  assert.equal(w.sameName, 2, "two namespaces have the name — not linked");
  assert.equal(w.lowTraffic, 5 < RED_MIN_REQUESTS);
  assert.equal(w.p95, null, "no histogram rows = no duration, not 0");
  assert.equal(r.services.find((s) => s.service === "orphan")!.sameName, 0);
  assert.deepEqual(r.buckets, [0.1, 0.3, 0.5]);
  assert.equal(r.resets, 0);
  assert.equal(aggregateRed({ ...raw, resets: [] }, 60, new Set(["resets"])).resets, null, "not read ≠ 0");
  assert.equal(aggregateRed(raw, 60, new Set(["buckets"])).services[0]!.p95, null, "a failed histogram query = no duration");
});

test("RED on screen: bucket text, per-minute under 1/s, '—' without requests", () => {
  assert.equal(view.quantileText({ le: 0.3 }, [0.1, 0.3, 30]), "≤ 300ms");
  assert.equal(view.quantileText({ le: 2 }, [0.1, 2, 30]), "≤ 2s");
  assert.equal(view.quantileText({ le: null }, [0.1, 30]), "> 30s");
  assert.equal(view.quantileText(null, [0.1]), "—");
  assert.deepEqual(view.rateText(0.0727), { key: "ob.red.perMin", n: "4.4" });
  assert.deepEqual(view.rateText(12.28), { key: "ob.red.perSec", n: "12.3" });
  assert.equal(view.errorRateText(null), "—");
  assert.equal(view.errorRateText(0), "0%");
  assert.equal(view.errorRateText(0.1), "10.0%");
  assert.equal(view.errorRateText(0.00001), "< 0.01%");
});

test("RED route: the windows the API answers are the web's", () => {
  const src = readFileSync(new URL("../src/services/workloadRed.ts", import.meta.url), "utf8");
  assert.match(src, /RED_WINDOWS: RedWindow\[\] = \[5, 15, 60, 360, 1440\]/);
  assert.deepEqual([...view.RED_WINDOWS], [5, 15, 60, 360, 1440]);
  assert.match(readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8"), /router\.get\("\/api\/observability\/red"/);
});

test("RED view (2026-11-13 stg screen): /actuator-only services apart, whole counts, route regexes folded", () => {
  // 13 of 17 services had only /actuator server spans in the hour → "—" for duration: no request, not a missing value
  const r = aggregateRed({ calls: [
    row({ service_name: "api", span_name: "http get /x", status_code: "status_code_unset" }, 3),
    row({ service_name: "worker", span_name: "http get /actuator/health/**", status_code: "status_code_unset" }, 1440),
  ] }, 60);
  const idle = r.services.find((s) => s.service === "worker")!;
  assert.equal(idle.requests, 0);
  assert.equal(idle.lowTraffic, false, "no user request is not 'low traffic'");
  assert.equal(idle.p95, null);
  assert.equal(r.services.find((s) => s.service === "api")!.lowTraffic, true);
  const split = view.splitByTraffic(r.services);
  assert.deepEqual([split.active.map((s) => s.service), split.idle.map((s) => s.service)], [["api"], ["worker"]]);
  assert.equal(view.redTotals(r.services).active, 1);
  // increase() extrapolates — 753.55 requests is shown whole
  assert.equal(view.countText(753.55, "en"), "754");
  assert.equal(view.countText(0.3, "en"), "< 1");
  assert.equal(view.countText(0, "en"), "0");
  // Spring route templates carry the variable's regex (nested braces included)
  const uuid = "[0-9a-fa-f]{8}-[0-9a-fa-f]{4}-[0-9a-fa-f]{4}-[0-9a-fa-f]{4}-[0-9a-fa-f]{12}";
  assert.equal(view.endpointLabel(`http get /applications/{applicationid:${uuid}}/actions/{actionid:${uuid}}/parameters`), "http get /applications/{applicationid}/actions/{actionid}/parameters");
  assert.equal(view.endpointLabel("http get /{tenantid}/scenarios/{scenarionanoid:[0-9a-za-z]{16}}"), "http get /{tenantid}/scenarios/{scenarionanoid}");
  assert.equal(view.endpointLabel("http get /api/workflow/**"), "http get /api/workflow/**");
  assert.equal(view.endpointLabel("http get /x/{id:[0-9]{3}"), "http get /x/{id:[0-9]{3}", "unbalanced: unchanged");
});
