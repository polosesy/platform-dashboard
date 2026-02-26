import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import type { ArgoAppSummary } from "@aud/types";
import { fetchArgoApps } from "../services/argocd";

export function registerDevOpsRoutes(router: Router, env: Env) {
  router.get("/api/argocd/apps", (_req: Request, res: Response) => {
    fetchArgoApps(env)
      .then((apps) => {
        if (apps) {
          res.json({ generatedAt: new Date().toISOString(), apps, note: "argocd" });
          return;
        }
        const mock: ArgoAppSummary[] = [
          {
            name: "platform",
            namespace: "argocd",
            project: "default",
            health: "Healthy",
            sync: "Synced",
            repo: "https://github.com/org/repo",
            revision: "main@a1b2c3d",
            lastDeployedAt: new Date(Date.now() - 60_000 * 42).toISOString(),
          },
        ];
        res.json({ generatedAt: new Date().toISOString(), apps: mock, note: "mock data" });
      })
      .catch((e: unknown) => {
        res.json({ generatedAt: new Date().toISOString(), apps: [], note: e instanceof Error ? e.message : "argocd error" });
      });
  });
}
