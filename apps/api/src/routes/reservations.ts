import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { mockReservationUtilization, tryGetReservationUtilization } from "../services/reservations.js";
import { queryString, querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";

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

    // Sample numbers only for anonymous callers (source:"mock"); a signed-in read that fails is an error — it used
    // to answer the sample utilisation (63 %) with the Azure error as a footnote, as if it were the caller's
    await respondWithFallback(res, () => tryGetReservationUtilization(env, req.auth?.bearerToken, grain, { subscriptionId }),
      mockReservationUtilization(grain), "reservations");
  });
}
