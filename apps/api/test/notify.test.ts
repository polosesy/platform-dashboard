import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Env } from "../src/env.js";
import { azureSeverity, classify, labelSeverity, parseAlertPayload, safeUrl, samplePayload, type ParsedAlert } from "../src/services/alertPayloads.js";
import { applyDelivery, clearNotifyMemory, listAlerts, ownerTeam, prune } from "../src/services/notifyStore.js";
import { relayBody, relayWanted } from "../src/services/notifyRelay.js";
import { inboxResponse, registerNotifyHooks, tokenMatches, visibleTo } from "../src/routes/notify.js";
import * as viewMod from "../../web/src/lib/notifyView.ts";
const V = ((viewMod as { default?: typeof viewMod }).default ?? viewMod) as typeof viewMod;

const SUB = "00000000-0000-0000-0000-0000000000aa";
const NOW = new Date("2026-10-30T09:00:00Z");
const azure = (essentials: Record<string, unknown>, alertContext: Record<string, unknown> = {}) => ({ schemaId: "azureMonitorCommonAlertSchema", data: { essentials, alertContext } });
const one = (body: unknown): ParsedAlert => {
  const r = parseAlertPayload(body, NOW);
  assert.ok(r.kind !== "unsupported", JSON.stringify(r));
  return r.alerts[0]!;
};

test("Azure common alert schema: metric · managed Prometheus · Service Health · Defender (activity log Security) · resolved", () => {
  const metric = one(samplePayload("azure", NOW));
  assert.deepEqual([metric.source, metric.status, metric.severity, metric.category], ["azure-monitor", "firing", "sev3", "monitoring"]);
  assert.equal(metric.target.resourceType, "microsoft.containerservice/managedclusters");
  assert.equal(metric.target.subscriptionId, "00000000-0000-0000-0000-000000000000");
  assert.equal(metric.values?.node_cpu_usage_percentage, 93.5);
  assert.equal(metric.labels["dim:node"], "aks-pool-0", "metric dimensions kept as labels");
  assert.match(metric.description!, /node_cpu_usage_percentage GreaterThan 90 \(= 93\.5\)/);
  assert.ok(metric.links.some((l) => l.kind === "portal" && l.url.startsWith("https://portal.azure.com/")));
  assert.ok(metric.links.some((l) => l.url === "/health"), "an Azure resource opens Resource status");
  assert.ok(metric.id.startsWith("az:") && metric.id === one(samplePayload("azure", NOW)).id, "same alertId = same item");

  const prom = one(azure(
    { alertId: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement/alerts/p1`, alertRule: "KubePodCrashLooping", severity: "Sev1", monitorCondition: "Fired", monitoringService: "Prometheus", firedDateTime: "2026-10-30T08:00:00Z", alertTargetIDs: [`/subscriptions/${SUB}/resourcegroups/rg-mon/providers/microsoft.monitor/accounts/amw-x`] },
    { labels: { alertname: "KubePodCrashLooping", namespace: "app", pod: "api-0", severity: "sev2", secret_label: "x" }, annotations: { summary: "Pod restarting", description: "kubectl -n app describe pod api-0", runbook_url: "https://runbooks.example.com/crash?token=abc" }, expressionValue: 4 },
  ));
  assert.deepEqual([prom.severity, prom.target.namespace, prom.target.pod, prom.summary], ["sev2", "app", "api-0", "Pod restarting"], "the rule's severity label wins over Sev1");
  assert.equal(prom.labels.secret_label, undefined, "labels are an allow-list");
  assert.equal(prom.links.find((l) => l.kind === "runbook")!.url, "https://runbooks.example.com/crash", "secret-looking query parameters dropped");
  assert.ok(prom.links.some((l) => l.url === "/observability"), "namespace/pod opens AKS monitoring");

  const sh = one(azure(
    { alertId: "/subscriptions/x/providers/Microsoft.AlertsManagement/alerts/sh", alertRule: "Service issues", severity: "Sev2", monitorCondition: "Fired", monitoringService: "ServiceHealth", firedDateTime: "2026-10-30T07:00:00Z" },
    { properties: { title: "Storage — Korea Central — degraded", communication: "<p>We are investigating&nbsp;an issue</p>" } },
  ));
  assert.deepEqual([sh.category, sh.categoryBasis, sh.title], ["incident", "service", "Storage — Korea Central — degraded"]);
  assert.equal(sh.description, "We are investigating an issue", "HTML stripped");

  const sec = one(azure({ alertId: "a/sec", alertRule: "Defender alerts", severity: "Sev1", monitorCondition: "Fired", monitoringService: "Activity Log - Security" }));
  assert.deepEqual([sec.category, sec.severity], ["security", "sev2"]);
  assert.ok(sec.links.some((l) => l.url === "/security/threats"));

  const resolved = one(azure({ alertId: "a/1", alertRule: "r", severity: "Sev3", monitorCondition: "Resolved", resolvedDateTime: "2026-10-30T08:30:00Z" }));
  assert.deepEqual([resolved.status, resolved.endsAt], ["resolved", "2026-10-30T08:30:00.000Z"]);

  assert.deepEqual(parseAlertPayload({ schemaId: "AzureMonitorMetricAlert", data: { context: {} } }), { kind: "unsupported", reason: "azure_not_common_schema" });
  assert.deepEqual(parseAlertPayload("x"), { kind: "unsupported", reason: "not_json_object" });
});

test("Grafana webhook and Alertmanager: one item per alert, sev labels, deep links from the description, endsAt 0001 = still firing", () => {
  const body = {
    receiver: "aud", status: "firing", orgId: 1, version: "1", externalURL: "https://grafana.example.com/",
    commonLabels: { alertname: "FluentdDeliveryFailure", team: "platform" }, commonAnnotations: { summary: "buffer flush failing" },
    alerts: [
      { status: "firing", labels: { alertname: "FluentdDeliveryFailure", namespace: "app", pod: "fluentd-1", severity: "warning" },
        annotations: { summary: "buffer flush failing", description: "Check EventHub. 🔗 Grafana: https://grafana.example.com/d/ns-health?var-ns=app&auth=secret" },
        startsAt: "2026-10-30T08:00:00Z", endsAt: "0001-01-01T00:00:00Z", fingerprint: "a1b2", values: { A: 34, C: 1 }, silenceURL: "https://grafana.example.com/alerting/silence/new" },
      { status: "resolved", labels: { alertname: "CiliumPolicyDropHigh", namespace: "app", severity: "sev2" }, annotations: {},
        startsAt: "2026-10-30T07:00:00Z", endsAt: "2026-10-30T08:10:00Z", fingerprint: "c3d4" },
    ],
  };
  const r = parseAlertPayload(body, NOW);
  assert.equal(r.kind, "grafana");
  if (r.kind === "unsupported") return;
  const [a, b] = r.alerts;
  assert.deepEqual([a!.status, a!.severity, a!.category, a!.endsAt, a!.values?.A], ["firing", "sev3", "monitoring", undefined, 34]);
  assert.equal(a!.labels.team, "platform", "common labels merged");
  assert.ok(a!.links.some((l) => l.kind === "grafana" && l.url === "https://grafana.example.com/d/ns-health?var-ns=app"), "description link, secret param dropped");
  assert.ok(a!.links.some((l) => l.kind === "silence"));
  assert.deepEqual([b!.status, b!.severity, b!.category, b!.endsAt], ["resolved", "sev2", "security", "2026-10-30T08:10:00.000Z"]);
  assert.ok(b!.links.some((l) => l.url === "/policies?tab=netpolSim") && b!.links.some((l) => l.url === "/hubble"), "policy drops open Pod traffic and the policy simulation");
  assert.notEqual(a!.id, b!.id);
  const am = parseAlertPayload({ version: "4", status: "firing", alerts: [{ status: "firing", labels: { alertname: "NodeDown", severity: "critical" }, annotations: {}, startsAt: "2026-10-30T08:00:00Z", fingerprint: "z" }] }, NOW);
  assert.equal(am.kind, "alertmanager");
  if (am.kind !== "unsupported") assert.deepEqual([am.alerts[0]!.severity, am.alerts[0]!.category, am.alerts[0]!.categoryBasis], ["sev1", "incident", "severity"]);
  assert.deepEqual(parseAlertPayload({ alerts: [] }), { kind: "unsupported", reason: "no_alerts" });
});

test("severity and category rules; safe links", () => {
  assert.deepEqual(["Sev0", "Sev1", "Sev2", "Sev3", "Sev4", "x"].map(azureSeverity), ["sev1", "sev2", "sev3", "sev4", "sev4", "sev3"]);
  assert.deepEqual(["sev1", "SEV4", "critical", "error", "warning", "info", "P2", ""].map(labelSeverity), ["sev1", "sev4", "sev1", "sev2", "sev3", "sev4", "sev2", "sev3"]);
  const c = (labels: Record<string, string>, service: string | undefined, name: string, severity: "sev1" | "sev3" = "sev3") => classify({ labels, service, names: [name], severity });
  assert.deepEqual(c({ category: "change" }, "ServiceHealth", "x"), { category: "change", basis: "label" }, "the label wins");
  assert.deepEqual(c({}, "Resource Health", "x"), { category: "incident", basis: "service" });
  assert.deepEqual(c({}, "Activity Log - Administrative", "x"), { category: "change", basis: "service" });
  assert.deepEqual(c({}, undefined, "AzureNodeMaintenanceScheduled"), { category: "change", basis: "name" });
  assert.deepEqual(c({}, undefined, "AppStartupFailure", "sev1"), { category: "incident", basis: "severity" });
  assert.deepEqual(c({}, undefined, "PodMemoryNearLimit"), { category: "monitoring", basis: "default" });
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://user:pw@grafana.example.com/x?code=1&var-ns=a"), "https://grafana.example.com/x?var-ns=a");
});

test("store: repeated deliveries update one item; re-firing re-opens and clears the acknowledgement; retention; teams", () => {
  const p = one(samplePayload("grafana", NOW));
  const t1 = applyDelivery({}, [p], NOW, () => "platform");
  assert.equal(t1.changed.length, 1);
  const id = p.id;
  assert.deepEqual([t1.next[id]!.received, t1.next[id]!.team], [1, "platform"]);
  const again = applyDelivery(t1.next, [p], new Date(NOW.getTime() + 60_000), () => "platform");
  assert.deepEqual([again.changed.length, again.next[id]!.received], [0, 2], "a repeat is not a change (no relay)");
  const acked = { ...again.next, [id]: { ...again.next[id]!, ack: { by: "kim", at: NOW.toISOString() } } };
  const res = applyDelivery(acked, [{ ...p, status: "resolved", endsAt: "2026-10-30T09:05:00.000Z" }], new Date(NOW.getTime() + 300_000), () => undefined);
  assert.deepEqual([res.changed.length, res.next[id]!.status, res.next[id]!.ack?.by], [1, "resolved", "kim"]);
  const refire = applyDelivery(res.next, [{ ...p, startsAt: "2026-10-30T10:00:00.000Z" }], new Date(NOW.getTime() + 3_600_000), () => undefined);
  assert.deepEqual([refire.next[id]!.status, refire.next[id]!.refired, refire.next[id]!.ack, refire.next[id]!.endsAt], ["firing", 1, undefined, undefined]);
  assert.deepEqual(refire.next[id]!.history.map((h) => h.status), ["firing", "resolved", "firing"]);
  // Retention: firing kept; resolved older than the window dropped
  const old = { ...res.next[id]!, id: "gf:old", status: "resolved" as const, endsAt: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(Object.keys(prune({ ...refire.next, [old.id]: old }, NOW, 30)), [id]);
  // Teams: namespace rules before resource-group rules
  const rules = [{ team: "infra", resourceGroups: ["rg-*"] }, { team: "apps", namespaces: ["example"] }];
  assert.equal(ownerTeam({ target: { namespace: "example", resourceGroup: "rg-x" } }, rules), "apps");
  assert.equal(ownerTeam({ target: { resourceGroup: "RG-X" } }, rules), "infra");
});

test("visibility, inbox counts, relay body, token check", () => {
  const p = one(samplePayload("azure", NOW));
  const grafana = one(samplePayload("grafana", NOW));
  const { next } = applyDelivery({}, [p, grafana], NOW, () => undefined);
  const all = Object.values(next);
  assert.equal(visibleTo(all, new Set([SUB])).length, 1, "the Azure alert's subscription is not the caller's — hidden; Grafana (no subscription) shown");
  assert.equal(visibleTo(all, "all").length, 2);
  const inbox = inboxResponse(all, { status: "firing", limit: 10 });
  assert.deepEqual([inbox.counts.firing, inbox.counts.firingUnacked, inbox.counts.bySeverity.sev2, inbox.counts.bySeverity.sev3], [2, 2, 1, 1]);
  assert.equal(inbox.items[0]!.severity, "sev2", "most severe first");
  const body = relayBody(next[grafana.id]!, "https://aud.example.com");
  assert.match(String(body.title), /^\[FIRING\]\[SEV2 major\] TestPodCrashLooping — example\/example-api-0$/);
  assert.match(String(body.message), /https:\/\/aud\.example\.com\/observability/);
  assert.equal((body.target as Record<string, unknown>).subscriptionId, undefined);
  assert.equal(relayBody(next[grafana.id]!, null).links instanceof Array, true);
  assert.deepEqual([relayWanted({ severity: "sev2" }, "sev2"), relayWanted({ severity: "sev3" }, "sev2")], [true, false]);
  assert.equal(tokenMatches("a".repeat(40), "a".repeat(40)), true);
  assert.equal(tokenMatches("a".repeat(39), "a".repeat(40)), false);
  assert.equal(tokenMatches(undefined, "a".repeat(40)), false);
});

test("receiver over HTTP: off = 404, wrong token = 401, Grafana with Bearer = 202, path / format mismatch = 400, Azure with ?token = 202", async () => {
  clearNotifyMemory();
  const TOKEN = "t".repeat(40);
  const mk = (token?: string) => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    registerNotifyHooks(app, { AUD_ALERT_RECEIVER_TOKEN: token, AUD_NOTIFY_RETENTION_DAYS: 30, AUD_NOTIFY_RELAY_MIN_SEVERITY: "sev2", CORS_ORIGIN: "http://localhost:3000" } as unknown as Env);
    return app.listen(0);
  };
  const off = mk();
  const on = mk(TOKEN);
  try {
    const url = (srv: ReturnType<typeof mk>, path: string) => `http://127.0.0.1:${(srv.address() as AddressInfo).port}${path}`;
    const post = (srv: ReturnType<typeof mk>, path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(srv, path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post(off, "/hooks/alerts/grafana", samplePayload("grafana"))).status, 404);
    assert.equal((await post(on, "/hooks/alerts/grafana", samplePayload("grafana"), { authorization: "Bearer wrong" })).status, 401);
    const ok = await post(on, "/hooks/alerts/grafana", samplePayload("grafana"), { authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { accepted: 1, kind: "grafana" });
    const mismatch = await post(on, `/hooks/alerts/azure?token=${TOKEN}`, samplePayload("grafana"));
    assert.deepEqual([mismatch.status, (await mismatch.json() as { error: string }).error], [400, "payload_mismatch"]);
    assert.equal((await post(on, `/hooks/alerts/azure?token=${TOKEN}`, samplePayload("azure"))).status, 202);
    assert.equal((await post(on, `/hooks/alerts/auto?token=${TOKEN}`, { hello: 1 })).status, 400);
    assert.equal((await listAlerts(undefined)).length, 2);
  } finally {
    off.close(); on.close(); clearNotifyMemory();
  }
});

test("web view: filters, new urgent alerts, setup snippets carry placeholders only", () => {
  const { next } = applyDelivery({}, [one(samplePayload("azure", NOW)), one(samplePayload("grafana", NOW))], NOW, (a) => (a.source === "grafana" ? "platform" : undefined));
  const items = Object.values(next);
  assert.equal(V.filterInbox(items, { ...V.DEFAULT_FILTER, team: "platform" }).length, 1);
  assert.equal(V.filterInbox(items, { ...V.DEFAULT_FILTER, team: "none" }).length, 1);
  assert.equal(V.filterInbox(items, { ...V.DEFAULT_FILTER, q: "example-api" }).length, 1);
  assert.equal(V.filterInbox(items, { ...V.DEFAULT_FILTER, severity: "sev2" })[0]!.source, "grafana");
  assert.equal(V.targetText(items.find((a) => a.source === "grafana")!), "example/example-api-0");
  assert.equal(V.newUrgent(items, new Set()).length, 1, "only the sev2 one");
  assert.equal(V.newUrgent(items, new Set(items.map((a) => `${a.id}@${a.startsAt}`))).length, 0);
  assert.match(V.azureSnippet("https://aud.example.com"), /\/hooks\/alerts\/azure\?token=<AUD_ALERT_RECEIVER_TOKEN>/);
  assert.match(V.grafanaSnippet("https://aud.example.com/"), /url\s+= "https:\/\/aud\.example\.com\/hooks\/alerts\/grafana"/);
  assert.ok(V.MAPPING.every((m) => m.screens.length > 0) && V.MAPPING.map((m) => m.category).join() === V.CATEGORIES.join());
});
