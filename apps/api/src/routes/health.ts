import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockHealthSummary, mockGlobalStatus, mockServiceHealthEvents } from "../mockData";
import {
  tryGetHealthSummary,
  tryGetGlobalStatus,
  tryGetServiceHealthEvents,
} from "../services/health";

export function registerHealthRoutes(router: Router, env: Env) {
  // Tab 1: Global Region Health (Azure Status RSS feed proxy — no auth required)
  router.get("/api/health/global-status", (_req: Request, res: Response) => {
    tryGetGlobalStatus(env)
      .then((data) => res.json(data ?? mockGlobalStatus))
      .catch((e: unknown) => {
        res.json({
          ...mockGlobalStatus,
          note: e instanceof Error ? e.message : "global status error",
        });
      });
  });

  // Tab 2: Instance Health (existing)
  router.get("/api/health/summary", (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockHealthSummary))
      .catch((e: unknown) => {
        res.json({
          ...mockHealthSummary,
          note: e instanceof Error ? e.message : "health summary error",
        });
      });
  });

  // Tab 3: Service Health Events (service issues, maintenance, advisories)
  router.get("/api/health/events", (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetServiceHealthEvents(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockServiceHealthEvents))
      .catch((e: unknown) => {
        res.json({
          ...mockServiceHealthEvents,
          note: e instanceof Error ? e.message : "service health events error",
        });
      });
  });
}
