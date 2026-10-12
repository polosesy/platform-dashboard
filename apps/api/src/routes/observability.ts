import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import {
  getObservabilityOverview,
  getObservabilityWorkloads,
  getObservabilityNodes,
} from "../services/observabilityAggregator.js";
import { collectPodLogs } from "../services/containerInsightsCollector.js";
import { listAllNamespacePods, readPodLogs, getWorkloadDetail } from "../services/kubernetes.js";
import type {
  ObservabilityStatusResponse,
  ObservabilityLogsResponse,
  ObservabilityNamespacesResponse,
  PodLogEntry,
} from "@aud/types";
import {
  HttpError,
  assertArmResourceId,
  queryArmResourceId,
  queryInt,
  queryString,
  sendError,
} from "../infra/requestParams.js";

/**
 * Cluster selector for Container Insights / Prometheus queries: either a full
 * AKS resource ID (validated) or a plain cluster name used as a KQL filter.
 */
function queryClusterSelector(req: Request, env: Env): string {
  const raw = queryString(req, "clusterId") ?? "default";
  return raw.toLowerCase().startsWith("/subscriptions/") ? assertArmResourceId(env, raw, "clusterId") : raw;
}

function requireQuery(req: Request, names: string[]): string[] {
  return names.map((n) => {
    const v = queryString(req, n);
    if (!v) throw new HttpError(400, "missing_params", `${names.join(", ")} are required`);
    return v;
  });
}

export function registerObservabilityRoutes(router: Router, env: Env) {
  // Status — data source connectivity check
  router.get("/api/observability/status", (_req: Request, res: Response) => {
    const workspaceId = env.AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID ?? env.AZURE_LOG_ANALYTICS_WORKSPACE_ID ?? null;
    const status: ObservabilityStatusResponse = {
      generatedAt: new Date().toISOString(),
      dataSourceStatus: {
        // Workspace may also be auto-discovered per cluster at request time
        containerInsights: !!workspaceId,
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
    try {
      const clusterId = queryClusterSelector(req, env);
      const clusterName = queryString(req, "clusterName") ?? clusterId;
      res.json(await getObservabilityOverview(env, req.auth?.bearerToken, clusterId, clusterName));
    } catch (e: unknown) {
      sendError(res, e, "overview_failed", "observability");
    }
  });

  // Workloads — full workload list with APM metrics
  router.get("/api/observability/workloads", async (req: Request, res: Response) => {
    try {
      res.json(await getObservabilityWorkloads(env, req.auth?.bearerToken, queryClusterSelector(req, env)));
    } catch (e: unknown) {
      sendError(res, e, "workloads_failed", "observability");
    }
  });

  // Nodes — node resource usage
  router.get("/api/observability/nodes", async (req: Request, res: Response) => {
    try {
      res.json(await getObservabilityNodes(env, req.auth?.bearerToken, queryClusterSelector(req, env)));
    } catch (e: unknown) {
      sendError(res, e, "nodes_failed", "observability");
    }
  });

  // ── Namespaces + Pods — K8s API 직접 조회 (실시간) ──
  router.get("/api/observability/namespaces", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const { pods, namespaces } = await listAllNamespacePods(env, req.auth?.bearerToken, clusterId);

      const items: ObservabilityNamespacesResponse["items"] = pods.map((p) => ({
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
          items.push({ namespace: ns.name, podName: "", workloadName: "", status: "", containers: [] });
        }
      }

      const data: ObservabilityNamespacesResponse = { clusterId, generatedAt: new Date().toISOString(), items };
      res.json(data);
    } catch (e: unknown) {
      sendError(res, e, "namespaces_failed", "observability");
    }
  });

  // ── Workload Detail — per-pod + services + endpoints ──
  router.get("/api/observability/workloads/detail", async (req: Request, res: Response) => {
    try {
      const [, namespace, workloadName] = requireQuery(req, ["clusterId", "namespace", "workloadName"]);
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const kind = queryString(req, "kind") ?? "Deployment";
      res.json(await getWorkloadDetail(env, req.auth?.bearerToken, clusterId, namespace!, workloadName!, kind));
    } catch (e: unknown) {
      sendError(res, e, "workload_detail_failed", "observability");
    }
  });

  // ── Logs — K8s API 직접 조회 (primary) + Container Insights (fallback) ──
  router.get("/api/observability/logs", async (req: Request, res: Response) => {
    let clusterId: string;
    let namespace: string;
    let podName: string;
    try {
      [, namespace, podName] = requireQuery(req, ["clusterId", "namespace", "podName"]) as [string, string, string];
      clusterId = queryArmResourceId(req, env, "clusterId");
    } catch (e: unknown) {
      return sendError(res, e, "logs_failed");
    }
    const container = queryString(req, "container");
    const limit = queryInt(req, "limit", 200, 10, 500);
    const sinceMinutes = queryInt(req, "sinceMinutes", 30, 1, 1440);

    const respond = (logs: PodLogEntry[]) => {
      const data: ObservabilityLogsResponse = {
        clusterId,
        generatedAt: new Date().toISOString(),
        logs,
        podName,
        namespace,
        hasMore: logs.length >= limit,
      };
      res.json(data);
    };

    try {
      // Primary: Kubernetes API (kubelet). tailLines만 사용 — sinceSeconds는 startup 로그를 누락시킬 수 있음.
      // sinceMinutes는 Container Insights fallback에서만 사용.
      const rawLog = await readPodLogs(env, req.auth?.bearerToken, clusterId, namespace, podName, { container, tailLines: limit });
      respond(parseKubeletLogs(rawLog, podName, container ?? ""));
    } catch (k8sErr) {
      console.warn("[observability] K8s API logs failed, falling back to Container Insights:", k8sErr instanceof Error ? k8sErr.message : k8sErr);
      try {
        const { logs } = await collectPodLogs(env, req.auth?.bearerToken, clusterId, namespace, podName, limit, sinceMinutes);
        respond(logs);
      } catch (ciErr) {
        console.error("[observability] logs error (both K8s API and CI failed):", ciErr instanceof Error ? ciErr.message : ciErr);
        sendError(res, k8sErr, "logs_failed");
      }
    }
  });
}

// ── K8s API 로그 파싱 ──
// timestamps=true 형식: "2026-03-24T10:30:00.123456789Z log message here"
// kubelet 로그 API는 stdout/stderr를 구분하지 않으므로 stream은 "unknown".
function parseKubeletLogs(raw: string, podName: string, containerName: string): PodLogEntry[] {
  if (!raw || !raw.trim()) return [];

  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s(.*)/);
      return {
        timestamp: tsMatch ? tsMatch[1]! : "",
        podName,
        containerName,
        logMessage: tsMatch ? tsMatch[2]! : line,
        stream: "unknown" as const,
      };
    });
}
