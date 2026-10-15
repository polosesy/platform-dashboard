import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { anonymousSpAllowed } from "../infra/azureClientFactory.js";
import type { ArchitectureFlowOverlayResponse } from "@aud/types";
import { mockArchitectureGraph } from "../mockData.js";
import { tryGetArchitectureGraphFromAzure } from "../services/azure.js";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network.js";
import { mapSubnetPairsToGraphEdgeMetrics } from "../services/flowOverlay.js";
import { isSigninRequired, queryInt, querySubscriptionId, safeMessage, sendError } from "../infra/requestParams.js";

export function registerArchitectureRoutes(router: Router, env: Env) {
  router.get("/api/architecture/graph", async (req: Request, res: Response) => {
    try {
      const subscriptionId = querySubscriptionId(req, env);
      try {
        const graph = await tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken, { subscriptionId });
        res.json(graph ? { ...graph, source: "azure" } : { ...mockArchitectureGraph, source: "mock" });
      } catch (e: unknown) {
        res.json({ ...mockArchitectureGraph, source: "mock", note: isSigninRequired(e) ? "signin_required" : safeMessage(e) });
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

    const bearer = req.auth?.bearerToken;
    // Anonymous: the sample overlay on the sample graph. Signed-in users never get sample traffic.
    if (!bearer && !anonymousSpAllowed(env)) {
      const sample = mockNetworkSummary(lookbackMinutes, env.AZURE_LOG_ANALYTICS_TABLE, "signin_required");
      const mapped = mapSubnetPairsToGraphEdgeMetrics(mockArchitectureGraph, sample.topSubnetPairs);
      const resp: ArchitectureFlowOverlayResponse = {
        generatedAt: new Date().toISOString(), lookbackMinutes, level: "subnet", edges: mapped.edges, unmatchedPairs: mapped.unmatchedPairs, note: "signin_required",
      };
      return res.json(resp);
    }
    try {
      const [graphMaybe, summaryMaybe] = await Promise.all([
        tryGetArchitectureGraphFromAzure(env, bearer, { subscriptionId }),
        tryGetNetworkSummaryFromLogAnalytics(env, bearer, { lookbackMinutes, top }),
      ]);
      if (!graphMaybe || !summaryMaybe) {
        // No workspace configured (or no graph): nothing measured — no edges, never sample numbers
        const resp: ArchitectureFlowOverlayResponse = { generatedAt: new Date().toISOString(), lookbackMinutes, level: "subnet", edges: [], unmatchedPairs: [] };
        return res.json(resp);
      }
      const graph = graphMaybe;
      const summary = summaryMaybe;
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
      sendError(res, e, "flow_overlay_failed", "architecture");
    }
  });
}
