import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import * as k8s from "@kubernetes/client-node";
import { createAuthMiddleware } from "../src/auth.js";
import { AuthError, type TokenVerifier } from "../src/infra/tokenVerifier.js";
import { loadEnv } from "../src/env.js";
import { anonymousSpAllowed, clearConnectionTokens, getArmFetcherAuto } from "../src/infra/azureClientFactory.js";
import { createCredentialProvider, setCredentialProviderForTests } from "../src/infra/connectionCredentials.js";
import { mapOboError } from "../src/infra/oboErrors.js";
import { HttpError, respondWithFallback } from "../src/infra/requestParams.js";
import { getDiagramSpec, listDiagramSpecs, saveDiagramSpec } from "../src/services/liveAggregator.js";
import { sanitizeKubeconfig } from "../src/services/kubernetes.js";
import { cachePrefix, principalKey, setCacheScopeResolver } from "../src/infra/cacheManager.js";
import { initPlatformAccess } from "../src/infra/platformAccess.js";

const baseEnv = (over: Record<string, string> = {}) => loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: "22222222-2222-2222-2222-222222222222", ...over });

// ── middleware: a present token must be valid; none = anonymous ──
async function withServer(verifier: TokenVerifier, fn: (base: string, seen: Array<string | undefined>) => Promise<void>) {
  const app = express();
  const seen: Array<string | undefined> = [];
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", createAuthMiddleware(verifier));
  app.get("/api/x", (req, res) => { seen.push(req.auth?.kind); res.json({ kind: req.auth?.kind, tid: req.auth?.principal?.tid }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { server.close(); }
}
const fakeVerifier: TokenVerifier = {
  async verify(t: string) {
    if (t === "good") return { tid: "t1", oid: "o1", scp: ["Azure.Read.All"], roles: [] };
    if (t === "old") throw new AuthError(401, "token_expired");
    throw new AuthError(401, "invalid_token", "signature");
  },
};

test("middleware: no header → anonymous; a bad or expired token stops at 401 before the route; /health stays public", async () => {
  await withServer(fakeVerifier, async (base, seen) => {
    assert.deepEqual(await (await fetch(`${base}/api/x`)).json(), { kind: "anonymous" });
    const good = await (await fetch(`${base}/api/x`, { headers: { authorization: "Bearer good" } })).json();
    assert.deepEqual(good, { kind: "user", tid: "t1" });
    for (const [h, code] of [["Bearer garbage", "invalid_token"], ["Bearer old", "token_expired"], ["Basic abc", "invalid_token"]] as const) {
      const r = await fetch(`${base}/api/x`, { headers: { authorization: h } });
      assert.equal(r.status, 401, h);
      assert.equal((await r.json()).error, code);
      assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer error=/);
    }
    assert.deepEqual(seen, ["anonymous", "user"], "the route never ran for a refused token");
    assert.equal((await fetch(`${base}/health`, { headers: { authorization: "Bearer garbage" } })).status, 200);
  });
});

const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** Fake credentials: record which factory produced the token; stub fetch answers 200 {} */
function fakeCredentials(calls: string[]) {
  const cred = (name: string, tid: string) => ({ getToken: async () => { calls.push(name); return { token: jwt({ tid, n: name }), expiresOnTimestamp: Date.now() + 3600_000 }; } });
  setCredentialProviderForTests(createCredentialProvider({
    makeSecret: (t) => cred("platform-secret", t),
    makeCert: (t) => cred("platform-cert", t),
    makeAssertion: (t) => cred("platform-assertion", t),
    readFile: async () => "",
    oboCredential: () => ({ getToken: async () => { calls.push("obo"); throw new Error("AADSTS65001: consent for app 'x' Trace ID: 1"); } }),
    getEnv: () => undefined,
  }));
  clearConnectionTokens();
}

test("credential policy: a signed-in user reads through the platform connection, never OBO; anonymous → signin unless dev mode", async () => {
  const calls: string[] = [];
  fakeCredentials(calls);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const user = jwt({ tid: "11111111-1111-1111-1111-111111111111", oid: "o1", roles: ["AUD.Viewer"] });
    const arm = await getArmFetcherAuto(baseEnv(), user);
    await arm.fetchJson("https://management.azure.com/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups?api-version=1");
    assert.deepEqual(calls, ["platform-secret"], "the platform identity, no OBO");

    calls.length = 0;
    clearConnectionTokens();
    const delegated = await getArmFetcherAuto(baseEnv({ AUD_HOME_CONNECTION_MODE: "delegated" }), user);
    await assert.rejects(delegated.fetchJson("https://management.azure.com/subscriptions/22222222-2222-2222-2222-222222222222?api-version=1"),
      (e: HttpError) => e.code === "consent_required" && !/Trace ID|AADSTS/.test(e.message));
    assert.deepEqual(calls, ["obo"], "delegated mode uses OBO only — no platform fallback");

    await assert.rejects(getArmFetcherAuto(baseEnv(), undefined), (e: HttpError) => e.code === "signin_required" && e.status === 401);
    calls.length = 0;
    clearConnectionTokens();
    const anon = await getArmFetcherAuto(baseEnv({ AUD_ANONYMOUS_SP: "true" }), undefined);
    await anon.fetchJson("https://management.azure.com/subscriptions?api-version=1");
    assert.deepEqual(calls, ["platform-secret"]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(anonymousSpAllowed(baseEnv({ AUD_ANONYMOUS_SP: "true" }), false), false, "a feature's own opt-in is required too");
  assert.equal(anonymousSpAllowed(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true" }), true), false, "old flag alone → no SP");
});

test("a user without a platform role is refused before any token or request", async () => {
  const calls: string[] = [];
  fakeCredentials(calls);
  const env = baseEnv({ AUD_DEFAULT_ROLE: "none" });
  const arm = await getArmFetcherAuto(env, jwt({ tid: "t", oid: "o", roles: [] }));
  await assert.rejects(arm.fetchJson("https://management.azure.com/subscriptions?api-version=1"), (e: HttpError) => e.code === "no_platform_role" && e.status === 403);
  assert.deepEqual(calls, []);
});

test("OBO errors map to codes the web can act on", () => {
  const code = (m: string) => mapOboError(new Error(m)).code;
  assert.equal(code("AADSTS50076: mfa"), "interaction_required");
  assert.equal(code("AADSTS65001: consent"), "consent_required");
  assert.equal(code("AADSTS53003: blocked"), "access_blocked");
  assert.equal(code("AADSTS500133: expired"), "token_expired");
  const other = mapOboError(new Error("boom for /subscriptions/22222222-2222-2222-2222-222222222222"));
  assert.equal(other.code, "obo_failed");
  assert.ok(!other.message.includes("22222222-2222-2222-2222-2222"), "ids masked");
});

test("env guards: anonymous SP only on loopback; CORS must list origins; production has no default role", () => {
  assert.throws(() => baseEnv({ NODE_ENV: "production", AUD_DEFAULT_ROLE: "viewer" }), /AUD_DEFAULT_ROLE/);
  assert.equal(baseEnv({ NODE_ENV: "production", AUD_DEFAULT_ROLE: "none" }).AUD_DEFAULT_ROLE, "none");
  assert.throws(() => baseEnv({ AUD_PLATFORM_CERT_PATH: "cert.pem" }), /absolute/);
  assert.throws(() => baseEnv({ AUD_ANONYMOUS_SP: "true", API_BIND_HOST: "0.0.0.0" }), /loopback/);
  assert.equal(baseEnv({ AUD_ANONYMOUS_SP: "true" }).API_BIND_HOST, "127.0.0.1");
  assert.throws(() => baseEnv({ CORS_ORIGIN: "*" }), /CORS_ORIGIN/);
  assert.equal(baseEnv().AUD_ANONYMOUS_SP, false, "secure by default");
});

test("routes with sample data answer an anonymous caller with the sample and note signin_required", async () => {
  let body: unknown;
  const res = { headersSent: false, writableEnded: false, json: (b: unknown) => { body = b; }, status() { return this; }, setHeader() {} };
  await respondWithFallback(res as never, async () => { throw new HttpError(401, "signin_required", "x"); }, { items: [] as number[] }, "t");
  assert.deepEqual(body, { items: [], source: "mock", note: "signin_required" });
});

test("a signed-in caller never gets sample numbers for a failed live read; samples always say so", async () => {
  const call = async (load: () => Promise<{ items: number[] } | null>, bearer?: string) => {
    let body: unknown; let status = 200;
    const res = { req: { auth: bearer ? { bearerToken: bearer } : undefined }, headersSent: false, writableEnded: false,
      json: (b: unknown) => { body = b; }, status(s: number) { status = s; return this; }, setHeader() {} };
    await respondWithFallback(res as never, load, { items: [42] }, "t");
    return { status, body };
  };
  const throttled = await call(async () => { throw new Error("ARM 429: 429: Too many requests. Please retry."); }, "tok");
  assert.equal(throttled.status, 429);
  assert.deepEqual((throttled.body as { error: string }).error, "azure_throttled");
  const denied = await call(async () => { throw new Error("ARM 401: RBACAccessDenied: The client does not have authorization"); }, "tok");
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "azure_forbidden");
  assert.equal((await call(async () => { throw new Error("socket hang up"); }, "tok")).status, 502);
  assert.deepEqual((await call(async () => null, "tok")).body, { items: [42], source: "mock", note: "mock data" }, "feature off: labelled sample");
  assert.deepEqual((await call(async () => null)).body, { items: [42], source: "mock", note: "signin_required" });
  assert.deepEqual((await call(async () => ({ items: [1] }), "tok")).body, { items: [1] });
});

test("diagram store: a user's diagram is theirs; anonymous sees only the public samples", () => {
  const spec = (id: string) => ({ version: "1", id, name: id, createdAt: "", updatedAt: "", groups: [], settings: { refreshIntervalSec: 30, defaultTimeRange: "5m", layout: "manual" as const }, nodes: [], edges: [] });
  saveDiagramSpec(spec("sample-x"));
  saveDiagramSpec(spec("auto-iso"), "u:t1:alice");
  assert.ok(getDiagramSpec("auto-iso", "u:t1:alice"));
  assert.equal(getDiagramSpec("auto-iso", "u:t1:bob"), undefined, "another user cannot read it");
  assert.equal(getDiagramSpec("auto-iso"), undefined, "anonymous cannot read it");
  assert.ok(getDiagramSpec("sample-x", "u:t1:bob"), "samples are public");
  assert.ok(!listDiagramSpecs().some((d) => d.id === "auto-iso"));
  assert.ok(listDiagramSpecs("u:t1:alice").some((d) => d.id === "auto-iso"));
});

test("cache prefix: per user until access is initialised; then shared per connection set, per user for delegated", () => {
  setCacheScopeResolver(null);
  const tok = (tid: string, oid: string, n: number, roles: string[] = []) => jwt({ tid, oid, n, roles });
  assert.equal(cachePrefix(tok("t1", "o1", 1)), cachePrefix(tok("t1", "o1", 2)), "a renewed token keeps the user's cache");
  assert.notEqual(cachePrefix(tok("t1", "o1", 1)), cachePrefix(tok("t2", "o1", 1)), "same oid, other tenant → other cache");
  assert.equal(cachePrefix(undefined), "sp");

  initPlatformAccess(baseEnv());
  const alice = tok("t1", "alice", 1, ["AUD.Viewer"]), bob = tok("t1", "bob", 1, ["AUD.Viewer"]);
  assert.equal(cachePrefix(alice), "c:home", "same connections through the platform credential → same data");
  assert.equal(cachePrefix(alice), cachePrefix(bob));
  assert.notEqual(principalKey(alice), principalKey(bob), "ownership (saved diagrams) stays personal");
  initPlatformAccess(baseEnv({ AUD_HOME_CONNECTION_MODE: "delegated" }));
  assert.notEqual(cachePrefix(alice), cachePrefix(bob), "OBO data is per user");
  initPlatformAccess(baseEnv({ AUD_DEFAULT_ROLE: "none" }));
  assert.match(cachePrefix(tok("t1", "carol", 1)), /^u:/, "no role → never a shared entry");
  setCacheScopeResolver(null);
});

test("kubeconfig: exec plugins are removed; a cluster that needs them is unsupported (no kubelogin on the host)", () => {
  const kc = (user: Record<string, unknown>) => {
    const c = new k8s.KubeConfig();
    c.loadFromOptions({ clusters: [{ name: "c", server: "https://x", skipTLSVerify: false }], users: [{ name: "u", ...user }], contexts: [{ name: "ctx", cluster: "c", user: "u" }], currentContext: "ctx" });
    return c;
  };
  assert.throws(() => sanitizeKubeconfig(kc({ exec: { command: "kubelogin", args: ["get-token"] } })), (e: HttpError) => e.code === "aad_cluster_unsupported" && e.status === 501);
  const ok = sanitizeKubeconfig(kc({ certData: "Y2VydA==", keyData: "a2V5", exec: { command: "evil" } }));
  assert.equal(ok.getCurrentUser()?.exec, undefined);
  assert.equal(ok.getCurrentUser()?.certData, "Y2VydA==");
});

test("static: credentials are constructed only in connectionCredentials.ts / oboTokenPool.ts; services never touch OBO", () => {
  const root = join(import.meta.dirname, "../src");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(root);
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    if (!f.endsWith("connectionCredentials.ts") && !f.endsWith("oboTokenPool.ts")) {
      assert.ok(!/new (ClientSecretCredential|ClientCertificateCredential|ClientAssertionCredential|WorkloadIdentityCredential|ManagedIdentityCredential|OnBehalfOfCredential)\(/.test(s), `${f} constructs a credential`);
    }
    if (f.includes(`${join("src", "services")}`) || f.includes(`${join("src", "routes")}`)) {
      assert.ok(!/oboTokenPool/.test(s), `${f} reaches OBO directly`);
    }
  }
});

test("a connection that may read a cluster but not fetch its credentials gets a clear 403, not a 500", async () => {
  const { kubeconfigError } = await import("../src/services/kubernetes.js");
  const { loadEnv } = await import("../src/env.js");
  const env = loadEnv({ AZURE_AD_TENANT_ID: "00000000-0000-0000-0000-000000000001", AZURE_SUBSCRIPTION_IDS: "00000000-0000-0000-0000-0000000000aa" });
  const id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourcegroups/rg/providers/microsoft.containerservice/managedclusters/aks";
  const denied = new Error("ARM 403: AuthorizationFailed: The client '…' does not have authorization to perform action 'microsoft.containerservice/managedclusters/listClusterUserCredential/action' over …");
  const mapped = kubeconfigError(denied, id, env) as HttpError;
  assert.equal(mapped.status, 403);
  assert.equal(mapped.code, "aks_credential_forbidden");
  assert.match(mapped.message, /Azure Kubernetes Service Cluster User Role/);
  const other = new Error("ARM 500: InternalServerError");
  assert.equal(kubeconfigError(other, id, env), other, "other failures pass through unchanged");
});
