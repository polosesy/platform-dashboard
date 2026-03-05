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

export function registerHealthRoutes(router: Router, env: Env) {
  // Tab 1: Global Region Health (Azure Status RSS feed proxy — no auth required)
  router.get("/api/health/global-status", async (_req: Request, res: Response) => {
    try {
      const data = await tryGetGlobalStatus(env);
      res.json(data ?? mockGlobalStatus);
    } catch (e: unknown) {
      console.error("[health] global-status error:", e instanceof Error ? e.message : e);
      res.json({ ...mockGlobalStatus, note: e instanceof Error ? e.message : "global status error" });
    }
  });

  // Tab 2: Instance Health (existing)
  router.get("/api/health/summary", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetHealthSummary(env, req.auth?.bearerToken, { subscriptionId });
      res.json(data ?? mockHealthSummary);
    } catch (e: unknown) {
      console.error("[health] summary error:", e instanceof Error ? e.message : e);
      res.json({ ...mockHealthSummary, note: e instanceof Error ? e.message : "health summary error" });
    }
  });

  // Tab 3: Service Health Events (service issues, maintenance, advisories)
  router.get("/api/health/events", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetServiceHealthEvents(env, req.auth?.bearerToken, { subscriptionId });
      res.json(data ?? mockServiceHealthEvents);
    } catch (e: unknown) {
      console.error("[health] events error:", e instanceof Error ? e.message : e);
      res.json({ ...mockServiceHealthEvents, note: e instanceof Error ? e.message : "service health events error" });
    }
  });

  // Translation proxy (optional — requires AZURE_TRANSLATOR_KEY)
  router.post("/api/health/translate", (req: Request, res: Response) => {
    const body = req.body as { texts?: unknown; to?: unknown; from?: unknown };
    const texts = Array.isArray(body.texts) ? body.texts.map(String) : [];
    const to = typeof body.to === "string" ? body.to : "ko";
    const from = typeof body.from === "string" ? body.from : "en";

    if (texts.length === 0) {
      return void res.status(400).json({ error: "texts_required" });
    }
    if (!env.AZURE_TRANSLATOR_KEY) {
      return void res.json({ error: "not_configured", translations: null });
    }

    translateTexts(env, texts, to, from)
      .then((translations) => res.json({ translations, from, to }))
      .catch((e: unknown) => {
        res.status(500).json({ error: e instanceof Error ? e.message : "translate_error" });
      });
  });

  // Tab 1 supplement: Regional Status (user's deployed regions × service health)
  // Required RBAC: Reader on each subscription (ResourceGraph + ResourceHealth)
  router.get("/api/health/regional-status", async (req: Request, res: Response) => {
    const subscriptionId =
      typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    try {
      const data = await tryGetRegionalStatus(env, req.auth?.bearerToken, { subscriptionId });
      res.json(data ?? mockRegionalStatus);
    } catch (e: unknown) {
      console.error("[health] regional-status error:", e instanceof Error ? e.message : e);
      res.json({ ...mockRegionalStatus, note: e instanceof Error ? e.message : "regional status error" });
    }
  });
}
