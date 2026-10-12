import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockReservationUtilization, tryGetReservationUtilization } from "../services/reservations.js";
import { queryString, querySubscriptionId, sendError } from "../infra/requestParams.js";

export function registerReservationRoutes(router: Router, env: Env) {
  router.get("/api/reservations/utilization", async (req: Request, res: Response) => {
    const grainParam = queryString(req, "grain");
    const grain = grainParam === "daily" || grainParam === "monthly" ? grainParam : env.AZURE_RESERVATIONS_GRAIN;

    let subscriptionId: string | undefined;
    try {
      subscriptionId = querySubscriptionId(req, env);
    } catch (e: unknown) {
      return sendError(res, e, "reservations_failed");
    }

    try {
      const r = await tryGetReservationUtilization(env, req.auth?.bearerToken, grain, { subscriptionId });
      res.json(r ?? mockReservationUtilization(grain, "mock data"));
    } catch (e: unknown) {
      res.json(mockReservationUtilization(grain, e instanceof Error ? e.message : "reservations error"));
    }
  });
}
