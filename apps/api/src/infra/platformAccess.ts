// Platform authorization — who may use the platform (SSO sign-in + app roles) and which Azure connections a role may
// read through. Unit-tested from apps/api/test/platformAccess.test.ts.
//
//   role  = the highest of the token's app roles AUD.Viewer < AUD.Operator < AUD.Admin (the `roles` claim of a token
//           the auth middleware verified). No app role → AUD_DEFAULT_ROLE (development default "viewer", production "none").
//   connection access = the connection's `roles` list (default: every role); admins reach every connection.
import { decodeJwt } from "jose";
import type { NextFunction, Request, Response } from "express";
import type { PlatformRole } from "@aud/types";
import type { Env } from "../env.js";
import { credentialGroup, getConnections, type AzureConnection } from "./connectionRegistry.js";
import { setCacheScopeResolver } from "./cacheManager.js";
import { HttpError, sendError } from "./requestParams.js";

const RANK: Record<PlatformRole, number> = { viewer: 1, operator: 2, admin: 3 };
const CLAIM: Record<string, PlatformRole> = { "aud.viewer": "viewer", "aud.operator": "operator", "aud.admin": "admin" };

export const roleAtLeast = (role: PlatformRole | null, min: PlatformRole) => !!role && RANK[role] >= RANK[min];

export function defaultRole(env: Env): PlatformRole | null {
  const d = env.AUD_DEFAULT_ROLE ?? (env.NODE_ENV === "production" ? "none" : "viewer");
  return d === "none" ? null : d;
}

/** The platform role carried by a verified token's `roles` claim, else the deployment default */
export function platformRole(env: Env, roles: readonly string[]): { role: PlatformRole | null; fromDefault: boolean } {
  let best: PlatformRole | null = null;
  for (const r of roles) {
    const role = CLAIM[r.toLowerCase()];
    if (role && (!best || RANK[role] > RANK[best])) best = role;
  }
  if (best) return { role: best, fromDefault: false };
  const d = defaultRole(env);
  return { role: d, fromDefault: !!d };
}

export type Caller = { tid: string; oid: string; role: PlatformRole | null };

const callersByEnv = new WeakMap<Env, Map<string, Caller>>();

/**
 * The caller behind a bearer token — services receive only the token, which the auth middleware verified before any
 * route ran. Memoised per token (bounded).
 */
export function callerOf(env: Env, bearerToken: string | undefined): Caller | null {
  if (!bearerToken) return null;
  let callers = callersByEnv.get(env);
  if (!callers) callersByEnv.set(env, (callers = new Map()));
  const hit = callers.get(bearerToken);
  if (hit) return hit;
  let caller: Caller;
  try {
    const c = decodeJwt(bearerToken);
    const roles = Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === "string") : [];
    caller = { tid: String(c.tid ?? ""), oid: String(c.oid ?? c.sub ?? ""), role: platformRole(env, roles).role };
  } catch {
    caller = { tid: "", oid: "", role: null };
  }
  if (callers.size > 2000) callers.clear();
  callers.set(bearerToken, caller);
  return caller;
}

export const canUse = (c: AzureConnection, role: PlatformRole | null) => !!role && (role === "admin" || c.roles.includes(role));

export function accessibleConnections(env: Env, role: PlatformRole | null): AzureConnection[] {
  return getConnections(env).filter((c) => canUse(c, role));
}

/**
 * Boot: callers who read only through platform credentials share cache entries per connection set (`c:home,cust-a`);
 * anyone reaching a delegated (OBO) connection keeps per-user entries.
 */
export function initPlatformAccess(env: Env): void {
  setCacheScopeResolver((bearerToken) => {
    const role = callerOf(env, bearerToken)?.role ?? null;
    if (!role) return null;
    const conns = accessibleConnections(env, role);
    if (!conns.length || conns.some((c) => credentialGroup(env, c) === "delegated")) return null;
    return `c:${conns.map((c) => c.key).sort().join(",")}`;
  });
}

export const roleRequired =(min: PlatformRole) => new HttpError(403, "role_required", `This needs the ${min} role`);
export const connectionForbidden = () => new HttpError(403, "connection_forbidden", "Your role cannot read this Azure connection");

/** Route gate: a signed-in user with at least `min` (anonymous → signin_required through the routes' own handling) */
export function requireRole(env: Env, min: PlatformRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.bearerToken) return next();
    if (roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, min)) return next();
    sendError(res, roleRequired(min), "role_required");
  };
}
