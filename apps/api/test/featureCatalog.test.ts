import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionFeature, FeatureStatus, PermissionCell, PermissionKey } from "@aud/types";
import { FEATURES, PERMISSIONS, PLAN_TIERS, cellFrom, rollupFeature } from "../src/services/featureCatalog.js";
import { FEATURE_ACTIONS, permissionCells, pickSamples, SAMPLE_TOTAL } from "../src/services/connectionCheck.js";
import { rollupClusterRules } from "../src/services/clusterAccessCheck.js";
import { GENERATED_MANIFESTS } from "../src/services/k8sReadSurface.js";
import * as navNs from "../../web/src/lib/navConfig.ts";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";
import * as webCatNs from "../../web/src/lib/featureCatalog.ts";

const nav = ((navNs as unknown as { default?: typeof navNs }).default ?? navNs) as typeof navNs;
const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;
const webCat = ((webCatNs as unknown as { default?: typeof webCatNs }).default ?? webCatNs) as typeof webCatNs;
const DOC = readFileSync(join(import.meta.dirname, "../../../docs/integrations/azure/permissions.md"), "utf8");

test("the subscription check's operations come from the catalog — unchanged", () => {
  assert.deepEqual(FEATURE_ACTIONS, {
    inventory: { action: "Microsoft.Resources/subscriptions/resourceGroups/read" },
    metrics: { action: "Microsoft.Insights/metrics/read" },
    logs: { action: "Microsoft.OperationalInsights/workspaces/query/AzureDiagnostics/read", scopedBelow: true },
    security: { action: "Microsoft.Security/assessments/read" },
    cost: { action: "Microsoft.CostManagement/query/read" },
    aksCredential: { action: "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action", scopedBelow: true },
    flowLogBlobs: { action: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read", data: true, scopedBelow: true },
    prometheus: { action: "Microsoft.Monitor/accounts/data/metrics/read", data: true, scopedBelow: true },
  });
});

test("catalog ↔ permissions.md: every Azure role and its built-in id is in the doc, every check key of the doc is in the catalog", () => {
  for (const p of PERMISSIONS.filter((x) => x.plane === "azure")) {
    assert.ok(p.roleDefinitionId && DOC.includes(p.roleDefinitionId), `${p.key}: role id in the doc`);
    const short = p.role.replace("Azure Kubernetes Service ", "AKS ");
    assert.ok(DOC.includes(p.role) || DOC.includes(short), `${p.key}: ${p.role} in the doc`);
  }
  const docKeys = [...DOC.matchAll(/\| `([a-zA-Z]+)` \|$/gm)].map((m) => m[1]!);
  assert.ok(docKeys.length >= 8);
  for (const k of docKeys) assert.ok(PERMISSIONS.some((p) => p.key === k), `doc key ${k}`);
  for (const p of PERMISSIONS.filter((x) => x.plane === "kubernetes")) {
    assert.equal(p.scope.kind, "kubernetes");
    assert.ok(p.scope.kind === "kubernetes" && GENERATED_MANIFESTS[p.scope.manifest], `${p.key}: a generated manifest`);
  }
});

test("catalog ↔ menu: every feature screen is a menu entry, every menu entry (but home and this page) has a feature", () => {
  const hrefs = nav.NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
  for (const f of FEATURES) for (const r of f.routes) assert.ok(hrefs.includes(r), `${f.id}: ${r}`);
  const covered = new Set(FEATURES.flatMap((f) => f.routes));
  for (const h of hrefs) if (h !== "/" && h !== "/settings/features") assert.ok(covered.has(h), `${h} belongs to a feature`);
});

test("catalog shape: tiers chain from core, each has features, every permission used is defined, ids unique", () => {
  assert.deepEqual(PLAN_TIERS.map((t) => [t.id, t.includes]), [["core", null], ["pro", "core"], ["enterprise", "pro"]]);
  for (const t of PLAN_TIERS) assert.ok(FEATURES.some((f) => f.tier === t.id), t.id);
  const keys = new Set(PERMISSIONS.map((p) => p.key));
  assert.equal(keys.size, PERMISSIONS.length);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const f of FEATURES) for (const k of [...f.requires, ...f.optional]) assert.ok(keys.has(k), `${f.id}: ${k}`);
  // the AKS security check, end to end: the cluster credential + the reader role, Hubble and Resource Graph optional
  const aks = FEATURES.find((f) => f.id === "aksSecurityCheck")!;
  assert.deepEqual([aks.requires, aks.optional, aks.preconditions], [["aksCredential", "k8sRead"], ["inventory", "hubbleExec", "security", "logs"], ["entraCluster", "clusterReachable"]]);
});

test("every catalog text is translated (ko / en)", () => {
  const need = [
    ...PLAN_TIERS.flatMap((t) => [`tier.${t.id}.name`, `tier.${t.id}.tagline`]),
    ...FEATURES.flatMap((f) => [`feat.${f.id}.name`, `feat.${f.id}.desc`, ...f.optional.map((k) => `feat.${f.id}.without.${k}`)]),
    ...PERMISSIONS.map((p) => `perm.${p.key}.why`),
    ...PERMISSIONS.filter((p) => p.gate).map((p) => `feat.gate.${p.gate}`),
    ...["ok", "missing", "partial", "unknown", "notApplicable", "optInOff", "inherited", "clusterNotChecked"].map((s) => `conn.ps.${s}`),
    ...["ready", "partial", "blocked", "unknown"].map((s) => `conn.ready.${s}`),
    ...["entra", "localAccount", "localAccountRefused", "unreachable", "credentialForbidden", "failed"].map((s) => `conn.cluster.access.${s}`),
    ...["k8s_secrets_read", "k8s_exec", "k8s_wildcard"].map((s) => `conn.warn.${s}`),
  ];
  for (const k of need) assert.ok(msg.T[k]?.ko && msg.T[k]?.en, k);
});

test("grant commands: placeholders only — no GUID, never anything but a role assignment or the generated manifest", () => {
  for (const p of PERMISSIONS) {
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.grant), p.key);
    assert.match(p.grant, p.plane === "azure" ? /^az role assignment create --assignee <CONNECTION_IDENTITY_OBJECT_ID> --role "[^"]+" --scope \S*<[A-Z_]+>$/ : /^kubectl apply -f docs\/integrations\/azure\/templates\/aks\/aud-dashboard-[a-z-]+\.yaml$/);
  }
});

const cell = (status: PermissionCell["status"]): PermissionCell => ({ status, at: "subscription" });
const all = (status: PermissionCell["status"]) => Object.fromEntries(PERMISSIONS.map((p) => [p.key, cell(status)])) as Record<PermissionKey, PermissionCell>;

test("feature readiness: a required one missing blocks, partial limits, unknown asks; opt-in off / no resource do not degrade optionals", () => {
  const aks = FEATURES.find((f) => f.id === "aksSecurityCheck")!;
  assert.equal(rollupFeature(aks, all("ok")).readiness, "ready");
  assert.equal(rollupFeature(aks, { ...all("ok"), aksCredential: cell("missing") }).readiness, "blocked");
  assert.equal(rollupFeature(aks, { ...all("ok"), aksCredential: cell("partial") }).readiness, "partial");
  assert.equal(rollupFeature(aks, { ...all("ok"), k8sRead: cell("unknown") }).readiness, "unknown");
  assert.equal(rollupFeature(aks, { ...all("ok"), hubbleExec: cell("optInOff") }).readiness, "ready", "Hubble off is a choice");
  assert.equal(rollupFeature(aks, { ...all("ok"), inventory: cell("missing") }).readiness, "partial");
  const pod = FEATURES.find((f) => f.id === "podTraffic")!;
  assert.equal(rollupFeature(pod, { ...all("ok"), hubbleExec: cell("optInOff") }).readiness, "blocked", "required and off: not available");
  // the web re-rolls after a cluster check with the same rule
  const statuses: PermissionCell["status"][] = ["ok", "missing", "partial", "unknown", "notApplicable", "optInOff"];
  for (const f of FEATURES) for (const [i, st] of statuses.entries()) {
    const cells = Object.fromEntries(PERMISSIONS.map((p, j) => [p.key, cell(statuses[(i + j) % statuses.length]!)])) as Record<PermissionKey, PermissionCell>;
    cells.inventory = cell(st);
    assert.deepEqual(webCat.rollupFeature(f, cells), rollupFeature(f, cells), `${f.id}/${st}`);
  }
});

const SUB_A = "00000000-0000-0000-0000-00000000000a";
const SUB_B = "00000000-0000-0000-0000-00000000000b";
const feats = (over: Partial<Record<ConnectionFeature, FeatureStatus>> = {}) =>
  ({ inventory: "ok", metrics: "ok", logs: "unknown", security: "ok", cost: "missing", aksCredential: "unknown", flowLogBlobs: "unknown", prometheus: "unknown", ...over }) as Record<ConnectionFeature, FeatureStatus>;
const rid = (sub: string, type: string, name: string) => `/subscriptions/${sub}/resourcegroups/rg/providers/${type}/${name}`;

test("connection cells: subscription counts, inherited from the subscription, sampled partial, no resource, query failed, switches", () => {
  const c1 = rid(SUB_A, "microsoft.containerservice/managedclusters", "c1");
  const c2 = rid(SUB_B, "microsoft.containerservice/managedclusters", "c2");
  const c3 = rid(SUB_B, "microsoft.containerservice/managedclusters", "c3");
  const w1 = rid(SUB_A, "microsoft.operationalinsights/workspaces", "w1");
  const cells = permissionCells({
    subs: [{ id: SUB_A, reachable: true, features: feats({ aksCredential: "ok", logs: "ok" }) }, { id: SUB_B, reachable: true, features: feats({ security: "missing" }) }],
    resources: { aksCredential: [c1, c2, c3], logs: [w1], prometheus: [], flowLogBlobs: [rid(SUB_B, "microsoft.storage/storageaccounts", "s1")] },
    probes: new Map<string, boolean | null>([[c2, true], [c3, false], [rid(SUB_B, "microsoft.storage/storageaccounts", "s1"), null]]),
    gates: { hubbleExec: false, podLogs: true },
  });
  assert.deepEqual([cells.inventory.status, cells.security.status, cells.cost.status], ["ok", "partial", "missing"]);
  assert.deepEqual(cells.security.sampled, { ok: 1, checked: 2, total: 2 });
  assert.deepEqual([cells.aksCredential.status, cells.aksCredential.sampled], ["partial", { ok: 2, checked: 3, total: 3 }], "c1 from its subscription, c2 yes, c3 no");
  assert.deepEqual([cells.logs.status, cells.logs.reason], ["ok", "inherited"]);
  assert.deepEqual([cells.prometheus.status, cells.prometheus.reason], ["notApplicable", "noResource"]);
  assert.deepEqual([cells.flowLogBlobs.status, cells.flowLogBlobs.reason], ["unknown", "readFailed"], "a failed GET is not 'missing'");
  assert.deepEqual([cells.k8sRead.status, cells.k8sRead.reason], ["unknown", "clusterNotChecked"]);
  assert.equal(cells.hubbleExec.status, "optInOff");
  assert.equal(cells.k8sPodLogs.status, "unknown");
  const failed = permissionCells({ subs: [{ id: SUB_A, reachable: true, features: feats() }], resources: null, probes: new Map(), gates: { hubbleExec: true, podLogs: true } });
  assert.equal(failed.aksCredential.status, "unknown");
  assert.equal(cellFrom("resource", 1, 2, 9).reason, "sampleLimit");
});

test("samples: only resources their subscription does not cover, five clusters / three others, twenty in all, in id order", () => {
  const many = (type: string, n: number) => Array.from({ length: n }, (_, i) => rid(SUB_B, type, `r${String(i).padStart(2, "0")}`));
  const picked = pickSamples({
    aksCredential: [...many("microsoft.containerservice/managedclusters", 9), rid(SUB_A, "microsoft.containerservice/managedclusters", "inherited")],
    logs: many("microsoft.operationalinsights/workspaces", 9),
    prometheus: many("microsoft.monitor/accounts", 9),
    flowLogBlobs: many("microsoft.storage/storageaccounts", 9),
  }, (_k, id) => id.includes(SUB_A));
  assert.equal(picked.filter((x) => x.key === "aksCredential").length, 5);
  assert.ok(!picked.some((x) => x.id.includes(SUB_A)));
  assert.ok(picked.length <= SAMPLE_TOTAL);
  assert.equal(picked.find((x) => x.key === "aksCredential")!.id.endsWith("r00"), true);
});

test("cluster check rollup: read surface allowed n/m, missing rules named, opt-ins off, over-privilege warned", () => {
  const r = rollupClusterRules({
    read: [{ rule: "pods list", allowed: true }, { rule: "nodes list", allowed: false }, { rule: "jobs list", allowed: null }],
    podLogs: null,
    hubble: [{ rule: "pods/exec create (kube-system)", allowed: true }],
    over: { secrets: true, exec: true, wildcard: false },
    hubbleOn: true,
  });
  assert.deepEqual(r.permissions.k8sRead, { status: "partial", at: "cluster", sampled: { ok: 1, checked: 2, total: 3 }, reason: "sampleLimit" });
  assert.deepEqual(r.missingRules, ["nodes list"]);
  assert.equal(r.permissions.k8sPodLogs?.status, "optInOff");
  assert.equal(r.permissions.hubbleExec?.status, "ok");
  assert.deepEqual(r.warnings, ["k8s_secrets_read"], "exec is expected while Hubble exec is on");
  const off = rollupClusterRules({ read: [{ rule: "pods list", allowed: true }], podLogs: null, hubble: null, over: { secrets: false, exec: true, wildcard: true }, hubbleOn: false });
  assert.deepEqual(off.warnings, ["k8s_exec", "k8s_wildcard"]);
  assert.equal(off.permissions.k8sRead?.status, "ok");
});
