import type { Env } from "../env.js";
import type { AlertRuleInfo, DiagramNodeSpec } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcher } from "../infra/azureClientFactory.js";

// ────────────────────────────────────────────
// Azure Alert Rules Collector
//
// Fetches configured alert rule definitions (not fired alerts)
// from Azure Resource Manager APIs, then correlates them with
// diagram nodes by azureResourceId.
// ────────────────────────────────────────────

const rulesCache = new CacheManager<AlertRuleInfo[]>(50, 120_000);

// ── ARM response shapes ──

type MetricAlertResource = {
  id: string;
  name: string;
  properties: {
    severity: number;
    enabled: boolean;
    scopes: string[];
    criteria?: {
      "odata.type"?: string;
      allOf?: Array<{
        metricName?: string;
        operator?: string;
        threshold?: number;
        metricNamespace?: string;
        timeAggregation?: string;
        dimensions?: Array<{ name?: string; operator?: string; values?: string[] }>;
      }>;
    };
    windowSize?: string;
    evaluationFrequency?: string;
    autoMitigate?: boolean;
    description?: string;
  };
};

/** How Azure evaluates a metric rule — aggregation, window, frequency, dimension filters (shown next to the condition:
 *  a card that reads the newest minute can disagree with a rule that judges five) */
export function metricRuleEvaluation(p: MetricAlertResource["properties"]): NonNullable<AlertRuleInfo["evaluation"]> {
  const all = p.criteria?.allOf ?? [];
  const aggs = [...new Set(all.map((c) => c.timeAggregation).filter((x): x is string => !!x))];
  const dims = all.flatMap((c) => (c.dimensions ?? []).map((d) =>
    `${d.name ?? "?"} ${d.operator === "Exclude" ? "≠" : "="} ${(d.values ?? []).join(", ") || "*"}`));
  return {
    ...(aggs.length ? { aggregation: aggs.join(", ") } : {}),
    ...(p.windowSize ? { windowSize: p.windowSize } : {}),
    ...(p.evaluationFrequency ? { frequency: p.evaluationFrequency } : {}),
    ...(dims.length ? { dimensions: dims } : {}),
    ...(p.autoMitigate != null ? { autoMitigate: p.autoMitigate } : {}),
  };
}

type ScheduledQueryRule = {
  id: string;
  name: string;
  properties: {
    severity?: number;
    enabled?: boolean | string;
    scopes?: string[];
    criteria?: {
      allOf?: Array<{
        query?: string;
        operator?: string;
        threshold?: number;
        metricMeasureColumn?: string;
      }>;
    };
    description?: string;
    displayName?: string;
  };
};

type SmartDetectorRule = {
  id: string;
  name: string;
  properties: {
    severity?: string; // "Sev0"–"Sev4"
    state?: string; // "Enabled" | "Disabled"
    scope?: string[];
    detector?: {
      id?: string;
      name?: string;
      description?: string;
    };
    description?: string;
  };
};

type ArmListResponse<T> = { value?: T[]; nextLink?: string };

function parseSeverity(sev: string | undefined): number {
  if (!sev) return 4;
  const match = sev.match(/\d/);
  return match ? parseInt(match[0], 10) : 4;
}

function buildConditionString(criteria: MetricAlertResource["properties"]["criteria"]): string | undefined {
  const rules = criteria?.allOf;
  if (!rules || rules.length === 0) return undefined;
  return rules
    .map((r) => {
      const name = r.metricName ?? "metric";
      const op = r.operator ?? ">=";
      const threshold = r.threshold ?? "?";
      return `${name} ${op} ${threshold}`;
    })
    .join(" AND ");
}

function buildQueryConditionString(criteria: ScheduledQueryRule["properties"]["criteria"]): string | undefined {
  const rules = criteria?.allOf;
  if (!rules || rules.length === 0) return undefined;
  return rules
    .map((r) => {
      if (r.query) {
        const short = r.query.length > 80 ? r.query.slice(0, 77) + "..." : r.query;
        return r.operator && r.threshold != null
          ? `${short} ${r.operator} ${r.threshold}`
          : short;
      }
      return r.operator && r.threshold != null
        ? `result ${r.operator} ${r.threshold}`
        : undefined;
    })
    .filter(Boolean)
    .join(" AND ");
}

/**
 * Collect alert rule definitions for diagram nodes.
 */
export async function collectAlertRules(
  env: Env,
  bearerToken: string,
  nodes: DiagramNodeSpec[],
): Promise<AlertRuleInfo[]> {
  const prefix = bearerKeyPrefix(bearerToken);
  const nodeIds = nodes.map((n) => n.id).sort().join(",");
  const cacheKey = `${prefix}:alertRules:${nodeIds}`;
  const cached = rulesCache.get(cacheKey);
  if (cached) return cached;

  // Build resource-to-node mapping
  const resourceIdToNodeId = new Map<string, string>();
  const subscriptionIds = new Set<string>();

  for (const node of nodes) {
    if (!node.azureResourceId) continue;
    resourceIdToNodeId.set(node.azureResourceId.toLowerCase(), node.id);
    const match = node.azureResourceId.match(/\/subscriptions\/([^/]+)/i);
    if (match) subscriptionIds.add(match[1]!);
  }

  if (subscriptionIds.size === 0) return [];

  const fetcher = await getArmFetcher(env, bearerToken);
  const allRules: AlertRuleInfo[] = [];

  // Fetch from all subscriptions in parallel
  const fetchPromises = [...subscriptionIds].map(async (subId) => {
    const base = `https://management.azure.com/subscriptions/${subId}`;

    // Fetch metric alerts, scheduled query rules, and smart detector rules in parallel
    const [metricAlerts, queryRules, smartRules] = await Promise.all([
      fetcher
        .fetchJson<ArmListResponse<MetricAlertResource>>(
          `${base}/providers/Microsoft.Insights/metricAlerts?api-version=2018-03-01`,
        )
        .then((r) => r.value ?? [])
        .catch(() => [] as MetricAlertResource[]),

      fetcher
        .fetchJson<ArmListResponse<ScheduledQueryRule>>(
          `${base}/providers/Microsoft.Insights/scheduledQueryRules?api-version=2023-03-15-preview`,
        )
        .then((r) => r.value ?? [])
        .catch(() => [] as ScheduledQueryRule[]),

      fetcher
        .fetchJson<ArmListResponse<SmartDetectorRule>>(
          `${base}/providers/Microsoft.AlertsManagement/smartDetectorAlertRules?api-version=2021-04-01`,
        )
        .then((r) => r.value ?? [])
        .catch(() => [] as SmartDetectorRule[]),
    ]);

    // Process metric alerts
    for (const rule of metricAlerts) {
      const scopes = rule.properties.scopes ?? [];
      const matchedNodeIds = matchScopes(scopes, resourceIdToNodeId);
      if (matchedNodeIds.length === 0) continue;

      allRules.push({
        id: rule.id,
        name: rule.name,
        severity: rule.properties.severity,
        signalType: "Metric",
        condition: buildConditionString(rule.properties.criteria),
        evaluation: metricRuleEvaluation(rule.properties),
        targetResourceId: scopes[0] ?? "",
        enabled: rule.properties.enabled,
        affectedNodeIds: matchedNodeIds,
      });
    }

    // Process scheduled query rules
    for (const rule of queryRules) {
      const scopes = rule.properties.scopes ?? [];
      const matchedNodeIds = matchScopes(scopes, resourceIdToNodeId);
      if (matchedNodeIds.length === 0) continue;

      allRules.push({
        id: rule.id,
        name: rule.properties.displayName ?? rule.name,
        severity: rule.properties.severity ?? 4,
        signalType: "Log",
        condition: buildQueryConditionString(rule.properties.criteria),
        targetResourceId: scopes[0] ?? "",
        enabled: rule.properties.enabled !== false && rule.properties.enabled !== "false",
        affectedNodeIds: matchedNodeIds,
      });
    }

    // Process smart detector rules
    for (const rule of smartRules) {
      const scopes = rule.properties.scope ?? [];
      const matchedNodeIds = matchScopes(scopes, resourceIdToNodeId);
      if (matchedNodeIds.length === 0) continue;

      allRules.push({
        id: rule.id,
        name: rule.properties.detector?.name ?? rule.name,
        severity: parseSeverity(rule.properties.severity),
        signalType: "Smart Detection",
        condition: rule.properties.detector?.description,
        targetResourceId: scopes[0] ?? "",
        enabled: rule.properties.state !== "Disabled",
        affectedNodeIds: matchedNodeIds,
      });
    }
  });

  await Promise.all(fetchPromises);

  // Sort by severity (low number = more severe)
  allRules.sort((a, b) => a.severity - b.severity);

  rulesCache.set(cacheKey, allRules);
  return allRules;
}

/**
 * Match Azure resource scopes to diagram node IDs (case-insensitive).
 */
function matchScopes(
  scopes: string[],
  resourceIdToNodeId: Map<string, string>,
): string[] {
  const matched: string[] = [];
  for (const scope of scopes) {
    const nodeId = resourceIdToNodeId.get(scope.toLowerCase());
    if (nodeId) matched.push(nodeId);
  }
  return matched;
}
