import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkloadIdentityResponse, WiIdentity } from "@aud/types";
import * as wl from "../../web/src/app/policies/insights/wiLayout.ts";

const L = ((wl as { default?: typeof wl }).default ?? wl) as typeof wl;

const idn = (id: string, name: string, ficIds: string[], roles: string[], kind: WiIdentity["kind"] = "userAssigned"): WiIdentity => ({
  id, kind, name, clientIdTail: "…abcd", fic: { status: "ok", count: ficIds.length, limit: 20, ids: ficIds, otherIssuers: 0, regionUnsupported: false },
  roles: roles.map((r) => ({ id: r, roleName: r, builtIn: true, privileged: null, wildcardActions: false, conditional: false, scope: { level: "resourceGroup", label: "rg" } })),
  rolesStatus: "ok", scanned: "annotated",
});
const sa = (ns: string, name: string, identityId: string | null, ficIds: string[], managed = false) =>
  ({ id: `sa:${ns}/${name}`, namespace: ns, name, exists: true, managed, tenantMatch: null, identityId, ficIds, k8sRbac: [], canUseIdentity: [] });
const wk = (ns: string, name: string, saName: string) =>
  ({ id: `w:${ns}/Deployment/${name}`, namespace: ns, name, kind: "Deployment", pods: 1, managed: false, saId: `sa:${ns}/${saName}`, useLabel: true, injected: "yes" as const });
const fic = (id: string, identityId: string, saId: string | null) =>
  ({ id, identityId, name: id, issuerMasked: "", issuerMatch: "exact" as const, subject: "", subjectMatch: "exact" as const, audiences: [], audienceOk: true, identityBindingAudience: false, saId, dangling: saId ? false : true });

const R: WorkloadIdentityResponse = {
  clusterId: "c", generatedAt: "", cluster: { oidcIssuerEnabled: true, workloadIdentityEnabled: true, issuerMasked: null },
  workloads: [wk("app", "api", "api-sa"), wk("app", "worker", "worker-sa"), wk("ops", "job", "ops-sa")],
  serviceAccounts: [sa("app", "api-sa", "mi:a", ["fic:1"]), sa("app", "worker-sa", "mi:a", ["fic:2"]), sa("ops", "ops-sa", "mi:b", []), sa("kube-system", "addon", "mi:b", [], true)],
  fics: [fic("fic:1", "mi:a", "sa:app/api-sa"), fic("fic:2", "mi:a", "sa:app/worker-sa"), fic("fic:3", "mi:a", null)],
  identities: [idn("mi:a", "id-app", ["fic:1", "fic:2", "fic:3"], ["ra:1", "ra:2"]), idn("mi:b", "id-ops", [], ["ra:3"])],
  findings: [{ id: "x", rule: "WI-11", sev: "crit", ev: "perm", title: "", detail: "", remediation: "", docUrl: "", docQuote: "", refs: ["mi:b", "ra:3"] }],
  coverage: { serviceAccounts: "ok", identitiesResolved: 2, identitiesUnresolved: 0, ficListed: 2, ficFailed: 0, roleAssignments: "ok", pimEligibleIncluded: false, identityBindings: "notCollected", subscriptionScan: { requested: false, scanned: 0, total: null, cap: 50 } },
  gaps: [],
};

test("groups: worst first, one band per identity; system SAs only when asked", () => {
  const g = L.wiGraph(R, { showSystem: false });
  assert.deepEqual(g.groups.map((x) => x.id), ["mi:b", "mi:a"], "the crit group leads");
  assert.ok(!g.nodes.some((n) => n.id === "sa:kube-system/addon"));
  assert.ok(L.wiGraph(R, { showSystem: true }).nodes.some((n) => n.id === "sa:kube-system/addon"));
  assert.ok(g.edges.some((e) => e.kind === "annotatedOnly" && e.from === "sa:ops/ops-sa"), "annotated but no credential → dashed SA → identity");
});

test("layout: fixed columns, no overlapping cards, bands don't overlap, no crossings, deterministic, fits the width", () => {
  const g = L.wiGraph(R, { showSystem: false });
  const l = L.layoutWi(g, { width: 1000 });
  assert.ok(l.width <= 1000);
  const boxes = [...l.nodes.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), "cards overlap");
  }
  for (let i = 1; i < l.groups.length; i++) assert.ok(l.groups[i]!.y0 >= l.groups[i - 1]!.y1);
  assert.equal(L.countCrossings(l, g), 0);
  assert.deepEqual([...L.layoutWi(g, { width: 1000 }).nodes.entries()], [...l.nodes.entries()]);
  // workloads sit level with their SA order
  assert.ok(l.nodes.get("w:app/Deployment/api")!.y < l.nodes.get("w:app/Deployment/worker")!.y);
});

test("chain: an identity lights its whole band; a role only what leads to it", () => {
  const g = L.wiGraph(R, { showSystem: false });
  const a = L.chainOf(g, "mi:a");
  for (const id of ["w:app/Deployment/api", "sa:app/worker-sa", "fic:3", "ra:1"]) assert.ok(a.has(id), id);
  const r = L.chainOf(g, "ra:1");
  assert.ok(r.has("sa:app/api-sa") && !r.has("ra:2"));
});

test("FIC gauge: 15 ok · 16 warn · 20 crit · unknown", () => {
  assert.equal(L.ficGauge(15).tone, "ok");
  assert.equal(L.ficGauge(16).tone, "warn");
  assert.deepEqual(L.ficGauge(20), { ratio: 1, tone: "crit", text: "20/20" });
  assert.deepEqual(L.ficGauge(null), { ratio: 0, tone: "unk", text: "?/20" });
});
