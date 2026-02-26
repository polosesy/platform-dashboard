import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import type { NetworkSummary } from "@aud/types";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network";

export function registerNetworkRoutes(router: Router, env: Env) {
  router.get("/api/network/summary", (req: Request, res: Response) => {
    const lookbackMinutes = Number(req.query.lookbackMinutes ?? 60);
    const top = Number(req.query.top ?? 15);

    tryGetNetworkSummaryFromLogAnalytics(env, req.auth?.bearerToken, { lookbackMinutes, top })
      .then((summary) => {
        if (summary) {
          res.json(summary);
          return;
        }
        const fallback: NetworkSummary = mockNetworkSummary(Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60, env.AZURE_LOG_ANALYTICS_TABLE, "mock data");
        res.json(fallback);
      })
      .catch((e: unknown) => {
        const fallback: NetworkSummary = mockNetworkSummary(
          Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60,
          env.AZURE_LOG_ANALYTICS_TABLE,
          e instanceof Error ? e.message : "log analytics error",
        );
        res.json(fallback);
      });
  });
}
