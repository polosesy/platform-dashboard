import type { Request, Response, Router } from "express";
import { mockArchitectureGraph } from "./mockData";
import type { Env } from "./env";
import type { ArgoAppSummary, ArchitectureFlowOverlayResponse, AzureSubscriptionsResponse, NetworkSummary } from "./types";
import { fetchArgoApps } from "./services/argocd";
import { tryGetArchitectureGraphFromAzure, tryListAzureSubscriptionsFromAzure } from "./services/azure";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "./services/network";
import { mapSubnetPairsToGraphEdgeMetrics } from "./services/flowOverlay";
import { mockReservationUtilization, tryGetReservationUtilization } from "./services/reservations";

export function registerRoutes(router: Router, env: Env) {
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "@aud/api", ts: new Date().toISOString() });
  });

  router.get("/api/azure/subscriptions", async (req: Request, res: Response) => {
    const allowRaw = env.AZURE_SUBSCRIPTION_IDS ?? "";
    const allowList = allowRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const list = await tryListAzureSubscriptionsFromAzure(env, req.auth?.bearerToken);
      const subscriptions = list ?? allowList.map((subscriptionId) => ({ subscriptionId, name: subscriptionId }));
      const note = list ? undefined : "allow-list only";
      const resp: AzureSubscriptionsResponse = { generatedAt: new Date().toISOString(), subscriptions, note };
      res.json(resp);
    } catch (e: unknown) {
      const resp: AzureSubscriptionsResponse = {
        generatedAt: new Date().toISOString(),
        subscriptions: allowList.map((subscriptionId) => ({ subscriptionId, name: subscriptionId })),
        note: e instanceof Error ? e.message : "azure subscriptions error",
      };
      res.json(resp);
    }
  });

  router.get("/api/architecture/graph", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken, { subscriptionId })
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

  router.get("/api/architecture/flow-overlay", async (req: Request, res: Response) => {
    const lookbackMinutes = Number(req.query.lookbackMinutes ?? 60);
    const top = Number(req.query.top ?? 30);
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;

    try {
      const bearer = req.auth?.bearerToken;
      const [graphMaybe, summaryMaybe] = await Promise.all([
        tryGetArchitectureGraphFromAzure(env, bearer, { subscriptionId }),
        tryGetNetworkSummaryFromLogAnalytics(env, bearer, { lookbackMinutes, top }),
      ]);

      const graph = graphMaybe ?? mockArchitectureGraph;
      const summary =
        summaryMaybe ??
        mockNetworkSummary(Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60, env.AZURE_LOG_ANALYTICS_TABLE, "mock data");

      const mapped = mapSubnetPairsToGraphEdgeMetrics(graph, summary.topSubnetPairs);

      const resp: ArchitectureFlowOverlayResponse = {
        generatedAt: new Date().toISOString(),
        lookbackMinutes: summary.lookbackMinutes,
        level: "subnet",
        edges: mapped.edges,
        unmatchedPairs: mapped.unmatchedPairs,
        note: summary.note,
      };
      res.json(resp);
    } catch (e: unknown) {
      const resp: ArchitectureFlowOverlayResponse = {
        generatedAt: new Date().toISOString(),
        lookbackMinutes: Number.isFinite(lookbackMinutes) ? lookbackMinutes : 60,
        level: "subnet",
        edges: [],
        unmatchedPairs: [],
        note: e instanceof Error ? e.message : "flow overlay error",
      };
      res.json(resp);
    }
  });

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
