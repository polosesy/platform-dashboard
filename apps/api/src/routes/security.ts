import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockSecureScore, mockSecurityAlerts, mockSecurityPosture } from "../mockData.js";
import { tryGetSecureScore, tryGetSecurityAlerts } from "../services/security.js";
import { tryGetSecurityPosture } from "../services/securityPosture.js";
import { queryArmResourceId, querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";
import { queryLang } from "../infra/lang.js";
import { collectAdvisories } from "../services/advisoriesCollector.js";

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

  // 보안 › 긴급 취약점: official feeds (CISA KEV, NVD, nodejs.org, php.net) matched against this dashboard's runtime,
  // the selected cluster's images and Defender container findings. ?cves= adds a watch list (CVE IDs only, max 20)
  router.get("/api/security/advisories", async (req: Request, res: Response) => {
    try {
      const clusterId = typeof req.query.clusterId === "string" && req.query.clusterId ? queryArmResourceId(req, env, "clusterId") : null;
      const watch = typeof req.query.cves === "string" ? req.query.cves.split(/[\s,]+/).filter(Boolean) : [];
      res.json(await collectAdvisories(env, req.auth?.bearerToken, { clusterId, watch, lang: queryLang(req) }));
    } catch (e: unknown) {
      sendError(res, e, "advisories_failed", "security");
    }
  });
}
