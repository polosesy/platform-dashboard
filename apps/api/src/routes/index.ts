import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import { registerArchitectureRoutes } from "./architecture";
import { registerNetworkRoutes } from "./network";
import { registerAzureRoutes } from "./azure";
import { registerReservationRoutes } from "./reservations";
import { registerKubernetesRoutes } from "./kubernetes";
import { registerCostRoutes } from "./cost";
import { registerSecurityRoutes } from "./security";
import { registerHealthRoutes } from "./health";
import { registerLiveDiagramRoutes } from "./liveDiagram";
import { registerObservabilityRoutes } from "./observability";

export function registerAllRoutes(router: Router, env: Env) {
  // Health check
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "@aud/api", ts: new Date().toISOString() });
  });

  // Domain routes
  registerAzureRoutes(router, env);
  registerArchitectureRoutes(router, env);
  registerNetworkRoutes(router, env);
  registerReservationRoutes(router, env);
  registerKubernetesRoutes(router, env);
  registerCostRoutes(router, env);
  registerSecurityRoutes(router, env);
  registerHealthRoutes(router, env);
  registerLiveDiagramRoutes(router, env);
  registerObservabilityRoutes(router, env);
}
