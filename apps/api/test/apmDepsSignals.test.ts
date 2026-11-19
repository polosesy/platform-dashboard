// 서비스 (APM) › 의존성 · 엔드포인트 and AKS 모니터링 › 경고 신호 (docs/architecture/apm-parity.md §4 — 2026-11-16).
// Shapes as measured on stg: outbound HTTP in two Micrometer tag conventions, timers without histograms, JDBC pools,
// Kafka lag; Microsoft's 30 recommended rules where `kube_job_failed` is absent and KubePVUsageHigh's many-to-many match
// errors. Synthetic names and addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PromRow } from "../src/services/hubbleMetrics.js";
import { aggregateDependencies, dependencyQueries, outboundFailed } from "../src/services/appDependencies.js";
import { forQuery, jobMismatches, metricsOf, objectOf, optionalMetricsOf, ruleGroupTemplate, ruleVerdict, scopeExpression } from "../src/services/k8sRecommendedAlerts.js";
import { MS_RULE_FIXES } from "../src/services/msRuleFixes.js";
import { MS_RECOMMENDED_RULES } from "../src/services/msRecommendedAlerts.js";
import * as redNs from "../../web/src/lib/redView.ts";
import * as depsNs from "../../web/src/lib/depsView.ts";
import * as raNs from "../../web/src/lib/recommendedAlertsView.ts";

const R = ((redNs as unknown as { default?: typeof redNs }).default ?? redNs) as typeof redNs;
const D = ((depsNs as unknown as { default?: typeof depsNs }).default ?? depsNs) as typeof depsNs;
const RA = ((raNs as unknown as { default?: typeof raNs }).default ?? raNs) as typeof raNs;
const row = (metric: Record<string, string>, value: number): PromRow => ({ metric, value }) as PromRow;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── 의존성 ──

test("outbound failure: 5xx, an I/O failure as status, an exception / error tag — never 4xx; both tag conventions", () => {
  assert.equal(outboundFailed({ status: "200", outcome: "SUCCESS", exception: "none" }), false);
  assert.equal(outboundFailed({ status: "404", outcome: "CLIENT_ERROR", exception: "none" }), false, "4xx is the caller's request, not a failure");
  assert.equal(outboundFailed({ status: "503", exception: "none" }), true);
  assert.equal(outboundFailed({ status: "CLIENT_ERROR", exception: "ConnectException" }), true, "no response at all");
  assert.equal(outboundFailed({ http_status_code: "500", error: "none" }), true, "Observation convention");
  assert.equal(outboundFailed({ http_status_code: "200", error: "SocketTimeoutException" }), true);
  assert.equal(outboundFailed({ http_status_code: "200", error: "none" }), false);
});

test("dependencies: per application — outbound targets (avg/max, no percentile), JDBC pools, Kafka lag; failed queries are '—'", () => {
  const q = dependencyQueries('cluster="c1",collector="alloy"', 60);
  assert.match(q.outCount!, /increase\(http_client_requests_seconds_count\{cluster="c1",collector="alloy"\}\[60m\]\)/);
  assert.match(q.outMax!, /max_over_time\(http_client_requests_seconds_max/);
  assert.ok(!Object.values(q).some((x) => /_bucket/.test(x)), "the timers carry no histogram — no quantile is computed");
  const raw = {
    outCount: [
      row({ namespace: "app", application: "orders", client_name: "pay.example.com", status: "200", outcome: "SUCCESS", exception: "none" }, 90),
      row({ namespace: "app", application: "orders", client_name: "pay.example.com", status: "503", outcome: "SERVER_ERROR", exception: "none" }, 10),
      row({ namespace: "app", application: "orders", clientname: "maps.example.com", http_status_code: "200", error: "none" }, 30),
      row({ namespace: "app", application: "report", client_name: "idle.example.com", status: "200", outcome: "SUCCESS", exception: "none" }, 0),
    ],
    outSum: [row({ application: "orders", client_name: "pay.example.com" }, 25), row({ application: "orders", clientname: "maps.example.com" }, 3)],
    outMax: [row({ application: "orders", client_name: "pay.example.com" }, 2.5), row({ application: "report", client_name: "idle.example.com" }, 0.1)],
    poolActive: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 3)],
    poolMax: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 10)],
    poolPending: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 0)],
    poolPendingPeak: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 4)],
    poolTimeouts: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 1)],
    poolAcquireSum: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 0.5)],
    poolAcquireCount: [row({ namespace: "app", application: "orders", pool: "HikariPool-1" }, 100)],
    kafkaLag: [row({ namespace: "app", application: "report", topic: "events" }, 12)],
    kafkaLagPeak: [row({ namespace: "app", application: "report", topic: "events" }, 340)],
  };
  const apps = aggregateDependencies(raw, 60, new Set(["orders"]));
  const orders = apps.find((a) => a.application === "orders")!;
  assert.equal(orders.inServiceMap, true);
  assert.equal(apps.find((a) => a.application === "report")!.inServiceMap, false, "exact name only");
  const pay = orders.outbound.find((o) => o.target === "pay.example.com")!;
  assert.deepEqual([pay.convention, pay.requests, pay.failed, pay.errorRate, pay.avg, pay.max], ["micrometer", 100, 10, 0.1, 0.25, 2.5]);
  assert.deepEqual(pay.statuses, [{ status: "200", requests: 90 }, { status: "503", requests: 10 }]);
  assert.equal(orders.outbound[0]!.target, "pay.example.com", "failures first");
  assert.equal(orders.outbound.find((o) => o.target === "maps.example.com")!.convention, "observation");
  const idle = apps.find((a) => a.application === "report")!.outbound[0]!;
  assert.deepEqual([idle.requests, idle.avg, idle.max], [0, null, 0.1], "no request: no average (not 0)");
  assert.deepEqual(orders.pools[0], { pool: "HikariPool-1", active: 3, max: 10, pending: 0, pendingPeak: 4, timeouts: 1, acquireAvg: 0.005 });
  assert.deepEqual(apps.find((a) => a.application === "report")!.consumers, [{ topic: "events", lag: 12, lagPeak: 340 }]);
  const noMax = aggregateDependencies(raw, 60, new Set(), new Set(["outMax", "poolTimeouts"]));
  assert.equal(noMax.find((a) => a.application === "orders")!.outbound[0]!.max, null);
  assert.equal(noMax.find((a) => a.application === "orders")!.pools[0]!.timeouts, null, "not read is not 0");

  const t = D.depsTotals(apps);
  assert.deepEqual([t.apps, t.targets, t.failed, t.failingTargets, t.poolsWaiting, t.timeouts, t.lagging], [2, 2, 10, 1, 1, 1, 1]);
  const rows = D.depsRows(apps, "maps");
  assert.deepEqual(rows.out.map((o) => o.target), ["maps.example.com"]);
  assert.equal(D.depsRows(apps).idleOut.length, 1);
  assert.deepEqual([D.durationText(0.0004), D.durationText(0.25), D.durationText(1.0321), D.durationText(null)], ["0.4 ms", "250 ms", "1.03 s", "—"]);
});

// ── 경고 신호 ──

const rule = (name: string) => MS_RECOMMENDED_RULES.find((r) => r.alert === name)!;

test("Microsoft's rule table: 30 rules verbatim (source of the coverage count)", () => {
  assert.equal(MS_RECOMMENDED_RULES.length, 30);
  assert.equal(new Set(MS_RECOMMENDED_RULES.map((r) => r.alert)).size, 30);
  assert.deepEqual([rule("KubeJobStale").forMinutes, rule("KubePersistentVolumeFillingUp").forMinutes, rule("KubeJobFailed").severity], [360, 60, 3]);
  // the measured finding: this rule reads a metric the stg workspace does not have (it has kube_job_status_failed)
  assert.match(rule("KubeJobFailed").expression, /kube_job_failed\{job="kube-state-metrics"\} > 0/);
  assert.match(read("../src/services/msRecommendedAlerts.ts"), /Azure\/prometheus-collector[\s\S]*MIT License/);
});

test("metrics of a rule: names outside quotes only; `unless` parts are optional", () => {
  assert.deepEqual(metricsOf(rule("KubePersistentVolumeFillingUp").expression), [
    "kubelet_volume_stats_available_bytes", "kubelet_volume_stats_capacity_bytes", "kubelet_volume_stats_used_bytes", "kube_persistentvolumeclaim_access_mode", "kube_persistentvolumeclaim_labels"]);
  assert.deepEqual(optionalMetricsOf(rule("KubePersistentVolumeFillingUp").expression), ["kube_persistentvolumeclaim_access_mode", "kube_persistentvolumeclaim_labels"]);
  assert.deepEqual(metricsOf(rule("KubeNodeUnreachable").expression), ["kube_node_spec_taint"], "label values (node.kubernetes.io/…) are not metrics");
  assert.deepEqual(optionalMetricsOf(rule("KubeNodeUnreachable").expression), [], "used before unless too: required");
  assert.deepEqual(metricsOf(rule("KubePodFailedState").expression), ["kube_pod_status_phase", "kube_pod_owner"], "a bare metric inside label_replace counts");
});

test("scope: every job matcher replaced by the family's scope; a bare metric scoped; nothing else changes", () => {
  const scope = (m: string) => (m.startsWith("kubelet_") ? 'cluster="c1",job="kubelet"' : 'cluster="c1"');
  assert.equal(scopeExpression(rule("KubeHpaMaxedOut").expression, scope),
    'kube_horizontalpodautoscaler_status_current_replicas{cluster="c1"} ==kube_horizontalpodautoscaler_spec_max_replicas{cluster="c1"}');
  assert.equal(scopeExpression(rule("KubePersistentVolumeInodesFillingUp").expression, scope),
    'kubelet_volume_stats_inodes_free{cluster="c1",job="kubelet"} / kubelet_volume_stats_inodes{cluster="c1",job="kubelet"} < 0.03');
  const failed = scopeExpression(rule("KubePodFailedState").expression, scope);
  assert.match(failed, /kube_pod_status_phase\{cluster="c1",phase="failed"\}/);
  assert.match(failed, /label_replace\(kube_pod_owner\{cluster="c1"\}, "controller", "\$1", "owner_name", "\(\.\*\)"\)/);
  const unreachable = scopeExpression(rule("KubeNodeUnreachable").expression, () => 'cluster="c1"');
  assert.match(unreachable, /kube_node_spec_taint\{cluster="c1",key="node\.kubernetes\.io\/unreachable",effect="NoSchedule"\}/);
  assert.match(unreachable, /key=~"ToBeDeletedByClusterAutoscaler\|cloud\.google\.com\/impending-node-termination\|aws-node-termination-handler\/spot-itn"/);
  // no scope (one unlabelled cluster): job removed, never an empty selector
  assert.equal(scopeExpression('kube_daemonset_status_number_misscheduled{job="kube-state-metrics"} > 0', () => ""), "kube_daemonset_status_number_misscheduled > 0");
  for (const r of MS_RECOMMENDED_RULES) assert.doesNotMatch(scopeExpression(r.expression, () => 'cluster="c1"'), /job=/, r.alert);
});

test("for: the condition now and at every step of the duration (1-minute steps, 5 beyond an hour)", () => {
  assert.equal(forQuery("x > 0", 15), "(x > 0) and (count_over_time((x > 0)[15m:1m]) >= 15)");
  assert.equal(forQuery("x > 0", 360), "(x > 0) and (count_over_time((x > 0)[360m:5m]) >= 72)");
});

test("verdict: firing / clear / noData (which metric) / ambiguous / failed — 'cannot evaluate' is never 'clear'", () => {
  const all = new Set(MS_RECOMMENDED_RULES.flatMap((r) => metricsOf(r.expression)));
  const present = new Set([...all].filter((m) => m !== "kube_job_failed" && m !== "kube_resourcequota" && m !== "kube_persistentvolumeclaim_labels"));
  assert.deepEqual(ruleVerdict(rule("KubeJobFailed"), present, new Set(), []).state, "noData");
  assert.deepEqual(ruleVerdict(rule("KubeJobFailed"), present, new Set(), []).missing, ["kube_job_failed"]);
  assert.equal(ruleVerdict(rule("KubePersistentVolumeFillingUp"), present, new Set(), []).state, "clear", "an absent optional metric does not block");
  const f = ruleVerdict(rule("KubePodFailedState"), present, new Set(), [{ metric: { cluster: "c1", namespace: "app", controller: "job-1", __name__: "x" }, value: 1 }]);
  assert.deepEqual([f.state, f.firing], ["firing", [{ object: { namespace: "app", controller: "job-1" }, value: 1 }]]);
  assert.equal(ruleVerdict(rule("KubePVUsageHigh"), present, new Set(), "failed").state, "failed");
  assert.equal(ruleVerdict(rule("KubeHpaMaxedOut"), present, new Set(["kube_horizontalpodautoscaler_spec_max_replicas"]), []).state, "ambiguous");
  assert.deepEqual(objectOf({ cluster: "c", job: "j", namespace: "n", persistentvolumeclaim: "data", pod: "p" }), { namespace: "n", persistentvolumeclaim: "data", pod: "p" });

  const ordered = RA.orderRules([
    ruleVerdict(rule("KubeHpaMaxedOut"), present, new Set(), []),
    ruleVerdict(rule("KubeJobFailed"), present, new Set(), []),
    f,
    ruleVerdict(rule("KubePVUsageHigh"), present, new Set(), "failed"),
  ]);
  assert.deepEqual(ordered.map((r) => r.state), ["firing", "failed", "noData", "clear"]);
  const s = RA.summarize(ordered);
  assert.deepEqual([s.total, s.evaluated, s.firing, s.objects, s.noData, s.failed], [4, 2, 1, 1, 1, 1]);
  assert.equal(RA.objectText({ pod: "p", namespace: "n" }), "n / p");
});

test("job mismatch: a shipped job matcher no series of that metric carries here (kubelet → the collector's own job name)", () => {
  const jobs = { kubelet_volume_stats_used_bytes: ["prometheus.scrape.kubelet"], kubelet_volume_stats_capacity_bytes: ["prometheus.scrape.kubelet"], kube_pod_status_phase: ["kube-state-metrics"] };
  assert.deepEqual(jobMismatches(rule("KubePVUsageHigh").expression, jobs), [
    { metric: "kubelet_volume_stats_used_bytes", expected: "kubelet", actual: ["prometheus.scrape.kubelet"] },
    { metric: "kubelet_volume_stats_capacity_bytes", expected: "kubelet", actual: ["prometheus.scrape.kubelet"] },
  ]);
  assert.deepEqual(jobMismatches('kube_pod_status_phase{job="kube-state-metrics"} > 0', jobs), [], "same job: no mismatch");
  assert.deepEqual(jobMismatches('kubelet_running_pods{job="kubelet"} > 0', jobs), [], "a metric not read here: not claimed");
  assert.deepEqual(jobMismatches("kube_pod_status_phase > 0", jobs), [], "no job matcher: nothing to compare");
});

test("corrections: only where the original cannot evaluate; each keeps the original's meaning and scopes like it", () => {
  assert.deepEqual(Object.keys(MS_RULE_FIXES).sort(), ["KubeJobFailed", "KubePVUsageHigh"]);
  for (const [alert, f] of Object.entries(MS_RULE_FIXES)) {
    assert.ok(MS_RECOMMENDED_RULES.some((r) => r.alert === alert), alert);
    assert.match(f.expression, /job="[^"]+"/, `${alert}: written with job matchers so the same scoping applies`);
    assert.doesNotMatch(scopeExpression(f.expression, () => 'cluster="c1"'), /job=/, alert);
  }
  const job = MS_RULE_FIXES.KubeJobFailed!.expression;
  assert.doesNotMatch(job, /kube_job_failed\b/, "reads the metric the workspace has");
  assert.match(job, /kube_job_status_failed[\s\S]*kube_job_status_succeeded[\s\S]*== 0[\s\S]*kube_job_status_active[\s\S]*== 0/, "a retried-then-succeeded Job is not failed");
  const pv = MS_RULE_FIXES.KubePVUsageHigh!.expression;
  assert.match(pv, /on\(namespace, persistentvolumeclaim, cluster, instance, job\)/);
  assert.doesNotMatch(pv, /\bpod\b|\bcontainer\b/, "volume metrics carry no pod or container");
});

test("template: three rule groups in Microsoft's shape — evaluable rules scoped, corrections where only they evaluate, the rest excluded", () => {
  const all = new Set(MS_RECOMMENDED_RULES.flatMap((r) => metricsOf(r.expression)));
  const present = new Set([...all].filter((m) => m !== "kube_job_failed" && m !== "kube_resourcequota"));
  const rules = MS_RECOMMENDED_RULES.map((r) => {
    const v = ruleVerdict(r, present, new Set(), r.alert === "KubePVUsageHigh" ? "failed" : []);
    if (v.state === "clear") v.expression = scopeExpression(r.expression, () => 'cluster="c1",job="prometheus.scrape.kubelet"');
    const f = MS_RULE_FIXES[r.alert];
    if (f) v.fix = { why: f.why, original: f.expression, expression: scopeExpression(f.expression, () => 'cluster="c1"'), state: "clear", firing: [] };
    return v;
  });
  const t = ruleGroupTemplate(rules);
  assert.deepEqual(t.fixed.sort(), ["KubeJobFailed", "KubePVUsageHigh"]);
  assert.deepEqual(t.excluded.map((x) => [x.alert, x.reason, x.missing]), [["KubeCPUQuotaOvercommit", "noData", ["kube_resourcequota"]], ["KubeMemoryQuotaOvercommit", "noData", ["kube_resourcequota"]], ["KubeQuotaAlmostFull", "noData", ["kube_resourcequota"]]], "the three quota rules (stg: no kube_resourcequota)");
  assert.equal(t.included.length + t.fixed.length + t.excluded.length, 30);
  const doc = JSON.parse(t.json);
  assert.deepEqual(Object.keys(doc.parameters).sort(), ["actionGroupResourceId", "azureMonitorWorkspaceResourceId", "clusterName", "clusterResourceId", "location"]);
  assert.equal(doc.resources.length, 3);
  for (const g of doc.resources) {
    assert.deepEqual([g.type, g.apiVersion, g.properties.interval], ["Microsoft.AlertsManagement/prometheusRuleGroups", "2023-03-01", "PT1M"]);
    assert.deepEqual(g.properties.scopes, ["[parameters('azureMonitorWorkspaceResourceId')]", "[parameters('clusterResourceId')]"]);
    for (const r of g.properties.rules) {
      assert.doesNotMatch(r.expression, /job="kubelet"|kube_job_failed\b/, r.alert);
      assert.match(r.for, /^PT\d+M$/);
      assert.deepEqual(r.actions, [{ actionGroupId: "[parameters('actionGroupResourceId')]" }]);
    }
  }
  const byAlert = Object.fromEntries(doc.resources.flatMap((g: { properties: { rules: Array<{ alert: string; for: string; severity: number }> } }) => g.properties.rules).map((r: { alert: string }) => [r.alert, r]));
  assert.deepEqual([byAlert.KubeJobStale.for, byAlert.KubeJobFailed.severity], ["PT360M", 3], "Microsoft's duration and severity kept");
  assert.doesNotMatch(t.json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "no IDs — parameters only");
});

// ── 엔드포인트 ──

test("endpoints: every service's endpoints in one table, sorted by errors / requests / p95 (above the last bucket = slowest)", () => {
  const svc = (service: string, endpoints: Array<[string, number, number, number | null | undefined]>) => ({
    service, workload: null, sameName: 0, requests: 0, rate: 0, errors: 0, errorRate: null, p50: null, p95: null, p99: null, actuatorRate: 0, lowTraffic: false,
    endpoints: endpoints.map(([name, requests, errors, le]) => ({ name, requests, errors, p95: le === undefined ? null : { le } })),
  });
  const services = [svc("a", [["GET /x", 100, 0, 0.1], ["POST /y", 10, 3, null]]), svc("b", [["GET /z", 50, 1, 2.5], ["GET /w", 5, 0, undefined]])];
  assert.deepEqual(R.endpointRows(services, "errors").map((r) => r.name), ["POST /y", "GET /z", "GET /x", "GET /w"]);
  assert.deepEqual(R.endpointRows(services, "requests").map((r) => r.name), ["GET /x", "GET /z", "POST /y", "GET /w"]);
  assert.deepEqual(R.endpointRows(services, "p95").map((r) => r.name), ["POST /y", "GET /z", "GET /x", "GET /w"], "> last bucket first, unknown last");
  assert.deepEqual(R.endpointRows(services, "errors", "b").map((r) => r.service), ["b", "b"]);
  assert.match(read("../src/services/workloadRed.ts"), /export const RED_TOP_ENDPOINTS = 200;/);
});

test("wiring: routes, the 경고 신호 tab, the 서비스 (APM) views, every rule described in ko and en", () => {
  const routes = read("../src/routes/observability.ts");
  for (const r of ["/api/observability/dependencies", "/api/observability/recommended-alerts"]) assert.ok(routes.includes(`"${r}"`), r);
  // 2026-11-19: the monitoring views are menu items of their own (one frame — ObservabilityView)
  const page = read("../../web/src/app/observability/ObservabilityView.tsx");
  assert.match(read("../../web/src/lib/navConfig.ts"), /item\("\/observability\/signals", "monSignals"/);
  assert.match(page, /key=\{`signals:\$\{clusterId\}`\}/);
  const tab = read("../../web/src/app/observability/components/SloTab.tsx");
  for (const v of ["map", "deps", "endpoints"]) assert.match(tab, new RegExp(`id: "${v}"`), v);
  assert.match(read("../../web/src/app/observability/components/ServiceMapView.tsx"), /deps=\{depsOf\(deps, sel\.id\)\}/, "the map panel lists the service's dependencies");
  const all = read("../../web/src/lib/i18nOps.ts") + read("../../web/src/lib/i18nMessages.ts");
  const keys = [...MS_RECOMMENDED_RULES.map((r) => `ob.ra.rule.${r.alert}`), "obs.tab.signals", "ob.slo.view.deps", "ob.slo.view.endpoints", "ob.ra.noDataWhy", "ob.ra.failedWhy", "ob.ra.summary", "ob.ra.jobMismatch", "ob.ra.chip.jobMismatch", "ob.ra.fix.state",
    "ob.ra.fix.metricMissing", "ob.ra.fix.duplicateMatch", "ob.ra.fix.expr", "ob.ra.tpl.title", "ob.ra.tpl.summary", "ob.ra.tpl.fixed", "ob.ra.tpl.excluded",
    "ob.ra.tpl.download", "ob.ra.tpl.deploy", "ob.ra.tpl.note",
    "ob.dep.title", "ob.dep.summary", "ob.dep.latencyHint", "ob.dep.conv.micrometer", "ob.dep.conv.observation", "ob.ep.title", "ob.ep.summary", "ob.apm.deps"];
  for (const k of keys) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});
