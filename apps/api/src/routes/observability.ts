import type { Request, Response, Router } from "express";
import type { Env } from "../env";
import {
  getObservabilityOverview,
  getObservabilityWorkloads,
  getObservabilityNodes,
} from "../services/observabilityAggregator";
import { collectPodLogs } from "../services/containerInsightsCollector";
import { listAllNamespacePods, readPodLogs, getWorkloadDetail } from "../services/kubernetes";
import type {
  ObservabilityStatusResponse,
  ObservabilityLogsResponse,
  ObservabilityNamespacesResponse,
  PodLogEntry,
} from "@aud/types";

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

  // ── Namespaces + Pods — K8s API 직접 조회 (실시간) ──
  router.get("/api/observability/namespaces", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    if (!clusterId) {
      res.status(400).json({ error: "missing_params", message: "clusterId is required" });
      return;
    }
    try {
      const { pods, namespaces } = await listAllNamespacePods(env, req.auth?.bearerToken, clusterId);

      // Pod가 있는 네임스페이스의 pod 항목
      const items = pods.map((p) => ({
        namespace: p.namespace,
        podName: p.podName,
        workloadName: p.podName,
        status: p.status,
        containers: p.containers,
      }));

      // Pod가 없는 네임스페이스도 빈 항목으로 포함 (프론트엔드 dropdown에 표시)
      const podNsSet = new Set(pods.map((p) => p.namespace));
      for (const ns of namespaces) {
        if (!podNsSet.has(ns.name)) {
          items.push({
            namespace: ns.name,
            podName: "",
            workloadName: "",
            status: "",
            containers: [],
          });
        }
      }

      const allNs = namespaces.map((n) => n.name).sort();
      console.log(`[observability] namespaces: ${pods.length} pods across ${allNs.length} namespaces [${allNs.join(", ")}]`);
      const data: ObservabilityNamespacesResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        items,
      };
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] namespaces error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "namespaces_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Workload Detail — per-pod + services + endpoints ──
  router.get("/api/observability/workloads/detail", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const namespace = typeof req.query.namespace === "string" ? req.query.namespace : "";
    const workloadName = typeof req.query.workloadName === "string" ? req.query.workloadName : "";
    const kind = typeof req.query.kind === "string" ? req.query.kind : "Deployment";

    if (!clusterId || !namespace || !workloadName) {
      res.status(400).json({ error: "missing_params", message: "clusterId, namespace, workloadName are required" });
      return;
    }

    try {
      const data = await getWorkloadDetail(env, req.auth?.bearerToken, clusterId, namespace, workloadName, kind);
      res.json(data);
    } catch (e: unknown) {
      console.error("[observability] workload detail error:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "workload_detail_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Logs — K8s API 직접 조회 (primary) + Container Insights (fallback) ──
  router.get("/api/observability/logs", async (req: Request, res: Response) => {
    const clusterId = typeof req.query.clusterId === "string" ? req.query.clusterId : "";
    const namespace = typeof req.query.namespace === "string" ? req.query.namespace : "";
    const podName = typeof req.query.podName === "string" ? req.query.podName : "";
    const container = typeof req.query.container === "string" ? req.query.container : undefined;
    const limit = Math.min(500, Math.max(10, parseInt(String(req.query.limit ?? "200"), 10) || 200));
    const sinceMinutes = Math.min(1440, Math.max(1, parseInt(String(req.query.sinceMinutes ?? "30"), 10) || 30));

    if (!clusterId || !namespace || !podName) {
      res.status(400).json({ error: "missing_params", message: "clusterId, namespace, podName are required" });
      return;
    }

    try {
      // Primary: Kubernetes API (kubelet에서 직접 로그 조회)
      // K8s API는 tailLines만 사용 (sinceSeconds는 startup 로그를 누락시킬 수 있음)
      // sinceMinutes는 CI fallback에서만 사용
      console.log(`[observability] logs: K8s API → ${namespace}/${podName} (tail=${limit})`);
      const rawLog = await readPodLogs(env, req.auth?.bearerToken, clusterId, namespace, podName, {
        container,
        tailLines: limit,
      });

      const logs: PodLogEntry[] = parseKubeletLogs(rawLog, podName);
      console.log(`[observability] logs: K8s API → ${namespace}/${podName}: ${logs.length} lines`);

      const data: ObservabilityLogsResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        logs,
        podName,
        namespace,
        hasMore: logs.length >= limit,
      };
      res.json(data);
    } catch (k8sErr) {
      console.warn("[observability] K8s API logs failed, falling back to Container Insights:", k8sErr instanceof Error ? k8sErr.message : k8sErr);

      // Fallback: Container Insights (historical logs via Log Analytics)
      try {
        const { logs } = await collectPodLogs(
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
      } catch (ciErr) {
        console.error("[observability] logs error (both K8s API and CI failed):", ciErr instanceof Error ? ciErr.message : ciErr);
        res.status(500).json({ error: "logs_failed", message: k8sErr instanceof Error ? k8sErr.message : String(k8sErr) });
      }
    }
  });
}

// ── K8s API 로그 파싱 ──
// timestamps=true 형식: "2026-03-24T10:30:00.123456789Z log message here"
function parseKubeletLogs(raw: string, podName: string): PodLogEntry[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim());
  return lines.map((line) => {
    // RFC3339Nano timestamp 추출
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s(.*)/);
    if (tsMatch) {
      return {
        timestamp: tsMatch[1]!,
        podName,
        containerName: "",
        logMessage: tsMatch[2]!,
        stream: "stdout" as const,
      };
    }
    return {
      timestamp: new Date().toISOString(),
      podName,
      containerName: "",
      logMessage: line,
      stream: "stdout" as const,
    };
  });
}
