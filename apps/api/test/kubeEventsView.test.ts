// AKS 모니터링 › K8s 이벤트 (web lib/kubeEventsView + API services/kubeEvents): `kubectl get events -A` Warning rows as a
// screen — no invented severity (Kubernetes has Normal · Warning only), the event's own reason, "still happening" =
// last occurrence within 5 min of the read, counts cumulative, system namespaces filterable, kubectl lines to copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KubeEvent } from "@aud/types";
import * as ns from "../../web/src/lib/kubeEventsView.ts";
import { mapEvents, matchingEvents } from "../src/services/kubeEvents.js";

const V = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const NOW = Date.parse("2026-11-11T03:00:00Z");
const min = (m: number) => new Date(NOW - m * 60_000).toISOString();

const ev = (p: Partial<KubeEvent>): KubeEvent => ({
  time: min(1), type: "Warning", reason: "Unhealthy", kind: "Pod", namespace: "app", name: "api-7d9f8c6b5-bcdfg", count: 3, ...p,
});

const EVENTS: KubeEvent[] = [
  ev({ name: "api-7d9f8c6b5-bcdfg", count: 3, time: min(1), message: "Readiness probe failed: connection refused" }),
  ev({ name: "api-7d9f8c6b5-hjklm", count: 40, time: min(30), firstTime: min(600) }),
  ev({ reason: "BackOff", name: "worker-0", count: 12, time: min(2) }),
  ev({ reason: "FailedScheduling", name: "batch-x", count: 1, time: min(50) }),
  ev({ reason: "FailedGetResourceMetric", kind: "HorizontalPodAutoscaler", name: "api", count: 7, time: min(4), component: "horizontal-pod-autoscaler" }),
  ev({ namespace: "kube-system", reason: "Unhealthy", name: "ama-logs-abcde", count: 2, time: min(10) }),
  ev({ namespace: "", kind: "Node", reason: "NodeNotReady", name: "aks-pool-1", count: 1, time: min(20) }),
];

test("still happening = last occurrence within 5 minutes of the read (not the viewer's clock)", () => {
  assert.ok(V.isRecent(ev({ time: min(4.9) }), NOW));
  assert.ok(!V.isRecent(ev({ time: min(5.1) }), NOW));
  assert.ok(!V.isRecent(ev({ time: "" }), NOW), "no time = not recent (never guessed)");
});

test("system namespaces: AKS add-ons, policy, CNI and cluster-scoped (Node) events — an app namespace is not", () => {
  for (const s of ["kube-system", "kube-node-lease", "aks-command", "azure-alb-system", "gatekeeper-system", "calico-system", "app-routing-system", ""]) assert.ok(V.isSystemNamespace(s), s);
  for (const s of ["app", "monitor", "argocd", "integration"]) assert.ok(!V.isSystemNamespace(s), s);
});

test("summary: rows · objects · still happening · namespaces; reason chips count within the other filters", () => {
  const s = V.summarizeEvents(EVENTS, V.NO_FILTER, NOW);
  assert.deepEqual([s.rows, s.objects, s.recent, s.namespaces, s.systemRows], [7, 7, 3, 3, 2]);
  assert.deepEqual(s.reasons[0], { reason: "Unhealthy", rows: 3, recent: 1 }, "most rows first");
  // a reason picked: the numbers are that reason's, the chips still show every reason (so another can be picked)
  const one = V.summarizeEvents(EVENTS, { ...V.NO_FILTER, reason: "BackOff" }, NOW);
  assert.deepEqual([one.rows, one.recent, one.reasons.length], [1, 1, 5]);
  // system off: kube-system and the Node event leave the numbers and the chips
  const apps = V.summarizeEvents(EVENTS, { ...V.NO_FILTER, system: false }, NOW);
  assert.deepEqual([apps.rows, apps.systemRows, apps.reasons.some((r) => r.reason === "NodeNotReady")], [5, 0, false]);
});

test("filter: namespace · reason · text (object, message, reporter) · still happening only", () => {
  const f = (p: Partial<ns.EventFilter>) => V.filterEvents(EVENTS, { ...V.NO_FILTER, ...p }, NOW).map((e) => e.name);
  assert.deepEqual(f({ namespace: "kube-system" }), ["ama-logs-abcde"]);
  assert.deepEqual(f({ reason: "Unhealthy", system: false }), ["api-7d9f8c6b5-bcdfg", "api-7d9f8c6b5-hjklm"]);
  assert.deepEqual(f({ query: "connection REFUSED" }), ["api-7d9f8c6b5-bcdfg"], "message, case-insensitive");
  assert.deepEqual(f({ query: "horizontal-pod" }), ["api"], "the reporting component");
  assert.deepEqual(f({ recentOnly: true }), ["api-7d9f8c6b5-bcdfg", "worker-0", "api"]);
});

test("sort: most recent (default) or most repeated (ties → most recent); kubectl line to copy", () => {
  assert.deepEqual(V.sortEvents(EVENTS, "recent").slice(0, 3).map((e) => e.name), ["api-7d9f8c6b5-bcdfg", "worker-0", "api"]);
  assert.deepEqual(V.sortEvents(EVENTS, "count").slice(0, 3).map((e) => e.count), [40, 12, 7]);
  assert.equal(V.eventLine(EVENTS[0]!), "app  Pod/api-7d9f8c6b5-bcdfg  [Unhealthy]  x3  Readiness probe failed: connection refused");
  assert.equal(V.eventLine(EVENTS[6]!), "-  Node/aks-pool-1  [NodeNotReady]  x1", "cluster-scoped, viewer (no message)");
});

test("namespaces for the picker: apps first then system, each by name, with counts", () => {
  assert.deepEqual(V.eventNamespaces(EVENTS).map((n) => `${n.namespace}:${n.rows}:${n.system}`), ["app:5:false", ":1:true", "kube-system:1:true"]);
});

test("ago: seconds → minutes → hours → days; nothing for no time", () => {
  assert.deepEqual(V.agoParts(min(0.5), NOW), { value: -30, unit: "second" });
  assert.deepEqual(V.agoParts(min(90), NOW), { value: -1, unit: "hour" });
  assert.deepEqual(V.agoParts(min(60 * 49), NOW), { value: -2, unit: "day" });
  assert.equal(V.agoParts(undefined, NOW), null);
});

test("every explained reason has ko/en text; the tab is in the page and the menu's tab list", () => {
  const ops = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  for (const r of V.KNOWN_REASONS) assert.match(ops, new RegExp(`"ob\\.ev\\.why\\.${r}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), r);
  const page = readFileSync(new URL("../../web/src/app/observability/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const TABS: Tab\[\] = \[[^\]]*"events"/);
  assert.match(page, /<EventsTab /);
});

test("API: the reporter (kubectl SOURCE) is kept; matching counts all before the limit", () => {
  const raw = (i: number) => ({
    type: "Warning", reason: "Unhealthy", count: 1, lastTimestamp: new Date(NOW - i * 1000) as unknown as Date,
    involvedObject: { kind: "Pod", name: `p-${i}`, namespace: "app" }, metadata: { namespace: "app" },
    ...(i === 0 ? { source: { component: "kubelet" } } : i === 1 ? { reportingComponent: "default-scheduler" } : {}),
  });
  const items = Array.from({ length: 5 }, (_, i) => raw(i));
  assert.equal(matchingEvents(items as never, { messages: false }).length, 5);
  const limited = mapEvents(items as never, { messages: false, limit: 2 });
  assert.deepEqual(limited.map((e) => [e.name, e.component]), [["p-0", "kubelet"], ["p-1", "default-scheduler"]]);
  assert.equal(mapEvents(items as never, { messages: false })[2]!.component, undefined, "no reporter → no field");
});
