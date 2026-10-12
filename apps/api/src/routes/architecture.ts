import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import type { ArchitectureFlowOverlayResponse } from "@aud/types";
import { mockArchitectureGraph } from "../mockData.js";
import { tryGetArchitectureGraphFromAzure } from "../services/azure.js";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network.js";
import { mapSubnetPairsToGraphEdgeMetrics } from "../services/flowOverlay.js";
import { queryInt, querySubscriptionId, sendError } from "../infra/requestParams.js";
import { safeMessage } from "../services/securityPosture.js";

export function registerArchitectureRoutes(router: Router, env: Env) {
  router.get("/api/architecture/graph", async (req: Request, res: Response) => {
    try {
      const subscriptionId = querySubscriptionId(req, env);
      try {
        const graph = await tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken, { subscriptionId });
        res.json(graph ? { ...graph, source: "azure" } : { ...mockArchitectureGraph, source: "mock" });
      } catch (e: unknown) {
        res.json({ ...mockArchitectureGraph, source: "mock", note: safeMessage(e) });
      }
    } catch (e: unknown) {
      sendError(res, e, "architecture_graph_failed");
    }
  });

  router.get("/api/architecture/flow-overlay", async (req: Request, res: Response) => {
    const lookbackMinutes = queryInt(req, "lookbackMinutes", 60, 5, 60 * 24 * 14);
    const top = queryInt(req, "top", 30, 5, 50);

    let subscriptionId: string | undefined;
    try {
      subscriptionId = querySubscriptionId(req, env);
    } catch (e: unknown) {
      return sendError(res, e, "flow_overlay_failed");
    }

    try {
      const bearer = req.auth?.bearerToken;
      const [graphMaybe, summaryMaybe] = await Promise.all([
        tryGetArchitectureGraphFromAzure(env, bearer, { subscriptionId }),
        tryGetNetworkSummaryFromLogAnalytics(env, bearer, { lookbackMinutes, top }),
      ]);

      const graph = graphMaybe ?? mockArchitectureGraph;
      const summary = summaryMaybe ?? mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE, "mock data");
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
        lookbackMinutes,
        level: "subnet",
        edges: [],
        unmatchedPairs: [],
        note: e instanceof Error ? e.message : "flow overlay error",
      };
      res.json(resp);
    }
  });
}
