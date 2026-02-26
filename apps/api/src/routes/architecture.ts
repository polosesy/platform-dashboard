import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import type { ArchitectureFlowOverlayResponse } from "@aud/types";
import { mockArchitectureGraph } from "../mockData";
import { tryGetArchitectureGraphFromAzure } from "../services/azure";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network";
import { mapSubnetPairsToGraphEdgeMetrics } from "../services/flowOverlay";

export function registerArchitectureRoutes(router: Router, env: Env) {
  router.get("/api/architecture/graph", (req: Request, res: Response) => {
    const subscriptionId = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : undefined;
    tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken, { subscriptionId })
      .then((graph) => res.json(graph ?? mockArchitectureGraph))
      .catch((e: unknown) => {
        res.json({ ...mockArchitectureGraph, note: e instanceof Error ? e.message : "azure integration error" });
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
}
