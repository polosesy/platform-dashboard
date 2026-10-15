// Azure connections: registry schema, credentials per mode, role-based access, request routing by subscription,
// connection check (pure parts) and the authorize middleware. No network — fetch and credentials are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { loadEnv } from "../src/env.js";
import { connectionForSubscription, credentialGroup, getConnections, parseConnections } from "../src/infra/connectionRegistry.js";
import { createCredentialProvider, mapCredentialError, setCredentialProviderForTests } from "../src/infra/connectionCredentials.js";
import { callerOf, platformRole, accessibleConnections } from "../src/infra/platformAccess.js";
import { clearConnectionTokens, getArmFetcherAuto, getLogAnalyticsFetcherAuto } from "../src/infra/azureClientFactory.js";
import { assertAllowedSubscription, HttpError, parseSubscriptionIds } from "../src/infra/requestParams.js";
import { featureCoverage, privilegeWarnings } from "../src/services/connectionCheck.js";
import { createAuthorizeMiddleware, subscriptionsInQuery } from "../src/middleware/authorize.js";
import { getKubeconfig } from "../src/services/kubernetes.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const CUST = "99999999-9999-9999-9999-999999999999";
const CUST2 = "88888888-8888-8888-8888-888888888888";
const S1 = "22222222-2222-2222-2222-222222222222";
const S2 = "33333333-3333-3333-3333-333333333333";
const S3 = "44444444-4444-4444-4444-444444444444";
const WS = "55555555-5555-5555-5555-555555555555";
const APP = "66666666-6666-6666-6666-666666666666";

const env = (over: Record<string, string> = {}) => loadEnv({ AZURE_AD_TENANT_ID: HOME, AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: S1, ...over });
const home = { key: "home", displayName: "EMRO", tenantId: HOME, mode: "platform", subscriptions: [S1] };
const lh = { key: "custa", displayName: "Customer A", tenantId: CUST, mode: "lighthouse", subscriptions: [S2] };
const sp = { key: "custb", displayName: "Customer B", tenantId: CUST2, mode: "servicePrincipal", subscriptions: [S3], clientId: APP, secretEnv: "AUD_CONN_CUSTB_SECRET", roles: ["operator"], logAnalyticsWorkspaces: [WS] };
const doc = (...connections: unknown[]) => ({ connections });
const fileEnv = (d: unknown, over: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "aud-conn-"));
  const file = join(dir, "connections.json");
  writeFileSync(file, JSON.stringify(d));
  return env({ AUD_CONNECTIONS_FILE: file, ...over });
};
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

// ── registry ──

test("no file → one home connection read by the platform identity; AUD_HOME_CONNECTION_MODE=delegated restores OBO", () => {
  assert.deepEqual(getConnections(env()).map((c) => [c.key, c.mode, c.subscriptions]), [["home", "platform", [S1]]]);
  assert.equal(getConnections(env({ AUD_HOME_CONNECTION_MODE: "delegated" }))[0]!.mode, "delegated");
  assert.deepEqual(parseSubscriptionIds(env()), [S1]);
});

test("a version-1 tenants file is converted (home → home mode, lighthouse → lighthouse)", () => {
  const e = fileEnv({ tenants: [{ key: "home", displayName: "H", tenantId: HOME, access: "home", subscriptions: [S1] }, { key: "custa", displayName: "A", tenantId: CUST, access: "lighthouse", subscriptions: [S2] }] });
  assert.deepEqual(getConnections(e).map((c) => [c.key, c.mode]), [["home", "platform"], ["custa", "lighthouse"]]);
  assert.equal(connectionForSubscription(e, S2.toUpperCase())?.key, "custa");
  assert.equal(assertAllowedSubscription(e, S2), S2);
  assert.throws(() => assertAllowedSubscription(e, "77777777-7777-7777-7777-777777777777"), /not a managed subscription/);
});

test("the schema refuses secrets, PEM text, bad references and unsafe combinations", () => {
  const p = (...c: unknown[]) => () => parseConnections(doc(...c), env());
  assert.throws(p(home, { ...lh, clientSecret: "x" }), /Unrecognized key/);
  assert.throws(p(home, { ...sp, secretEnv: undefined, certificatePath: "-----BEGIN PRIVATE KEY-----" }), /PEM/);
  assert.throws(p(home, { ...sp, secretEnv: "MY_SECRET" }), /AUD_CONN_/);
  assert.throws(p(home, { ...sp, secretEnv: undefined, certificatePath: "certs/b.pem" }), /absolute/);
  assert.throws(p(home, { ...sp, clientId: undefined }), /clientId/);
  assert.throws(p(home, { ...sp, certificatePath: "/etc/aud/b.pem" }), /exactly one of/);
  assert.throws(p(home, { ...lh, clientId: APP }), /servicePrincipal only/);
  assert.throws(p(home, { ...home, key: "home2" }), /exactly one connection must be the home/);
  assert.throws(p(home, { ...lh, tenantId: HOME }), /not the home tenant/);
  assert.throws(p(lh), /exactly one connection must be the home/);
  assert.throws(p(home, { ...lh, subscriptions: [S1] }), /listed under "home" and "custa"/);
  assert.throws(p(home, { ...lh, key: "Bad Key" }), /a-z 0-9/);
  assert.throws(() => parseConnections(doc(home, lh), env({ AUD_ANONYMOUS_SP: "true" })), /AUD_ANONYMOUS_SP/);
  assert.deepEqual(parseConnections(doc({ ...home, subscriptions: [] }), env())[0]!.subscriptions, [S1], "home defaults to AZURE_SUBSCRIPTION_IDS");
  const ok = parseConnections(doc(home, lh, sp), env());
  assert.deepEqual(ok.map((c) => credentialGroup(env(), c)), ["platform", "platform", "sp:custb"], "Lighthouse uses the home credential");
});

// ── roles ──

test("platform role: highest app role wins, unknown roles ignored, default only without one; no header spoofing", () => {
  assert.deepEqual(platformRole(env(), ["AUD.Viewer", "AUD.Admin", "Other"]), { role: "admin", fromDefault: false });
  assert.deepEqual(platformRole(env(), []), { role: "viewer", fromDefault: true }, "development default");
  assert.deepEqual(platformRole(env({ AUD_DEFAULT_ROLE: "none" }), []), { role: null, fromDefault: false });
  assert.deepEqual(platformRole(env({ NODE_ENV: "production" }), ["x"]), { role: null, fromDefault: false }, "production: no role without an assignment");
  const e = fileEnv(doc(home, lh, sp));
  assert.deepEqual(accessibleConnections(e, "viewer").map((c) => c.key), ["home", "custa"], "custb is operators-only");
  assert.deepEqual(accessibleConnections(e, "admin").map((c) => c.key), ["home", "custa", "custb"]);
  assert.equal(callerOf(e, jwt({ tid: HOME, oid: "o", roles: ["AUD.Operator"] }))?.role, "operator");
});

// ── credentials ──

function fake(calls: string[], secrets: Record<string, string> = {}) {
  const cred = (name: string, tid: string) => ({ getToken: async () => { calls.push(name); return { token: jwt({ tid }), expiresOnTimestamp: Date.now() + 3600_000 }; } });
  setCredentialProviderForTests(createCredentialProvider({
    makeSecret: (t, c) => cred(`secret:${c}`, t),
    makeCert: (t, c) => cred(`cert:${c}`, t),
    oboCredential: () => cred("obo", HOME),
    getEnv: (n) => secrets[n],
  }));
  clearConnectionTokens();
}

test("credential errors are coded and masked; a missing secret names the variable, never a value", async () => {
  const code = (m: string) => mapCredentialError(new Error(m));
  assert.equal(code("AADSTS700016: Application with identifier 'x' was not found in the directory 'y'").code, "connection_not_consented");
  assert.equal(code("AADSTS7000215: Invalid client secret provided").code, "connection_credential_invalid");
  assert.equal(code("AADSTS90002: Tenant not found").code, "connection_tenant_mismatch");
  const other = code(`boom ${CUST} Trace ID: 123 Correlation ID: 456`);
  assert.equal(other.code, "connection_failed");
  assert.ok(!other.message.includes(CUST) && !/Trace ID|Correlation/.test(other.message));

  const calls: string[] = [];
  fake(calls);
  const e = fileEnv(doc(home, sp));
  const arm = await getArmFetcherAuto(e, jwt({ tid: HOME, oid: "o", roles: ["AUD.Admin"] }));
  await assert.rejects(arm.fetchJson(`https://management.azure.com/subscriptions/${S3}?api-version=1`),
    (err: HttpError) => err.code === "connection_unconfigured" && err.message.includes("AUD_CONN_CUSTB_SECRET") && err.status === 503);
});

// ── routing ──

test("each request is read with the credential of its subscription's connection; forbidden ones never reach Azure", async () => {
  const calls: string[] = [];
  fake(calls, { AUD_CONN_CUSTB_SECRET: "hidden" });
  const seen: Array<{ url: string; auth: string; body?: { subscriptions?: string[] } }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    seen.push({ url: String(url), auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ data: [{ n: seen.length }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const e = fileEnv(doc(home, lh, sp));
    const admin = jwt({ tid: HOME, oid: "a", roles: ["AUD.Admin"] });
    const viewer = jwt({ tid: HOME, oid: "v", roles: ["AUD.Viewer"] });
    const arm = await getArmFetcherAuto(e, admin);
    await arm.fetchJson(`https://management.azure.com/subscriptions/${S2}/resourceGroups?api-version=1`);
    await arm.fetchJson(`https://management.azure.com/subscriptions/${S3}/resourceGroups?api-version=1`);
    assert.deepEqual(calls, ["secret:c", `secret:${APP}`], "Lighthouse → platform identity; custb → its own principal");

    // Resource Graph with no subscriptions: every one the caller may read, split per credential and merged
    const r = await arm.postJson<{ data: unknown[] }>("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01", { query: "resources" });
    const argCalls = seen.filter((s) => /ResourceGraph/.test(s.url));
    assert.deepEqual(argCalls.map((s) => s.body?.subscriptions), [[S1, S2], [S3]]);
    assert.equal(r.data.length, 2);

    // A viewer: custb is operators-only — refused before any request, in the URL and in a Graph body
    const n = seen.length;
    const v = await getArmFetcherAuto(e, viewer);
    await assert.rejects(v.fetchJson(`https://management.azure.com/subscriptions/${S3}?api-version=1`), (err: HttpError) => err.code === "connection_forbidden");
    await assert.rejects(v.postJson("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=1", { subscriptions: [S1, S3], query: "x" }), (err: HttpError) => err.code === "connection_forbidden");
    const vr = await v.postJson<{ data: unknown[] }>("https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=1", { query: "x" });
    assert.deepEqual(seen.slice(n).map((s) => s.body?.subscriptions), [[S1, S2]], "a viewer's default scope leaves custb out");
    assert.equal(vr.data.length, 1);

    // Log Analytics: the workspace's connection
    const la = await getLogAnalyticsFetcherAuto(e, admin);
    calls.length = 0;
    clearConnectionTokens();
    await la.query(WS, "print 1");
    await la.query("12345678-1234-1234-1234-123456789012", "print 1");
    assert.deepEqual(calls, [`secret:${APP}`, "secret:c"], "listed workspace → custb; any other → home");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an upstream error body never reaches the message raw (codes kept for callers that match on status)", async () => {
  fake([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "AuthorizationFailed", message: `The client '${APP}' with object id '${APP}' does not have authorization over scope '/subscriptions/${S1}/resourceGroups/rg'` } }), { status: 403 })) as typeof fetch;
  try {
    const arm = await getArmFetcherAuto(env(), jwt({ tid: HOME, oid: "o", roles: ["AUD.Viewer"] }));
    await assert.rejects(arm.fetchJson(`https://management.azure.com/subscriptions/${S1}?api-version=1`), (e: Error) => {
      assert.match(e.message, /^ARM 403: AuthorizationFailed: /);
      assert.ok(!e.message.includes(APP) && !e.message.includes(S1), e.message);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── connection check (pure) ──

test("feature coverage from effective permissions; over-privilege is reported", () => {
  const reader = { actions: ["*/read"], notActions: [] };
  const c = featureCoverage([reader]);
  assert.equal(c.inventory, "ok");
  assert.equal(c.metrics, "ok", "Reader reads metrics");
  assert.equal(c.security, "ok");
  assert.equal(c.aksCredential, "unknown", "usually granted on the cluster");
  assert.equal(c.flowLogBlobs, "unknown", "data action, usually on the storage account");
  assert.equal(c.prometheus, "unknown");
  assert.equal(featureCoverage([{ actions: ["*/read"], notActions: ["Microsoft.Security/*"] }]).security, "missing");
  assert.equal(featureCoverage([]).inventory, "missing");
  assert.equal(featureCoverage([{ dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"] }]).flowLogBlobs, "ok");

  assert.deepEqual(privilegeWarnings([reader, { actions: ["Microsoft.OperationalInsights/workspaces/query/*/read", "Microsoft.Support/*"] }]), []);
  assert.deepEqual(privilegeWarnings([{ actions: ["*"] }]).sort(), ["cluster_admin_credential", "role_assignment_write", "wildcard", "write_or_delete"]);
  assert.deepEqual(privilegeWarnings([{ actions: ["Microsoft.Compute/virtualMachines/write"] }]), ["write_or_delete"]);
  assert.deepEqual(privilegeWarnings([{ actions: ["Microsoft.Authorization/roleAssignments/write"] }]), ["write_or_delete", "role_assignment_write"]);
  assert.deepEqual(privilegeWarnings([{ actions: ["Microsoft.ContainerService/managedClusters/listClusterAdminCredential/action"] }]), ["cluster_admin_credential"]);
});

// ── authorize middleware ──

test("authorize: no role → 403 (except /api/me); a forbidden subscription in the query → 403 before the route; audit has no ids", async () => {
  const e = fileEnv(doc(home, lh, sp), { AUD_DEFAULT_ROLE: "none", AUD_AUDIT_LOG: "stdout" });
  const tokens: Record<string, string> = {
    viewer: jwt({ tid: HOME, oid: "aaaaaaaa-0000-0000-0000-00000000beef", roles: ["AUD.Viewer"] }),
    none: jwt({ tid: HOME, oid: "o2", roles: [] }),
  };
  const app = express();
  let ran = 0;
  app.use("/api", (req, _res, next) => {
    const t = /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1];
    req.auth = t ? { kind: "user", bearerToken: t, principal: { tid: HOME, oid: "aaaaaaaa-0000-0000-0000-00000000beef", scp: [], roles: [] } } : { kind: "anonymous" };
    next();
  });
  app.use("/api", createAuthorizeMiddleware(e));
  app.get("/api/me", (_req, res) => res.json({ ok: true }));
  app.get("/api/x", (req, res) => { ran++; res.json({ connection: req.access?.connection ?? null }); });
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string) => { if (String(chunk).includes('"audit"')) { lines.push(String(chunk)); return true; } return write(chunk); };
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, who?: string) => fetch(`${base}${path}`, { headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} });
  try {
    assert.equal((await get("/api/x", "none")).status, 403);
    assert.equal((await get("/api/me", "none")).status, 200, "/api/me answers without a role");
    assert.equal((await get(`/api/x?subscriptionId=${S3}`, "viewer")).status, 403, "custb is operators-only");
    assert.equal((await get(`/api/x?resourceId=${encodeURIComponent(`/subscriptions/${S3}/resourceGroups/r`)}`, "viewer")).status, 403);
    assert.deepEqual(await (await get(`/api/x?subscriptionId=${S2}`, "viewer")).json(), { connection: "custa" });
    assert.equal(ran, 1, "the route ran only for the allowed request");
    assert.equal((await get("/api/x")).status, 200, "anonymous passes to the route's own handling");
  } finally {
    server.close();
    (process.stdout as { write: unknown }).write = write;
  }
  assert.ok(lines.length >= 4);
  for (const l of lines) {
    assert.ok(!/eyJ|[0-9a-f]{8}-[0-9a-f]{4}-/.test(l), l);
    assert.match(l, /"user":"…beef"|"user":"…/);
  }
  assert.deepEqual(subscriptionsInQuery({ subscriptionId: S1, id: `/subscriptions/${S2}/x`, other: S3 }).sort(), [S1, S2].sort(), "a bare GUID in another parameter is not a subscription");
});

test("anonymous callers never get a kubeconfig (pod logs, exec) unless both dev switches are on", async () => {
  await assert.rejects(getKubeconfig(env(), undefined, `/subscriptions/${S1}/resourceGroups/r/providers/Microsoft.ContainerService/managedClusters/c`), /Sign in/);
  await assert.rejects(getKubeconfig(env({ AUD_ANONYMOUS_SP: "true" }), undefined, `/subscriptions/${S1}/resourceGroups/r/providers/Microsoft.ContainerService/managedClusters/c`), /Sign in/, "AUD_ANONYMOUS_K8S too");
});
