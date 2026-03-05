import type { Env } from "../env";
import type {
  HealthSummary,
  ResourceHealthStatus,
  GlobalStatusResponse,
  GlobalStatusIncident,
  GlobalStatusIncidentStatus,
  ServiceHealthEventsResponse,
  ServiceHealthEvent,
  ServiceHealthEventType,
} from "@aud/types";
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

// ─────────────────────────────────────────────────────────
// Azure Global Status — RSS Feed Proxy
// ─────────────────────────────────────────────────────────

const globalStatusCache = new CacheManager<GlobalStatusResponse>(10);
const AZURE_STATUS_RSS_URL = "https://rssfeed.azure.status.microsoft/en-us/status/feed/";

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

const KNOWN_REGIONS = [
  "East US", "East US 2", "West US", "West US 2", "West US 3",
  "Central US", "North Central US", "South Central US", "West Central US",
  "Canada Central", "Canada East", "Brazil South",
  "North Europe", "West Europe", "UK South", "UK West",
  "France Central", "Germany West Central", "Switzerland North",
  "Norway East", "Sweden Central", "Poland Central",
  "Southeast Asia", "East Asia", "Korea Central", "Korea South",
  "Japan East", "Japan West", "Australia East", "Australia Southeast",
  "Central India", "South India", "West India",
  "UAE North", "South Africa North",
];

function parseIncidentMeta(title: string, description: string): {
  regions: string[];
  services: string[];
  status: GlobalStatusIncidentStatus;
} {
  const text = `${title} ${description}`;
  const regions: string[] = [];

  for (const r of KNOWN_REGIONS) {
    if (text.toLowerCase().includes(r.toLowerCase())) regions.push(r);
  }

  // Extract bracketed service names from Azure RSS titles like "[Service Name] - Description"
  const svcMatch = title.match(/^\[([^\]]+)\]/);
  const services = svcMatch ? [svcMatch[1]] : [];

  let status: GlobalStatusIncidentStatus = "Active";
  if (/resolved|mitigated.*complete|fully.*mitigated/i.test(text)) status = "Resolved";
  else if (/mitigat/i.test(text)) status = "Mitigated";
  else if (/investigat/i.test(text)) status = "Investigating";

  return { regions, services, status };
}

function parseRssItems(xml: string): GlobalStatusIncident[] {
  const items: GlobalStatusIncident[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const description = extractTag(block, "description");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid") || link;

    const { regions, services, status } = parseIncidentMeta(title, description);

    items.push({
      id: guid,
      title: stripHtml(title),
      description: stripHtml(description).slice(0, 600),
      pubDate,
      link,
      affectedRegions: regions,
      affectedServices: services,
      status,
    });
  }

  return items;
}

/**
 * Fetch and parse Azure global status RSS feed.
 * Public endpoint — no auth required.
 */
export async function tryGetGlobalStatus(
  env: Env,
): Promise<GlobalStatusResponse | null> {
  const key = "global:azure-status";
  const cached = globalStatusCache.get(key);
  if (cached) return cached;

  const resp = await fetch(AZURE_STATUS_RSS_URL);
  if (!resp.ok) throw new Error(`Azure Status RSS ${resp.status}: ${resp.statusText}`);
  const xml = await resp.text();

  const incidents = parseRssItems(xml);
  const result: GlobalStatusResponse = {
    generatedAt: new Date().toISOString(),
    activeIncidents: incidents.filter((i) => i.status !== "Resolved").length,
    incidents,
  };

  globalStatusCache.set(key, result, env.AZURE_HEALTH_CACHE_TTL_MS);
  return result;
}

// ─────────────────────────────────────────────────────────
// Azure Service Health — Events
// ─────────────────────────────────────────────────────────

const eventsCache = new CacheManager<ServiceHealthEventsResponse>(50);

type ArmHealthEvent = {
  name?: string;
  properties?: {
    eventType?: string;
    title?: string;
    summary?: string;
    status?: string;
    level?: string;
    impactStartTime?: string;
    impactMitigationTime?: string;
    lastUpdateTime?: string;
    impact?: Array<{
      impactedService?: string;
      impactedRegions?: Array<{ impactedRegion?: string }>;
    }>;
  };
};

function mapEventType(t?: string): ServiceHealthEventType {
  if (t === "ServiceIssue") return "ServiceIssue";
  if (t === "PlannedMaintenance") return "PlannedMaintenance";
  if (t === "HealthAdvisory") return "HealthAdvisory";
  if (t === "SecurityAdvisory") return "SecurityAdvisory";
  return "HealthAdvisory";
}

function mapEventLevel(l?: string): ServiceHealthEvent["level"] {
  if (l === "Warning") return "Warning";
  if (l === "Error") return "Error";
  return "Informational";
}

/**
 * Fetch Azure Service Health events for a subscription.
 * Returns service issues, planned maintenance, and health advisories.
 */
export async function tryGetServiceHealthEvents(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<ServiceHealthEventsResponse | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = `${prefix}:health:events:${subId}`;
  const cached = eventsCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const resp = await fetcher.fetchJson<{ value?: ArmHealthEvent[] }>(
    `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.ResourceHealth/events?api-version=2022-10-01`,
  );

  const events: ServiceHealthEvent[] = (resp.value ?? []).map((item) => {
    const p = item.properties ?? {};
    const affectedServices: string[] = [];
    const affectedRegions: string[] = [];

    for (const impact of p.impact ?? []) {
      if (impact.impactedService) affectedServices.push(impact.impactedService);
      for (const r of impact.impactedRegions ?? []) {
        if (r.impactedRegion) affectedRegions.push(r.impactedRegion);
      }
    }

    return {
      id: item.name ?? String(Math.random()),
      eventType: mapEventType(p.eventType),
      title: p.title ?? "Unknown event",
      summary: p.summary ?? "",
      status: p.status ?? "Active",
      level: mapEventLevel(p.level),
      impactStartTime: p.impactStartTime,
      impactMitigationTime: p.impactMitigationTime,
      lastUpdateTime: p.lastUpdateTime,
      affectedServices: [...new Set(affectedServices)],
      affectedRegions: [...new Set(affectedRegions)],
      isResolved: p.status === "Resolved",
    };
  });

  const byType = {
    serviceIssue: events.filter((e) => e.eventType === "ServiceIssue").length,
    plannedMaintenance: events.filter((e) => e.eventType === "PlannedMaintenance").length,
    healthAdvisory: events.filter((e) => e.eventType === "HealthAdvisory").length,
    securityAdvisory: events.filter((e) => e.eventType === "SecurityAdvisory").length,
  };

  const result: ServiceHealthEventsResponse = {
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    byType,
    events,
  };

  eventsCache.set(key, result, env.AZURE_HEALTH_CACHE_TTL_MS);
  return result;
}
