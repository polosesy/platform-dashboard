import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import type { DiagramSpec } from "@aud/types";
import {
  saveDiagramSpec,
  getDiagramSpec,
  listDiagramSpecs,
  buildLiveSnapshot,
} from "../services/liveAggregator";
import {
  mockDiagramSpec,
  generateMockSnapshot,
} from "../services/liveDiagramMock";

// Seed the mock diagram on startup
saveDiagramSpec(mockDiagramSpec);

export function registerLiveDiagramRoutes(router: Router, env: Env) {
  // ── List all diagrams ──
  router.get("/api/live/diagrams", (_req: Request, res: Response) => {
    res.json({ diagrams: listDiagramSpecs() });
  });

  // ── Get a single diagram spec ──
  router.get("/api/live/diagrams/:id", (req: Request, res: Response) => {
    const spec = getDiagramSpec(req.params.id);
    if (!spec) {
      res.status(404).json({ error: "Diagram not found" });
      return;
    }
    res.json({ diagram: spec });
  });

  // ── Save/update a diagram spec ──
  router.post("/api/live/diagrams", (req: Request, res: Response) => {
    const body = req.body as DiagramSpec;
    if (!body?.id || !body?.version) {
      res.status(400).json({ error: "Invalid diagram spec: id and version required" });
      return;
    }
    body.updatedAt = new Date().toISOString();
    if (!body.createdAt) body.createdAt = body.updatedAt;
    saveDiagramSpec(body);
    res.status(201).json({ ok: true, id: body.id });
  });

  // ── Live snapshot (REST polling) ──
  router.get("/api/live/snapshot", (req: Request, res: Response) => {
    const diagramId = typeof req.query.diagramId === "string" ? req.query.diagramId : "prod-infra";

    if (env.AZURE_LIVE_DIAGRAM_ENABLED) {
      // Real Azure Monitor integration
      buildLiveSnapshot(env, req.auth?.bearerToken, diagramId)
        .then((snapshot) => {
          if (snapshot && hasRealData(snapshot)) {
            res.json(snapshot);
          } else {
            // Aggregator returned empty data — fall back to mock
            res.json(withSource(generateMockSnapshot(), "mock"));
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Unknown error";
          res.json(withSource(generateMockSnapshot(), "mock", msg));
        });
    } else {
      // Mock mode — no Azure calls
      res.json(withSource(generateMockSnapshot(), "mock"));
    }
  });

  // ── SSE stream (server-push) ──
  router.get("/api/live/stream", (req: Request, res: Response) => {
    const diagramId = typeof req.query.diagramId === "string" ? req.query.diagramId : "prod-infra";
    const spec = getDiagramSpec(diagramId);
    const intervalSec = spec?.settings.refreshIntervalSec ?? 30;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendSnapshot = () => {
      if (env.AZURE_LIVE_DIAGRAM_ENABLED) {
        buildLiveSnapshot(env, req.auth?.bearerToken, diagramId)
          .then((snapshot) => {
            const data = snapshot && hasRealData(snapshot)
              ? snapshot
              : withSource(generateMockSnapshot(), "mock");
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          })
          .catch(() => {
            res.write(`data: ${JSON.stringify(withSource(generateMockSnapshot(), "mock"))}\n\n`);
          });
      } else {
        res.write(`data: ${JSON.stringify(withSource(generateMockSnapshot(), "mock"))}\n\n`);
      }
    };

    sendSnapshot();
    const timer = setInterval(sendSnapshot, intervalSec * 1000);

    req.on("close", () => {
      clearInterval(timer);
    });
  });

  // ── Data source status ──
  router.get("/api/live/status", (_req: Request, res: Response) => {
    res.json({
      azureEnabled: env.AZURE_LIVE_DIAGRAM_ENABLED,
      appInsightsConfigured: !!env.AZURE_APP_INSIGHTS_APP_ID,
      oboConfigured: !!(env.AZURE_AD_TENANT_ID && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET),
      cacheTtl: {
        metrics: env.AZURE_LIVE_METRICS_CACHE_TTL_MS,
        alerts: env.AZURE_MONITOR_ALERTS_CACHE_TTL_MS,
        appInsights: env.AZURE_APP_INSIGHTS_CACHE_TTL_MS,
      },
    });
  });
}

/** Check if the snapshot has any resolved metrics (not all zeros/empty) */
function hasRealData(snapshot: ReturnType<typeof generateMockSnapshot>): boolean {
  const { topology } = snapshot;
  return (topology?.resolvedBindings ?? 0) > 0;
}

/** Tag a snapshot with its data source for frontend debugging */
function withSource<T extends Record<string, unknown>>(
  data: T,
  source: "azure" | "mock",
  error?: string,
): T & { _source: string; _error?: string } {
  return { ...data, _source: source, ...(error ? { _error: error } : {}) };
}
