import type { Env } from "../env";
import type { HealthSummary, ResourceHealthStatus } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Azure Resource Health — Availability Status
// ────────────────────────────────────────────

const healthCache = new CacheManager<HealthSummary>(50);

function parseSubscriptionIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

type ArmAvailabilityStatus = {
  id?: string;
  name?: string;
  properties?: {
    availabilityState?: string;
    summary?: string;
    occurredTime?: string;
  };
};

/**
 * Fetch resource health summary from Azure Resource Health API.
 * Lists availability statuses for all resources in the subscription.
 */
export async function tryGetHealthSummary(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<HealthSummary | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = `${prefix}:health:${subId}`;
  const cached = healthCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const resp = await fetcher.fetchJson<{ value?: ArmAvailabilityStatus[] }>(
    `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2024-02-01&$top=200`,
  );

  const resources: ResourceHealthStatus[] = (resp.value ?? []).map((item) => {
    const resourceId = item.id?.replace(/\/providers\/Microsoft\.ResourceHealth\/availabilityStatuses\/current$/i, "") ?? "";
    const parts = parseResourceId(resourceId);
    return {
      resourceId,
      resourceName: parts.name,
      resourceType: parts.type,
      resourceGroup: parts.resourceGroup,
      availabilityState: mapAvailability(item.properties?.availabilityState),
      summary: item.properties?.summary,
      occurredTime: item.properties?.occurredTime,
    };
  });

  const summary: HealthSummary = {
    generatedAt: new Date().toISOString(),
    available: resources.filter((r) => r.availabilityState === "Available").length,
    degraded: resources.filter((r) => r.availabilityState === "Degraded").length,
    unavailable: resources.filter((r) => r.availabilityState === "Unavailable").length,
    unknown: resources.filter((r) => r.availabilityState === "Unknown").length,
    resources,
  };

  healthCache.set(key, summary, env.AZURE_HEALTH_CACHE_TTL_MS);
  return summary;
}

function mapAvailability(state?: string): ResourceHealthStatus["availabilityState"] {
  if (state === "Available") return "Available";
  if (state === "Degraded") return "Degraded";
  if (state === "Unavailable") return "Unavailable";
  return "Unknown";
}

function parseResourceId(id: string): { name: string; type: string; resourceGroup: string } {
  const rgMatch = id.match(/resourceGroups\/([^/]+)/i);
  const resourceGroup = rgMatch?.[1] ?? "";

  // Extract last provider/type/name segment
  const providerMatch = id.match(/providers\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?$/i);
  if (providerMatch) {
    const namespace = providerMatch[1] ?? "";
    const typeName = providerMatch[4] ? `${providerMatch[2]}/${providerMatch[4]}` : providerMatch[2] ?? "";
    const name = providerMatch[4] ? providerMatch[5] ?? "" : providerMatch[3] ?? "";
    return { name, type: `${namespace}/${typeName}`, resourceGroup };
  }

  return { name: id.split("/").pop() ?? id, type: "Unknown", resourceGroup };
}
