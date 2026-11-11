// AKS 클러스터 = 구성 · 리소스 (docs/architecture/kubernetes-ia.md): the cluster's Azure configuration (API
// services/aksClusterConfig.ts — ARM only, nothing guessed, nothing identifying sent) and the page's view model (web
// lib/aksConfigView.ts — object groups, filters, links to and from AKS 모니터링).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KubernetesObject } from "@aud/types";
import { clusterConfigOf, compareVersions, mockClusterConfig } from "../src/services/aksClusterConfig.js";
import { podOwnerName, serviceTargets } from "../src/services/kubernetes.js";
import * as viewNs from "../../web/src/lib/aksConfigView.ts";

const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const ID = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-a/providers/Microsoft.ContainerService/managedClusters/aks-a";
const NOW = Date.parse("2026-11-11T00:00:00Z");

test("config: ARM properties as they are — absent = null (never a guessed default), side reads that failed are gaps", () => {
  const c = clusterConfigOf(ID, {
    name: "aks-a", location: "koreacentral", sku: { tier: "Standard" },
    properties: {
      kubernetesVersion: "1.31.9", powerState: { code: "Running" }, provisioningState: "Succeeded",
      agentPoolProfiles: [
        { name: "user", mode: "User", vmSize: "Standard_D8s_v5", count: 4, enableAutoScaling: true, minCount: 2, maxCount: 10, osType: "Linux", osSKU: "Ubuntu", orchestratorVersion: "1.31.8", scaleSetPriority: "Spot" },
        { name: "sys", mode: "System", vmSize: "Standard_D4s_v5", count: 3, availabilityZones: ["1", "2"], orchestratorVersion: "1.31.9" },
      ],
      networkProfile: { networkPlugin: "azure", networkDataplane: "cilium" },
      apiServerAccessProfile: { enablePrivateCluster: false, authorizedIPRanges: ["203.0.113.0/24", "198.51.100.7/32"] },
      addonProfiles: { omsAgent: { enabled: true }, azurepolicy: { enabled: false } },
    },
  }, null, null, NOW);
  assert.equal(c.clusterId, ID.toLowerCase());
  assert.deepEqual(c.gaps, ["upgrades", "windows"]);
  assert.equal(c.version.upgrades, null, "not read ≠ no upgrades");
  assert.equal(c.windows, null);
  assert.deepEqual(c.pools.map((p) => p.name), ["sys", "user"], "system pools first");
  assert.deepEqual(c.pools[1]!.autoscale, { min: 2, max: 10 });
  assert.equal(c.pools[0]!.autoscale, null);
  assert.equal(c.pools[1]!.spot, true);
  assert.equal(c.network.policy, null, "no policy engine in the answer = null, the page says 'none'");
  assert.equal(c.network.authorizedIpRanges, 2, "the count — the ranges themselves are not sent");
  assert.ok(!JSON.stringify(c).includes("203.0.113"), "no IP range leaves");
  assert.equal(c.identity.entra, false, "no aadProfile = no Entra integration (a fact)");
  assert.equal(c.identity.localAccounts, null, "disableLocalAccounts absent = not said");
  const addon = (id: string) => c.addons.find((a) => a.id === id)!.on;
  assert.deepEqual([addon("monitoring"), addon("azurePolicy"), addon("defender")], [true, false, null], "omsAgent / omsagent alike; absent = null");
});

test("config: upgrades sorted numerically (1.31.10 after 1.31.9), windows with their next start; the sample is marked", () => {
  assert.ok(compareVersions("1.31.10", "1.31.9") > 0 && compareVersions("1.32.0", "1.31.10") > 0 && compareVersions("1.31", "1.31.0") === 0);
  const c = clusterConfigOf(ID, { properties: { kubernetesVersion: "1.31.9" } },
    { properties: { controlPlaneProfile: { upgrades: [{ kubernetesVersion: "1.32.1" }, { kubernetesVersion: "1.31.10" }, { kubernetesVersion: "1.33.0", isPreview: true }] } } },
    [{ name: "default", properties: { maintenanceWindow: { schedule: { daily: { intervalDays: 1 } }, durationHours: 4, utcOffset: "+00:00", startTime: "02:00" } } }], NOW);
  assert.deepEqual(c.version.upgrades, [{ version: "1.31.10", preview: false }, { version: "1.32.1", preview: false }, { version: "1.33.0", preview: true }]);
  assert.deepEqual(c.gaps, []);
  assert.equal(c.windows![0]!.next, "2026-11-11T02:00:00.000Z", "the next start after now");
  assert.ok(!("startDate" in c.windows![0]!));
  const mock = mockClusterConfig(ID, "sample");
  assert.equal(mock.source, "mock");
  assert.equal(mock.pools.length, 2);
});

test("view: where the version stands — patch of the same minor first, then a newer minor; preview never counts; unread = unknown", () => {
  const v = (upgrades: { version: string; preview: boolean }[] | null) => V.upgradeState({ current: "1.31.9", upgrades, upgradeChannel: null, nodeOsChannel: null, tier: null, supportPlan: null });
  assert.deepEqual(v(null), { state: "unknown", to: null });
  assert.deepEqual(v([]), { state: "upToDate", to: null });
  assert.deepEqual(v([{ version: "1.33.0", preview: true }]), { state: "upToDate", to: null });
  assert.deepEqual(v([{ version: "1.31.10", preview: false }, { version: "1.32.1", preview: false }]), { state: "patch", to: "1.31.10" });
  assert.deepEqual(v([{ version: "1.32.1", preview: false }]), { state: "minor", to: "1.32.1" });
  const pools = [{ name: "a", version: "1.31.9", count: 3, autoscale: null }, { name: "b", version: "1.31.8", count: 2, autoscale: { min: 1, max: 6 } }] as never;
  assert.deepEqual(V.poolsBehind({ version: { current: "1.31.9" } as never, pools }), ["b"]);
  assert.deepEqual(V.nodeTotals(pools), { nodes: 5, max: 9 }, "a fixed pool counts as its size in the ceiling");
});

const obj = (kind: KubernetesObject["kind"], name: string, namespace = "app"): KubernetesObject => ({ kind, name, namespace, status: "", createdAt: "" });
const OBJECTS = [obj("Deployment", "api"), obj("Pod", "api-7d9f-x"), obj("Service", "api"), obj("Ingress", "web"), obj("CronJob", "nightly", "ops"), obj("Node", "n1", "")];

test("view: objects by group, chips count within the other filters, text and namespace narrow", () => {
  assert.deepEqual(V.groupCounts(OBJECTS, V.NO_OBJECT_FILTER), [{ group: "workloads", n: 2 }, { group: "network", n: 2 }, { group: "batch", n: 1 }, { group: "cluster", n: 1 }]);
  assert.deepEqual(V.groupCounts(OBJECTS, { ...V.NO_OBJECT_FILTER, group: "network", query: "api" }).map((g) => `${g.group}:${g.n}`), ["workloads:2", "network:1"],
    "the chosen group does not hide the others' counts");
  assert.deepEqual(V.filterObjects(OBJECTS, { ...V.NO_OBJECT_FILTER, group: "network" }).map((o) => o.name), ["api", "web"]);
  assert.deepEqual(V.filterObjects(OBJECTS, { ...V.NO_OBJECT_FILTER, namespace: "ops" }).map((o) => o.name), ["nightly"]);
  assert.deepEqual(V.kindCounts(OBJECTS, V.NO_OBJECT_FILTER).map((k) => k.kind), ["Deployment", "Pod", "Service", "Ingress", "CronJob", "Node"]);
  for (const kinds of Object.values(V.KIND_GROUPS)) for (const k of kinds) assert.ok(V.groupOfKind(k), k);
});

test("view: links between the two screens carry names only — a workload opens its signals, the panel opens its objects", () => {
  assert.equal(V.monitoringHref(obj("Deployment", "api")), "/observability?wl=app%2Fapi");
  assert.equal(V.monitoringHref(obj("Service", "api")), null, "only what AKS 모니터링 draws as a workload");
  assert.equal(V.parseWorkloadParam("?wl=app%2Fapi"), "app/api");
  for (const bad of ["?wl=app", "?wl=<script>/x", "?wl=App/api", "", "?wl=a/b/c"]) assert.equal(V.parseWorkloadParam(bad), null, bad);
  assert.equal(V.configHref("app", "api"), "/kubernetes?ns=app&q=api");
  assert.deepEqual(V.parseObjectParams("?ns=app&q=api"), { namespace: "app", query: "api" });
  assert.deepEqual(V.parseObjectParams("?ns=%3Cb%3E&q=A%20B"), { namespace: "", query: "" });
});

test("services: the pods a selector picks in its own namespace and the workloads that own them", () => {
  assert.equal(podOwnerName("api-7d9f8c6b5-abcde", [{ kind: "ReplicaSet", name: "api-7d9f8c6b5" }]), "api");
  assert.equal(podOwnerName("db-0", [{ kind: "StatefulSet", name: "db" }]), "db");
  assert.equal(podOwnerName("lonely", undefined), "lonely");
  const pods = [
    { namespace: "app", labels: { app: "api", tier: "web" }, owner: "api" },
    { namespace: "app", labels: { app: "api", tier: "web" }, owner: "api" },
    { namespace: "app", labels: { app: "api" }, owner: "api-canary" },
    { namespace: "other", labels: { app: "api", tier: "web" }, owner: "api" },
  ];
  assert.deepEqual(serviceTargets({ app: "api" }, "app", pods), { pods: 3, workloads: ["api", "api-canary"] });
  assert.deepEqual(serviceTargets({ app: "api", tier: "web" }, "app", pods), { pods: 2, workloads: ["api"] }, "every label must match");
  assert.deepEqual(serviceTargets({ app: "none" }, "app", pods), { pods: 0, workloads: [] });
});

test("wiring: the route answers ARM only for a cluster ID, the page has both sections and no pod-state card, every runtime key is translated", () => {
  const routes = readFileSync(new URL("../src/routes/kubernetes.ts", import.meta.url), "utf8");
  assert.match(routes, /router\.get\("\/api\/kubernetes\/cluster-config"/);
  assert.match(routes, /managedclusters\\\/\[\^\/\]\+\$\/i\.test\(clusterId\)/, "only an AKS cluster's ID is read");
  const page = readFileSync(new URL("../../web/src/app/kubernetes/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<ClusterConfig c=\{config\}/);
  assert.doesNotMatch(page, /podRunning|podFailed|podPending/, "pod state is AKS 모니터링's (one source)");
  assert.match(page, /configQuery\.data\?\.clusterId === selectedClusterId\.toLowerCase\(\)/, "never another cluster's configuration");
  const msgs = readFileSync(new URL("../../web/src/lib/i18nMessages.ts", import.meta.url), "utf8");
  const has = (k: string) => new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`).test(msgs);
  const addons = clusterConfigOf(ID, {}, null, null, NOW).addons.map((a) => a.id);
  for (const k of [
    ...addons.map((a) => `k8s.cfg.addon.${a}`), ...Object.keys(V.KIND_GROUPS).map((g) => `k8s.group.${g}`),
    ...["upToDate", "patch", "minor", "unknown"].flatMap((s) => [`k8s.cfg.up.${s}`, `k8s.cfg.upHint.${s}`]), "k8s.cfg.gap.upgrades", "k8s.cfg.gap.windows",
  ]) assert.ok(has(k), k);
  assert.match(msgs, /"nav\.desc\.aksClusters": \{ ko: "구성 · 리소스/);
  assert.match(msgs, /"nav\.desc\.aksMonitoring": \{ ko: "상태 · 신호/);
});
