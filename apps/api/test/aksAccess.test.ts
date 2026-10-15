// AKS access: cluster profile from ARM, the sign-in plan (Entra token vs refused local account), token kubeconfig,
// the reach probe (injected DNS/TCP), Kubernetes error mapping and the per-connection policy. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { assertSafeEnv, loadEnv } from "../src/env.js";
import { HttpError } from "../src/infra/requestParams.js";
import { AKS_SERVER_APP_ID, assertAksAudience, clusterConnection } from "../src/infra/azureClientFactory.js";
import {
  aksClusterProfile,
  assertHubbleExecAllowed,
  k8sError,
  kubeloginServerId,
  planClusterAuth,
  podLogNamespaceAllowed,
  probeApiServer,
  tokenKubeConfig,
  type AksClusterProfile,
} from "../src/services/aksAccess.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const CUST = "99999999-9999-9999-9999-999999999999";
const S1 = "22222222-2222-2222-2222-222222222222";
const S2 = "33333333-3333-3333-3333-333333333333";
const APP = "66666666-6666-6666-6666-666666666666";
const PRIVATE = "aks-prd-abc.privatelink.koreacentral.azmk8s.io";
const PUBLIC = "aks-prd-abc.hcp.koreacentral.azmk8s.io";

const coded = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code;

const profile = (over: Partial<AksClusterProfile> = {}): AksClusterProfile => ({
  powerState: "Running", private: true, entra: true, legacyEntra: false, entraTenantId: HOME,
  localAccounts: false, azureRbac: false, hosts: [PRIVATE], ...over,
});

/** A kubeconfig like listClusterUserCredential returns (Entra → kubelogin exec user) */
const kubeconfig = (opts: { server?: string; caData?: string | null; skipTLSVerify?: boolean; user?: Record<string, unknown> } = {}) => {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: opts.server ?? `https://${PRIVATE}:443`, skipTLSVerify: opts.skipTLSVerify ?? false, ...(opts.caData === null ? {} : { caData: opts.caData ?? "Q0E=" }) }],
    users: [{ name: "u", ...(opts.user ?? { exec: { command: "kubelogin", args: ["get-token", "--login", "devicecode", "--server-id", AKS_SERVER_APP_ID] } }) }],
    contexts: [{ name: "ctx", cluster: "c", user: "u" }],
    currentContext: "ctx",
  });
  return kc;
};
const plan = (kc: k8s.KubeConfig, p = profile(), allowLocalAccount = false, credentialTenantId = HOME) =>
  planClusterAuth(kc, p, { allowLocalAccount, credentialTenantId });

// ── profile ──

test("cluster profile: private, AKS-managed Entra (tenant), local accounts, Azure RBAC and the API server host names", () => {
  const p = aksClusterProfile({
    powerState: { code: "Running" }, fqdn: PUBLIC.toUpperCase(), privateFQDN: PRIVATE, azurePortalFQDN: PRIVATE,
    apiServerAccessProfile: { enablePrivateCluster: true }, disableLocalAccounts: true,
    aadProfile: { managed: true, enableAzureRBAC: true, tenantID: HOME.toUpperCase() },
  });
  assert.deepEqual(p, { powerState: "Running", private: true, entra: true, legacyEntra: false, entraTenantId: HOME, localAccounts: false, azureRbac: true, hosts: [PUBLIC, PRIVATE] });
  const plain = aksClusterProfile({ fqdn: PUBLIC });
  assert.equal(plain.entra, false);
  assert.equal(plain.localAccounts, true, "local accounts are on unless disabled");
  assert.equal(plain.private, false);
  assert.equal(aksClusterProfile({ aadProfile: { managed: false, serverAppID: APP } }).legacyEntra, true);
});

test("kubelogin --server-id is read in both spellings", () => {
  const u = (args: string[]) => ({ name: "u", exec: { command: "kubelogin", args } }) as unknown as k8s.User;
  assert.equal(kubeloginServerId(u(["get-token", "--server-id", AKS_SERVER_APP_ID.toUpperCase()])), AKS_SERVER_APP_ID);
  assert.equal(kubeloginServerId(u(["get-token", `--server-id=${APP}`])), APP);
  assert.equal(kubeloginServerId(u(["get-token"])), undefined);
});

// ── sign-in plan ──

test("Entra cluster → Entra token plan (kubelogin is never run); the token user keeps only server + CA", () => {
  const kc = kubeconfig();
  assert.deepEqual(plan(kc), { kind: "entra", host: PRIVATE });
  const out = tokenKubeConfig(kc, "tkn");
  const user = out.getCurrentUser();
  assert.equal(user?.token, "tkn");
  assert.equal(user?.exec, undefined, "no exec plugin survives");
  assert.equal(out.getCurrentCluster()?.caData, "Q0E=");
  assert.equal(out.getCurrentCluster()?.skipTLSVerify, false);
  assert.equal(out.getCurrentCluster()?.server, `https://${PRIVATE}:443`);
});

test("a kubeconfig asking for another server application, or pointing at another host, gets no token", () => {
  assert.throws(() => plan(kubeconfig({ user: { exec: { command: "kubelogin", args: ["get-token", "--server-id", APP] } } })), coded(502, "aks_server_id_mismatch"));
  assert.throws(() => plan(kubeconfig({ server: "https://attacker.example.com" })), coded(502, "aks_server_mismatch"));
  assert.throws(() => plan(kubeconfig({ server: `https://${PUBLIC}` })), coded(502, "aks_server_mismatch"), "only the cluster's ARM host names");
  assert.deepEqual(plan(kubeconfig({ server: `https://${PUBLIC}` }), profile({ hosts: [PUBLIC, PRIVATE] })).host, PUBLIC, "public FQDN of a private cluster (privateDNSZone none)");
});

test("TLS must be verified with the cluster CA", () => {
  assert.throws(() => plan(kubeconfig({ skipTLSVerify: true })), coded(502, "aks_kubeconfig_invalid"));
  assert.throws(() => plan(kubeconfig({ caData: null })), coded(502, "aks_kubeconfig_invalid"));
});

test("an Entra cluster of another tenant (a Lighthouse delegation) cannot be signed in to; legacy Entra is unsupported; stopped is 409", () => {
  assert.throws(() => plan(kubeconfig(), profile({ entraTenantId: CUST })), coded(501, "aks_aad_cross_tenant_unsupported"));
  assert.deepEqual(plan(kubeconfig(), profile({ entraTenantId: CUST }), false, CUST).kind, "entra", "the customer's own service principal works");
  assert.throws(() => plan(kubeconfig(), profile({ entra: false, legacyEntra: true })), coded(501, "aad_cluster_unsupported"));
  assert.throws(() => plan(kubeconfig(), profile({ powerState: "Stopped" })), coded(409, "cluster_stopped"));
});

test("local-account cluster (no Entra): its cluster-admin certificate is refused unless allowed; allowed → static plan", () => {
  const local = profile({ entra: false, entraTenantId: undefined, localAccounts: true });
  const certKc = kubeconfig({ user: { certData: "Y2VydA==", keyData: "a2V5" } });
  assert.throws(() => plan(certKc, local), coded(403, "aks_local_account_refused"));
  assert.deepEqual(plan(certKc, local, true), { kind: "static", host: PRIVATE });
  assert.throws(() => plan(kubeconfig(), local, true), coded(501, "aad_cluster_unsupported"), "allowed, but only an exec user → nothing to use");
});

test("production refuses AUD_AKS_ALLOW_LOCAL_ACCOUNTS; HUBBLE_EXEC_ENABLED is on in development and off in production unless set", () => {
  const base = { AZURE_AD_TENANT_ID: HOME, AZURE_SUBSCRIPTION_IDS: S1 };
  assert.throws(() => loadEnv({ ...base, NODE_ENV: "production", AUD_DEFAULT_ROLE: "none", AUD_AKS_ALLOW_LOCAL_ACCOUNTS: "true" }), /AUD_AKS_ALLOW_LOCAL_ACCOUNTS/);
  assert.equal(assertSafeEnv(loadEnv({ ...base, AUD_AKS_ALLOW_LOCAL_ACCOUNTS: "true" })).AUD_AKS_ALLOW_LOCAL_ACCOUNTS, true);
  assert.equal(loadEnv({ ...base }).HUBBLE_EXEC_ENABLED, undefined);
  assert.equal(loadEnv({ ...base, HUBBLE_EXEC_ENABLED: "false" }).HUBBLE_EXEC_ENABLED, false);
});

// ── tokens ──

test("only a token for the AKS server application is sent to an API server", () => {
  const jwt = (aud: unknown) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.sig`;
  assert.equal(assertAksAudience(jwt(AKS_SERVER_APP_ID)), jwt(AKS_SERVER_APP_ID));
  assert.ok(assertAksAudience(jwt(`api://${AKS_SERVER_APP_ID}`)));
  assert.throws(() => assertAksAudience(jwt("https://management.azure.com")), coded(502, "aks_token_audience"));
  assert.throws(() => assertAksAudience("opaque"), coded(502, "aks_token_audience"));
});

// ── reach ──

test("probe: DNS failure → dns, no TCP connection → tcp, a hanging lookup times out as dns", async () => {
  const ok = async () => undefined;
  const fail = async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); };
  assert.equal(await probeApiServer(PRIVATE, 50, { lookup: ok, connect: ok }), null);
  assert.equal(await probeApiServer(PRIVATE, 50, { lookup: fail, connect: ok }), "dns");
  assert.equal(await probeApiServer(PRIVATE, 50, { lookup: ok, connect: fail }), "tcp");
  assert.equal(await probeApiServer(PRIVATE, 30, { lookup: () => new Promise(() => {}), connect: ok }), "dns");
});

test("Kubernetes failures become coded errors without host names; others pass through", () => {
  const r = k8sError(Object.assign(new Error("Forbidden"), { code: 403 })) as HttpError;
  assert.equal(r.code, "aks_rbac_forbidden");
  assert.match(r.message, /aud-dashboard-reader/);
  assert.equal((k8sError(Object.assign(new Error("Unauthorized"), { code: 401 })) as HttpError).code, "aks_unauthorized");
  const dns = k8sError(Object.assign(new Error(`getaddrinfo ENOTFOUND ${PRIVATE}`), { code: "ENOTFOUND" }), true) as HttpError;
  assert.equal(dns.code, "cluster_dns_unresolved");
  assert.ok(!dns.message.includes(PRIVATE), "the private host name is not echoed to the caller");
  assert.equal((k8sError(Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } })) as HttpError).code, "cluster_unreachable");
  const other = new Error("boom");
  assert.equal(k8sError(other), other);
});

// ── per-connection policy ──

const clusterIn = (sub: string) => `/subscriptions/${sub}/resourcegroups/rg/providers/microsoft.containerservice/managedclusters/aks`;
const envWith = (aks: Record<string, unknown> | undefined, over: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "aud-aks-"));
  const file = join(dir, "connections.json");
  writeFileSync(file, JSON.stringify({ connections: [
    { key: "home", displayName: "Home", tenantId: HOME, mode: "platform", subscriptions: [S1] },
    { key: "custb", displayName: "B", tenantId: CUST, mode: "servicePrincipal", subscriptions: [S2], clientId: APP, secretEnv: "AUD_CONN_CUSTB_SECRET", ...(aks ? { aks } : {}) },
  ] }));
  return loadEnv({ AZURE_AD_TENANT_ID: HOME, AZURE_SUBSCRIPTION_IDS: S1, AUD_CONNECTIONS_FILE: file, ...over });
};

test("the token tenant of a cluster's connection: the customer's own SP tenant, home for the platform identity", () => {
  const env = envWith(undefined);
  assert.equal(clusterConnection(env, clusterIn(S2)).tokenTenantId, CUST);
  assert.equal(clusterConnection(env, clusterIn(S1)).tokenTenantId, HOME);
});

test("pod logs from the kubelet: every namespace for home, none for a customer unless listed", () => {
  const env = envWith(undefined);
  assert.equal(podLogNamespaceAllowed(env, clusterIn(S1), "payments"), true);
  assert.equal(podLogNamespaceAllowed(env, clusterIn(S2), "payments"), false);
  const listed = envWith({ podLogNamespaces: ["app"] });
  assert.equal(podLogNamespaceAllowed(listed, clusterIn(S2), "app"), true);
  assert.equal(podLogNamespaceAllowed(listed, clusterIn(S2), "kube-system"), false);
});

test("Hubble exec: deployment switch first, then home or a customer connection that opted in", () => {
  const off = coded(501, "hubble_exec_disabled");
  assert.doesNotThrow(() => assertHubbleExecAllowed(envWith(undefined), clusterIn(S1)), "development default: on for home");
  assert.throws(() => assertHubbleExecAllowed(envWith(undefined), clusterIn(S2)), off, "customer without opt-in");
  assert.doesNotThrow(() => assertHubbleExecAllowed(envWith({ hubbleExec: true }), clusterIn(S2)));
  assert.throws(() => assertHubbleExecAllowed(envWith({ hubbleExec: true }, { HUBBLE_EXEC_ENABLED: "false" }), clusterIn(S2)), off);
  assert.throws(() => assertHubbleExecAllowed(envWith(undefined, { NODE_ENV: "production", AUD_DEFAULT_ROLE: "none" }), clusterIn(S1)), off, "production default: off");
});

test("connections file: aks options are strict", () => {
  assert.throws(() => clusterConnection(envWith({ exec: true }), clusterIn(S2)), /Invalid connections file/);
  assert.throws(() => clusterConnection(envWith({ podLogNamespaces: ["Not_A_Namespace"] }), clusterIn(S2)), /Invalid connections file/);
});
