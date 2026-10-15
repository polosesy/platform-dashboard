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
import { queryLang } from "../infra/lang.js";

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
        return enabled ? tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId, lang: queryLang(req) }) : null;
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

  // Translation proxy for Service Health event text (services/health.ts translateTexts): Azure Translator when
  // AZURE_TRANSLATOR_KEY is set, else the keyless endpoint, else the built-in sample translations. A failure is
  // answered 200 with `error` = why (not_configured · translator_auth · translator_quota · translator_error).
  router.post("/api/health/translate", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { texts?: unknown; to?: unknown; from?: unknown };
    const texts = Array.isArray(body.texts) ? body.texts.map(String).slice(0, 200).map((t) => t.slice(0, 5_000)) : [];
    const lang = (v: unknown, dflt: string) => (typeof v === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v) ? v : dflt);
    const to = lang(body.to, "ko");
    const from = lang(body.from, "en");

    if (texts.length === 0) {
      res.status(400).json({ error: "texts_required" });
      return;
    }

    try {
      // The Translator key is billed: anonymous callers get the built-in translations (sample events) only
      const signedIn = !!req.auth?.bearerToken || env.AUD_ANONYMOUS_SP;
      const r = await translateTexts(signedIn ? env : { ...env, AZURE_TRANSLATOR_KEY: undefined }, texts, to, from);
      if (res.writableEnded) return;
      res.json(r.ok
        ? { translations: r.translations, from, to, provider: r.provider }
        : { error: r.reason, translations: null, ...(r.status ? { status: r.status } : {}), ...(r.freeStatus ? { freeStatus: r.freeStatus } : {}) });
    } catch (e: unknown) {
      sendError(res, e, "translate_error", "health");
    }
  });
}
