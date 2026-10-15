// Platform authorization — runs after the token was verified (auth.ts), before any route:
//   1. a signed-in user needs a platform role (app role, or AUD_DEFAULT_ROLE) — 403 no_platform_role, except /api/me
//   2. a subscription named in the query (subscriptionId, or inside an ARM id) must belong to a connection the role
//      may read — 403 connection_forbidden before any cache read or Azure call (the fetchers check again per request)
//   3. AUD_AUDIT_LOG=stdout: one JSON line per signed-in request — who (last 4 of oid) · role · connection · route ·
//      status. Never a token, a query string, a body or a full GUID.
import type { NextFunction, Request, Response } from "express";
import type { PlatformRole } from "@aud/types";
import type { Env } from "../env.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { callerOf, canUse, connectionForbidden } from "../infra/platformAccess.js";
import { HttpError, sendError } from "../infra/requestParams.js";

declare global {
  namespace Express {
    interface Request {
      access?: { role: PlatformRole | null; connection?: string };
    }
  }
}

const SUB = /(?:^|\/subscriptions\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[/?])/gi;

/** Subscriptions a request names: `subscriptionId` and any `/subscriptions/{guid}` inside query values */
export function subscriptionsInQuery(query: Request["query"]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, name?: string) => {
    if (typeof v === "string") {
      if (name === "subscriptionId" && /^[0-9a-f-]{36}$/i.test(v)) out.add(v.toLowerCase());
      for (const m of v.matchAll(SUB)) if (m[0].startsWith("/") || name === "subscriptionId") out.add(m[1]!.toLowerCase());
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, name));
  };
  for (const [k, v] of Object.entries(query ?? {})) visit(v, k);
  return [...out];
}

export function createAuthorizeMiddleware(env: Env) {
  const audit = (env.AUD_AUDIT_LOG ?? (env.NODE_ENV === "production" ? "stdout" : "off")) === "stdout";
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.auth?.bearerToken;
    if (!token) return next();
    const role = callerOf(env, token)?.role ?? null;
    req.access = { role };

    if (audit) {
      const started = Date.now();
      res.on("finish", () => {
        const oid = req.auth?.principal?.oid ?? "";
        process.stdout.write(`${JSON.stringify({
          audit: 1, ts: new Date().toISOString(), requestId: req.requestId, user: oid ? `…${oid.slice(-4)}` : "", role: req.access?.role ?? null,
          connection: req.access?.connection ?? null, method: req.method, route: req.route?.path ?? req.path.split("/").slice(0, 4).join("/"),
          status: res.statusCode, ms: Date.now() - started,
        })}\n`);
      });
    }

    if (!role && req.path !== "/me") return sendError(res, new HttpError(403, "no_platform_role", "No platform role is assigned to this account"), "no_platform_role");
    for (const sub of subscriptionsInQuery(req.query)) {
      const conn = connectionForSubscription(env, sub);
      if (!conn) continue; // not managed: the route's own allow-list check answers
      if (!canUse(conn, role)) return sendError(res, connectionForbidden(), "connection_forbidden");
      req.access.connection = conn.key;
    }
    next();
  };
}
