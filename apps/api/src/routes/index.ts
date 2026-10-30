import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { registerArchitectureRoutes } from "./architecture.js";
import { registerNetworkRoutes } from "./network.js";
import { registerAzureRoutes } from "./azure.js";
import { registerReservationRoutes } from "./reservations.js";
import { registerKubernetesRoutes } from "./kubernetes.js";
import { registerCostRoutes } from "./cost.js";
import { registerSecurityRoutes } from "./security.js";
import { registerHealthRoutes } from "./health.js";
import { registerLiveDiagramRoutes } from "./liveDiagram.js";
import { registerObservabilityRoutes } from "./observability.js";
import { registerHubbleRoutes } from "./hubble.js";
import { registerNotifyRoutes } from "./notify.js";

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
  registerHubbleRoutes(router, env);
  registerNotifyRoutes(router, env);
}
