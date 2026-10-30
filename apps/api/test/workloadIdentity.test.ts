import { test } from "node:test";
import assert from "node:assert/strict";
import type { PolicyInventory, InvWorkload } from "../src/services/policyAnalyzer.js";
import {
  WI_RULE_DOCS, buildWorkloadIdentityMap, cidrHasImds, classifyScope, compareExact, imdsAllowPolicies, imdsKvQuery, parseFicSubject, saRbac,
  type InvIdentity, type InvRoleAssignment, type WiInput,
} from "../src/services/workloadIdentity.js";
import { imdsFacts, nodePoolIdentitiesQuery, nodePoolsFromRows, roleAssignmentsQuery, uamiByClientIdQuery } from "../src/services/workloadIdentityCollector.js";
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

test("WI-14 is one finding per identity and namespace; cluster-admin-only reach is informational", () => {
  const i = input();
  i.serviceAccounts!.push({ namespace: "app", name: "api2-sa", annotations: { "azure.workload.identity/client-id": CLIENT_A }, labels: {} });
  i.inventory.workloads.push(wl("app", "api2", "api2-sa", true));
  i.fics.get(UAMI_A.toLowerCase())!.items.push(fic("api2", "system:serviceaccount:app:api2-sa"));
  const r = buildWorkloadIdentityMap(i);
  const app = r.findings.filter((f) => f.rule === "WI-14" && f.refs.includes("sa:app/api-sa"));
  assert.equal(app.length, 1, "api-sa and api2-sa share one finding");
  assert.ok(app[0]!.refs.includes("sa:app/api2-sa"));
  assert.notEqual(app[0]!.sev, "info", "devs can exec (not only cluster-admin)");
  // ops: the only other subject is worker-sa through cluster-admin → informational
  const ops = r.findings.find((f) => f.rule === "WI-14" && f.refs.includes("sa:ops/ops-sa"))!;
  assert.equal(ops.sev, "info");
});

// ── IMDS path: node pool scale sets carry identities any pod on those nodes can use (no workload identity needed) ──

const UAMI_NODE = `/subscriptions/${SUB}/resourcegroups/mc-rg/providers/microsoft.managedidentity/userassignedidentities/agentpool`;
const PRINC_NODE = "ffffffff-0000-0000-0000-00000000000f";
const CLIENT_NODE = "99999999-0000-0000-0000-0000000000aa";
function imdsInput(over: Partial<WiInput> = {}): WiInput {
  const i = input();
  i.inventory.nodes = [{ name: "aks-user-1-vmss000000", pool: "user" }, { name: "aks-sys-1-vmss000000", pool: "sys" }];
  i.inventory.workloads.push(wl("app", "web", "web-sa", false), wl("kube-system", "coredns", "coredns", false));
  i.inventory.pods.push(
    { namespace: "app", name: "web-6d5f7-a", labels: {}, phase: "Running", serviceAccountName: "web-sa", nodeName: "aks-user-1-vmss000000" },
    { namespace: "kube-system", name: "coredns-5c9-b", labels: {}, phase: "Running", serviceAccountName: "coredns", nodeName: "aks-sys-1-vmss000000" },
  );
  i.inventory.pods[0]!.nodeName = "aks-user-1-vmss000000";
  i.identities.push({ ...ident(UAMI_NODE, "agentpool", CLIENT_NODE, PRINC_NODE), resourceGroup: "mc-rg", scanned: "nodePool" });
  i.roleAssignments!.push({ principalId: PRINC_NODE, roleDefGuid: "7f951dda-4ed3-4680-a7ca-43fe172d538d", roleName: "AcrPull", roleType: "BuiltInRole", scope: `/subscriptions/${SUB}/resourceGroups/rg-acr/providers/Microsoft.ContainerRegistry/registries/acr1`, hasCondition: false, actions: [] });
  i.inventory.ciliumPolicies = [{ namespace: "app", name: "baseline", specs: [{ endpointSelector: {}, egress: [{ toCIDR: ["169.254.169.254/32"], toPorts: [] }] }] }];
  return {
    ...i,
    nodePools: [{ pool: "user", identityArmIds: [UAMI_A, UAMI_NODE] }, { pool: "sys", identityArmIds: [UAMI_NODE] }],
    imds: { podAccess: "allowed", restrictionBlockedBy: ["Azure Policy", "Container Insights"], pools: "ok", nodeResourceGroup: "mc-rg" },
    ...over,
  };
}

test("workloads without workload identity are listed with the node pools they run on", () => {
  const r = buildWorkloadIdentityMap(imdsInput());
  const web = r.otherWorkloads.find((w) => w.name === "web")!;
  assert.deepEqual([web.namespace, web.serviceAccount, web.pools, web.managed], ["app", "web-sa", ["pool:user"], false]);
  assert.equal(r.otherWorkloads.find((w) => w.name === "coredns")!.managed, true, "kube-system is a system object");
  assert.equal(r.otherWorkloads[r.otherWorkloads.length - 1]!.managed, true, "system objects last");
  assert.ok(!r.otherWorkloads.some((w) => w.name === "api"), "workload identity users are not 'other'");
  const user = r.nodePools.find((p) => p.name === "user")!;
  assert.equal(user.nodes, 1);
  assert.deepEqual(user.namespaces.find((n) => n.namespace === "app"), { namespace: "app", workloads: 2, withoutWi: 1 }, "api (WI) + web (not)");
  const idA = r.identities.find((i) => i.name === "id-app")!;
  assert.deepEqual(idA.pools, ["pool:user"]);
  assert.deepEqual(user.identityIds.sort(), [idA.id, r.identities.find((i) => i.name === "agentpool")!.id].sort());
  assert.deepEqual(r.imds.allowPolicies, [{ kind: "CiliumNetworkPolicy", namespace: "app", name: "baseline", selectsAll: true }]);
});

test("WI-17: an identity on a node pool scale set — severity by its roles, AKS-made vs attached by hand, nothing when restricted", async () => {
  const r = buildWorkloadIdentityMap(imdsInput());
  const f17 = r.findings.filter((f) => f.rule === "WI-17");
  const app = f17.find((f) => f.title.includes("id-app"))!;
  assert.equal(app.sev, "crit", "Owner at subscription — reachable from every pod on the pool");
  assert.ok(app.refs.includes(`pool:user@${r.identities.find((i) => i.name === "id-app")!.id}`), "the pool card is referenced");
  assert.match(app.detail, /baseline/, "the explicit IMDS allow policy is named");
  assert.match(app.remediation, /①/, "attached by hand → move to workload identity, then detach");
  assert.match(app.remediation, /Azure Policy, Container Insights/, "the add-ons blocking the IMDS restriction are named");
  const node = f17.find((f) => f.title.includes("agentpool"))!;
  assert.equal(node.sev, "info", "AcrPull only");
  assert.match(node.remediation, /AKS/, "node resource group identity → don't detach");
  assert.equal(node.code, undefined, "no Key Vault role → no Key Vault log query");
  const restricted = buildWorkloadIdentityMap(imdsInput({ imds: { podAccess: "restricted", restrictionBlockedBy: [], pools: "ok", nodeResourceGroup: "mc-rg" } }));
  assert.equal(restricted.findings.filter((f) => f.rule === "WI-17").length, 0);
  // An unreadable setting is not "allowed" — and the text says so
  const unk = buildWorkloadIdentityMap(imdsInput({ imds: { podAccess: null, restrictionBlockedBy: [], pools: "ok", nodeResourceGroup: "mc-rg" } }));
  assert.match(unk.findings.find((f) => f.rule === "WI-17")!.detail, /확인 불가/);
  const { withLang } = await import("../src/infra/lang.js");
  assert.doesNotMatch(JSON.stringify(withLang("en", () => buildWorkloadIdentityMap(imdsInput()))), /[가-힯]/, "English has no Korean");
  // Same no-GUID rule as everything else
  assert.doesNotMatch(JSON.stringify({ ...r, clusterId: "" }), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // No node pools read → no pool links, no WI-17
  const none = buildWorkloadIdentityMap(input());
  assert.deepEqual([none.nodePools.length, none.imds.pools, none.findings.some((f) => f.rule === "WI-17")], [0, "notRead", false]);
});

test("Key Vault role → the finding carries a Key Vault log query with the client ID tail only", () => {
  const i = imdsInput();
  i.roleAssignments!.push({ principalId: PRINC_A, roleDefGuid: "4633458b-17de-408a-b874-0445c86b69e6", roleName: "Key Vault Secrets User", roleType: "BuiltInRole", scope: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.KeyVault/vaults/kv1`, hasCondition: false, actions: [] });
  const f = buildWorkloadIdentityMap(i).findings.find((x) => x.rule === "WI-17" && x.title.includes("id-app"))!;
  assert.match(f.code ?? "", /appid endswith "000a"/);
  assert.ok(!(f.code ?? "").includes(CLIENT_A));
  assert.equal(imdsKvQuery(CLIENT_A).includes(CLIENT_A), false);
});

test("IMDS allow policies: explicit link-local CIDRs only, except removes it, NetworkPolicy ipBlock too", () => {
  assert.equal(cidrHasImds("169.254.169.254/32"), true);
  assert.equal(cidrHasImds("169.254.169.254"), true);
  assert.equal(cidrHasImds("169.254.0.0/16"), true);
  assert.equal(cidrHasImds("0.0.0.0/0"), false, "the whole internet is not an explicit IMDS allow");
  assert.equal(cidrHasImds("10.0.0.0/8"), false);
  assert.equal(cidrHasImds("169.254.169.0/24"), true);
  assert.equal(cidrHasImds("nonsense"), false);
  const inv0 = inv();
  inv0.ciliumPolicies = [
    { namespace: "a", name: "set", specs: [{ endpointSelector: { matchLabels: { app: "x" } }, egress: [{ toCIDRSet: [{ cidr: "169.254.0.0/16" }] }] }] },
    { namespace: "a", name: "except", specs: [{ endpointSelector: {}, egress: [{ toCIDRSet: [{ cidr: "169.254.0.0/16", except: ["169.254.169.254/32"] }] }] }] },
    { name: "cw", specs: [{ endpointSelector: {}, egress: [{ toCIDR: ["169.254.169.254/32"] }] }] },
    { namespace: "a", name: "host", specs: [{ nodeSelector: {}, egress: [{ toCIDR: ["169.254.169.254/32"] }] }] },
  ];
  inv0.networkPolicies = [{ namespace: "b", name: "np", podSelector: {}, egress: [{ to: [{ ipBlock: { cidr: "169.254.169.254/32" } }] }] }];
  assert.deepEqual(imdsAllowPolicies(inv0).map((p) => [p.kind, p.namespace ?? "", p.name, p.selectsAll]), [
    ["CiliumClusterwideNetworkPolicy", "", "cw", true],
    ["CiliumNetworkPolicy", "a", "set", false],
    ["NetworkPolicy", "b", "np", true],
  ]);
});

test("collector: preview cluster facts and scale set rows (pure)", () => {
  assert.deepEqual(imdsFacts({ properties: { nodeResourceGroup: "mc-rg", networkProfile: { podLinkLocalAccess: "IMDS" }, addonProfiles: { omsagent: { enabled: true }, azurepolicy: { enabled: true }, azureKeyvaultSecretsProvider: { enabled: true }, aciConnectorLinux: { enabled: false } }, metricsProfile: { costAnalysis: { enabled: true } } } }),
    { podAccess: "allowed", restrictionBlockedBy: ["Azure Policy", "Azure cost analysis", "Container Insights"], nodeResourceGroup: "mc-rg" });
  assert.equal(imdsFacts({ properties: { networkProfile: { podLinkLocalAccess: "None" } } }).podAccess, "restricted");
  assert.equal(imdsFacts({ properties: {} }).podAccess, null, "not reported → unknown, not 'allowed'");
  const r = nodePoolsFromRows([
    { name: "aks-user-12345678-vmss", pool: "user", ids: { [UAMI_A]: { clientId: CLIENT_A, principalId: PRINC_A }, [UAMI_NODE]: { clientId: CLIENT_NODE, principalId: PRINC_NODE } } },
    { name: "aks-sys-87654321-vmss", ids: { [UAMI_NODE]: { clientId: CLIENT_NODE, principalId: PRINC_NODE }, "/not/an/identity": { clientId: "x", principalId: "y" } } },
    { name: "aks-empty-1-vmss", ids: null },
  ]);
  assert.deepEqual(r.nodePools.map((p) => [p.pool, p.identityArmIds.length]), [["user", 2], ["sys", 1], ["empty", 0]], "pool from the tag, else the AKS name pattern");
  assert.equal(r.attached.length, 2, "one entry per identity across pools");
  assert.match(nodePoolIdentitiesQuery(`mc-rg" or 1==1`), /resourceGroup =~ "mc-rg\\" or 1==1"/);
});

test("WI-18 granted vs used: data roles by definition ID, unused only when the scope logs others, unknown otherwise", async () => {
  const W = await import("../src/services/workloadIdentity.js");
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  // Verdicts
  assert.deepEqual(W.usageVerdict([{ who: "", n: 0 }], ids, "keyVault"), { state: "unknown", source: "keyVault", days: 30, logsInScope: 0, reason: "noLogs" });
  assert.deepEqual(W.usageVerdict([{ who: "", n: 52 }], ids, "keyVault"), { state: "unused", source: "keyVault", days: 30, requests: 0, logsInScope: 52 });
  const used = W.usageVerdict([{ who: "", n: 10 }, { who: ids[0], n: 5, lastSeen: "2026-10-28T00:00:00Z" }, { who: ids[1], n: 2, lastSeen: "2026-10-29T00:00:00Z" }], ids, "storage");
  assert.deepEqual([used.state, used.requests, used.last, used.logsInScope], ["used", 7, "2026-10-29T00:00:00.000Z", 17]);
  // Query: ids are validated GUIDs only, one row per caller
  const q = W.roleUsageQuery("keyVault", [...ids, "not-a-guid', drop"]);
  assert.match(q, /AZKVAuditLogs/);
  assert.match(q, /summarize n = count\(\), lastSeen = max\(TimeGenerated\) by who/, "'last' is a KQL keyword — the column must not be named so");
  assert.doesNotMatch(q, /not-a-guid/);
  assert.match(W.roleUsageQuery("storage", ids), /StorageBlobLogs, StorageFileLogs, StorageQueueLogs, StorageTableLogs/);
  // Classification by definition ID: Secrets User (data, read), Contributor (control plane — not here)
  assert.deepEqual(W.DATA_ROLES["4633458b-17de-408a-b874-0445c86b69e6"], { svc: "keyVault", write: false });
  assert.equal(W.DATA_ROLES["b24988ac-6180-42a0-ab88-20f7382dd24c"], undefined);
});

test("WI-18 in the map: usage on the role, a finding only for 'unused' data roles (write = warn), 'notCovered' for control-plane roles", async () => {
  const W = await import("../src/services/workloadIdentity.js");
  const i = input();
  const kv = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.KeyVault/vaults/kv1`;
  i.roleAssignments!.push({ principalId: PRINC_A, roleDefGuid: "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", roleName: "Key Vault Secrets Officer", roleType: "BuiltInRole", scope: kv, hasCondition: false, actions: [] });
  const usage = new Map([[W.usageKey(PRINC_A, "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", kv), { state: "unused" as const, source: "keyVault" as const, days: 30, requests: 0, logsInScope: 52 }]]);
  const r = W.buildWorkloadIdentityMap({ ...i, roleUsage: usage });
  const idn = r.identities.find((x) => x.roles.some((ra) => ra.roleName === "Key Vault Secrets Officer"))!;
  assert.equal(idn.roles.find((ra) => ra.roleName === "Key Vault Secrets Officer")!.usage!.state, "unused");
  assert.equal(idn.roles.find((ra) => ra.roleName === "Owner")!.usage!.reason, "notCovered", "control plane: no log records reads");
  const f = r.findings.filter((x) => x.rule === "WI-18");
  assert.equal(f.length, 1);
  assert.deepEqual([f[0]!.sev, f[0]!.ev], ["warn", "obs"], "a write role");
  assert.match(f[0]!.detail, /52건/);
  assert.ok(!JSON.stringify(f).includes(PRINC_A) && !JSON.stringify(f).includes(CLIENT_A), "no full ids in the response");
  // Not checked at all → no usage field, no WI-18
  const none = W.buildWorkloadIdentityMap(i);
  assert.ok(none.identities.every((x) => x.roles.every((ra) => ra.usage === undefined)));
  assert.equal(none.findings.filter((x) => x.rule === "WI-18").length, 0);
});
