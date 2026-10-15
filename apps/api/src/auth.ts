import type { Request, Response, NextFunction } from "express";
import type { Env } from "./env.js";
import { AuthError, createTokenVerifier, remoteJwks, type Principal, type TokenVerifier } from "./infra/tokenVerifier.js";

/**
 * Who is calling. `bearerToken` is set only for a verified user — services that pass it on to OBO never see an
 * unverified token, and an invalid token never becomes "anonymous" (it is refused before any route runs).
 */
export type AuthContext =
  | { kind: "anonymous"; bearerToken?: undefined; principal?: undefined }
  | { kind: "user"; bearerToken: string; principal: Principal };

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/** The verifier for this deployment: home tenant (later: the tenant registry), this API's audience and scopes */
export function verifierFromEnv(env: Env, allowedTenants?: ReadonlySet<string>): TokenVerifier {
  const clientId = env.AZURE_AD_CLIENT_ID ?? "";
  const audiences = env.AUD_AUTH_AUDIENCES?.split(",").map((s) => s.trim()).filter(Boolean)
    ?? (clientId ? [`api://${clientId}`, clientId] : []);
  return createTokenVerifier({
    getJwks: remoteJwks(),
    audiences,
    allowedTenants: allowedTenants ?? new Set(env.AZURE_AD_TENANT_ID ? [env.AZURE_AD_TENANT_ID.toLowerCase()] : []),
    scopes: env.AUD_AUTH_SCOPES.split(",").map((s) => s.trim()).filter(Boolean),
  });
}

function refuse(res: Response, e: AuthError) {
  if (e.status === 401) res.setHeader("WWW-Authenticate", `Bearer error="${e.code === "token_expired" ? "invalid_token" : e.code}"`);
  res.status(e.status).json({ error: e.code, message: e.code, ...(e.reason ? { reason: e.reason } : {}) });
}

/** No Authorization header → anonymous. A header must carry a valid token, or the request ends here (401/403/503). */
export function createAuthMiddleware(verifier: TokenVerifier) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header) {
      req.auth = { kind: "anonymous" };
      return next();
    }
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return refuse(res, new AuthError(401, "invalid_token", "scheme"));
    const token = m[1]!;
    // Express 4 does not catch rejected promises — explicit then / catch
    verifier.verify(token).then(
      (principal) => {
        req.auth = { kind: "user", bearerToken: token, principal };
        next();
      },
      (e: unknown) => refuse(res, e instanceof AuthError ? e : new AuthError(503, "auth_unavailable")),
    );
  };
}
