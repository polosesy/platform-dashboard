import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockCostSummary, mockCostTrend, mockBudgets } from "../mockData";
import { tryGetCostSummary, tryGetCostTrend, tryGetBudgets } from "../services/cost";

export function registerCostRoutes(router: Router, env: Env) {
  router.get("/api/cost/summary", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetCostSummary(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockCostSummary))
      .catch((e: unknown) => {
        res.json({ ...mockCostSummary, note: e instanceof Error ? e.message : "cost integration error" });
      });
  });

  router.get("/api/cost/trend", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    const granularity = req.query.granularity === "monthly" ? "monthly" : "daily";
    tryGetCostTrend(env, req.auth?.bearerToken, { subscriptionId, granularity })
      .then((data) => res.json(data ?? mockCostTrend))
      .catch((e: unknown) => {
        res.json({ ...mockCostTrend, note: e instanceof Error ? e.message : "cost trend error" });
      });
  });

  router.get("/api/cost/budgets", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetBudgets(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockBudgets))
      .catch((e: unknown) => {
        res.json({ ...mockBudgets, note: e instanceof Error ? e.message : "budgets error" });
      });
  });
}
