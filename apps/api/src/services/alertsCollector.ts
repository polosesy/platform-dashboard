import type { Env } from "../env";
import type { LiveAlert, AlertSeverity, DiagramNodeSpec } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Azure Monitor Alerts Collector
//
// Fetches active alerts from Azure Alerts Management API,
// then correlates them with diagram nodes by azureResourceId
// to produce LiveAlert[] for the snapshot.
// ────────────────────────────────────────────

const alertsCache = new CacheManager<LiveAlert[]>(50, 60_000);

// Azure Alerts Management REST response shape
type AzureAlert = {
  id: string;
  name: string;
  properties: {
    essentials: {
      severity: string; // "Sev0" | "Sev1" | "Sev2" | "Sev3" | "Sev4"
      signalType: string;
      alertState: string; // "New" | "Acknowledged" | "Closed"
      monitorCondition: string; // "Fired" | "Resolved"
      targetResource?: string;
      targetResourceGroup?: string;
      targetResourceType?: string;
      startDateTime: string;
      lastModifiedDateTime: string;
      description?: string;
      alertRule?: string;
    };
    context?: {
      // Custom payload from alert rule
      context?: Record<string, unknown>;
    };
  };
};

type AlertsResponse = {
  value?: AzureAlert[];
  nextLink?: string;
};

function mapSeverity(azureSeverity: string): AlertSeverity {
  switch (azureSeverity) {
    case "Sev0":
    case "Sev1":
      return "critical";
    case "Sev2":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Fetch active alerts for a subscription from Azure Alerts Management API.
 */
async function fetchAzureAlerts(
  env: Env,
  bearerToken: string,
  subscriptionId: string,
): Promise<AzureAlert[]> {
  const fetcher = await getArmFetcher(env, bearerToken);

  // Filter: only fired/new alerts
  const filter = encodeURIComponent(
    "properties/essentials/monitorCondition eq 'Fired' and properties/essentials/alertState ne 'Closed'",
  );

  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/providers/Microsoft.AlertsManagement/alerts` +
    `?api-version=2023-01-01` +
    `&$filter=${filter}` +
    `&$top=100`;

  const resp = await fetcher.fetchJson<AlertsResponse>(url);
  return resp.value ?? [];
}

/**
 * Determine root-cause candidates based on alert context.
 * Basic heuristic — maps severity + resource type to common causes.
 */
function inferRootCauses(alert: AzureAlert): string[] {
  const causes: string[] = [];
  const resType = alert.properties.essentials.targetResourceType?.toLowerCase() ?? "";
  const sev = alert.properties.essentials.severity;

  if (resType.includes("managedclusters")) {
    causes.push("Pod resource limits exceeded");
    if (sev === "Sev0" || sev === "Sev1") causes.push("Node pool autoscaler at max");
  } else if (resType.includes("databases") || resType.includes("sql")) {
    causes.push("Query plan regression");
    if (sev === "Sev0") causes.push("DTU/vCore saturation");
  } else if (resType.includes("redis")) {
    causes.push("Memory pressure");
    causes.push("Connection pool exhaustion");
  } else if (resType.includes("applicationgateways")) {
    causes.push("Backend pool unhealthy");
  } else if (resType.includes("sites") || resType.includes("functions")) {
    causes.push("Cold start latency");
    causes.push("Scaling limit reached");
  }

  return causes;
}

/**
 * Collect alerts for the diagram and correlate with nodes/edges.
 *
 * 1. Extracts unique subscription IDs from node azureResourceIds.
 * 2. Fetches alerts for each subscription (parallel).
 * 3. Maps alerts to LiveAlert[], linking to affected nodes/edges.
 */
export async function collectDiagramAlerts(
  env: Env,
  bearerToken: string,
  nodes: DiagramNodeSpec[],
  edgeMap: Map<string, { source: string; target: string }>,
): Promise<LiveAlert[]> {
  const prefix = bearerKeyPrefix(bearerToken);
  const nodeIds = nodes.map((n) => n.id).sort().join(",");
  const cacheKey = `${prefix}:alerts:${nodeIds}`;
  const cached = alertsCache.get(cacheKey);
  if (cached) return cached;

  // Extract unique subscription IDs from node resource IDs
  const subscriptionIds = new Set<string>();
  const resourceIdToNodeId = new Map<string, string>();

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    resourceIdToNodeId.set(node.azureResourceId.toLowerCase(), node.id);
    const match = node.azureResourceId.match(/\/subscriptions\/([^/]+)/i);
    if (match) subscriptionIds.add(match[1]!);
  }

  if (subscriptionIds.size === 0) return [];

  // Fetch alerts from all subscriptions in parallel
  const allAzureAlerts: AzureAlert[] = [];
  const fetchPromises = [...subscriptionIds].map(async (subId) => {
    try {
      const alerts = await fetchAzureAlerts(env, bearerToken, subId);
      allAzureAlerts.push(...alerts);
    } catch {
      // Non-critical: skip alerts for failed subscriptions
    }
  });
  await Promise.all(fetchPromises);

  // Correlate alerts with diagram nodes
  const liveAlerts: LiveAlert[] = [];

  for (const azAlert of allAzureAlerts) {
    const targetResource = azAlert.properties.essentials.targetResource?.toLowerCase();
    if (!targetResource) continue;

    // Find matching node
    const matchedNodeId = resourceIdToNodeId.get(targetResource);
    if (!matchedNodeId) continue; // Alert for resource not in diagram

    // Find edges connected to the affected node
    const affectedEdgeIds: string[] = [];
    for (const [edgeId, edge] of edgeMap) {
      if (edge.source === matchedNodeId || edge.target === matchedNodeId) {
        affectedEdgeIds.push(edgeId);
      }
    }

    liveAlerts.push({
      id: azAlert.name,
      severity: mapSeverity(azAlert.properties.essentials.severity),
      title: azAlert.properties.essentials.alertRule ?? azAlert.name,
      resourceId: azAlert.properties.essentials.targetResource ?? "",
      firedAt: azAlert.properties.essentials.startDateTime,
      summary: azAlert.properties.essentials.description ?? "Azure Monitor alert fired",
      rootCauseCandidates: inferRootCauses(azAlert),
      affectedNodeIds: [matchedNodeId],
      affectedEdgeIds,
    });
  }

  // Sort by severity (critical first) then by firedAt (newest first)
  liveAlerts.sort((a, b) => {
    const sevOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
    const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.firedAt).getTime() - new Date(a.firedAt).getTime();
  });

  alertsCache.set(cacheKey, liveAlerts);
  return liveAlerts;
}
