import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { anonymousSpAllowed } from "../infra/azureClientFactory.js";
import type { ArchitectureFlowOverlayResponse } from "@aud/types";
import { mockArchitectureGraph } from "../mockData.js";
import { tryGetArchitectureGraphFromAzure } from "../services/azure.js";
import { mockNetworkSummary, tryGetNetworkSummaryFromLogAnalytics } from "../services/network.js";
import { mapSubnetPairsToGraphEdgeMetrics } from "../services/flowOverlay.js";
import { queryInt, querySubscriptionId, respondWithFallback, sendError } from "../infra/requestParams.js";
import { requireRole } from "../infra/platformAccess.js";
import { ArrangementBody, readArrangement, writeArrangement } from "../services/arrangementStore.js";

export function registerArchitectureRoutes(router: Router, env: Env) {
  // Team layout of the diagram (slot order + manual lines) — layout only, nothing in Azure changes
  const durable = !!env.AUD_ARRANGEMENT_DIR;
  router.get("/api/architecture/arrangement", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.json({ doc: null, durable, signedIn: false });
      const subscriptionId = querySubscriptionId(req, env);
      if (!subscriptionId) return res.json({ doc: null, durable, signedIn: true });
      res.json({ doc: await readArrangement(env.AUD_ARRANGEMENT_DIR, subscriptionId), durable, signedIn: true });
    } catch (e: unknown) {
      sendError(res, e, "arrangement_read_failed");
    }
  });
  router.put("/api/architecture/arrangement", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      // requireRole lets anonymous callers through (they see sample data) — publishing needs a signed-in operator
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const subscriptionId = querySubscriptionId(req, env);
      if (!subscriptionId) return res.status(400).json({ error: "subscription_required" });
      // Only the document's own fields (baseVersion rides along in the body); grid is optional (v1 documents have none)
      const body = ArrangementBody.safeParse({ order: req.body?.order, lines: req.body?.lines, ...(req.body?.grid !== undefined ? { grid: req.body.grid } : {}) });
      if (!body.success) return res.status(400).json({ error: "arrangement_invalid" });
      const baseVersion = typeof req.body?.baseVersion === "number" ? req.body.baseVersion : null;
      const r = await writeArrangement(env.AUD_ARRANGEMENT_DIR, subscriptionId, body.data, { baseVersion, force: req.query.force === "1", by: req.auth.principal.name });
      if (!r.ok) return res.status(409).json({ error: "arrangement_conflict", doc: r.conflict, durable });
      res.json({ doc: r.doc, durable });
    } catch (e: unknown) {
      sendError(res, e, "arrangement_write_failed");
    }
  });

  router.get("/api/architecture/graph", async (req: Request, res: Response) => {
    try {
      const subscriptionId = querySubscriptionId(req, env);
      // The sample diagram only when there is nothing live (anonymous / feature off); a signed-in read that fails
      // (403, 429 …) is an error — it used to draw the sample subscription as if it were the caller's
      await respondWithFallback(res, async () => {
        const graph = await tryGetArchitectureGraphFromAzure(env, req.auth?.bearerToken, { subscriptionId });
        return graph ? { ...graph, source: "azure" as const } : null;
      }, { ...mockArchitectureGraph }, "architecture");
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
