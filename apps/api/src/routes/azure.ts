import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { AzureConnectionsResponse, AzureSubscriptionsResponse, FeatureCatalogResponse, MeResponse } from "@aud/types";
import { tryListAzureSubscriptionsFromAzure } from "../services/azure.js";
import { checkConnection, connectionOption } from "../services/connectionCheck.js";
import { anonymousSpAllowed, signinRequired } from "../infra/azureClientFactory.js";
import { HttpError, isSigninRequired, queryArmResourceId, queryString, safeMessage, sendError } from "../infra/requestParams.js";
import { FEATURES, PERMISSIONS, PLAN_TIERS } from "../services/featureCatalog.js";
import { checkClusterAccess } from "../services/clusterAccessCheck.js";
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

  // ── In-cluster permissions of a connection (SelfSubjectAccessReview — nothing stored), one cluster — admins only ──
  router.get("/api/azure/connections/:key/cluster-check", requireRole(env, "admin"), async (req: Request, res: Response) => {
    const token = req.auth?.bearerToken;
    if (!token) return sendError(res, signinRequired(), "cluster_check");
    try {
      const conn = connectionByKey(env, req.params.key ?? "");
      if (!conn || !canUse(conn, callerOf(env, token)?.role ?? null)) throw new HttpError(404, "connection_not_found", "Unknown connection");
      const clusterId = queryArmResourceId(req, env, "resourceId");
      // Only a cluster of this connection's subscriptions — the check runs with its credential
      if (!conn.subscriptions.includes(clusterId.split("/")[2]?.toLowerCase() ?? "")) throw new HttpError(400, "cluster_not_in_connection", "The cluster is not in this connection's subscriptions");
      res.json(await checkClusterAccess(env, token, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "cluster_check_failed", "azure");
    }
  });

  // ── Feature × permission catalog (packages, minimum roles, grant commands) — static, no Azure call ──
  router.get("/api/azure/feature-catalog", (_req: Request, res: Response) => {
    const body: FeatureCatalogResponse = { tiers: PLAN_TIERS, permissions: PERMISSIONS, features: FEATURES };
    res.json(body);
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
