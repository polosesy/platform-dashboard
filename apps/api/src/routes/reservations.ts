import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { mockReservationUtilization, tryGetReservationUtilization } from "../services/reservations";

export function registerReservationRoutes(router: Router, env: Env) {
  router.get("/api/reservations/utilization", (req: Request, res: Response) => {
    const grain = (req.query.grain ?? env.AZURE_RESERVATIONS_GRAIN) as "daily" | "monthly";
    const safeGrain = grain === "daily" || grain === "monthly" ? grain : env.AZURE_RESERVATIONS_GRAIN;
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;

    tryGetReservationUtilization(env, req.auth?.bearerToken, safeGrain, { subscriptionId })
      .then((r) => {
        if (r) {
          res.json(r);
          return;
        }
        res.json(mockReservationUtilization(safeGrain, "mock data"));
      })
      .catch((e: unknown) => {
        res.json(mockReservationUtilization(safeGrain, e instanceof Error ? e.message : "reservations error"));
      });
  });
}
