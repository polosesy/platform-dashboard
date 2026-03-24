import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import {
  getObservabilityOverview,
  getObservabilityWorkloads,
  getObservabilityNodes,
} from "../services/observabilityAggregator";
import { collectPodLogs } from "../services/containerInsightsCollector";
import type { ObservabilityStatusResponse, ObservabilityLogsResponse } from "@aud/types";

export function registerObservabilityRoutes(router: Router, env: Env) {
  // Status — data source connectivity check
  router.get("/api/observability/status", (_req: Request, res: Response) => {
    const workspaceId =
      env.AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID ?? env.AZURE_LOG_ANALYTICS_WORKSPACE_ID ?? null;
    // workspace가 env에 설정되어 있거나, cluster에서 auto-discover 가능하면 CI 사용 가능
    const ciConfigured = !!workspaceId; // auto-discover는 런타임에만 확인 가능
    const status: ObservabilityStatusResponse = {
      generatedAt: new Date().toISOString(),
      dataSourceStatus: {
        containerInsights: ciConfigured,
        prometheus: !!env.AZURE_PROMETHEUS_ENDPOINT,
        appInsights: !!env.AZURE_APP_INSIGHTS_APP_ID,
      },
      workspaceId,
      prometheusEndpoint: env.AZURE_PROMETHEUS_ENDPOINT ?? null,
      appInsightsConfigured: !!env.AZURE_APP_INSIGHTS_APP_ID,
    };
    res.json(status);
  });

  // Overview — cluster summary + top alerting workloads
  router.get("/api/observability/overview", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "default";
    const clusterName = typeof req.query.clusterName === "string" ? req.query.clusterName : clusterId;
    try {
      const data = await getObservabilityOverview(env, req.auth?.bearerToken, clusterId, clusterName);
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] overview error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "overview_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // Workloads — full workload list with APM metrics
  router.get("/api/observability/workloads", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "default";
    try {
      const data = await getObservabilityWorkloads(env, req.auth?.bearerToken, clusterId);
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] workloads error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "workloads_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // Nodes — node resource usage
  router.get("/api/observability/nodes", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "default";
    try {
      const data = await getObservabilityNodes(env, req.auth?.bearerToken, clusterId);
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] nodes error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "nodes_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // Logs — pod live logs via ContainerLogV2/ContainerLog
  router.get("/api/observability/logs", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const namespace = typeof req.query.namespace === "string" ? req.query.namespace : "";
    const podName = typeof req.query.podName === "string" ? req.query.podName : "";
    const limit = Math.min(500, Math.max(10, parseInt(String(req.query.limit ?? "200"), 10) || 200));
    const sinceMinutes = Math.min(1440, Math.max(1, parseInt(String(req.query.sinceMinutes ?? "30"), 10) || 30));

    if (!clusterId || !namespace || !podName) {
      res.status(400).json({ error: "missing_params", message: "clusterId, namespace, podName are required" });
      return;
    }

    try {
      const { logs, containerInsightsAvailable } = await collectPodLogs(
        env, req.auth?.bearerToken, clusterId, namespace, podName, limit, sinceMinutes,
      );
      const data: ObservabilityLogsResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        logs,
        podName,
        namespace,
        hasMore: logs.length >= limit,
      };
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] logs error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "logs_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
