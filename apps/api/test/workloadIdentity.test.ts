import { test } from "node:test";
import assert from "node:assert/strict";
import type { PolicyInventory, InvWorkload } from "../src/services/policyAnalyzer.js";
import {
  WI_RULE_DOCS, buildWorkloadIdentityMap, classifyScope, compareExact, parseFicSubject, saRbac,
  type InvIdentity, type InvRoleAssignment, type WiInput,
} from "../src/services/workloadIdentity.js";
import { roleAssignmentsQuery, uamiByClientIdQuery } from "../src/services/workloadIdentityCollector.js";
import { wiTraces } from "../src/services/k8sPolicyCollector.js";

// Synthetic GUIDs (not tenant data)
const SUB = "11111111-1111-1111-1111-111111111111";
const TENANT = "22222222-2222-2222-2222-222222222222";
const CLIENT_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const CLIENT_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const CLIENT_X = "cccccccc-0000-0000-0000-00000000000c";
const PRINC_A = "dddddddd-0000-0000-0000-00000000000d";
const ISSUER = `https://koreacentral.oic.prod-aks.azure.com/${TENANT}/33333333-3333-3333-3333-333333333333/`;
const CLUSTER = `/subscriptions/${SUB}/resourcegroups/rg-aks/providers/microsoft.containerservice/managedclusters/aks1`;
const UAMI_A = `/subscriptions/${SUB}/resourcegroups/rg-id/providers/microsoft.managedidentity/userassignedidentities/id-app`;
const UAMI_B = `/subscriptions/${SUB}/resourcegroups/rg-id/providers/microsoft.managedidentity/userassignedidentities/id-other`;

function wl(ns: string, name: string, sa: string, useLabel: boolean): InvWorkload {
  return {
    kind: "Deployment", namespace: ns, name, replicas: 1, podLabels: { app: name, ...(useLabel ? { "azure.workload.identity/use": "true" } : {}) }, serviceAccountName: sa,
    containers: [], labels: {}, security: { hostNetwork: false, hostPID: false, hostIPC: false, hostPaths: [], usesSecrets: false, containers: [] },
  } as unknown as InvWorkload;
}

function inv(): PolicyInventory {
  return {
    namespaces: [], workloads: [wl("app", "api", "api-sa", true), wl("app", "worker", "worker-sa", false), wl("ops", "job", "ops-sa", true)],
    pods: [
      { namespace: "app", name: "api-7f9c6d5b8-x", labels: {}, phase: "Running", serviceAccountName: "api-sa", wi: { tokenFile: true, clientId: CLIENT_A, tenantId: TENANT } },
      { namespace: "app", name: "worker-5d4c3-y", labels: {}, phase: "Running", serviceAccountName: "worker-sa" },
      { namespace: "ops", name: "job-1-z", labels: {}, phase: "Running", serviceAccountName: "ops-sa", wi: { tokenFile: true, clientId: CLIENT_X } },
    ],
    roles: [
      { kind: "ClusterRole", name: "cluster-admin", labels: {}, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], aggregated: false },
      { kind: "Role", namespace: "app", name: "exec", labels: {}, rules: [{ apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] }], aggregated: false },
    ],
    bindings: [
      { kind: "ClusterRoleBinding", name: "worker-admin", labels: {}, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "ServiceAccount", name: "worker-sa", namespace: "app" }] },
      { kind: "RoleBinding", namespace: "app", name: "devs-exec", labels: {}, roleRef: { kind: "Role", name: "exec" }, subjects: [{ kind: "Group", name: "devs" }] },
    ],
    networkPolicies: [], ciliumPolicies: [], hpas: [], vpas: [], pdbs: [], resourceQuotas: [], limitRanges: [], services: [], routes: [], nodes: [],
    capabilities: { vpaInstalled: false, ciliumInstalled: true, unavailable: [] },
  } as unknown as PolicyInventory;
}

const ident = (armId: string, name: string, clientId: string, principalId: string, location = "koreacentral"): InvIdentity =>
  ({ armId, name, resourceGroup: "rg-id", subscriptionId: SUB, location, clientId, principalId, tenantId: TENANT, scanned: "annotated" });
const fic = (name: string, subject: string, issuer = ISSUER, audiences = ["api://AzureADTokenExchange"]) => ({ name, issuer, subject, audiences });

function input(over: Partial<WiInput> = {}): WiInput {
  return {
    clusterId: CLUSTER, inventory: inv(),
    serviceAccounts: [
      { namespace: "app", name: "api-sa", annotations: { "azure.workload.identity/client-id": CLIENT_A, "azure.workload.identity/tenant-id": TENANT }, labels: {} },
      { namespace: "app", name: "worker-sa", annotations: { "azure.workload.identity/client-id": CLIENT_B }, labels: {} },
      { namespace: "ops", name: "ops-sa", annotations: { "azure.workload.identity/client-id": CLIENT_X }, labels: {} },
    ],
    saStatus: "ok",
    cluster: { issuerUrl: ISSUER, oidcEnabled: true, wiEnabled: true },
    identities: [ident(UAMI_A, "id-app", CLIENT_A, PRINC_A), ident(UAMI_B, "id-other", CLIENT_B, "eeeeeeee-0000-0000-0000-00000000000e")],
    identityLookup: "ok",
    fics: new Map([
      [UAMI_A.toLowerCase(), { status: "ok" as const, items: [
        fic("api", "system:serviceaccount:app:api-sa"),
        fic("gone", "system:serviceaccount:old:removed-sa"),
        fic("gh", "repo:org/app:ref:refs/heads/main", "https://token.actions.githubusercontent.com"),
      ] }],
      [UAMI_B.toLowerCase(), { status: "ok" as const, items: [fic("worker", "system:serviceaccount:app:Worker-sa")] }],
    ]),
    roleAssignments: [
      { principalId: PRINC_A, roleDefGuid: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", roleName: "Owner", roleType: "BuiltInRole", scope: `/subscriptions/${SUB}`, hasCondition: false, actions: ["*"] },
      { principalId: PRINC_A, roleDefGuid: "99999999-0000-0000-0000-000000000009", roleName: "Owner", roleType: "CustomRole", scope: `/subscriptions/${SUB}/resourceGroups/rg-app`, hasCondition: false, actions: ["*"] },
    ] satisfies InvRoleAssignment[],
    subNames: new Map([[SUB, "sub-demo"]]),
    scan: { requested: false, scanned: 0, total: null, cap: 50 },
    gaps: [], now: new Date("2026-10-23T00:00:00Z"),
    ...over,
  };
}
const rules = (r: ReturnType<typeof buildWorkloadIdentityMap>) => r.findings.map((f) => f.rule);

test("exact matching only: whitespace, trailing slash and case are near misses", () => {
  assert.equal(compareExact(ISSUER, ISSUER), "exact");
  assert.equal(compareExact(ISSUER, ` ${ISSUER}`), "whitespace");
  assert.equal(compareExact(ISSUER, ISSUER.slice(0, -1)), "trailingSlash");
  assert.equal(compareExact(ISSUER, ISSUER.toUpperCase()), "case");
  assert.equal(compareExact(ISSUER, "https://other"), "other");
  assert.deepEqual(parseFicSubject("system:serviceaccount:app:api-sa"), { namespace: "app", name: "api-sa" });
  assert.equal(parseFicSubject("System:serviceaccount:app:api-sa"), null);
  assert.equal(parseFicSubject("system:serviceaccount:app"), null);
  assert.equal(parseFicSubject(""), null);
});

test("the chain: workload → SA → FIC → identity → roles; dangling, near-miss, unresolved and roles become findings", () => {
  const r = buildWorkloadIdentityMap(input());
  const api = r.serviceAccounts.find((s) => s.name === "api-sa")!;
  const idA = r.identities.find((i) => i.name === "id-app")!;
  assert.equal(api.identityId, idA.id);
  assert.equal(api.ficIds.length, 1);
  assert.equal(idA.fic.count, 3);
  assert.equal(idA.fic.otherIssuers, 1, "the GitHub credential is counted, not drawn");
  assert.equal(r.fics.filter((f) => f.identityId === idA.id).length, 2);
  const got = rules(r);
  assert.ok(got.includes("WI-05"), "credential for old/removed-sa trusts this cluster but the SA is gone");
  assert.ok(got.includes("WI-04"), "Worker-sa differs only in case");
  assert.ok(!r.findings.some((f) => f.rule === "WI-03" && f.refs.includes("sa:app/worker-sa")), "near miss reports WI-04, not WI-03");
  assert.ok(got.includes("WI-07"), "worker lacks the use label");
  assert.ok(got.includes("WI-13"), "worker-sa is cluster-admin and has an Azure identity");
  assert.ok(got.includes("WI-14"), "group devs can exec in app");
  // Owner at subscription → crit; the custom role named "Owner" is not privileged (decided by ID), but its * is WI-12
  const owner = r.findings.filter((f) => f.rule === "WI-11");
  assert.deepEqual(owner.map((f) => f.sev), ["crit"]);
  assert.ok(got.includes("WI-12"));
  // CLIENT_X is not a managed identity we can see → unresolved, grey, no FIC findings
  const unresolved = r.identities.find((i) => i.kind === "unresolved")!;
  assert.equal(unresolved.clientIdTail, "…000c");
  assert.equal(r.findings.some((f) => f.refs.includes(unresolved.id) && f.sev === "crit"), false);
  assert.equal(r.findings[0]!.sev, "crit", "worst first");
  for (const f of r.findings) assert.match(f.docUrl, /^https:\/\/(learn\.microsoft\.com|kubernetes\.io)\//);
});

test("unknown stays unknown: no SA list → no dangling verdict; no ARM → no cluster verdict", () => {
  const r = buildWorkloadIdentityMap(input({ serviceAccounts: null, saStatus: "forbidden", cluster: { issuerUrl: ISSUER, oidcEnabled: null, wiEnabled: null } }));
  assert.ok(!rules(r).includes("WI-05"));
  assert.ok(r.fics.some((f) => f.dangling === null));
  assert.ok(!rules(r).includes("WI-08"));
  // still linked through the pods' injected client ID
  assert.equal(r.serviceAccounts.find((s) => s.name === "api-sa")!.clientIdSource, "podEnv");
  assert.equal(r.coverage.serviceAccounts, "forbidden");
});

test("WI-03 missing credential, WI-01/02 limits, WI-06 audience, WI-08 cluster off, WI-09 tenant", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => fic(`f${i}`, `system:serviceaccount:x:sa${i}`, "https://elsewhere"));
  const r = buildWorkloadIdentityMap(input({
    fics: new Map([
      [UAMI_A.toLowerCase(), { status: "ok", items: twenty }],
      [UAMI_B.toLowerCase(), { status: "ok", items: [fic("worker", "system:serviceaccount:app:worker-sa", ISSUER, ["api://AKSIdentityBinding"])] }],
    ]),
    cluster: { issuerUrl: ISSUER, oidcEnabled: false, wiEnabled: true },
    serviceAccounts: [
      { namespace: "app", name: "api-sa", annotations: { "azure.workload.identity/client-id": CLIENT_A, "azure.workload.identity/tenant-id": "44444444-4444-4444-4444-444444444444" }, labels: {} },
      { namespace: "app", name: "worker-sa", annotations: { "azure.workload.identity/client-id": CLIENT_B }, labels: {} },
    ],
  }));
  const got = rules(r);
  for (const id of ["WI-01", "WI-03", "WI-06", "WI-08", "WI-09"]) assert.ok(got.includes(id as never), id);
  assert.equal(r.findings.find((f) => f.rule === "WI-06")!.sev, "info", "identity binding audience is informational");
  const near = buildWorkloadIdentityMap(input({ fics: new Map([[UAMI_A.toLowerCase(), { status: "ok", items: twenty.slice(0, 17).concat([fic("api", "system:serviceaccount:app:api-sa")]) }]]) }));
  assert.ok(rules(near).includes("WI-02"));
});

test("group subjects count as the SA's RBAC", () => {
  const i = inv();
  i.bindings.push({ kind: "ClusterRoleBinding", name: "all-sa", labels: {}, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "Group", name: "system:serviceaccounts:app" }] } as never);
  const b = saRbac(i, "app", "api-sa");
  assert.deepEqual(b.map((x) => [x.name, x.via, x.group]), [["all-sa", "group", "system:serviceaccounts:app"]]);
});

test("scopes are display labels; no subscription ID, principal ID, ARM ID or full GUID leaves the builder", () => {
  const subs = new Map([[SUB, "sub-demo"]]);
  assert.deepEqual(classifyScope("/", subs), { level: "root", label: "/" });
  assert.equal(classifyScope(`/subscriptions/${SUB}`, subs).label, "sub-demo");
  assert.equal(classifyScope(`/subscriptions/${SUB}/resourceGroups/rg-app`, subs).level, "resourceGroup");
  assert.equal(classifyScope("/providers/Microsoft.Management/managementGroups/55555555-5555-5555-5555-555555555555", subs).label, "…5555");
  // clusterId is the request key the page matches (like every cluster response) — everything else is checked
  const json = JSON.stringify({ ...buildWorkloadIdentityMap(input()), clusterId: "" });
  assert.ok(!json.includes("/subscriptions/"));
  assert.ok(!json.includes(PRINC_A));
  assert.doesNotMatch(json, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("English response has no Korean; every rule has a doc and quote", async () => {
  const { withLang } = await import("../src/infra/lang.js");
  const en = JSON.stringify(withLang("en", () => buildWorkloadIdentityMap(input())));
  assert.doesNotMatch(en, /[가-힯]/);
  for (const [id, d] of Object.entries(WI_RULE_DOCS)) assert.ok(d.url.startsWith("https://") && d.quote.length > 20, id);
});

test("queries keep GUIDs only, capped, quoted; webhook traces keep only names and GUIDs", () => {
  const q = uamiByClientIdQuery([CLIENT_A, "x\" or 1==1", CLIENT_A.toUpperCase()]);
  assert.match(q, /in~ \("aaaaaaaa-0000-0000-0000-00000000000a"\)/);
  assert.doesNotMatch(q, /1==1/);
  assert.equal((uamiByClientIdQuery(Array.from({ length: 300 }, (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`)).match(/"aaaaaaaa/g) ?? []).length, 200);
  assert.match(roleAssignmentsQuery([PRINC_A]), /authorizationresources/);
  const t = wiTraces([{ env: [{ name: "AZURE_FEDERATED_TOKEN_FILE", value: "/var/run/secrets/token" }, { name: "AZURE_CLIENT_ID", value: CLIENT_A }, { name: "DB_PASSWORD", value: "hunter2" }] }]);
  assert.deepEqual(t, { wi: { tokenFile: true, clientId: CLIENT_A } });
  assert.deepEqual(wiTraces([{ env: [{ name: "AZURE_CLIENT_ID", value: "not-a-guid" }] }]), {});
});
