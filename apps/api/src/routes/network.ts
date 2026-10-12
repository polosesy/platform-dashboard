import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network.js";
import { queryInt } from "../infra/requestParams.js";

export function registerNetworkRoutes(router: Router, env: Env) {
  router.get("/api/network/summary", async (req: Request, res: Response) => {
    const lookbackMinutes = queryInt(req, "lookbackMinutes", 60, 5, 60 * 24 * 14);
    const top = queryInt(req, "top", 15, 5, 50);

    try {
      const summary = await tryGetNetworkSummaryFromLogAnalytics(env, req.auth?.bearerToken, { lookbackMinutes, top });
      res.json(summary ?? mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE, "mock data"));
    } catch (e: unknown) {
      res.json(mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE, e instanceof Error ? e.message : "log analytics error"));
    }
  });
}
