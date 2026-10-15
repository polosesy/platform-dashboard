import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockHealthSummary, mockGlobalStatus, mockServiceHealthEvents, mockRegionalStatus } from "../mockData.js";
import {
  tryGetHealthSummary,
  tryGetGlobalStatus,
  tryGetServiceHealthEvents,
  tryGetRegionalStatus,
  translateTexts,
} from "../services/health.js";
import { querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";

export function registerHealthRoutes(router: Router, env: Env) {
  const enabled = env.AZURE_HEALTH_ENABLED;

  // Tab 1: Global Region Health (Azure Status RSS feed proxy — no auth required)
  router.get("/api/health/global-status", (_req: Request, res: Response) =>
    respondWithFallback(res, () => (enabled ? tryGetGlobalStatus(env) : Promise.resolve(null)), mockGlobalStatus, "health"),
  );

  // Tab 2: Instance Health
  router.get("/api/health/summary", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockHealthSummary,
      "health",
    ),
  );

  // Tab 3: Service Health Events (service issues, maintenance, advisories)
  router.get("/api/health/events", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetServiceHealthEvents(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockServiceHealthEvents,
      "health",
    ),
  );

  // Tab 1 supplement: Regional Status (user's deployed regions × service health)
  // Required RBAC: Reader on each subscription (ResourceGraph + ResourceHealth)
  router.get("/api/health/regional-status", (req: Request, res: Response) =>
    respondWithFallback(
      res,
      async () => {
        const subscriptionId = querySubscriptionId(req, env);
        return enabled ? tryGetRegionalStatus(env, req.auth?.bearerToken, { subscriptionId }) : null;
      },
      mockRegionalStatus,
      "health",
    ),
  );

  // Translation proxy — uses AZURE_TRANSLATOR_KEY when available,
  // falls back to built-in translations for known mock events.
  router.post("/api/health/translate", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { texts?: unknown; to?: unknown; from?: unknown };
    const texts = Array.isArray(body.texts) ? body.texts.map(String).slice(0, 200) : [];
    const to = typeof body.to === "string" ? body.to : "ko";
    const from = typeof body.from === "string" ? body.from : "en";

    if (texts.length === 0) {
      res.status(400).json({ error: "texts_required" });
      return;
    }

    try {
      // The Translator key is billed: anonymous callers get the built-in translations (sample events) only
    const signedIn = !!req.auth?.bearerToken || env.AUD_ANONYMOUS_SP;
    const translations = await translateTexts(signedIn ? env : { ...env, AZURE_TRANSLATOR_KEY: undefined }, texts, to, from);
      if (res.writableEnded) return;
      res.json(translations ? { translations, from, to } : { error: "not_configured", translations: null });
    } catch (e: unknown) {
      sendError(res, e, "translate_error", "health");
    }
  });
}
