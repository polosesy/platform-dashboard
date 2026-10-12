import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockCostSummary, mockCostTrend, mockBudgets } from "../mockData.js";
import { tryGetCostSummary, tryGetCostTrend, tryGetBudgets } from "../services/cost.js";
import { querySubscriptionId, respondWithFallback } from "../infra/requestParams.js";

export function registerCostRoutes(router: Router, env: Env) {
  const enabled = env.AZURE_COST_MANAGEMENT_ENABLED;

  router.get("/api/cost/summary", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetCostSummary(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockCostSummary,
      "cost",
    ),
  );

  router.get("/api/cost/trend", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        const granularity = req.query.granularity === "monthly" ? "monthly" : "daily";
        return enabled ? tryGetCostTrend(env, req.auth?.bearerToken, { subscriptionId, granularity }) : null;
      },
      mockCostTrend,
      "cost",
    ),
  );

  router.get("/api/cost/budgets", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetBudgets(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockBudgets,
      "cost",
    ),
  );
}
