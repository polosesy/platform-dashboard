import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { AzureConnectionsResponse, AzureSubscriptionsResponse, MeResponse } from "@aud/types";
import { tryListAzureSubscriptionsFromAzure } from "../services/azure.js";
import { checkConnection, connectionOption } from "../services/connectionCheck.js";
import { anonymousSpAllowed, signinRequired } from "../infra/azureClientFactory.js";
import { HttpError, isSigninRequired, queryString, safeMessage, sendError } from "../infra/requestParams.js";
import { connectionByKey } from "../infra/connectionRegistry.js";
import { accessibleConnections, callerOf, canUse, platformRole, requireRole } from "../infra/platformAccess.js";

export function registerAzureRoutes(router: Router, env: Env) {
  // ── Who am I on this platform (role from the SSO token's app roles) — answered even without a role ──
  router.get("/api/me", (req: Request, res: Response) => {
    const auth = req.auth;
    if (!auth?.bearerToken) {
      const resp: MeResponse = { anonymous: true, role: null, connections: [] };
      return res.json(resp);
    }
    const { role, fromDefault } = platformRole(env, auth.principal.roles);
    const resp: MeResponse = {
      anonymous: false,
      name: auth.principal.name,
      role,
      ...(fromDefault ? { roleFromDefault: true } : {}),
      connections: accessibleConnections(env, role).map(connectionOption),
    };
    res.json(resp);
  });

  // ── Azure connections this role may read through — keys and names, never tenant or subscription GUIDs ──
  router.get("/api/azure/connections", (req: Request, res: Response) => {
    if (!req.auth?.bearerToken && !anonymousSpAllowed(env)) return sendError(res, signinRequired(), "connections");
    const role = req.auth?.bearerToken ? callerOf(env, req.auth.bearerToken)?.role ?? null : "viewer";
    const resp: AzureConnectionsResponse = {
      generatedAt: new Date().toISOString(),
      connections: accessibleConnections(env, role).map(connectionOption),
    };
    res.json(resp);
  });

  // ── Connection test with the connection's own credential (read-only) — admins only ──
  router.get("/api/azure/connections/:key/check", requireRole(env, "admin"), async (req: Request, res: Response) => {
    const token = req.auth?.bearerToken;
    if (!token) return sendError(res, signinRequired(), "connection_check");
    const conn = connectionByKey(env, req.params.key ?? "");
    if (!conn || !canUse(conn, callerOf(env, token)?.role ?? null)) return sendError(res, new HttpError(404, "connection_not_found", "Unknown connection"), "connection_check");
    try {
      res.json(await checkConnection(env, conn, token));
    } catch (e: unknown) {
      sendError(res, e, "connection_check_failed", "azure");
    }
  });

  // ── Subscriptions the caller may read (optionally of one connection). Anonymous: none — IDs are not public ──
  router.get("/api/azure/subscriptions", async (req: Request, res: Response) => {
    const key = queryString(req, "connection") ?? queryString(req, "tenant");
    const inConnection = <T extends { connectionKey?: string }>(list: T[]) => (key ? list.filter((s) => s.connectionKey === key) : list);
    const token = req.auth?.bearerToken;
    try {
      const list = await tryListAzureSubscriptionsFromAzure(env, token);
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: inConnection(list ?? []),
        ...(list ? {} : { note: "allow-list only" }),
      };
      res.json(resp);
    } catch (e: unknown) {
      if (e instanceof HttpError && !isSigninRequired(e) && e.status === 403) return sendError(res, e, "subscriptions");
      // A signed-in user still gets the subscriptions of their connections (ids + connection) when Resource Graph
      // fails; anonymous gets none
      const known = token
        ? accessibleConnections(env, callerOf(env, token)?.role ?? null).flatMap((c) =>
          c.subscriptions.map((subscriptionId) => ({ subscriptionId, connectionKey: c.key, connectionName: c.displayName })))
        : [];
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: inConnection(known),
        note: isSigninRequired(e) ? "signin_required" : e instanceof HttpError ? e.code : safeMessage(e),
      };
      res.json(resp);
    }
  });
}
