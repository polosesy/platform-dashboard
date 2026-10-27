import type { Request, Response, Router } from "express";
import type { Env } from "../env.js";
import { requireRole } from "../infra/platformAccess.js";
import {
  getObservabilityOverview,
  getObservabilityWorkloads,
  getObservabilityNodes,
} from "../services/observabilityAggregator.js";
import { collectPodLogs } from "../services/containerInsightsCollector.js";
import { getObservabilityStack } from "../services/observabilityStack.js";
import { getObservabilitySources } from "../services/observabilitySources.js";
import { getWorkloadHeatmap } from "../services/workloadHeatmap.js";
import { listWarningEvents } from "../services/kubeEvents.js";
import { getWorkloadVpa } from "../services/workloadVpa.js";
import { getPodLogsFromLoki, getWorkloadLogs } from "../services/lokiLogs.js";
import { redactLogLine } from "../services/logRedaction.js";
import { podLogNamespaceAllowed } from "../services/aksAccess.js";
import { callerOf, roleAtLeast } from "../infra/platformAccess.js";
import { listAllNamespacePods, readPodLogs, getWorkloadDetail } from "../services/kubernetes.js";
import type {
  ObservabilityStatusResponse,
  ObservabilityLogsResponse,
  ObservabilityNamespacesResponse,
  PodLogAttempt,
  PodLogEntry,
  PodLogSource,
} from "@aud/types";
import {
  HttpError,
  assertArmResourceId,
  queryArmResourceId,
  queryInt,
  queryString,
  safeMessage,
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
  // Stack — the customer's collection pipeline (Alloy, Loki, Tempo, Pyroscope, KSM, scrape targets) from the cluster's
  // Azure Monitor workspace; states only, never sample data (services/observabilityStack.ts)
  // Heatmap — one tile per workload, the customer's container-map signals (services/workloadHeatmap.ts)
  router.get("/api/observability/heatmap", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await getWorkloadHeatmap(env, req.auth?.bearerToken, clusterId, queryInt(req, "window", 60, 1, 1440)));
    } catch (e: unknown) {
      sendError(res, e, "heatmap_failed", "observability");
    }
  });

  // Warning kube events (Kubernetes API, ~1 h) — the message only for operators, redacted
  router.get("/api/observability/events", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const messages = roleAtLeast(callerOf(env, req.auth?.bearerToken)?.role ?? null, "operator");
      res.json(await listWarningEvents(env, req.auth?.bearerToken, clusterId, {
        namespace: queryString(req, "namespace"), workload: queryString(req, "workload"), messages,
      }));
    } catch (e: unknown) {
      sendError(res, e, "events_failed", "observability");
    }
  });

  // VPA recommendation beside the workload's request / limit (Kubernetes API — the AMW has no VPA series)
  router.get("/api/observability/vpa", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const [namespace, workload] = requireQuery(req, ["namespace", "workload"]);
      res.json(await getWorkloadVpa(env, req.auth?.bearerToken, clusterId, { namespace: namespace!, workload: workload!, kind: queryString(req, "kind") }));
    } catch (e: unknown) {
      sendError(res, e, "vpa_failed", "observability");
    }
  });

  // Workload log stream from the cluster's Loki — the pod-log gate: operator + the connection's allowed namespaces
  router.get("/api/observability/workload-logs", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      const [namespace, workload] = requireQuery(req, ["namespace", "workload"]);
      if (!podLogNamespaceAllowed(env, clusterId, namespace!)) {
        throw new HttpError(403, "pod_log_namespace_denied", "Logs of this namespace are not read for this connection (aks.podLogNamespaces)");
      }
      const pods = (queryString(req, "pods") ?? "").split(",").filter(Boolean).slice(0, 20);
      res.json(await getWorkloadLogs(env, req.auth?.bearerToken, clusterId, {
        namespace: namespace!, workload: workload!, pods, errorsOnly: queryString(req, "errorsOnly") !== "false", minutes: queryInt(req, "minutes", 60, 1, 1440),
      }));
    } catch (e: unknown) {
      sendError(res, e, "workload_logs_failed", "observability");
    }
  });

  // Loki · Tempo · Pyroscope · Grafana: read / link only / blocked / not set up (Loki /ready probe cached per cluster)
  router.get("/api/observability/sources", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await getObservabilitySources(env, req.auth?.bearerToken, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "observability_sources_failed", "observability");
    }
  });

  router.get("/api/observability/stack", async (req: Request, res: Response) => {
    try {
      const clusterId = queryArmResourceId(req, env, "clusterId");
      res.json(await getObservabilityStack(env, req.auth?.bearerToken, clusterId));
    } catch (e: unknown) {
      sendError(res, e, "observability_stack_failed", "observability");
    }
  });

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

      // Which namespaces the Logs tab can read from inside the cluster (the rest fall back to Container Insights)
      const names = [...new Set(items.map((i) => i.namespace))];
      const logNamespaces = names.every((ns) => podLogNamespaceAllowed(env, clusterId, ns)) ? null : names.filter((ns) => podLogNamespaceAllowed(env, clusterId, ns));
      const data: ObservabilityNamespacesResponse = { clusterId, generatedAt: new Date().toISOString(), items, logNamespaces };
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

  // ── Logs — Loki (the cluster's own) → kubelet → Container Insights, each attempt reported ──
  // Pod logs can carry secrets and personal data — operators and admins only, and only the namespaces the connection
  // allows (`aks.podLogNamespaces`) are read from inside the cluster (Loki, kubelet); Container Insights stays the
  // customer-governed fallback. Never a silent empty list: `attempts` says which source answered and why the others
  // did not (the stg connection allowed one namespace, had no pods/log Role and no ContainerLogV2 — the tab was blank).
  router.get("/api/observability/logs", requireRole(env, "operator"), async (req: Request, res: Response) => {
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
    const allowed = podLogNamespaceAllowed(env, clusterId, namespace);
    const attempts: PodLogAttempt[] = [];
    let picked: { source: PodLogSource; logs: PodLogEntry[]; redactions: number } | null = null;

    try {
      // 1. Loki — every namespace the collector ships, with a time window
      if (!allowed) attempts.push({ source: "loki", state: "denied" });
      else {
        const r = await getPodLogsFromLoki(env, req.auth?.bearerToken, clusterId, { namespace, pod: podName, container, minutes: sinceMinutes, limit });
        if (r.state === "ok") {
          attempts.push({ source: "loki", state: r.lines.length ? "ok" : "empty" });
          if (r.lines.length) picked = { source: "loki", logs: r.lines, redactions: r.redactions };
        } else attempts.push({ source: "loki", state: r.state, ...(r.message ? { message: r.message } : {}) });
      }
      // 2. kubelet — needs a pods/log Role in that namespace (k8sReadSurface: never cluster-wide)
      if (!picked) {
        if (!allowed) attempts.push({ source: "kubelet", state: "denied" });
        else {
          try {
            const raw = await readPodLogs(env, req.auth?.bearerToken, clusterId, namespace, podName, { container, tailLines: limit });
            const logs = parseKubeletLogs(raw, podName, container ?? "");
            attempts.push({ source: "kubelet", state: logs.length ? "ok" : "empty" });
            if (logs.length) picked = { source: "kubelet", logs, redactions: 0 };
          } catch (e: unknown) {
            const status = (e as { status?: number }).status;
            attempts.push({ source: "kubelet", state: status === 403 ? "forbidden" : "failed", message: safeMessage(e) });
          }
        }
      }
      // 3. Container Insights — ContainerLogV2 / ContainerLog, when the cluster's DCR collects them
      if (!picked) {
        try {
          const { logs, containerInsightsAvailable } = await collectPodLogs(env, req.auth?.bearerToken, clusterId, namespace, podName, limit, sinceMinutes);
          if (!containerInsightsAvailable) attempts.push({ source: "containerInsights", state: "notConfigured" });
          else {
            let redactions = 0;
            const masked = logs.map((l) => { const r = redactLogLine(l.logMessage); redactions += r.n; return { ...l, logMessage: r.line }; });
            attempts.push({ source: "containerInsights", state: masked.length ? "ok" : "empty" });
            if (masked.length) picked = { source: "containerInsights", logs: masked, redactions };
          }
        } catch (e: unknown) {
          attempts.push({ source: "containerInsights", state: "failed", message: safeMessage(e) });
        }
      }
    } catch (e: unknown) {
      return sendError(res, e, "logs_failed");
    }

    const data: ObservabilityLogsResponse = {
      clusterId,
      generatedAt: new Date().toISOString(),
      logs: picked?.logs ?? [],
      podName,
      namespace,
      hasMore: (picked?.logs.length ?? 0) >= limit,
      source: picked?.source ?? null,
      attempts,
      redactions: picked?.redactions ?? 0,
    };
    res.json(data);
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
