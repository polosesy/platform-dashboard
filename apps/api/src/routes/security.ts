import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockSecureScore, mockSecurityAlerts, mockSecurityPosture } from "../mockData.js";
import { tryGetSecureScore, tryGetSecurityAlerts } from "../services/security.js";
import { tryGetSecurityPosture } from "../services/securityPosture.js";
import { querySubscriptionId, respondWithFallback } from "../infra/requestParams.js";

export function registerSecurityRoutes(router: Router, env: Env) {
  const enabled = env.AZURE_SECURITY_ENABLED;

  router.get("/api/security/score", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetSecureScore(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockSecureScore,
      "security",
    ),
  );

  router.get("/api/security/alerts", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetSecurityAlerts(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockSecurityAlerts,
      "security",
    ),
  );

  // Defender posture via Resource Graph — recommendations, controls, compliance, plans, alerts (OBO or SP)
  router.get("/api/security/posture", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => tryGetSecurityPosture(env, req.auth?.bearerToken, { subscriptionId: querySubscriptionId(req, env) }),
      mockSecurityPosture,
      "security",
    ),
  );
}
