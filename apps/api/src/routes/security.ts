import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockSecureScore, mockSecurityAlerts } from "../mockData";
import { tryGetSecureScore, tryGetSecurityAlerts } from "../services/security";

export function registerSecurityRoutes(router: Router, env: Env) {
  router.get("/api/security/score", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetSecureScore(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockSecureScore))
      .catch((e: unknown) => {
        res.json({ ...mockSecureScore, note: e instanceof Error ? e.message : "security score error" });
      });
  });

  router.get("/api/security/alerts", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetSecurityAlerts(env, req.auth?.bearerToken, { subscriptionId })
      .then((data) => res.json(data ?? mockSecurityAlerts))
      .catch((e: unknown) => {
        res.json({ ...mockSecurityAlerts, note: e instanceof Error ? e.message : "security alerts error" });
      });
  });
}
