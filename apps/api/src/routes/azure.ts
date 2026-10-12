import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { AzureSubscriptionsResponse, AzureTenantsResponse } from "@aud/types";
import { tryListAzureSubscriptionsFromAzure } from "../services/azure.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";

export function registerAzureRoutes(router: Router, env: Env) {
  // ── Tenants ──
  router.get("/api/azure/tenants", (_req: Request, res: Response) => {
    const tenantId = env.AZURE_AD_TENANT_ID;
    const tenants = tenantId ? [{ tenantId, displayName: tenantId }] : [];
    const resp: AzureTenantsResponse = {
      generatedAt: new Date().toISOString(),
      tenants,
      note: tenants.length === 0 ? "no tenant configured" : undefined,
    };
    res.json(resp);
  });

  // ── Subscriptions ──
  router.get("/api/azure/subscriptions", async (req: Request, res: Response) => {
    const allowListOnly = parseSubscriptionIds(env).map((subscriptionId) => ({ subscriptionId, name: subscriptionId }));

    try {
      const list = await tryListAzureSubscriptionsFromAzure(env, req.auth?.bearerToken);
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: list ?? allowListOnly,
        note: list ? undefined : "allow-list only",
      };
      res.json(resp);
    } catch (e: unknown) {
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: allowListOnly,
        note: e instanceof Error ? e.message : "azure subscriptions error",
      };
      res.json(resp);
    }
  });
}
