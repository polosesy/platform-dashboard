import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockHealthSummary, mockGlobalStatus, mockServiceHealthEvents, mockRegionalStatus } from "../mockData";
import {
  tryGetHealthSummary,
  tryGetGlobalStatus,
  tryGetServiceHealthEvents,
  tryGetRegionalStatus,
  translateTexts,
} from "../services/health";

/**
 * Safely send JSON response — guards against writing to a destroyed/closed socket.
 * Prevents the "write after end" / unhandled error that causes ECONNRESET cascades.
 */
function safeJson(res: Response, data: unknown): void {
  try {
    if (res.headersSent || res.writableEnded) return;
    res.json(data);
  } catch (e: unknown) {
    console.error("[health] safeJson write failed:", e instanceof Error ? e.message : e);
  }
}

export function registerHealthRoutes(router: Router, env: Env) {
  // Tab 1: Global Region Health (Azure Status RSS feed proxy — no auth required)
  router.get("/api/health/global-status", async (_req: Request, res: Response) => {
    try {
      const data = await tryGetGlobalStatus(env);
      safeJson(res, data ?? mockGlobalStatus);
    } catch (e: unknown) {
      console.error("[health] global-status error:", e instanceof Error ? e.message : e);
      safeJson(res, { ...mockGlobalStatus, note: e instanceof Error ? e.message : "global status error" });
    }
  });

  // Tab 2: Instance Health (existing)
  router.get("/api/health/summary", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId });
      safeJson(res, data ?? mockHealthSummary);
    } catch (e: unknown) {
      console.error("[health] summary error:", e instanceof Error ? e.message : e);
      safeJson(res, { ...mockHealthSummary, note: e instanceof Error ? e.message : "health summary error" });
    }
  });

  // Tab 3: Service Health Events (service issues, maintenance, advisories)
  router.get("/api/health/events", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetServiceHealthEvents(env, req.auth?.bearerToken, { subscriptionId });
      safeJson(res, data ?? mockServiceHealthEvents);
    } catch (e: unknown) {
      console.error("[health] events error:", e instanceof Error ? e.message : e);
      safeJson(res, { ...mockServiceHealthEvents, note: e instanceof Error ? e.message : "service health events error" });
    }
  });

  // Translation proxy — uses AZURE_TRANSLATOR_KEY when available,
  // falls back to built-in translations for known mock events.
  router.post("/api/health/translate", (req: Request, res: Response) => {
    const body = req.body as { texts?: unknown; to?: unknown; from?: unknown };
    const texts = Array.isArray(body.texts) ? body.texts.map(String) : [];
    const to = typeof body.to === "string" ? body.to : "ko";
    const from = typeof body.from === "string" ? body.from : "en";

    if (texts.length === 0) {
      return void res.status(400).json({ error: "texts_required" });
    }

    translateTexts(env, texts, to, from)
      .then((translations) => {
        if (translations) {
          safeJson(res, { translations, from, to });
        } else {
          safeJson(res, { error: "not_configured", translations: null });
        }
      })
      .catch((e: unknown) => {
        try {
          if (!res.headersSent) res.status(500).json({ error: e instanceof Error ? e.message : "translate_error" });
        } catch { /* socket dead */ }
      });
  });

  // Tab 1 supplement: Regional Status (user's deployed regions × service health)
  // Required RBAC: Reader on each subscription (ResourceGraph + ResourceHealth)
  router.get("/api/health/regional-status", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetRegionalStatus(env, req.auth?.bearerToken, { subscriptionId });
      safeJson(res, data ?? mockRegionalStatus);
    } catch (e: unknown) {
      console.error("[health] regional-status error:", e instanceof Error ? e.message : e);
      safeJson(res, { ...mockRegionalStatus, note: e instanceof Error ? e.message : "regional status error" });
    }
  });
}
