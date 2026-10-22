// AKS readiness from Azure facts only — synthetic cluster properties, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aksReadiness, askSnippet, type ReadinessContext } from "../src/services/aksReadiness.js";

const T = "11111111-1111-1111-1111-111111111111";
const OID = "22222222-2222-2222-2222-222222222222";
const privateEntra = {
  aadProfile: { managed: true, enableAzureRBAC: false, tenantID: T },
  disableLocalAccounts: true,
  apiServerAccessProfile: { enablePrivateCluster: true },
  privateFQDN: "aks-x.abc.privatelink.koreacentral.azmk8s.io",
  securityProfile: { defender: { securityMonitoring: { enabled: true } } },
  addonProfiles: { azurepolicy: { enabled: true }, omsagent: { enabled: false } },
  azureMonitorProfile: { metrics: { enabled: true } },
};
const ctx = (o: Partial<ReadinessContext> = {}): ReadinessContext => ({ connectionTenantId: T, credential: "secret", clusterUserRole: false, workspaces: [{ dataReader: false }], probe: "dns", ...o });
const byKey = (items: ReturnType<typeof aksReadiness>) => Object.fromEntries(items.map((i) => [i.key, i]));

test("private Entra cluster with Kubernetes RBAC: Azure-only features ready, what to ask for the rest", () => {
  const r = byKey(aksReadiness(privateEntra, ctx()));
  assert.equal(r.defender!.state, "ok");
  assert.equal(r.policyAddon!.state, "ok");
  assert.deepEqual([r.prometheus!.state, r.prometheus!.ask], ["missing", "amwDataReader"], "metrics on, but no Monitoring Data Reader on the cluster's own workspace");
  assert.equal(r.containerInsights!.state, "missing");
  assert.deepEqual([r.entra!.state, r.entra!.detail], ["ok", undefined]);
  assert.equal(r.localAccounts!.state, "ok");
  assert.deepEqual([r.authz!.ask, r.authz!.detail], ["clusterRoleBinding", "kubernetesRbac"]);
  assert.equal(r.clusterUserRole!.ask, "clusterUserRole");
  assert.deepEqual([r.reach!.state, r.reach!.ask, r.reach!.detail], ["missing", "privateEndpoint", "privateDns"]);
  assert.deepEqual([r.credential!.state, r.credential!.ask], ["info", "federation"]);
});

test("Azure RBAC, reachable, readable workspace, federated credential; an unread cluster is all unknown", () => {
  const r = byKey(aksReadiness({ ...privateEntra, aadProfile: { managed: true, enableAzureRBAC: true, tenantID: T } }, ctx({ probe: null, clusterUserRole: true, workspaces: [{ dataReader: true }], credential: "federatedKubernetes" })));
  assert.equal(r.authz!.ask, "azureRbacRole");
  assert.equal(r.reach!.state, "ok");
  assert.equal(r.prometheus!.state, "ok");
  assert.equal(r.clusterUserRole!.state, "ok");
  assert.deepEqual([r.credential!.state, r.credential!.ask], ["ok", undefined]);
  assert.ok(aksReadiness(undefined, ctx()).every((i) => i.state === "unknown"), "nothing read: never 'missing'");
  assert.equal(byKey(aksReadiness(privateEntra, ctx({ workspaces: [] }))).prometheus!.detail, "noWorkspace");
  assert.equal(byKey(aksReadiness(privateEntra, ctx({ workspaces: null }))).prometheus!.state, "unknown");
});

test("Entra in another tenant, local accounts on, no Entra at all", () => {
  assert.deepEqual(byKey(aksReadiness({ ...privateEntra, aadProfile: { managed: true, tenantID: "99999999-9999-9999-9999-999999999999" } }, ctx())).entra, { key: "entra", tier: 1, state: "missing", detail: "otherTenant" });
  const local = byKey(aksReadiness({ disableLocalAccounts: false, fqdn: "aks.hcp.koreacentral.azmk8s.io" }, ctx({ probe: "tcp" })));
  assert.equal(local.entra!.detail, "noEntra");
  assert.equal(local.localAccounts!.state, "missing");
  assert.deepEqual([local.reach!.ask, local.reach!.detail], ["allowedIp", "publicTcp"]);
  assert.equal(local.defender!.state, "missing", "absent profile with the cluster read = off");
});

test("snippets: the object id when known, placeholders otherwise; the federated credential matches the platform", () => {
  assert.ok(askSnippet("clusterRoleBinding", { objectId: OID }).includes(`name: "${OID}"`));
  assert.ok(askSnippet("clusterUserRole").includes("<CONNECTION_IDENTITY_OBJECT_ID>"));
  const fic = JSON.parse(askSnippet("federation", { issuer: "https://oidc.example/abc/", subject: "system:serviceaccount:aud-dashboard:aud-dashboard" }));
  assert.deepEqual([fic.issuer, fic.subject, fic.audiences], ["https://oidc.example/abc/", "system:serviceaccount:aud-dashboard:aud-dashboard", ["api://AzureADTokenExchange"]]);
  assert.match(fic.name, /^fed-common-/);
  assert.ok(askSnippet("privateEndpoint").includes("--group-id management"));
  for (const k of ["clusterUserRole", "clusterRoleBinding", "azureRbacRole", "amwDataReader", "privateEndpoint", "allowedIp", "federation"] as const) {
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(askSnippet(k)), `${k}: no id without one given`);
  }
});
