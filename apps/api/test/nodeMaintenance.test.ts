// Node maintenance: planned windows, episodes from the Activity Log + kube-state-metrics node facts. Synthetic data in the
// shape measured on a customer cluster 2026-10-23 (node image upgrade inside the 4th-Saturday node-OS window) — names
// are placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMaintenance,
  isChangeOp,
  nextWindowStart,
  nodeFacts,
  occursOn,
  parseWindows,
  poolOfNode,
  stepFor,
  windowAt,
  type ActEvent,
  type NodeTrack,
} from "../src/services/nodeMaintenance.js";

const CID = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-app/providers/Microsoft.ContainerService/managedClusters/aks-app";
const NODE_RG = "rg-app-aks";
const VMSS = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/RG-APP-AKS/providers/Microsoft.Compute/virtualMachineScaleSets/aks-pool1-12345678-vmss";
const s = (iso: string) => Date.parse(iso) / 1000;

const WINDOWS = parseWindows([
  { name: "aksManagedNodeOSUpgradeSchedule", properties: { maintenanceWindow: { schedule: { relativeMonthly: { intervalMonths: 1, dayOfWeek: "Saturday", weekIndex: "Fourth" } }, durationHours: 4, utcOffset: "+09:00", startDate: "2026-07-21", startTime: "02:00" } } },
  { name: "aksManagedAutoUpgradeSchedule", properties: { maintenanceWindow: { schedule: { relativeMonthly: { intervalMonths: 3, dayOfWeek: "Saturday", weekIndex: "Second" } }, durationHours: 4, utcOffset: "+09:00", startDate: "2026-07-21", startTime: "02:00" } } },
], Date.parse("2026-10-29T01:00:00Z"));

test("windows: relative / absolute / weekly / daily recurrence, local offset, interval from the start date", () => {
  const nodeOs = WINDOWS.find((w) => w.name === "aksManagedNodeOSUpgradeSchedule")!;
  const auto = WINDOWS.find((w) => w.name === "aksManagedAutoUpgradeSchedule")!;
  // 2026-10-24 (KST) is the 4th Saturday → 02:00 KST = 10-23 17:00Z, 4 h
  assert.equal(windowAt(WINDOWS, Date.parse("2026-10-23T17:00:12Z"))?.name, "aksManagedNodeOSUpgradeSchedule");
  assert.equal(windowAt(WINDOWS, Date.parse("2026-10-23T20:59:00Z"))?.name, "aksManagedNodeOSUpgradeSchedule");
  assert.equal(windowAt(WINDOWS, Date.parse("2026-10-23T21:00:00Z")), null, "the window is 4 hours");
  assert.equal(windowAt(WINDOWS, Date.parse("2026-10-28T21:38:00Z")), null, "a Wednesday night is no window");
  assert.equal(nodeOs.next, "2026-11-27T17:00:00.000Z", "next: 2026-11-28 (4th Saturday) 02:00 KST");
  // Every 3 months from July: October's 2nd Saturday (10-10) yes, November's no
  assert.equal(occursOn(auto, 2026, 9, 10), true);
  assert.equal(occursOn(auto, 2026, 10, 14), false);
  assert.equal(windowAt([auto], Date.parse("2026-10-09T17:00:07Z"))?.name, "aksManagedAutoUpgradeSchedule");
  assert.equal(occursOn(auto, 2026, 6, 11), false, "before the start date");
  const [weekly, last, abs, daily] = parseWindows([
    { name: "w", properties: { maintenanceWindow: { schedule: { weekly: { intervalWeeks: 2, dayOfWeek: "Sunday" } }, durationHours: 8, utcOffset: "+00:00", startDate: "2026-10-04", startTime: "00:00" } } },
    { name: "x", properties: { maintenanceWindow: { schedule: { relativeMonthly: { intervalMonths: 1, dayOfWeek: "Friday", weekIndex: "Last" } }, durationHours: 4, utcOffset: "+00:00", startTime: "22:00" } } },
    { name: "y", properties: { maintenanceWindow: { schedule: { absoluteMonthly: { intervalMonths: 1, dayOfMonth: 15 } }, durationHours: 4, utcOffset: "-05:00", startTime: "23:00" } } },
    { name: "z", properties: { maintenanceWindow: { schedule: { daily: { intervalDays: 1 } }, durationHours: 1, utcOffset: "+00:00", startTime: "03:00" } } },
  ], Date.parse("2026-10-29T00:00:00Z")).sort((a, b) => (a.name < b.name ? -1 : 1));
  assert.equal(occursOn(weekly!, 2026, 9, 18), true, "two weeks after the start");
  assert.equal(occursOn(weekly!, 2026, 9, 11), false, "the off week");
  assert.equal(occursOn(last!, 2026, 9, 30), true, "the last Friday of October 2026");
  assert.equal(occursOn(last!, 2026, 9, 23), false);
  assert.equal(windowAt([abs!], Date.parse("2026-11-16T04:30:00Z"))?.name, "y", "15th 23:00 at -05:00 = 16th 04:00Z");
  assert.equal(nextWindowStart(daily!, Date.parse("2026-10-29T03:30:00Z")), "2026-10-29T03:00:00.000Z", "an ongoing window counts");
  assert.equal(stepFor(7), 60);
  assert.equal(stepFor(14), 120);
  assert.equal(stepFor(30), 240);
});

test("only changes are maintenance: reads, credential lists and run-commands are not", () => {
  assert.equal(isChangeOp("Microsoft.ContainerService/managedClusters/agentPools/upgradeNodeImageVersion/action"), true);
  assert.equal(isChangeOp("Microsoft.Compute/virtualMachineScaleSets/reimage/action"), true);
  assert.equal(isChangeOp("Microsoft.ContainerService/managedClusters/agentpools/write"), true);
  assert.equal(isChangeOp("Microsoft.ContainerService/managedClusters/listClusterUserCredential/action"), false);
  assert.equal(isChangeOp("Microsoft.ContainerService/managedClusters/runCommand/action"), false);
  assert.equal(isChangeOp("Microsoft.Compute/virtualMachineScaleSets/virtualMachines/networkInterfaces/effectiveRouteTable/action"), false);
  assert.equal(poolOfNode("aks-pool1-12345678-vmss000000"), "pool1");
  assert.equal(poolOfNode("node-1"), null);
});

const ev = (time: string, op: string, status: string, resource: string, caller = "Microsoft.ContainerService", category = "Administrative"): ActEvent => ({ time, op, status, resource, caller, category });
const pts = (from: string, minutes: number, value: (m: number) => number): [number, number][] =>
  Array.from({ length: minutes }, (_, m) => [s(from) + m * 60, value(m)] as [number, number]);

test("an AKS node image upgrade: one episode with its operations, window, nodes and nothing left 'unplanned'", () => {
  const events: ActEvent[] = [
    ev("2026-10-23T17:00:12Z", "Microsoft.ContainerService/managedClusters/agentPools/upgradeNodeImageVersion/action", "Started", `${CID}/agentPools/pool1`),
    ev("2026-10-23T17:00:15Z", "Microsoft.ContainerService/managedClusters/agentPools/upgradeNodeImageVersion/action", "Accepted", `${CID}/agentPools/pool1`),
    ev("2026-10-23T17:05:51Z", "Microsoft.Compute/virtualMachineScaleSets/reimage/action", "Succeeded", VMSS, "11111111-1111-1111-1111-111111111111"),
    ev("2026-10-23T17:11:55Z", "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/write", "Failed", `${VMSS}/virtualMachines/3`, "11111111-1111-1111-1111-111111111111"),
    ev("2026-10-23T17:08:40Z", "Microsoft.ResourceHealth/healthevent/Activated/action", "Active", VMSS, "", "ResourceHealth"),
    ev("2026-10-23T17:18:16Z", "Microsoft.ContainerService/managedClusters/agentpools/write", "Succeeded", `${CID}/agentPools/pool1`),
    // noise: a person's credential list and a role assignment on the cluster
    ev("2026-10-23T17:20:00Z", "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action", "Succeeded", CID, "someone@example.com"),
    ev("2026-10-22T07:33:09Z", "Microsoft.Authorization/roleAssignments/write", "Succeeded", `${CID}/providers/Microsoft.Authorization/roleAssignments/x`, "someone@example.com"),
    // a scale-set model write alone changes no node
    ev("2026-10-15T07:31:22Z", "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/write", "Succeeded", `${VMSS}/virtualMachines/1`, "11111111-1111-1111-1111-111111111111"),
  ];
  const node0: NodeTrack = {
    node: "aks-pool1-12345678-vmss000000",
    cordon: pts("2026-10-23T16:50:00Z", 40, (m) => (m >= 17 && m < 23 ? 1 : 0)),
    // NotReady twice inside the upgrade (17:10–17:12 and 17:14–17:16)
    ready: pts("2026-10-23T16:50:00Z", 40, (m) => (m >= 20 && m < 22) || (m >= 24 && m < 26) ? 0 : 1),
    created: pts("2026-10-23T16:50:00Z", 40, (m) => (m < 22 ? s("2026-10-01T00:00:00Z") : s("2026-10-23T17:11:54Z"))),
    kernels: [{ kernel: "6.8.0-1067-azure", first: s("2026-10-23T16:50:00Z"), last: s("2026-10-23T17:09:00Z") }, { kernel: "6.8.0-1070-azure", first: s("2026-10-23T17:10:00Z"), last: s("2026-10-23T17:29:00Z") }],
    kubelets: [{ version: "v1.36.4", first: s("2026-10-23T16:50:00Z"), last: s("2026-10-23T17:29:00Z") }],
  };
  const surge: NodeTrack = {
    node: "aks-pool1-12345678-vmss00000t",
    cordon: pts("2026-10-23T17:03:00Z", 10, () => 0), ready: pts("2026-10-23T17:03:00Z", 10, () => 1),
    created: pts("2026-10-23T17:03:00Z", 10, () => s("2026-10-23T17:01:16Z")), kernels: [], kubelets: [],
  };
  // A node NotReady on another day with no operation: not maintenance — listed apart
  const other: NodeTrack = {
    node: "aks-pool1-12345678-vmss000004",
    cordon: [], ready: [...pts("2026-10-23T16:50:00Z", 40, () => 1), ...pts("2026-10-28T21:30:00Z", 20, (m) => (m >= 8 && m < 12 ? 0 : 1))],
    created: pts("2026-10-23T16:50:00Z", 40, () => s("2026-10-01T00:00:00Z")), kernels: [], kubelets: [],
  };
  const out = buildMaintenance({
    clusterId: CID, nodeResourceGroup: NODE_RG, events, tracks: [node0, surge, other],
    // the range ends where the series do (a series ending earlier would read as a removed node)
    rangeStart: s("2026-10-15T00:00:00Z"), rangeEnd: s("2026-10-28T21:50:00Z"), step: 60, windows: WINDOWS, now: Date.parse("2026-10-28T21:50:00Z"),
  });
  assert.equal(out.episodes.length, 1, JSON.stringify(out.episodes.map((e) => [e.kind, e.start])));
  const e = out.episodes[0]!;
  assert.deepEqual([e.kind, e.status, e.initiator, e.inWindow, e.pools], ["nodeImageUpgrade", "succeeded", "aks", "aksManagedNodeOSUpgradeSchedule", ["pool1"]]);
  assert.equal(e.start, "2026-10-23T17:00:12.000Z");
  assert.equal(e.failedOps, 1, "a failed instance write inside a succeeded upgrade is counted, not hidden");
  assert.equal(e.resourceHealth, 1);
  assert.ok(e.operations.some((o) => o.op === "agentpools/upgradenodeimageversion/action" && o.target === "pool1"));
  assert.ok(!e.operations.some((o) => /listclusterusercredential/.test(o.op)), "credential lists are not maintenance");
  const n0 = e.nodes.find((n) => n.node === node0.node)!;
  assert.deepEqual(n0.cordoned, { start: "2026-10-23T17:07:00.000Z", end: "2026-10-23T17:13:00.000Z", times: 1 });
  assert.deepEqual(n0.notReady, { start: "2026-10-23T17:10:00.000Z", end: "2026-10-23T17:16:00.000Z", times: 2 });
  assert.equal(n0.reRegistered, "2026-10-23T17:11:54.000Z");
  assert.deepEqual(n0.kernel, { from: "6.8.0-1067-azure", to: "6.8.0-1070-azure" });
  assert.equal(n0.kubelet, undefined);
  assert.deepEqual(e.nodes.find((n) => n.node === surge.node)!.surge, { created: "2026-10-23T17:01:16.000Z", removed: "2026-10-23T17:12:00.000Z" });
  assert.deepEqual(out.unplanned, [{ node: other.node, start: "2026-10-28T21:38:00.000Z", end: "2026-10-28T21:42:00.000Z" }]);
  assert.ok(!JSON.stringify(out).includes("someone@example.com"), "callers are reduced to who-kind");
  assert.ok(!JSON.stringify(out).includes("/subscriptions/"));
});

test("a Kubernetes upgrade is a kubelet change on the nodes; without Azure operations the initiator stays unknown", () => {
  const n: NodeTrack = {
    node: "aks-pool1-12345678-vmss000000", cordon: pts("2026-10-09T17:00:00Z", 30, (m) => (m >= 15 && m < 20 ? 1 : 0)), ready: pts("2026-10-09T17:00:00Z", 30, () => 1),
    created: pts("2026-10-09T17:00:00Z", 30, (m) => (m < 19 ? s("2026-10-01T00:00:00Z") : s("2026-10-09T17:19:25Z"))), kernels: [],
    kubelets: [{ version: "v1.36.2", first: s("2026-10-09T17:00:00Z"), last: s("2026-10-09T17:18:00Z") }, { version: "v1.36.4", first: s("2026-10-09T17:19:00Z"), last: s("2026-10-09T17:29:00Z") }],
  };
  const base = { clusterId: CID, nodeResourceGroup: NODE_RG, rangeStart: s("2026-10-01T00:00:00Z"), rangeEnd: s("2026-10-29T00:00:00Z"), step: 60, windows: WINDOWS, now: Date.parse("2026-10-29T01:00:00Z") };
  const withOps = buildMaintenance({ ...base, tracks: [n], events: [ev("2026-10-09T17:00:07Z", "Microsoft.ContainerService/managedClusters/write", "Succeeded", CID)] });
  assert.deepEqual([withOps.episodes[0]!.kind, withOps.episodes[0]!.initiator, withOps.episodes[0]!.inWindow], ["kubernetesUpgrade", "aks", "aksManagedAutoUpgradeSchedule"]);
  assert.deepEqual(withOps.episodes[0]!.nodes[0]!.kubelet, { from: "v1.36.2", to: "v1.36.4" });
  const metricsOnly = buildMaintenance({ ...base, tracks: [n], events: null });
  assert.deepEqual([metricsOnly.episodes[0]!.initiator, metricsOnly.episodes[0]!.status, metricsOnly.episodes[0]!.basis], ["unknown", "unknown", ["metrics"]]);
  assert.equal(buildMaintenance({ ...base, tracks: [n], events: [], windows: null }).episodes[0]!.inWindow, undefined, "no windows read → not judged");
});

test("node facts: spans, gaps, appeared / removed, re-registration", () => {
  const t: NodeTrack = {
    node: "aks-pool1-12345678-vmss00000k", cordon: [], kernels: [], kubelets: [],
    ready: pts("2026-10-23T17:22:00Z", 8, (m) => (m === 0 ? 0 : 1)),
    created: pts("2026-10-23T17:22:00Z", 8, () => s("2026-10-23T17:21:18Z")),
  };
  const f = nodeFacts(t, s("2026-10-20T00:00:00Z"), s("2026-10-29T00:00:00Z"), 60);
  assert.equal(f.appeared, s("2026-10-23T17:21:18Z"));
  assert.equal(f.removed, s("2026-10-23T17:29:00Z"));
  assert.deepEqual(f.notReady, [{ start: s("2026-10-23T17:22:00Z"), end: s("2026-10-23T17:23:00Z") }]);
  assert.deepEqual(f.reRegistered, [], "a new node's creation is not a re-registration");
});

test("web view: durations, the recent episode a card chip shows, the version change an episode agrees on", async () => {
  const ns = await import("../../web/src/lib/nodeMaintView.ts");
  const v = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
  const t = (k: string, x?: Record<string, string | number>) => `${k}:${JSON.stringify(x ?? {})}`;
  assert.equal(v.durationText(t, 216 * 60_000), 'nm.dur.hm:{"h":3,"m":36}');
  assert.equal(v.durationText(t, 45 * 60_000), 'nm.dur.m:{"m":45}');
  assert.equal(v.durationText(t, (2 * 1440 + 4 * 60 + 5) * 60_000), 'nm.dur.dh:{"d":2,"h":4}');
  const ep = (end: string | null) => ({ id: "x", kind: "nodeImageUpgrade" as const, start: "2026-10-23T17:00:00Z", end, status: "succeeded" as const, initiator: "aks" as const, pools: [], operations: [], failedOps: 0, resourceHealth: 0, nodes: [], podsRestarted: null, basis: [] });
  const resp = (end: string | null) => ({ episodes: [ep(end)] }) as never;
  const now = Date.parse("2026-10-24T10:00:00Z");
  assert.ok(v.recentEpisode(resp("2026-10-23T17:49:00Z"), now), "ended 16 h ago");
  assert.equal(v.recentEpisode(resp("2026-10-23T17:49:00Z"), Date.parse("2026-10-29T00:00:00Z")), null, "older than 24 h");
  assert.ok(v.recentEpisode(resp(null), now), "running");
  const nodes = [{ node: "a", pool: "p", kernel: { from: "k1", to: "k2" } }, { node: "b", pool: "p", kernel: { from: "k1", to: "k2" } }];
  assert.deepEqual(v.versionChange({ ...ep(null), nodes }), { kind: "kernel", from: "k1", to: "k2" });
  assert.equal(v.versionChange({ ...ep(null), nodes: [...nodes, { node: "c", pool: "p", kernel: { from: "k0", to: "k2" } }] }), null, "nodes disagree → no single change shown");
});
