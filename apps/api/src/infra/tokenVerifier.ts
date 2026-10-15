// Bearer token verification (Entra ID access tokens for this API) — pure apart from the injected key source,
// unit-tested from apps/api/test/tokenVerifier.test.ts with a local key set (no network).
//
// A token that is present must prove itself: signature (RS256, the tenant's published keys), issuer (v1 or v2
// endpoint of an allowed tenant), audience (this API), lifetime, a delegated scope of this API, and a user
// object id. A token that fails never becomes "anonymous" and never reaches the service principal.
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type Principal = { tid: string; oid: string; name?: string; scp: string[]; roles: string[] };

/** 401 / 403 / 503 with a stable code the web understands */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_token" | "token_expired" | "insufficient_scope" | "tenant_not_allowed" | "auth_unavailable",
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
  }
}

export type TokenVerifierOptions = {
  /** Signing keys of one tenant (default: its v2 discovery keys endpoint) */
  getJwks: (tid: string) => JWTVerifyGetKey;
  /** Accepted `aud` values: `api://{clientId}` (v1 tokens) and `{clientId}` (v2 tokens) */
  audiences: string[];
  /** Tenants whose users may call this API (home tenant; later: the tenant registry) */
  allowedTenants: ReadonlySet<string>;
  /** Delegated scopes of this API — the token's `scp` must contain at least one */
  scopes: string[];
  clockToleranceSec?: number;
  /** Tests pin the clock */
  currentDate?: () => Date;
};

const TID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenVerifier(o: TokenVerifierOptions) {
  return {
    async verify(token: string): Promise<Principal> {
      // 1. Which tenant? (read without trusting it, only to pick the key set — never fetch keys for a stranger)
      let claims: JWTPayload;
      try {
        claims = decodeJwt(token);
      } catch {
        throw new AuthError(401, "invalid_token", "malformed");
      }
      const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
      if (!TID.test(tid)) throw new AuthError(401, "invalid_token", "tid");
      if (!o.allowedTenants.has(tid)) throw new AuthError(403, "tenant_not_allowed");

      // 2. Signature, issuer, audience, lifetime
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, o.getJwks(tid), {
          algorithms: ["RS256"],
          issuer: [`https://sts.windows.net/${tid}/`, `https://login.microsoftonline.com/${tid}/v2.0`],
          audience: o.audiences,
          clockTolerance: o.clockToleranceSec ?? 60,
          ...(o.currentDate ? { currentDate: o.currentDate() } : {}),
        }));
      } catch (e) {
        throw mapJoseError(e);
      }

      // 3. A user, with a delegated scope of this API (app-only tokens carry `roles`, not `scp`)
      const scp = typeof payload.scp === "string" ? payload.scp.split(" ").filter(Boolean) : [];
      if (!scp.some((s) => o.scopes.includes(s))) throw new AuthError(403, "insufficient_scope");
      const oid = typeof payload.oid === "string" ? payload.oid.toLowerCase() : "";
      if (!oid) throw new AuthError(401, "invalid_token", "oid");
      const roles = Array.isArray(payload.roles) ? payload.roles.map(String) : [];
      const name = typeof payload.name === "string" ? payload.name : undefined;
      return { tid, oid, scp, roles, ...(name ? { name } : {}) };
    },
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

function mapJoseError(e: unknown): AuthError {
  if (e instanceof errors.JWTExpired) return new AuthError(401, "token_expired");
  if (e instanceof errors.JWKSTimeout) return new AuthError(503, "auth_unavailable", "jwks_timeout");
  if (e instanceof errors.JWKSNoMatchingKey) return new AuthError(401, "invalid_token", "kid");
  if (e instanceof errors.JOSEAlgNotAllowed) return new AuthError(401, "invalid_token", "alg");
  if (e instanceof errors.JWSSignatureVerificationFailed) return new AuthError(401, "invalid_token", "signature");
  if (e instanceof errors.JWTClaimValidationFailed) return new AuthError(401, "invalid_token", e.claim);
  if (e instanceof errors.JOSEError) return new AuthError(401, "invalid_token", e.code);
  // Not a token problem: the key endpoint could not be reached
  return new AuthError(503, "auth_unavailable");
}

/** One remote key set per tenant (cached by jose, refreshed on an unknown kid) */
export function remoteJwks(): (tid: string) => JWTVerifyGetKey {
  const sets = new Map<string, JWTVerifyGetKey>();
  return (tid) => {
    let s = sets.get(tid);
    if (!s) {
      s = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`), { timeoutDuration: 5000 });
      sets.set(tid, s);
    }
    return s;
  };
}
