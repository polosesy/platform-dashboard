// 사례·런북 › 재발 · 인시던트 기록 (docs/architecture/ops-knowledge.md §10 — 2026-11-17). Shapes as the Azure Alerts
// Management API and the alert centre store them; synthetic names and IDs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NotifyAlert, OpsCase, OpsRecurrenceGroup, OpsRunbook } from "@aud/types";
import type { AzureAlert } from "../src/services/alertsCollector.js";
import { azureFirings, centerFirings, recurrenceGroups, recurrenceKey, recurrenceUrl } from "../src/services/opsRecurrence.js";
import { CaseBody, RunbookBody } from "../src/services/opsKnowledgeStore.js";
import * as webNs from "../../web/src/lib/opsKnowledge.ts";

const web = ((webNs as unknown as { default?: typeof webNs }).default ?? webNs) as typeof webNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const SUB = "00000000-0000-0000-0000-0000000000aa";
const RES = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Network/applicationGateways/agw-1`;
const NOW = new Date("2026-11-17T00:00:00Z");
const az = (rule: string, target: string, start: string, over: Partial<AzureAlert["properties"]["essentials"]> = {}): AzureAlert => ({
  id: `${target}/alerts/${start}`, name: rule,
  properties: { essentials: {
    severity: "Sev2", alertState: "New", monitorCondition: "Resolved", startDateTime: start, targetResource: target,
    targetResourceType: "microsoft.network/applicationgateways", targetResourceGroup: "rg-app", alertRule: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/microsoft.insights/metricalerts/${rule}`,
    ...over,
  } },
});
const NOW_ISO = NOW.toISOString();
const kase = (id: string, over: Partial<OpsCase>): OpsCase => ({
  id, title: id, status: "open", severity: "sev3", occurredAt: NOW_ISO, symptoms: "x", tags: [], signals: [], scope: {}, runbookIds: [],
  rev: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO, ...over,
});
const book = (id: string, over: Partial<OpsRunbook>): OpsRunbook => ({
  id, title: id, when: "w", signals: [], tags: [], steps: [{ title: "s" }], rev: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO, ...over,
});

test("Azure firings: rule = the rule's own name, Sev0/1 → sev1 … Sev4 → sev4, firing = Fired and not closed by a person", () => {
  const f = azureFirings([
    az("unhealthy-backends", RES, "2026-11-16T01:00:00Z", { severity: "Sev0", monitorCondition: "Fired" }),
    az("unhealthy-backends", RES, "2026-11-16T02:00:00Z", { severity: "Sev3", monitorCondition: "Fired", alertState: "Closed" }),
    az("unhealthy-backends", RES, "2026-11-16T03:00:00Z", { severity: "Sev4", monitorConditionResolvedDateTime: "2026-11-16T03:12:00Z" }),
  ]);
  assert.deepEqual(f.map((x) => [x.rule, x.severity, x.firing, x.target.name, x.resolvedAt ?? null]), [
    ["unhealthy-backends", "sev1", true, "agw-1", null], ["unhealthy-backends", "sev3", false, "agw-1", null], ["unhealthy-backends", "sev4", false, "agw-1", "2026-11-16T03:12:00Z"],
  ]);
  assert.match(recurrenceUrl(SUB, 30), /timeRange=30d&pageCount=250/);
  assert.doesNotMatch(recurrenceUrl(SUB, 30), /monitorCondition=/, "both Fired and Resolved — the live diagram reads Resolved for 1 day only");
});

test("alert-centre firings: Grafana / Alertmanager only (Azure comes from Azure Monitor — no double count); one per firing event", () => {
  const item = (over: Partial<NotifyAlert>): NotifyAlert => ({
    id: "gf:1", source: "grafana", status: "resolved", severity: "sev2", category: "monitoring", categoryBasis: "default", rule: "HighErrorRate", title: "t",
    target: { namespace: "shop", pod: "orders-7d9f8c6b5d-x2k4q" }, labels: {}, links: [], startsAt: "2026-11-16T00:00:00Z",
    firstReceivedAt: "2026-11-16T00:00:00Z", lastReceivedAt: "2026-11-16T05:00:00Z", received: 3, refired: 1, history: [], deliveries: [], ...over,
  } as NotifyAlert);
  const f = centerFirings([
    item({ history: [{ at: "2026-11-16T00:00:00Z", status: "firing" }, { at: "2026-11-16T00:10:00Z", status: "resolved" }, { at: "2026-11-16T04:00:00Z", status: "firing" }], status: "firing" }),
    item({ id: "az:1", source: "azure-monitor" }),
    item({ id: "t:1", source: "test" }),
  ]);
  assert.deepEqual(f.map((x) => [x.at, x.resolvedAt ?? null, x.firing, x.target.name, x.target.namespace]), [
    ["2026-11-16T00:00:00Z", "2026-11-16T00:10:00Z", false, "orders", "shop"],
    ["2026-11-16T04:00:00Z", null, true, "orders", "shop"],
  ], "the pod's ReplicaSet hash and pod suffix are not part of the target");
  assert.equal(recurrenceKey(f[0]!), recurrenceKey(f[1]!));
});

test("groups: rule × exact target, most firings first; resolve times; cases written for the group vs naming the rule; runbooks by rule; totals", () => {
  const RES2 = RES.replace("agw-1", "agw-2");
  const firings = azureFirings([
    az("unhealthy-backends", RES, "2026-11-16T01:00:00Z", { monitorConditionResolvedDateTime: "2026-11-16T01:10:00Z" }),
    az("unhealthy-backends", RES, "2026-11-16T02:00:00Z", { monitorConditionResolvedDateTime: "2026-11-16T02:30:00Z" }),
    az("unhealthy-backends", RES, "2026-11-16T03:00:00Z", { monitorCondition: "Fired" }),
    az("unhealthy-backends", RES2, "2026-11-16T04:00:00Z"),
    az("cpu-high", RES, "2026-10-01T00:00:00Z"), // before the window
  ]);
  const key = recurrenceKey(firings[0]!);
  assert.match(key, /^az:[0-9a-f]{16}$/);
  assert.ok(!key.includes(SUB) && !key.includes("agw"), "hashed — no subscription or resource id leaves the API");
  const { groups, totals } = recurrenceGroups(firings,
    [kase("for-group", { recurrenceKey: key }), kase("by-rule", { signals: [{ kind: "alertRule", value: "Unhealthy-Backends" }] }), kase("other", {})],
    [book("rb-1", { signals: [{ kind: "alertRule", value: "unhealthy-backends" }] }), book("rb-2", { signals: [{ kind: "keyword", value: "unhealthy-backends" }] })],
    NOW, 30);
  assert.equal(groups.length, 2, "two targets = two groups; the October firing is outside 30 days");
  const g = groups[0]!;
  assert.deepEqual([g.occurrences, g.firingNow, g.firingSince, g.firstAt, g.lastAt], [3, 1, "2026-11-16T03:00:00Z", "2026-11-16T01:00:00Z", "2026-11-16T03:00:00Z"]);
  assert.deepEqual(g.resolveMinutes, { p50: 20, max: 30, n: 2 });
  assert.deepEqual(g.recent.map((r) => r.at), ["2026-11-16T03:00:00Z", "2026-11-16T02:00:00Z", "2026-11-16T01:00:00Z"]);
  assert.deepEqual(g.cases, { linked: ["for-group"], rule: ["by-rule"] }, "rule match ignores case; a linked case is not listed twice");
  assert.deepEqual(g.runbooks, ["rb-1"], "only an alertRule signal links a runbook — a keyword does not");
  assert.deepEqual(groups[1]!.resolveMinutes, null);
  assert.deepEqual(totals, { alerts: 4, groups: 2, recurring: 1, firingNow: 1, recurringNoCase: 0, recurringNoRunbook: 0 });
  const bare = recurrenceGroups(firings, [], [], NOW, 30).totals;
  assert.deepEqual([bare.recurringNoCase, bare.recurringNoRunbook], [1, 1]);
});

test("incident record: timeline and follow-ups in the case body — bounded, ids unique, the group key only in its hashed form", () => {
  const base = { title: "t", status: "open", severity: "sev2", occurredAt: NOW_ISO, symptoms: "s", tags: [], signals: [], scope: {}, runbookIds: [], baseRev: null };
  assert.ok(CaseBody.safeParse({ ...base, recurrenceKey: "az:0123456789abcdef",
    timeline: [{ at: NOW_ISO, kind: "alert", text: "fired" }, { at: NOW_ISO, kind: "action", text: "restarted", by: "me" }],
    followUps: [{ id: "a1", title: "auto-resolve on", status: "open", due: "2026-11-30" }, { id: "a2", title: "runbook", status: "done", doneAt: NOW_ISO }] }).success);
  for (const bad of [
    { recurrenceKey: `az:${SUB}` }, { recurrenceKey: "x:0123456789abcdef" },
    { timeline: [{ at: "yesterday", kind: "alert", text: "x" }] }, { timeline: [{ at: NOW_ISO, kind: "page", text: "x" }] }, { timeline: [{ at: NOW_ISO, kind: "note", text: "" }] },
    { followUps: [{ id: "a", title: "x", status: "open" }, { id: "a", title: "y", status: "open" }] }, { followUps: [{ id: "a", title: "x", status: "open", due: "30.11.2026" }] },
    { followUps: Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, title: "x", status: "open" })) },
  ]) assert.equal(CaseBody.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad).slice(0, 80));
  const route = read("../src/routes/ops.ts");
  assert.match(route, /timeline\?\.map\(\(e\) => \{ const m = maskTexts\(e, \["text"\]\)/, "timeline lines are masked like the other texts");
  assert.match(route, /followUps\?\.map\(\(f\) => \{ const m = maskTexts\(f, \["title"\]\)/);
  assert.match(route, /router\.get\("\/api\/ops\/recurrence", async[\s\S]{0,200}signin_required/, "signed in only");
});

test("web: a case from a recurrence group passes the API schema; follow-ups toggle; runbook alert rules round-trip as alertRule signals", () => {
  const g: OpsRecurrenceGroup = {
    key: "az:0123456789abcdef", source: "azureMonitor", rule: "unhealthy-backends", target: { name: "agw-1", type: "microsoft.network/applicationgateways", resourceGroup: "rg-app" },
    severity: "sev2", occurrences: 3, firingNow: 1, firingSince: "2026-11-16T03:00:00Z", firstAt: "2026-11-16T01:00:00Z", lastAt: "2026-11-16T03:00:00Z",
    resolveMinutes: { p50: 20, max: 30, n: 2 }, recent: [{ at: "2026-11-16T03:00:00Z" }, { at: "2026-11-16T01:00:00Z", resolvedAt: "2026-11-16T01:10:00Z" }],
    cases: { linked: [], rule: [] }, runbooks: [],
  };
  const f = web.caseFromGroup(g, NOW, { title: "unhealthy-backends — agw-1", symptoms: "fired 3 times", fired: "Fired", resolved: "Resolved" });
  assert.deepEqual([f.alertRule, f.recurrenceKey, f.severity, f.resourceType], ["unhealthy-backends", g.key, "sev2", "microsoft.network/applicationgateways"]);
  assert.deepEqual(f.timeline.map((e) => [e.at, e.text]), [
    ["2026-11-16T01:00:00Z", "Fired — unhealthy-backends"], ["2026-11-16T01:10:00Z", "Resolved — unhealthy-backends"], ["2026-11-16T03:00:00Z", "Fired — unhealthy-backends"],
  ], "oldest first");
  const withFu = { ...f, followUps: [{ id: web.newFollowUpId([], 1), title: "auto-resolve on", status: "open" as const, due: "2026-11-30" }] };
  const body = web.caseBody(withFu, null);
  const parsed = CaseBody.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? []));
  const done = web.toggleFollowUp(withFu.followUps, withFu.followUps[0]!.id, NOW);
  assert.deepEqual([done[0]!.status, done[0]!.doneAt], ["done", NOW_ISO]);
  const reopened = web.toggleFollowUp(done, done[0]!.id, NOW);
  assert.deepEqual([reopened[0]!.status, "doneAt" in reopened[0]!], ["open", false]);
  assert.deepEqual(web.followUpStats([kase("a", { followUps: [...done, { id: "b", title: "x", status: "open", due: "2026-11-01" }, { id: "c", title: "y", status: "open" }] })], "2026-11-17"),
    { open: 2, overdue: 1, done: 1 });
  assert.equal(web.newFollowUpId([{ id: (1).toString(36) }], 1), (2).toString(36));

  const rb = web.runbookBody({ ...web.emptyRunbook({ title: "AGW backends", when: "w", alertRules: "unhealthy-backends", keywords: "502" }), steps: [{ title: "check probes" }] }, null);
  assert.deepEqual(rb.signals, [{ kind: "alertRule", value: "unhealthy-backends" }, { kind: "keyword", value: "502" }]);
  assert.ok(RunbookBody.safeParse(rb).success);
  const back = web.runbookForm(book("r", { signals: rb.signals }));
  assert.deepEqual([back.alertRules, back.keywords], ["unhealthy-backends", "502"], "an edited runbook keeps its alert rule a rule (it used to become a keyword)");

  const gs = [g, { ...g, key: "az:1111111111111111", occurrences: 1, rule: "cpu-high" }];
  assert.deepEqual(web.filterGroups(gs, true, "").map((x) => x.rule), ["unhealthy-backends"]);
  assert.deepEqual(web.filterGroups(gs, false, "CPU").map((x) => x.rule), ["cpu-high"]);
});

test("wiring: the 재발 tab, its i18n, operator-only actions", () => {
  const page = read("../../web/src/app/runbooks/page.tsx");
  assert.match(page, /const TABS = \["find", "recurrence", "cases", "runbooks"\] as const;/);
  const view = read("../../web/src/app/runbooks/RecurrenceView.tsx");
  assert.match(view, /\{canWrite \? <Button size="sm" variant="primary" onClick=\{\(\) => startCase\(g\)\}>/);
  const all = read("../../web/src/lib/i18nOps.ts");
  const used = new Set([...view.matchAll(/t\("(ops\.rec\.[\w.]+)"/g), ...read("../../web/src/app/runbooks/Editors.tsx").matchAll(/t\("(ops\.kb\.(?:tl|fu)\.[\w.]+)"/g)].map((m) => m[1]!));
  for (const k of ["partial", "failed"]) used.add(`ops.rec.state.${k}`);
  for (const k of ["azureMonitor", "alertCenter"]) used.add(`ops.rec.src.${k}`);
  for (const k of ["alert", "change", "action", "note", "status"]) used.add(`ops.kb.tl.kind.${k}`);
  for (const k of used) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});
