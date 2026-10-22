// Azure Monitor alerts on the live diagram: the Alerts Management query (a version that exists, plain parameters,
// every page), correlation (case-insensitive IDs, active vs. history, dedup), a failed read reported as "failed"
// (never "no alerts"), an active alert setting the card state, and the rule's evaluation shown. Synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramNodeSpec, LiveNode } from "@aud/types";
import { loadEnv } from "../src/env.js";
import { alertsUrl, collectDiagramAlerts, correlateAlerts, fetchAllPages, type AzureAlert, ALERTS_API_VERSION } from "../src/services/alertsCollector.js";
import { metricRuleEvaluation } from "../src/services/alertRulesCollector.js";
import { resolveEvidence } from "../src/services/healthEvidence.js";
import { buildFaultImpacts } from "../src/services/liveAggregator.js";
import * as alertsNs from "../../web/src/lib/liveAlerts.ts";

const W = ((alertsNs as unknown as { default?: typeof alertsNs }).default ?? alertsNs) as typeof alertsNs;
const SUB = "00000000-0000-0000-0000-000000000001";
const AGW = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Network/applicationGateways/agw-1`;
const NOW = Date.parse("2026-10-22T06:00:00Z");
const alert = (name: string, cond: "Fired" | "Resolved", start: string, resolved?: string, o: Partial<AzureAlert["properties"]["essentials"]> = {}): AzureAlert => ({
  id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement/alerts/${name}`,
  name,
  properties: { essentials: {
    severity: "Sev1", alertState: "New", monitorCondition: cond, startDateTime: start,
    ...(resolved ? { monitorConditionResolvedDateTime: resolved } : {}),
    // Azure writes the target with a lower-case "resourcegroups" while the graph has "resourceGroups"
    targetResource: AGW.replace("resourceGroups", "resourcegroups").toLowerCase(),
    alertRule: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/microsoft.insights/metricalerts/appgw-be-unhealthy`,
    ...o,
  } },
});
const ids = new Map([[AGW.toLowerCase(), "agw"]]);

test("the query: api-version that exists for alerts, plain parameters (no $filter/$top), Fired 30 days · Resolved 1 day", () => {
  assert.equal(ALERTS_API_VERSION, "2018-05-05");
  const fired = alertsUrl(SUB, "Fired");
  assert.match(fired, /api-version=2018-05-05&monitorCondition=Fired&timeRange=30d&pageCount=250/);
  assert.doesNotMatch(fired, /\$filter|\$top|2023-01-01/);
  assert.match(alertsUrl(SUB, "Resolved"), /monitorCondition=Resolved&timeRange=1d/);
});

test("every page is read (nextLink), at most 4", async () => {
  let calls = 0;
  const all = await fetchAllPages(async () => ({ value: [alert(`a${++calls}`, "Fired", "2026-10-22T05:00:00Z")], nextLink: "next" }), "first");
  assert.equal(calls, 4);
  assert.equal(all.length, 4);
});

test("flapping rule (fired → resolved → fired → resolved): nothing active, history 2 instances on the card's node", () => {
  const r = correlateAlerts([
    alert("i1", "Resolved", "2026-10-22T05:14:35Z", "2026-10-22T05:21:26Z"),
    alert("i2", "Resolved", "2026-10-22T05:28:31Z", "2026-10-22T05:35:35Z"),
  ], ids, new Map(), NOW);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.history.length, 1);
  const h = r.history[0]!;
  assert.deepEqual([h.nodeId, h.rule, h.active, h.count, h.sev], ["agw", "appgw-be-unhealthy", false, 2, 1]);
  assert.equal(h.instances[0]!.firedAt, "2026-10-22T05:28:31Z", "newest first");
  assert.deepEqual(W.recentAlertChip(r.history, "agw"), { count: 2, sev: 1, hours: 6 });
  assert.equal(W.firedMinutes(h.instances[0]!), 7);
});

test("active = Fired and not Closed; the same instance from both queries counts once; older than the window drops", () => {
  const live = alert("now", "Fired", "2026-10-22T05:58:00Z");
  const r = correlateAlerts([
    live, live,
    alert("closed", "Fired", "2026-10-22T05:50:00Z", undefined, { alertState: "Closed" }),
    alert("old", "Resolved", "2026-10-21T20:00:00Z", "2026-10-21T20:10:00Z"),
    alert("other", "Fired", "2026-10-22T05:58:00Z", undefined, { targetResource: "/subscriptions/x/resourcegroups/y/providers/a/b/c" }),
  ], ids, new Map([["e1", { source: "agw", target: "web" }]]), NOW);
  assert.deepEqual(r.alerts.map((a) => [a.id, a.severity, a.title, a.affectedNodeIds, a.affectedEdgeIds]), [["now", "critical", "appgw-be-unhealthy", ["agw"], ["e1"]]]);
  assert.equal(r.history[0]!.count, 2, "the active one + the closed one (old one is outside 6 h)");
  assert.equal(r.history[0]!.active, true);
  assert.equal(W.recentAlertChip(r.history, "agw"), null, "an active alert makes the card red — no 'resolved' chip");
});

test("a failed read is 'failed' and not cached; a good read is cached", async () => {
  const env = loadEnv({ AZURE_AD_TENANT_ID: "00000000-0000-0000-0000-0000000000aa", AZURE_SUBSCRIPTION_IDS: SUB });
  const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ tid: "t", oid: "o-alerts" })).toString("base64url")}.x`;
  const nodes = [{ id: "agw", azureResourceId: AGW }] as DiagramNodeSpec[];
  let calls = 0;
  const failing = await collectDiagramAlerts(env, token, nodes, new Map(), async () => { calls++; throw new Error("ARM 404"); });
  assert.equal(failing.state, "failed");
  const ok = await collectDiagramAlerts(env, token, nodes, new Map(), async (url) => { calls++; return { value: url.includes("Fired") ? [alert("x", "Fired", new Date().toISOString())] : [] }; });
  assert.equal(ok.state, "ok", "the failure was not cached");
  assert.equal(ok.alerts.length, 1);
  const before = calls;
  const again = await collectDiagramAlerts(env, token, nodes, new Map(), async () => { calls++; return { value: [] }; });
  assert.equal(calls, before, "cached");
  assert.equal(again.alerts.length, 1);
});

test("an active alert sets the card: metric ok + Sev1 fired → critical, basis alert; Sev2 → warning; none → metric ok", () => {
  const base = { kind: "appGateway", health: "ok" as const, judged: true, metrics: { backend: 100 } };
  const crit = resolveEvidence({ ...base, alerts: ["critical"] });
  assert.deepEqual([crit.health, crit.basis], ["critical", "alert"]);
  assert.ok(crit.reasons.includes("ld.ev.alertFired"));
  assert.deepEqual([resolveEvidence({ ...base, alerts: ["warning"] }).health, resolveEvidence({ ...base, alerts: ["warning"] }).basis], ["warning", "alert"]);
  assert.deepEqual([resolveEvidence({ ...base, alerts: ["info"] }).health, resolveEvidence(base).basis], ["ok", "metric"]);
  // the worse of metric and alert wins
  assert.equal(resolveEvidence({ ...base, health: "critical", alerts: ["warning"] }).basis, "metric");
});

test("a card red because of an alert starts a fault impact triggered by the alert", () => {
  const n = (id: string, health: LiveNode["health"], basis: LiveNode["basis"]) => ({ id, health, basis, healthScore: 0, metrics: {}, activeAlertIds: [] }) as LiveNode;
  const imp = buildFaultImpacts([n("agw", "critical", "alert"), n("web", "ok", "metric")], [{ id: "e", source: "agw", target: "web", edgeKind: "network" }] as never);
  assert.deepEqual(imp.map((i) => [i.sourceNodeId, i.trigger, i.affectedNodeIds]), [["agw", "alert", ["web"]]]);
});

test("the rule's evaluation: aggregation, window, frequency, dimension, auto-resolve → panel parts", () => {
  const e = metricRuleEvaluation({
    severity: 1, enabled: true, scopes: [AGW], windowSize: "PT5M", evaluationFrequency: "PT1M", autoMitigate: true,
    criteria: { allOf: [{ metricName: "UnhealthyHostCount", operator: "GreaterThan", threshold: 0, timeAggregation: "Average",
      dimensions: [{ name: "BackendSettingsPool", operator: "Include", values: ["pool~setting"] }] }] },
  });
  assert.deepEqual(e, { aggregation: "Average", windowSize: "PT5M", frequency: "PT1M", dimensions: ["BackendSettingsPool = pool~setting"], autoMitigate: true });
  assert.deepEqual(W.evaluationParts(e).map((p) => [p.key, p.vars ?? null]), [
    ["ld.rule.agg", { agg: "Average" }], ["ld.rule.window", { n: 5 }], ["ld.rule.every", { n: 1 }],
    ["ld.rule.dim", { dim: "BackendSettingsPool = pool~setting" }], ["ld.rule.autoMitigate", null],
  ]);
  assert.deepEqual([W.isoMinutes("PT1H"), W.isoMinutes("P1D"), W.isoMinutes("PT"), W.isoMinutes(undefined)], [60, 1440, null, null]);
});
