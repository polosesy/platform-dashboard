// 노출 관리 (CTEM, 2026-11-19): services/exposure.ts (scoping · discovery · controls), services/issueSightingStore.ts
// (first / last seen) and web lib/exposureView.ts (prioritization · validation · remediation from the issue list).
// Checked on stg (my token, 3 subscriptions): every asset class, coverage (clusters · VMs), all 9 controls and all 9
// finding classes (count and distinct resources) = an independent pull of the raw rows classified in TS. Found while
// checking: Resource Graph paging without `id` in the projection returns duplicated / missing rows (13,011 rows, 663
// distinct resources instead of 680) — the module counts inside KQL so it never pages raw rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateExposure, EXPOSURE_Q, planCovers, type ExposureRaw } from "../src/services/exposure.js";
import { clearSightingMemory, mergeSightings, readSightings, recordSightings } from "../src/services/issueSightingStore.js";
import * as vNs from "../../web/src/lib/exposureView.ts";
import * as qNs from "../../web/src/lib/issueQueue.ts";

const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;
const Q = ((qNs as unknown as { default?: typeof qNs }).default ?? qNs) as typeof qNs;
const S1 = "00000000-0000-0000-0000-0000000000a1", S2 = "00000000-0000-0000-0000-0000000000a2";
const rid = (sub: string, rest: string) => `/subscriptions/${sub}/resourcegroups/rg/providers/${rest}`;
const plan = (scope: string, name: string, tier: string) => ({ id: `${scope}/providers/microsoft.security/pricings/${name}`, name, tier });

test("coverage: the resource-level plan wins over the subscription's (both ways)", () => {
  const aks1 = rid(S1, "microsoft.containerservice/managedclusters/a"), aks2 = rid(S2, "microsoft.containerservice/managedclusters/b");
  const covers = planCovers([plan(`/subscriptions/${S1}`, "Containers", "Standard"), plan(aks1, "Containers", "Free"), plan(`/subscriptions/${S2}`, "Containers", "Free"), plan(aks2, "Containers", "Standard")]);
  assert.equal(covers(aks1, S1, "Containers"), false); // turned off on the resource
  assert.equal(covers(aks2, S2, "Containers"), true); // turned on on the resource
  assert.equal(covers(rid(S1, "microsoft.containerservice/managedclusters/c"), S1, "containers"), true);
  assert.equal(covers(rid(S2, "microsoft.containerservice/managedclusters/d"), S2, "Containers"), false);
});

const RAW: ExposureRaw = {
  subscriptions: [{ sub: S1 }, { sub: S2 }],
  assets: [
    { id: rid(S1, "microsoft.containerservice/managedclusters/a"), type: "microsoft.containerservice/managedclusters", sub: S1 },
    { id: rid(S1, "microsoft.compute/virtualmachines/vm1"), type: "microsoft.compute/virtualmachines", sub: S1 },
    { id: rid(S2, "microsoft.compute/virtualmachinescalesets/ss"), type: "microsoft.compute/virtualmachinescalesets", sub: S2 },
    { id: rid(S1, "microsoft.cache/redis/r"), type: "microsoft.cache/redis", sub: S1 },
    { id: rid(S1, "microsoft.storage/storageaccounts/st"), type: "microsoft.storage/storageaccounts", sub: S1 },
    { id: rid(S1, "microsoft.network/publicipaddresses/ip"), type: "microsoft.network/publicipaddresses", sub: S1 },
  ],
  plans: [plan(`/subscriptions/${S1}`, "Containers", "Standard"), plan(`/subscriptions/${S1}`, "VirtualMachines", "Standard"), plan(`/subscriptions/${S2}`, "VirtualMachines", "Free"),
    plan(`/subscriptions/${S1}`, "StorageAccounts", "Free"), plan(`/subscriptions/${S1}`, "CloudPosture", "Standard"), plan(`/subscriptions/${S2}`, "CloudPosture", "Free")],
  findings: [{ cls: "vulnImages", sev: "High", n: 10 }, { cls: "vulnImages", sev: "Low", n: 2 }, { cls: "identity", sev: "Medium", n: 3 }, { cls: "secrets", sev: "High", n: 0 }],
  findingResources: [{ cls: "vulnImages", r: 4 }, { cls: "identity", r: 2 }],
  risk: [{ level: "High", n: 2 }, { level: "Medium", n: 5 }],
  inventory: [{ eos: "None", vm: "a", n: 50 }, { eos: "EndOfSupport", vm: "b", n: 3 }, { eos: "", vm: "c", n: 4 }],
  alerts: [{ sev: "High", n: 1 }, { sev: "Informational", n: 2 }],
  controls: [{ c: "wafPrevention", n: 2 }, { c: "wafDetection", n: 3 }, { c: "wafOff", n: 1 }, { c: "appGateway:noWaf", n: 4 }, { c: "appGateway:waf", n: 1 },
    { c: "aks:pd", n: 1 }, { c: "aks:-d", n: 1 }, { c: "aks:--", n: 1 }, { c: "storage:deny", n: 5 }, { c: "storage:open", n: 1 }],
};

test("scoping: totals per class, covered only where a plan covers the kind (null when none does)", () => {
  const a = Object.fromEntries(aggregateExposure(RAW).assets.map((x) => [x.id, [x.total, x.covered]]));
  assert.deepEqual(a.subscriptions, [2, 1]); // Defender CSPM on S1 only
  assert.deepEqual(a.kubernetesClusters, [1, 1]);
  assert.deepEqual(a.virtualMachines, [2, 1]); // VMSS in S2 (Free)
  assert.deepEqual(a.dataStores, [2, 0]); // Redis has no plan, storage plan Free
  assert.deepEqual(a.applicationEndpoints, [1, 0]); // a public IP is no plan's kind …
  assert.equal(aggregateExposure(RAW).assets.find((x) => x.id === "applicationEndpoints")!.coverable, 0); // … so it is not in the denominator
  assert.equal(aggregateExposure(RAW).assets.find((x) => x.id === "dataStores")!.coverable, 1); // Redis has no plan
  assert.deepEqual(a.onPremServers, [0, 0]);
  // a section that failed = null, never 0
  const none = aggregateExposure({ ...RAW, assets: null, plans: null }).assets;
  assert.ok(none.every((x) => x.covered === null));
  assert.ok(none.filter((x) => x.id !== "subscriptions").every((x) => x.total === null));
});

test("discovery: counts by class and severity, resources from the exact distinct query, EOL from the inventory, secrets need CSPM", () => {
  const f = Object.fromEntries(aggregateExposure(RAW).findings.map((x) => [x.id, x]));
  assert.equal(f.vulnImages!.count, 12);
  assert.equal(f.vulnImages!.resources, 4);
  assert.deepEqual(f.vulnImages!.bySeverity, { High: 10, Low: 2 });
  assert.equal(f.cloudConfig!.count, 0); // none of that class — a real 0 (the query was read)
  assert.equal(f.secrets!.note, "someSubscriptions");
  assert.deepEqual([f.endOfLife!.count, f.endOfLife!.resources], [3, 1]); // "None" and "" are not end of life
  assert.deepEqual([f.threats!.count, f.threats!.bySeverity], [3, { High: 1, Informational: 2 }]);
  const noCspm = aggregateExposure({ ...RAW, plans: RAW.plans!.filter((p) => p.name !== "CloudPosture") }).findings.find((x) => x.id === "secrets")!;
  assert.deepEqual([noCspm.count, noCspm.note], [null, "noPlan"]);
  assert.equal(aggregateExposure({ ...RAW, inventory: [] }).findings.find((x) => x.id === "endOfLife")!.note, "noInventory");
  assert.equal(aggregateExposure({ ...RAW, findings: null }).findings.find((x) => x.id === "identity")!.count, null);
  assert.deepEqual(aggregateExposure(RAW).defenderRisk, { high: 2, medium: 5, low: 0 });
});

test("controls: counts and their 'out of'", () => {
  const c = Object.fromEntries(aggregateExposure(RAW).controls.map((x) => [x.id, [x.count, x.of ?? null]]));
  assert.deepEqual(c.wafPrevention, [2, 6]);
  assert.deepEqual(c.appGatewayNoWaf, [4, 5]);
  assert.deepEqual(c.aksPolicyAddon, [1, 3]);
  assert.deepEqual(c.aksDefenderSensor, [2, 3]);
  assert.deepEqual(c.storageDenyByDefault, [5, 6]);
  assert.deepEqual(c.keyVaultPrivate, [0, 0]);
  assert.deepEqual(c.azureFirewalls, [0, null]);
  assert.ok(aggregateExposure({ ...RAW, controls: null }).controls.every((x) => x.count === null));
});

test("queries: counted inside KQL (no raw-row paging), no `kind` column name, exact distinct resources", () => {
  for (const [k, q] of Object.entries(EXPOSURE_Q)) {
    assert.doesNotMatch(q, /\bdcount\(/, k);
    assert.doesNotMatch(q, /extend kind\b/, k);
  }
  assert.match(EXPOSURE_Q.findingResources, /summarize by cls, rid = .* \| summarize r = count\(\) by cls/);
  assert.match(EXPOSURE_Q.assets, /isnotempty\(properties\.ipConfiguration\)/); // a NAT gateway's egress IP is not an endpoint
});

test("sightings: first never moves, last follows, old entries drop, the cap keeps the newest", async () => {
  const t0 = new Date("2026-01-01T00:00:00Z"), t1 = new Date("2026-01-05T00:00:00Z");
  const a = mergeSightings({}, [{ key: "azure:a", sev: "high" }], t0);
  const b = mergeSightings(a, [{ key: "azure:a", sev: "critical" }, { key: "azure:b", sev: "high" }], t1);
  assert.deepEqual(b["azure:a"], { first: t0.toISOString(), last: t1.toISOString(), sev: "critical" });
  assert.equal(b["azure:b"]!.first, t1.toISOString());
  const later = mergeSightings(b, [{ key: "azure:b", sev: "high" }], new Date("2026-07-10T00:00:00Z"));
  assert.equal(later["azure:a"], undefined); // not seen for 180 days
  clearSightingMemory();
  await recordSightings(undefined, S1, [{ key: "vuln:rg/aks:x", sev: "high" }], t0);
  await recordSightings(undefined, S1, [{ key: "vuln:rg/aks:x", sev: "high" }], t1);
  assert.equal((await readSightings(undefined, S1.toUpperCase()))["vuln:rg/aks:x"]!.first, t0.toISOString());
});

const item = (over: Partial<qNs.QueueItem>): qNs.QueueItem => ({
  key: "azure:x", source: "azure", pathType: "exposure", sev: "high", title: "t", target: "", evidence: "cfg", href: "/", seenAt: null,
  namespaces: [], resourceGroups: [], team: null, stored: null, status: "open", flag: null, ...over,
});

test("stages: prioritized = open / in progress critical-high; validated = observed; SLA from first sightings (BOD 19-02)", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const st = (status: "open" | "resolved" | "accepted" | "inProgress", history: Array<{ status: "open" | "resolved" | "accepted" | "inProgress"; at: string }>, assignee?: string) => ({ status, rev: 1, updatedAt: history[0]!.at, history, ...(assignee ? { assignee } : {}) });
  const items = [
    item({ key: "azure:a", sev: "critical", evidence: "obs", stored: st("open", [{ status: "open", at: day(1) }], "team-a") }),
    item({ key: "azure:b", sev: "high", pathType: "privilege", status: "inProgress" }),
    item({ key: "azure:c", sev: "medium" }), // not prioritized
    item({ key: "azure:d", sev: "critical", status: "accepted" }), // excepted — not prioritized
    item({ key: "alert:high:x", source: "alert", pathType: "threat", sev: "high", evidence: "obs" }),
  ];
  const queue = { items, counts: { open: 0, openCritical: 0, inProgress: 0, accepted: 0, resolved: 0 }, notDetected: 2 };
  const states = {
    "azure:a": st("open", [{ status: "open", at: day(1) }], "team-a"),
    "azure:r1": st("resolved", [{ status: "resolved", at: day(10) }, { status: "open", at: day(40) }]),
    "azure:r2": st("resolved", [{ status: "resolved", at: day(120) }]),
    "azure:e": st("accepted", [{ status: "accepted", at: day(3) }]),
  };
  const sightings = {
    "azure:a": { first: day(20), last: day(0), sev: "critical" as const }, // 20 > 15 → overdue
    "azure:b": { first: day(29), last: day(0), sev: "high" as const }, // 29 ≤ 30 → within
  };
  const s = V.stages(queue, states, sightings, now);
  assert.deepEqual(s.prioritized.map((i) => i.key), ["azure:a", "azure:b", "alert:high:x"]);
  assert.deepEqual(s.validated.map((i) => i.key), ["azure:a", "alert:high:x"]);
  assert.equal(s.remediation.resolved, 1); // r2 was resolved 120 days ago
  assert.equal(s.remediation.notDetected, 2);
  assert.equal(s.remediation.exceptions, 1);
  assert.equal(s.remediation.inProgress, 1);
  assert.deepEqual([s.remediation.assigned, s.remediation.assignmentRate], [1, 1 / 3]);
  assert.deepEqual([s.remediation.sla.within, s.remediation.sla.overdue, s.remediation.sla.unknown, s.remediation.sla.rate], [1, 1, 1, 0.5]);
  assert.deepEqual(s.remediation.sla.overdueItems.map((o) => [o.item.key, o.days, o.limit]), [["azure:a", 20, 15]]);
  assert.deepEqual(V.byPath(s.prioritized).filter((p) => p.n).map((p) => [p.type, p.n, p.critical]), [["exposure", 1, 1], ["privilege", 1, 0], ["threat", 1, 0]]);
  const empty = V.stages({ ...queue, items: [] }, {}, null, now);
  assert.equal(empty.remediation.assignmentRate, null);
  assert.equal(empty.remediation.sla.rate, null);
});

test("funnel: log heights — the largest = 1, 0 = 0, unknown = no band", () => {
  const [a, b, c, d] = V.funnelHeights([11448, 100, 0, null]);
  assert.equal(a, 1);
  assert.ok(b! > 0.4 && b! < 0.6);
  assert.equal(c, 0);
  assert.equal(d, null);
});

test("issue list: every source gives its attack-path type (cluster combo kinds, Azure combo kinds, paths)", () => {
  const q = Q.buildIssueQueue({
    clusterId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks",
    insights: { generatedAt: "2026-01-01T00:00:00Z", issues: (["vnet", "exfil", "takeover", "standing", "local"] as const).map((kind) => ({ id: `${kind}:a`, sev: "crit", kind, title: kind, owner: "o", ownerGroup: "mine", findingIds: [], extraEvidence: [], nodes: [], edges: [], actions: [] })) } as never,
    azureRisk: { subscriptionId: "x", generatedAt: "2026-01-01T00:00:00Z", combos: [
      { key: "azure:rg/t/a", name: "a", type: "t", resourceGroup: "rg", kind: "exposedHigh", sev: "high", exposure: { state: "yes" }, high: { state: "yes" }, identity: { state: "no" }, portalUrl: "", resourceId: "" },
      { key: "azure:rg/t/b", name: "b", type: "t", resourceGroup: "rg", kind: "highIdentity", sev: "high", exposure: { state: "no" }, high: { state: "yes" }, identity: { state: "yes" }, portalUrl: "", resourceId: "" },
    ], paths: [], undetermined: [], counts: { exposed: 0, high: 0, privileged: 0, combos: 2, undetermined: 0, paths: 0 }, gaps: [] } as never,
    states: {}, now: new Date("2026-01-02T00:00:00Z"),
  });
  const by = Object.fromEntries(q.items.map((i) => [i.title, i.pathType]));
  assert.deepEqual(by, { vnet: "exposure", exfil: "exfiltration", takeover: "privilege", standing: "privilege", local: "privilege", exposedHigh: "exposure", highIdentity: "privilege" });
});
