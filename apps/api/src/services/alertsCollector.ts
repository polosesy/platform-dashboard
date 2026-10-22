import type { Env } from "../env.js";
import type { LiveAlert, LiveAlertHistory, AlertSeverity, DiagramNodeSpec } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcher } from "../infra/azureClientFactory.js";

// ────────────────────────────────────────────
// Azure Monitor Alerts Collector
//
// Alerts Management "Alerts - Get All" per subscription, correlated with diagram nodes by target resource ID:
//   active  = monitorCondition Fired (and not Closed), any start time in the last 30 days
//   history = every instance (Fired or Resolved) that started in the last day — a rule that fires and mitigates
//             between two polls (flapping) is still visible
// The API takes plain query parameters (monitorCondition, timeRange 1h|1d|7d|30d, pageCount ≤ 250) and pages with
// nextLink; api-version 2018-05-05 (the newer 2023-01-01 does not exist for this resource type — every call of the
// old collector failed with 404 and was shown as "no active alerts").
// Learn: https://learn.microsoft.com/rest/api/monitor/alertsmanagement/alerts/get-all
// ────────────────────────────────────────────

export const ALERTS_API_VERSION = "2018-05-05";
/** Hours of history shown (instances are read for a day; older ones are dropped) */
export const HISTORY_HOURS = 6;
const MAX_PAGES = 4;

// Azure Alerts Management REST response shape
export type AzureAlert = {
  id: string;
  name: string;
  properties: {
    essentials: {
      severity: string; // "Sev0" | "Sev1" | "Sev2" | "Sev3" | "Sev4"
      signalType?: string;
      alertState: string; // "New" | "Acknowledged" | "Closed"
      monitorCondition: string; // "Fired" | "Resolved"
      monitorConditionResolvedDateTime?: string;
      targetResource?: string;
      targetResourceGroup?: string;
      targetResourceType?: string;
      startDateTime: string;
      lastModifiedDateTime?: string;
      description?: string;
      alertRule?: string;
    };
  };
};

type AlertsPage = { value?: AzureAlert[]; nextLink?: string };
export type AlertsFetch = (url: string) => Promise<AlertsPage>;

export type DiagramAlerts = {
  alerts: LiveAlert[];
  history: LiveAlertHistory[];
  /** ok = every subscription answered; failed = at least one did not (nothing shown may then be wrong) */
  state: "ok" | "failed";
};

const alertsCache = new CacheManager<DiagramAlerts>(50, 60_000);
const inflight = new Map<string, Promise<DiagramAlerts>>();

export function mapSeverity(azureSeverity: string): AlertSeverity {
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

const sevNumber = (s: string) => Number(/\d/.exec(s ?? "")?.[0] ?? 4);
const ruleName = (a: AzureAlert) => (a.properties.essentials.alertRule ?? a.name).split("/").filter(Boolean).pop() ?? a.name;

export function alertsUrl(subscriptionId: string, condition: "Fired" | "Resolved"): string {
  return `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.AlertsManagement/alerts` +
    `?api-version=${ALERTS_API_VERSION}&monitorCondition=${condition}&timeRange=${condition === "Fired" ? "30d" : "1d"}` +
    `&pageCount=250&includeContext=false`;
}

/** Every page of one query (nextLink), at most MAX_PAGES — throws on any error (the caller reports "failed") */
export async function fetchAllPages(fetch: AlertsFetch, firstUrl: string): Promise<AzureAlert[]> {
  const out: AzureAlert[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r: AlertsPage = await fetch(url);
    out.push(...(r.value ?? []));
    url = r.nextLink;
  }
  return out;
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
 * Alerts of the subscriptions → the diagram's active alerts and per (node, rule) history. Pure.
 * Target resource IDs are compared case-insensitively (Azure writes `resourcegroups` in some places).
 */
export function correlateAlerts(
  azAlerts: AzureAlert[],
  resourceIdToNodeId: Map<string, string>,
  edgeMap: Map<string, { source: string; target: string }>,
  nowMs: number,
): { alerts: LiveAlert[]; history: LiveAlertHistory[] } {
  const since = nowMs - HISTORY_HOURS * 3600_000;
  const seen = new Set<string>();
  const alerts: LiveAlert[] = [];
  const hist = new Map<string, LiveAlertHistory>();

  for (const az of azAlerts) {
    if (seen.has(az.id)) continue;   // the Fired and Resolved queries can overlap while an alert changes state
    seen.add(az.id);
    const e = az.properties.essentials;
    const nodeId = e.targetResource ? resourceIdToNodeId.get(e.targetResource.toLowerCase()) : undefined;
    if (!nodeId) continue;
    const active = e.monitorCondition === "Fired" && e.alertState !== "Closed";

    if (active) {
      const affectedEdgeIds = [...edgeMap].filter(([, ed]) => ed.source === nodeId || ed.target === nodeId).map(([id]) => id);
      alerts.push({
        id: az.name,
        severity: mapSeverity(e.severity),
        title: ruleName(az),
        resourceId: e.targetResource ?? "",
        firedAt: e.startDateTime,
        summary: e.description ?? "Azure Monitor alert fired",
        rootCauseCandidates: inferRootCauses(az),
        affectedNodeIds: [nodeId],
        affectedEdgeIds,
      });
    }

    const started = Date.parse(e.startDateTime);
    if (!active && !(started >= since)) continue;   // history: active ones always, others when they started recently
    const key = `${nodeId}|${ruleName(az).toLowerCase()}`;
    const h = hist.get(key) ?? {
      nodeId, rule: ruleName(az), severity: mapSeverity(e.severity), sev: sevNumber(e.severity),
      active: false, instances: [], count: 0, windowHours: HISTORY_HOURS,
    };
    h.active ||= active;
    h.count++;
    h.instances.push({
      firedAt: e.startDateTime,
      ...(e.monitorCondition === "Resolved" && e.monitorConditionResolvedDateTime ? { resolvedAt: e.monitorConditionResolvedDateTime } : {}),
    });
    hist.set(key, h);
  }

  // Sort by severity (critical first) then by firedAt (newest first)
  const sevOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || Date.parse(b.firedAt) - Date.parse(a.firedAt));
  const history = [...hist.values()].map((h) => ({
    ...h,
    instances: h.instances.sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt)).slice(0, 10),
  })).sort((a, b) => Number(b.active) - Number(a.active) || a.sev - b.sev || Date.parse(b.instances[0]!.firedAt) - Date.parse(a.instances[0]!.firedAt));
  return { alerts, history };
}

/** One subscription's alerts: the active ones (30 days) and everything of the last day */
async function subscriptionAlerts(fetch: AlertsFetch, subscriptionId: string): Promise<AzureAlert[]> {
  const [fired, resolved] = await Promise.all([
    fetchAllPages(fetch, alertsUrl(subscriptionId, "Fired")),
    fetchAllPages(fetch, alertsUrl(subscriptionId, "Resolved")),
  ]);
  return [...fired, ...resolved];
}

/**
 * Alerts of the diagram's subscriptions, correlated with its nodes. A subscription that fails makes the result
 * "failed" — the page then says alerts could not be read instead of "no active alerts" — and is not cached.
 */
export async function collectDiagramAlerts(
  env: Env,
  bearerToken: string,
  nodes: DiagramNodeSpec[],
  edgeMap: Map<string, { source: string; target: string }>,
  fetchOverride?: AlertsFetch,
): Promise<DiagramAlerts> {
  const prefix = bearerKeyPrefix(bearerToken);
  const cacheKey = `${prefix}:alerts:${nodes.map((n) => n.id).sort().join(",")}`;
  const cached = alertsCache.get(cacheKey);
  if (cached) return cached;
  const running = inflight.get(cacheKey);
  if (running) return running;

  const job = (async (): Promise<DiagramAlerts> => {
    const subscriptionIds = new Set<string>();
    const resourceIdToNodeId = new Map<string, string>();
    for (const node of nodes) {
      if (!node.azureResourceId) continue;
      resourceIdToNodeId.set(node.azureResourceId.toLowerCase(), node.id);
      const match = node.azureResourceId.match(/\/subscriptions\/([^/]+)/i);
      if (match) subscriptionIds.add(match[1]!.toLowerCase());
    }
    if (subscriptionIds.size === 0) return { alerts: [], history: [], state: "ok" };

    const fetcher = fetchOverride ?? (await getArmFetcher(env, bearerToken)).fetchJson as AlertsFetch;
    let failed = false;
    const all = (await Promise.all([...subscriptionIds].map((sub) =>
      subscriptionAlerts(fetcher, sub).catch(() => { failed = true; return [] as AzureAlert[]; })))).flat();
    const result: DiagramAlerts = { ...correlateAlerts(all, resourceIdToNodeId, edgeMap, Date.now()), state: failed ? "failed" : "ok" };
    if (!failed) alertsCache.set(cacheKey, result, env.AZURE_MONITOR_ALERTS_CACHE_TTL_MS);
    return result;
  })();
  inflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(cacheKey);
  }
}
