import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { AuthError, createTokenVerifier } from "../src/infra/tokenVerifier.js";

// ── local keys: no network ──
const TID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const CLIENT = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-10-14T06:00:00Z");
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const foreign = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwks = createLocalJWKSet({ keys: [jwk] });

const verifier = createTokenVerifier({
  getJwks: () => jwks,
  audiences: [`api://${CLIENT}`, CLIENT],
  allowedTenants: new Set([TID]),
  scopes: ["Azure.Read.All"],
  currentDate: () => NOW,
});

type Claims = Record<string, unknown>;
const base = (over: Claims = {}): Claims => ({ tid: TID, oid: "44444444-4444-4444-4444-444444444444", scp: "Azure.Read.All", name: "Ops", ...over });
async function sign(claims: Claims, o: { iss?: string; aud?: string; exp?: number; nbf?: number; kid?: string; key?: CryptoKey } = {}) {
  const t = Math.floor(NOW.getTime() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
    .setIssuer(o.iss ?? `https://sts.windows.net/${claims.tid}/`)
    .setAudience(o.aud ?? `api://${CLIENT}`)
    .setIssuedAt(t - 60)
    .setNotBefore(o.nbf ?? t - 60)
    .setExpirationTime(o.exp ?? t + 3600)
    .sign(o.key ?? privateKey);
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { assert.ok(e instanceof AuthError, String(e)); return e.code + (e.reason ? `:${e.reason}` : ""); }
}

test("valid v1 and v2 tokens give the user principal", async () => {
  const p = await verifier.verify(await sign(base()));
  assert.deepEqual({ tid: p.tid, oid: p.oid, scp: p.scp }, { tid: TID, oid: "44444444-4444-4444-4444-444444444444", scp: ["Azure.Read.All"] });
  assert.equal(await code(verifier.verify(await sign(base(), { iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: CLIENT }))), "ok");
});

test("expired, not yet valid, wrong audience or issuer, unknown or foreign key, tampered — all rejected", async () => {
  const t = Math.floor(NOW.getTime() / 1000);
  assert.equal(await code(verifier.verify(await sign(base(), { exp: t - 61, nbf: t - 3600 }))), "token_expired");
  assert.equal(await code(verifier.verify(await sign(base(), { exp: t - 30, nbf: t - 3600 }))), "ok", "60 s clock tolerance");
  assert.match(await code(verifier.verify(await sign(base(), { nbf: t + 600 }))), /^invalid_token/);
  assert.equal(await code(verifier.verify(await sign(base(), { aud: "api://someone-else" }))), "invalid_token:aud");
  assert.equal(await code(verifier.verify(await sign(base(), { iss: "https://evil.example/" }))), "invalid_token:iss");
  assert.equal(await code(verifier.verify(await sign(base(), { kid: "nope" }))), "invalid_token:kid");
  assert.equal(await code(verifier.verify(await sign(base(), { key: foreign.privateKey }))), "invalid_token:signature");
  const good = await sign(base());
  const [h, , s] = good.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...base({ name: "Admin" }), iss: `https://sts.windows.net/${TID}/`, aud: `api://${CLIENT}`, exp: t + 3600 })).toString("base64url")}.${s}`;
  assert.equal(await code(verifier.verify(forged)), "invalid_token:signature", "tampered payload");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(base())).toString("base64url")}.`;
  assert.match(await code(verifier.verify(none)), /^invalid_token/, "alg none");
  assert.equal(await code(verifier.verify("abc")), "invalid_token:malformed");
});

test("another tenant, an app-only token or a missing scope are refused; an unreachable key endpoint is 503", async () => {
  assert.equal(await code(verifier.verify(await sign(base({ tid: OTHER })))), "tenant_not_allowed");
  assert.equal(await code(verifier.verify(await sign(base({ scp: undefined, roles: ["Reader"] })))), "insufficient_scope");
  assert.equal(await code(verifier.verify(await sign(base({ scp: "User.Read" })))), "insufficient_scope");
  assert.equal(await code(verifier.verify(await sign(base({ oid: undefined })))), "invalid_token:oid");
  const down = createTokenVerifier({ getJwks: () => async () => { throw new TypeError("fetch failed"); }, audiences: [`api://${CLIENT}`], allowedTenants: new Set([TID]), scopes: ["Azure.Read.All"], currentDate: () => NOW });
  assert.equal(await code(down.verify(await sign(base()))), "auth_unavailable");
});
