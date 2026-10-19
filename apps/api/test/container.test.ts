// Running in a container (on-prem Docker, AKS pod): lifecycle helpers, the platform identity through workload
// identity (no secret), and the switches that keep a server from calling endpoints it should not. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/env.js";
import { canKillPortHolder, healthBody, isBenignSocketError, onUncaught } from "../src/infra/lifecycle.js";
import { platformClientId, platformCredentialKind } from "../src/infra/connectionRegistry.js";
import { createCredentialProvider } from "../src/infra/connectionCredentials.js";
import { statusFeedUrls, translateTexts, translatorKeyless } from "../src/services/health.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const SSO_APP = "22222222-2222-2222-2222-222222222222";
const MI = "33333333-3333-3333-3333-333333333333";
const TOKEN = "/var/run/secrets/azure/tokens/azure-identity-token";
const env = (over: Record<string, string> = {}) => loadEnv({ AZURE_AD_TENANT_ID: HOME, AZURE_AD_CLIENT_ID: SSO_APP, AZURE_SUBSCRIPTION_IDS: "44444444-4444-4444-4444-444444444444", ...over });
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("lifecycle: dropped sockets never stop the server; production exits on anything else; the port killer is Windows dev only", () => {
  assert.ok(isBenignSocketError(Object.assign(new Error("x"), { code: "ECONNRESET" })));
  assert.ok(!isBenignSocketError(new Error("boom")));
  assert.equal(onUncaught(Object.assign(new Error("x"), { code: "EPIPE" }), "production"), "ignore");
  assert.equal(onUncaught(new TypeError("bug"), "production"), "exit");
  assert.equal(onUncaught(new TypeError("bug"), "development"), "ignore");
  assert.equal(canKillPortHolder("win32", "development"), true);
  assert.equal(canKillPortHolder("linux", "development"), false, "a container never runs netstat/taskkill");
  assert.equal(canKillPortHolder("win32", "production"), false);
  assert.deepEqual(healthBody(undefined), { ok: true, version: "dev" });
  assert.deepEqual(healthBody("1.2.3"), { ok: true, version: "1.2.3" });
});

test("platform credential: explicit kind wins, else certificate > secret > token file; workload identity signs in as the managed identity", () => {
  assert.equal(platformCredentialKind(env({ AZURE_AD_CLIENT_SECRET: "s" })), "secret");
  assert.equal(platformCredentialKind(env({ AZURE_AD_CLIENT_SECRET: "s", AUD_PLATFORM_CERT_PATH: "/etc/aud/platform.pem" })), "certificate");
  assert.equal(platformCredentialKind(env({ AZURE_FEDERATED_TOKEN_FILE: TOKEN, AZURE_CLIENT_ID: MI })), "workloadIdentity");
  assert.equal(platformCredentialKind(env()), null);
  const wi = env({ AUD_PLATFORM_CREDENTIAL: "workloadIdentity", AZURE_FEDERATED_TOKEN_FILE: TOKEN, AZURE_CLIENT_ID: MI });
  assert.equal(platformClientId(wi), MI, "the managed identity — not the SSO app (it stays the token audience)");
  assert.equal(platformClientId(env({ AZURE_AD_CLIENT_SECRET: "s" })), SSO_APP);
  assert.throws(() => env({ AUD_PLATFORM_CREDENTIAL: "workloadIdentity", AZURE_CLIENT_ID: MI }), /AUD_FEDERATED_TOKEN_FILE/);
  assert.throws(() => env({ AUD_PLATFORM_CREDENTIAL: "workloadIdentity", AUD_FEDERATED_TOKEN_FILE: TOKEN }), /AUD_PLATFORM_CLIENT_ID/);
  assert.throws(() => env({ AUD_PLATFORM_CREDENTIAL: "certificate" }), /AUD_PLATFORM_CERT_PATH/);
  assert.throws(() => env({ AUD_PLATFORM_CLIENT_ID: "not-a-guid" }), /GUID/);
});

test("platform workload identity: the pod's token, read on every request, is the assertion for the managed identity in the home tenant", async () => {
  const calls: string[] = [];
  let content = "sa-token-1";
  const provider = createCredentialProvider({
    makeSecret: () => { throw new Error("no secret expected"); },
    makeCert: () => { throw new Error("no certificate expected"); },
    makeAssertion: (t, c, get) => ({ getToken: async () => { calls.push(`${t}:${c}:${await get()}`); return { token: jwt({ tid: t }), expiresOnTimestamp: Date.now() + 3600_000 }; } }),
    readFile: async (p) => { if (p !== TOKEN) throw new Error("ENOENT"); return content; },
    oboCredential: () => { throw new Error("no OBO"); },
    getEnv: () => undefined,
  });
  const e = env({ AUD_PLATFORM_CREDENTIAL: "workloadIdentity", AZURE_FEDERATED_TOKEN_FILE: TOKEN, AZURE_CLIENT_ID: MI });
  const cred = provider.platformCredential(e);
  await cred.getToken("https://management.azure.com/.default");
  content = "sa-token-2\n";
  await cred.getToken("https://management.azure.com/.default");
  assert.deepEqual(calls, [`${HOME}:${MI}:sa-token-1`, `${HOME}:${MI}:sa-token-2`]);
});

test("translator: the keyless endpoint is off in production unless switched on; status feeds can be pointed elsewhere (https only)", async () => {
  assert.equal(translatorKeyless(env()), true, "development default");
  assert.equal(translatorKeyless(env({ NODE_ENV: "production" })), false);
  assert.equal(translatorKeyless(env({ NODE_ENV: "production", AUD_TRANSLATOR_KEYLESS: "true" })), true);
  let called = 0;
  const fakeFetch = (async () => { called++; return new Response("[]", { status: 200 }); }) as typeof fetch;
  const r = await translateTexts(env({ NODE_ENV: "production", AUD_TRANSLATOR_KEYLESS: "false" }), ["An unusual sentence for the container test"], "ko", "en", fakeFetch);
  assert.deepEqual(r, { ok: false, reason: "not_configured" });
  assert.equal(called, 0, "no request leaves the server");
  assert.equal(statusFeedUrls(env()).length, 2);
  assert.deepEqual(statusFeedUrls(env({ AZURE_STATUS_FEED_URLS: "https://status.example.com/feed/, https://mirror.example.com/feed" })), ["https://status.example.com/feed/", "https://mirror.example.com/feed"]);
  assert.throws(() => env({ AZURE_STATUS_FEED_URLS: "http://plain.example.com/feed" }), /https/);
});
