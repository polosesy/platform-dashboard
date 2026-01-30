import type { Request, Response, Router } from "express";
import { mockArchitectureGraph } from "./mockData";
import type { Env } from "./env";
import type { ArgoAppSummary, NetworkSummary } from "./types";
import { fetchArgoApps } from "./services/argocd";
import { tryGetArchitectureGraphFromAzure } from "./services/azure";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "./services/network";

export function registerRoutes(router: Router, env: Env) {
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "@aud/api", ts: new Date().toISOString() });
  });

  router.get("/api/architecture/graph", (req: Request, res: Response) => {
    tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken)
      .then((graph) => res.json(graph ?? mockArchitectureGraph))
      .catch((e: unknown) => {
        res.json({ ...mockArchitectureGraph, note: e instanceof Error ? e.message : "azure integration error" });
      });
  });

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
            lastDeployedAt: new Date(Date.now() - 60_000 * 42).toISOString()
          }
        ];
        res.json({ generatedAt: new Date().toISOString(), apps: mock, note: "mock data" });
      })
      .catch((e: unknown) => {
        res.json({ generatedAt: new Date().toISOString(), apps: [], note: e instanceof Error ? e.message : "argocd error" });
      });
  });

  router.get("/api/network/summary", (req: Request, res: Response) => {
    const lookbackMinutes = Number(req.query.lookbackMinutes ?? 60);
    const top = Number(req.query.top ?? 15);

    tryGetNetworkSummaryFromLogAnalytics(env, req.auth?.bearerToken, { lookbackMinutes, top })
      .then((summary) => {
        if (summary) {
          res.json(summary);
          return;
        }
        const fallback: NetworkSummary = mockNetworkSummary(Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60, env.AZURE_LOG_ANALYTICS_TABLE, "mock data");
        res.json(fallback);
      })
      .catch((e: unknown) => {
        const fallback: NetworkSummary = mockNetworkSummary(
          Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60,
          env.AZURE_LOG_ANALYTICS_TABLE,
          e instanceof Error ? e.message : "log analytics error"
        );
        res.json(fallback);
      });
  });
}
