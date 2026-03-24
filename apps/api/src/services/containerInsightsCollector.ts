import type { Env } from "../env";
import type {
  WorkloadHealth,
  NodeResourceSummary,
  NodeConditionSummary,
  ResourceUsage,
} from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getLogAnalyticsFetcherAuto, getArmFetcherAuto } from "../infra/azureClientFactory";

// ──────────────────────────────────────────────────────────────
// Container Insights Collector
//
// Queries Azure Log Analytics (Container Insights tables) for
// pod/node resource metrics.  Tables used:
//   - KubePodInventory  — workload pod state counts
//   - KubeNodeInventory — node status + conditions
//   - InsightsMetrics   — CPU/memory usage (cpuUsageNanoCores, memoryWorkingSetBytes)
//
// Auto-discovers Log Analytics workspace from AKS cluster ARM ID.
// Falls back gracefully when Container Insights is not enabled.
// ──────────────────────────────────────────────────────────────

type LogAnalyticsTable = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
};
type LaQueryResponse = {
  tables?: LogAnalyticsTable[];
  error?: { message?: string };
};

const workloadsCache = new CacheManager<WorkloadHealth[]>(20, 60_000);
const nodesCache = new CacheManager<NodeResourceSummary[]>(20, 60_000);
const workspaceIdCache = new CacheManager<string>(10, 5 * 60_000);

// ── Auto-discover Log Analytics workspace from AKS cluster ──
//
// AKS 모니터링 설정은 두 가지 경로로 workspace 참조를 저장합니다:
//   (a) Legacy OMS agent: addonProfiles.omsagent.config.logAnalyticsWorkspaceResourceID
//   (b) AMA (Azure Monitor Agent): azureMonitorProfile.containerInsights.logAnalyticsWorkspaceResourceId
// 클러스터 ARM API에서 두 경로 모두 확인합니다.

type AksClusterMonitoringProps = {
  properties?: {
    addonProfiles?: {
      omsagent?: { enabled?: boolean; config?: { logAnalyticsWorkspaceResourceID?: string } };
      omsAgent?: { enabled?: boolean; config?: { logAnalyticsWorkspaceResourceID?: string } };
    };
    azureMonitorProfile?: {
      containerInsights?: {
        enabled?: boolean;
        logAnalyticsWorkspaceResourceId?: string;
      };
      metrics?: { enabled?: boolean };
    };
  };
};

async function resolveWorkspaceId(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<string | null> {
  // 1) AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID가 명시적으로 설정된 경우 우선
  //    (AZURE_LOG_ANALYTICS_WORKSPACE_ID는 Traffic Analytics용이므로 여기서 fallback 안 함)
  if (env.AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID) {
    return env.AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID;
  }

  // 2) 클러스터 ARM ID에서 자동 탐색
  if (clusterId && clusterId.toLowerCase().startsWith("/subscriptions/")) {
    const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
    const cacheKey = `${prefix}:ws-resolve:${clusterId.toLowerCase()}`;
    const cached = workspaceIdCache.get(cacheKey);
    if (cached) return cached;

    try {
      const fetcher = await getArmFetcherAuto(env, bearerToken);
      const clusterUrl = `https://management.azure.com${clusterId}?api-version=2024-09-01`;
      const cluster = await fetcher.fetchJson<AksClusterMonitoringProps>(clusterUrl);

      // (a) AMA 방식: azureMonitorProfile.containerInsights
      const amaWsId =
        cluster.properties?.azureMonitorProfile?.containerInsights?.logAnalyticsWorkspaceResourceId;

      // (b) Legacy 방식: addonProfiles.omsagent
      const omsWsId =
        cluster.properties?.addonProfiles?.omsagent?.config?.logAnalyticsWorkspaceResourceID ??
        cluster.properties?.addonProfiles?.omsAgent?.config?.logAnalyticsWorkspaceResourceID;

      const wsResourceId = amaWsId ?? omsWsId;

      console.log("[containerInsights] cluster addon discovery:", {
        clusterId,
        amaEnabled: cluster.properties?.azureMonitorProfile?.containerInsights?.enabled,
        amaWsId: amaWsId ?? "(none)",
        omsEnabled: cluster.properties?.addonProfiles?.omsagent?.enabled,
        omsWsId: omsWsId ?? "(none)",
        prometheusEnabled: cluster.properties?.azureMonitorProfile?.metrics?.enabled,
      });

      if (wsResourceId) {
        // workspace ARM resource ID → customerId (GUID)
        const wsUrl = `https://management.azure.com${wsResourceId}?api-version=2022-10-01`;
        const ws = await fetcher.fetchJson<{
          properties?: { customerId?: string };
        }>(wsUrl);

        const workspaceGuid = ws.properties?.customerId;
        if (workspaceGuid) {
          console.log("[containerInsights] Auto-discovered workspace GUID:", workspaceGuid);
          workspaceIdCache.set(cacheKey, workspaceGuid);
          return workspaceGuid;
        }
        console.warn("[containerInsights] Workspace has no customerId:", wsResourceId);
      } else {
        console.warn("[containerInsights] No Container Insights workspace in cluster config");
      }
    } catch (err) {
      console.error("[containerInsights] workspace resolve error:", err instanceof Error ? err.message : err);
    }
  }

  // 3) 최후 fallback: 공유 Log Analytics workspace (Traffic Analytics와 동일)
  const fallback = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  if (fallback) {
    console.log("[containerInsights] Falling back to AZURE_LOG_ANALYTICS_WORKSPACE_ID:", fallback);
  }
  return fallback ?? null;
}

function tableToObjects(table: LogAnalyticsTable): Record<string, unknown>[] {
  const cols = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]!] = row[i];
    return obj;
  });
}

function asNumber(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

// ── Workloads: KubePodInventory + InsightsMetrics ──

export async function collectWorkloadHealth(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<{ workloads: WorkloadHealth[]; containerInsightsAvailable: boolean }> {
  const workspaceId = await resolveWorkspaceId(env, bearerToken, clusterId);
  if (!workspaceId) {
    console.warn("[containerInsights] No workspace ID resolved for cluster:", clusterId);
    return { workloads: [], containerInsightsAvailable: false };
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:obs:workloads:${workspaceId}:${clusterId}`;
  const cached = workloadsCache.get(cacheKey);
  if (cached) return { workloads: cached, containerInsightsAvailable: true };

  try {
    const fetcher = await getLogAnalyticsFetcherAuto(env, bearerToken);

    // ClusterId 필터: ARM resource ID 포함 여부로 클러스터 구분
    const clusterFilter = clusterId.startsWith("/subscriptions/")
      ? `| where ClusterId =~ "${clusterId}"`
      : `| where ClusterId contains "${clusterId}"`;

    // Query 1: Pod inventory grouped by controller (workload)
    // ContainerLogV2 스키마에서는 PodName 대신 Name, Restarts 대신 PodRestartCount 사용 가능
    // column_ifexists()로 양쪽 스키마 호환
    const podKql = `
KubePodInventory
| where TimeGenerated > ago(5m)
${clusterFilter}
| extend _PodLabel = coalesce(column_ifexists("PodName", ""), column_ifexists("Name", ""), tostring(PodUid))
| extend _Restarts = toint(coalesce(tostring(column_ifexists("PodRestartCount", "")), tostring(column_ifexists("Restarts", "")), "0"))
| summarize arg_max(TimeGenerated, *) by PodUid
| summarize
    TotalPods   = dcount(_PodLabel),
    RunningPods = countif(PodStatus == "Running"),
    PendingPods = countif(PodStatus == "Pending"),
    FailedPods  = countif(PodStatus in ("Failed","CrashLoopBackOff","Error","OOMKilled")),
    TotalRestarts = sum(_Restarts)
  by ControllerName, ControllerKind, Namespace
| where isnotempty(ControllerName) and ControllerKind in ("ReplicaSet","StatefulSet","DaemonSet","Deployment")
| top 100 by TotalPods desc`;

    // Query 2: CPU/memory from InsightsMetrics (container level, grouped to controller)
    // Namespace: "container.azm.ms/k8s" (AMA) 또는 "k8s" (legacy OMS)
    const metricsKql = `
InsightsMetrics
| where TimeGenerated > ago(5m) and Namespace in ("container.azm.ms/k8s", "k8s")
| where Name in ("cpuUsageNanoCores", "memoryWorkingSetBytes")
| extend Tags = todynamic(Tags)
| extend
    _ControllerName = coalesce(tostring(Tags.controllerName), tostring(Tags.k8sControllerName), ""),
    _K8sNs          = coalesce(tostring(Tags["k8sNamespace"]), tostring(Tags.Namespace), ""),
    _CpuLimit       = todouble(coalesce(Tags.cpuLimitNanoCores, Tags.k8sCpuLimitNanoCores, "0")),
    _MemLimit       = todouble(coalesce(Tags.memoryLimitBytes, Tags.k8sMemoryLimitBytes, "0"))
| where isnotempty(_ControllerName) and isnotempty(_K8sNs)
| summarize AvgVal = avg(Val), AvgLimit = avg(_CpuLimit + _MemLimit) by Name, _ControllerName, _K8sNs
| summarize
    AvgCpuNano   = avgif(AvgVal, Name == "cpuUsageNanoCores"),
    AvgMemBytes  = avgif(AvgVal, Name == "memoryWorkingSetBytes"),
    CpuLimitNano = maxif(AvgLimit, Name == "cpuUsageNanoCores"),
    MemLimitBytes = maxif(AvgLimit, Name == "memoryWorkingSetBytes")
  by _ControllerName, _K8sNs`;

    console.log("[containerInsights] querying workloads — workspace:", workspaceId, "cluster:", clusterId);

    const [podResult, metricsResult] = await Promise.allSettled([
      fetcher.query(workspaceId, podKql),
      fetcher.query(workspaceId, metricsKql),
    ]);

    // Parse pod inventory
    const podMap = new Map<string, WorkloadHealth>();
    if (podResult.status === "fulfilled") {
      const resp = podResult.value as LaQueryResponse;
      if (resp.error) {
        console.error("[containerInsights] KQL pod error:", resp.error.message);
      }
      const table = resp.tables?.[0];
      console.log("[containerInsights] pod query — rows:", table?.rows?.length ?? 0, "columns:", table?.columns?.map((c: { name: string }) => c.name).join(", ") ?? "(none)");
      if (table) {
        for (const row of tableToObjects(table)) {
          const name = asString(row.ControllerName);
          const ns = asString(row.Namespace);
          const rawKind = asString(row.ControllerKind);
          // Normalize ReplicaSet → Deployment (strip RS suffix pattern)
          const kind = (rawKind === "ReplicaSet" ? "Deployment" : rawKind) as WorkloadHealth["kind"];
          const key = `${ns}/${name}`;
          podMap.set(key, {
            name,
            namespace: ns,
            kind,
            pods: {
              total: asNumber(row.TotalPods) ?? 0,
              running: asNumber(row.RunningPods) ?? 0,
              pending: asNumber(row.PendingPods) ?? 0,
              failed: asNumber(row.FailedPods) ?? 0,
              restarts: asNumber(row.TotalRestarts) ?? 0,
            },
            cpu: null,
            memory: null,
            apm: null,
            jvm: null,
          });
        }
      }
    }

    if (podResult.status === "rejected") {
      console.error("[containerInsights] pod query rejected:", podResult.reason);
    }

    // Merge metrics into workload map
    if (metricsResult.status === "fulfilled") {
      const resp = metricsResult.value as LaQueryResponse;
      const table = resp.tables?.[0];
      if (table) {
        for (const row of tableToObjects(table)) {
          const rsName = asString(row._ControllerName ?? row.RsName);
          const ns = asString(row._K8sNs ?? row.K8sNs);

          // Try direct key match, then strip RS hash suffix (rs-name-xxxxx → name)
          let wl = podMap.get(`${ns}/${rsName}`);
          if (!wl) {
            // ReplicaSet name pattern: deployment-name-<hash> — strip last segment
            const stripped = rsName.replace(/-[a-z0-9]+$/, "");
            wl = podMap.get(`${ns}/${stripped}`);
          }
          if (!wl) continue;

          const cpuNano = asNumber(row.AvgCpuNano);
          const memBytes = asNumber(row.AvgMemBytes);
          const cpuLimitNano = asNumber(row.CpuLimitNano);
          const memLimitBytes = asNumber(row.MemLimitBytes);

          if (cpuNano !== null) {
            const cpuMillicores = cpuNano / 1_000_000;
            const cpuLimitMilli = cpuLimitNano ? cpuLimitNano / 1_000_000 : null;
            const cpuUsage: ResourceUsage = {
              usageRaw: Math.round(cpuMillicores),
              usagePct: cpuLimitMilli ? Math.min(100, (cpuMillicores / cpuLimitMilli) * 100) : 0,
              limitRaw: cpuLimitMilli ? Math.round(cpuLimitMilli) : null,
              requestRaw: null,
            };
            wl.cpu = cpuUsage;
          }

          if (memBytes !== null) {
            const memMiB = memBytes / (1024 * 1024);
            const memLimitMiB = memLimitBytes ? memLimitBytes / (1024 * 1024) : null;
            const memUsage: ResourceUsage = {
              usageRaw: Math.round(memMiB),
              usagePct: memLimitMiB ? Math.min(100, (memMiB / memLimitMiB) * 100) : 0,
              limitRaw: memLimitMiB ? Math.round(memLimitMiB) : null,
              requestRaw: null,
            };
            wl.memory = memUsage;
          }
        }
      }
    }

    const workloads = [...podMap.values()];
    workloadsCache.set(cacheKey, workloads);
    return { workloads, containerInsightsAvailable: true };
  } catch (err) {
    console.error("[containerInsights] workloads error:", err instanceof Error ? err.message : err);
    return { workloads: [], containerInsightsAvailable: false };
  }
}

// ── Nodes: KubeNodeInventory ──

export async function collectNodeHealth(
  env: Env,
  bearerToken: string | undefined,
  clusterId: string,
): Promise<{ nodes: NodeResourceSummary[]; containerInsightsAvailable: boolean }> {
  const workspaceId = await resolveWorkspaceId(env, bearerToken, clusterId);
  if (!workspaceId) {
    console.warn("[containerInsights] No workspace ID resolved for nodes, cluster:", clusterId);
    return { nodes: [], containerInsightsAvailable: false };
  }

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const cacheKey = `${prefix}:obs:nodes:${workspaceId}:${clusterId}`;
  const cached = nodesCache.get(cacheKey);
  if (cached) return { nodes: cached, containerInsightsAvailable: true };

  try {
    const fetcher = await getLogAnalyticsFetcherAuto(env, bearerToken);

    const clusterFilter = clusterId.startsWith("/subscriptions/")
      ? `| where ClusterId =~ "${clusterId}"`
      : `| where ClusterId contains "${clusterId}"`;

    const nodeKql = `
KubeNodeInventory
| where TimeGenerated > ago(5m)
${clusterFilter}
| summarize arg_max(TimeGenerated, *) by Computer
| project
    NodeName = Computer,
    Status,
    Labels,
    Capacity = todynamic(Capacity)`;

    // Node-level metrics: join with cluster's nodes via KubeNodeInventory
    const nodeMetricsKql = `
let clusterNodes = KubeNodeInventory
| where TimeGenerated > ago(5m)
${clusterFilter}
| distinct Computer;
InsightsMetrics
| where TimeGenerated > ago(5m) and Namespace in ("container.azm.ms/k8s", "k8s")
| where Name in ("cpuUsageNanoCores", "memoryWorkingSetBytes", "cpuCapacityNanoCores", "memoryCapacityBytes")
| where isempty(todynamic(Tags).k8sPodName)
| extend Tags = todynamic(Tags)
| extend NodeName = coalesce(tostring(Tags.hostName), tostring(Tags.k8sNode), Computer)
| where NodeName in (clusterNodes)
| summarize AvgVal = avg(Val) by Name, NodeName`;

    const podCountKql = `
KubePodInventory
| where TimeGenerated > ago(5m)
${clusterFilter}
| extend _PodLabel = coalesce(column_ifexists("PodName", ""), column_ifexists("Name", ""), tostring(PodUid))
| summarize arg_max(TimeGenerated, *) by PodUid
| summarize PodCount = dcount(_PodLabel) by Computer`;

    console.log("[containerInsights] querying nodes — workspace:", workspaceId, "cluster:", clusterId);

    const [nodeResult, metricsResult, podCountResult] = await Promise.allSettled([
      fetcher.query(workspaceId, nodeKql),
      fetcher.query(workspaceId, nodeMetricsKql),
      fetcher.query(workspaceId, podCountKql),
    ]);

    // Build node map
    const nodeMap = new Map<string, NodeResourceSummary>();

    if (nodeResult.status === "fulfilled") {
      const resp = nodeResult.value as LaQueryResponse;
      if (resp.error) console.error("[containerInsights] KQL node error:", resp.error.message);
      const table = resp.tables?.[0];
      console.log("[containerInsights] node query rows:", table?.rows?.length ?? 0);
      if (table) {
        for (const row of tableToObjects(table)) {
          const name = asString(row.NodeName);
          if (!name) continue;
          const status = asString(row.Status);
          const cap = (row.Capacity as Record<string, unknown> | null) ?? {};
          const cpuStr = asString(cap.cpu ?? "");        // e.g. "4"
          const memStr = asString(cap.memory ?? "");     // e.g. "16Gi"

          const cpuCores = cpuStr ? parseFloat(cpuStr) : null;
          const memMiB = parseMemToMiB(memStr);

          nodeMap.set(name, {
            name,
            status: status === "Ready" ? "Ready" : status === "NotReady" ? "NotReady" : "Unknown",
            cpuUsagePct: null,
            memoryUsagePct: null,
            cpuCapacityMillicores: cpuCores ? Math.round(cpuCores * 1000) : null,
            memoryCapacityMiB: memMiB,
            podCount: 0,
            conditions: [],
          });
        }
      }
    }

    // Merge CPU/memory metrics
    if (metricsResult.status === "fulfilled") {
      const resp = metricsResult.value as LaQueryResponse;
      const table = resp.tables?.[0];
      if (table) {
        const byNode = new Map<string, Record<string, number>>();
        for (const row of tableToObjects(table)) {
          const nodeName = asString(row.NodeName);
          const name = asString(row.Name);
          const val = asNumber(row.AvgVal);
          if (!nodeName || val === null) continue;
          if (!byNode.has(nodeName)) byNode.set(nodeName, {});
          byNode.get(nodeName)![name] = val;
        }
        for (const [nodeName, metrics] of byNode) {
          const node = nodeMap.get(nodeName);
          if (!node) continue;
          const cpuUsage = metrics["cpuUsageNanoCores"];
          const cpuCap = metrics["cpuCapacityNanoCores"] ?? ((node.cpuCapacityMillicores ?? 0) * 1_000_000);
          const memUsage = metrics["memoryWorkingSetBytes"];
          const memCap = metrics["memoryCapacityBytes"] ?? ((node.memoryCapacityMiB ?? 0) * 1024 * 1024);
          if (cpuUsage !== undefined && cpuCap > 0) {
            node.cpuUsagePct = Math.min(100, Math.round((cpuUsage / cpuCap) * 100));
          }
          if (memUsage !== undefined && memCap > 0) {
            node.memoryUsagePct = Math.min(100, Math.round((memUsage / memCap) * 100));
          }
        }
      }
    }

    // Merge pod counts
    if (podCountResult.status === "fulfilled") {
      const resp = podCountResult.value as LaQueryResponse;
      const table = resp.tables?.[0];
      if (table) {
        for (const row of tableToObjects(table)) {
          const node = nodeMap.get(asString(row.Computer));
          if (node) node.podCount = asNumber(row.PodCount) ?? 0;
        }
      }
    }

    const nodes = [...nodeMap.values()];
    nodesCache.set(cacheKey, nodes);
    return { nodes, containerInsightsAvailable: true };
  } catch (err) {
    console.error("[containerInsights] nodes error:", err instanceof Error ? err.message : err);
    return { nodes: [], containerInsightsAvailable: false };
  }
}

// ── Helpers ──

function parseMemToMiB(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/i);
  if (!m) return null;
  const val = parseFloat(m[1]!);
  const unit = (m[2] ?? "").toLowerCase();
  switch (unit) {
    case "ki": return Math.round(val / 1024);
    case "mi": return Math.round(val);
    case "gi": return Math.round(val * 1024);
    case "ti": return Math.round(val * 1024 * 1024);
    case "k":  return Math.round(val / 1024);
    case "m":  return Math.round(val);
    case "g":  return Math.round(val * 1024);
    case "t":  return Math.round(val * 1024 * 1024);
    default:   return Math.round(val / (1024 * 1024)); // assume bytes
  }
}

export function clearObservabilityCache(): void {
  workloadsCache.clear();
  nodesCache.clear();
}
