import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import type { AzureSubscriptionsResponse } from "@aud/types";
import { tryListAzureSubscriptionsFromAzure } from "../services/azure";

export function registerAzureRoutes(router: Router, env: Env) {
  router.get("/api/azure/subscriptions", async (req: Request, res: Response) => {
    const allowRaw = env.AZURE_SUBSCRIPTION_IDS ?? "";
    const allowList = allowRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const list = await tryListAzureSubscriptionsFromAzure(env, req.auth?.bearerToken);
      const subscriptions = list ?? allowList.map((subscriptionId) => ({ subscriptionId, name: subscriptionId }));
      const note = list ? undefined : "allow-list only";
      const resp: AzureSubscriptionsResponse = { generatedAt: new Date().toISOString(), subscriptions, note };
      res.json(resp);
    } catch (e: unknown) {
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: allowList.map((subscriptionId) => ({ subscriptionId, name: subscriptionId })),
        note: e instanceof Error ? e.message : "azure subscriptions error",
      };
      res.json(resp);
    }
  });
}
