import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockHealthSummary } from "../mockData";
import { tryGetHealthSummary } from "../services/health";

export function registerHealthRoutes(router: Router, env: Env) {
  router.get("/api/health/summary", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockHealthSummary))
      .catch((e: unknown) => {
        res.json({ ...mockHealthSummary, note: e instanceof Error ? e.message : "health summary error" });
      });
  });
}
