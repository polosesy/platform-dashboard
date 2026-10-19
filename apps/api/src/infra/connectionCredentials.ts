// Credentials of the Azure connections — the only place (with oboTokenPool.ts) that constructs an Azure credential.
// Unit-tested from apps/api/test/connectionCredentials.test.ts with injected factories (no network).
//
//   platform / lighthouse → the platform identity: AZURE_AD_CLIENT_ID in the home tenant, certificate
//                           (AUD_PLATFORM_CERT_PATH) or AZURE_AD_CLIENT_SECRET — one pooled credential
//   servicePrincipal      → the connection's own app in its own tenant, secret from the env var it names, a certificate,
//                           or workload identity federation (our pod's service-account token as the client assertion)
//   delegated             → the signed-in user's OBO token (oboTokenPool) — no user, no token
//
// A failing connection never falls back to another connection, credential or mode.
import { decodeJwt } from "jose";
import { readFile } from "node:fs/promises";
import { ClientAssertionCredential, ClientCertificateCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";
import type { Env } from "../env.js";
import { credentialGroup, federatedTokenFile, homeConnection, platformClientId, platformCredentialKind, type AzureConnection } from "./connectionRegistry.js";
import { getOBOCredential } from "./oboTokenPool.js";
import { mapOboError } from "./oboErrors.js";
import { HttpError, maskGuids } from "./requestParams.js";

const TOKEN_TIMEOUT_MS = 10_000;

export type CredentialDeps = {
  makeSecret: (tenantId: string, clientId: string, secret: string) => TokenCredential;
  makeCert: (tenantId: string, clientId: string, certificatePath: string) => TokenCredential;
  /** Federation: the assertion (a service-account JWT) is fetched on every token request */
  makeAssertion: (tenantId: string, clientId: string, getAssertion: () => Promise<string>) => TokenCredential;
  readFile: (path: string) => Promise<string>;
  oboCredential: (env: Env, bearerToken: string) => TokenCredential;
  getEnv: (name: string) => string | undefined;
};

const defaultDeps: CredentialDeps = {
  makeSecret: (t, c, s) => new ClientSecretCredential(t, c, s),
  makeCert: (t, c, path) => new ClientCertificateCredential(t, c, { certificatePath: path }),
  makeAssertion: (t, c, get) => new ClientAssertionCredential(t, c, get),
  readFile: (path) => readFile(path, "utf8"),
  oboCredential: getOBOCredential,
  getEnv: (name) => process.env[name],
};

export const signinRequiredError = () => new HttpError(401, "signin_required", "Sign in to read Azure data");

/** AAD / credential failures → a coded, masked HttpError (the raw text names apps, tenants and trace ids) */
export function mapCredentialError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const raw = e instanceof Error ? e.message : String(e);
  const code = /AADSTS(\d+)/.exec(raw)?.[1];
  switch (code) {
    case "700016": return new HttpError(403, "connection_not_consented", "The platform app is not consented in the connection's tenant");
    case "7000215": case "7000222": case "700027": return new HttpError(503, "connection_credential_invalid", "The connection's secret or certificate is invalid or expired");
    case "90002": case "50020": return new HttpError(502, "connection_tenant_mismatch", "The connection's tenant cannot issue this token");
    // Federation: the app has no federated credential matching our token (issuer / subject) — see Azure Pipelines'
    // workload identity troubleshooting table; a credential just created can also fail for a few minutes (cache)
    case "70021": case "700211": case "700213": return new HttpError(503, "connection_federation_mismatch", "The app's federated credential does not match this platform's issuer or subject");
  }
  if (/timed out/i.test(raw)) return new HttpError(504, "connection_timeout", "Token request timed out");
  return new HttpError(502, "connection_failed", maskGuids(raw.replace(/Trace ID:.*$/is, "")).slice(0, 200));
}

async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("token request timed out")), TOKEN_TIMEOUT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function createCredentialProvider(deps: CredentialDeps = defaultDeps) {
  const pool = new Map<string, TokenCredential>();

  /** A projected service-account token as the client assertion — read on every request (the kubelet rotates it) */
  function fileAssertion(file: string, who: string): () => Promise<string> {
    return async () => {
      try {
        const jwt = (await deps.readFile(file)).trim();
        if (!jwt) throw new Error("empty");
        return jwt;
      } catch {
        // Names the variable, never the path
        throw new HttpError(503, "connection_unconfigured", `The federated token file (AUD_FEDERATED_TOKEN_FILE) cannot be read for ${who}`);
      }
    };
  }

  function platformCredential(env: Env): TokenCredential {
    const hit = pool.get("platform");
    if (hit) return hit;
    const kind = platformCredentialKind(env);
    const tenant = env.AZURE_AD_TENANT_ID, client = platformClientId(env);
    if (!tenant || !client) throw new HttpError(503, "connection_unconfigured", kind === "workloadIdentity" ? "AZURE_AD_TENANT_ID / AUD_PLATFORM_CLIENT_ID (managed identity) are not set" : "AZURE_AD_TENANT_ID / AZURE_AD_CLIENT_ID are not set");
    let cred: TokenCredential;
    if (kind === "certificate" && env.AUD_PLATFORM_CERT_PATH) cred = deps.makeCert(tenant, client, env.AUD_PLATFORM_CERT_PATH);
    else if (kind === "secret" && env.AZURE_AD_CLIENT_SECRET) cred = deps.makeSecret(tenant, client, env.AZURE_AD_CLIENT_SECRET);
    else if (kind === "workloadIdentity" && federatedTokenFile(env)) {
      // A user-assigned managed identity through workload identity: our pod's token is the assertion for the MI's
      // client id in the home tenant — no secret anywhere (the MI's federated credential trusts this service account)
      cred = deps.makeAssertion(tenant, client, fileAssertion(federatedTokenFile(env)!, "the platform identity"));
    } else throw new HttpError(503, "connection_unconfigured", "Set AUD_PLATFORM_CERT_PATH, AZURE_AD_CLIENT_SECRET or AUD_PLATFORM_CREDENTIAL=workloadIdentity");
    pool.set("platform", cred);
    return cred;
  }

  function servicePrincipalCredential(env: Env, c: AzureConnection): TokenCredential {
    const id = `sp:${c.key}`;
    const hit = pool.get(id);
    if (hit) return hit;
    let cred: TokenCredential;
    if (c.federation) {
      const file = federatedTokenFile(env);
      if (!file) throw new HttpError(503, "connection_unconfigured", `AUD_FEDERATED_TOKEN_FILE is not set for connection "${c.key}"`);
      // The kubelet rotates the projected token: read it on every request. The connection's own tenant and app —
      // never the webhook's AZURE_CLIENT_ID / AZURE_TENANT_ID (those name our own identity, not the customer's app)
      cred = deps.makeAssertion(c.tenantId, c.clientId!, fileAssertion(file, `connection "${c.key}"`));
    } else if (c.certificatePath) cred = deps.makeCert(c.tenantId, c.clientId!, c.certificatePath);
    else {
      const secret = deps.getEnv(c.secretEnv!);
      // Names the variable, never a value
      if (!secret) throw new HttpError(503, "connection_unconfigured", `${c.secretEnv} is not set for connection "${c.key}"`);
      cred = deps.makeSecret(c.tenantId, c.clientId!, secret);
    }
    pool.set(id, cred);
    return cred;
  }

  /** The credential of a connection (SDK clients). delegated needs the user's verified token. */
  function credential(env: Env, c: AzureConnection, bearerToken?: string): TokenCredential {
    const group = credentialGroup(env, c);
    if (group === "delegated") {
      if (!bearerToken) throw signinRequiredError();
      return deps.oboCredential(env, bearerToken);
    }
    return group === "platform" ? platformCredential(env) : servicePrincipalCredential(env, c);
  }

  /** The tenant the token must come from: home for the platform identity, the connection's tenant for its own SP */
  function expectedTenant(env: Env, c: AzureConnection): string {
    return credentialGroup(env, c) === "platform" ? homeConnection(env).tenantId : c.tenantId;
  }

  async function token(env: Env, c: AzureConnection, scope: string, bearerToken?: string): Promise<string> {
    const delegated = credentialGroup(env, c) === "delegated";
    let issued: string;
    try {
      const t = await withTimeout(credential(env, c, bearerToken).getToken(scope));
      if (!t?.token) throw new Error("no token");
      issued = t.token;
    } catch (e) {
      throw delegated ? mapOboError(e) : mapCredentialError(e);
    }
    if (!delegated) {
      // A misconfigured tenant id must not silently read another tenant
      let tid = "";
      try { tid = String(decodeJwt(issued).tid ?? "").toLowerCase(); } catch { /* opaque token: nothing to compare */ }
      if (tid && tid !== expectedTenant(env, c)) throw new HttpError(502, "connection_tenant_mismatch", "The token came from a different tenant than the connection");
    }
    return issued;
  }

  return { credential, token, platformCredential, reset: () => pool.clear() };
}

export type CredentialProvider = ReturnType<typeof createCredentialProvider>;

let provider: CredentialProvider = createCredentialProvider();
export const credentials = () => provider;
/** Tests only: swap the factories */
export function setCredentialProviderForTests(p: CredentialProvider): void {
  provider = p;
}
