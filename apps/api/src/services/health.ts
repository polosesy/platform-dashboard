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
import { getArmFetcherAuto } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Azure Resource Health — Availability Status
// ────────────────────────────────────────────

const healthCache = new CacheManager<HealthSummary>(50);

function parseSubscriptionIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

type ArmAvailabilityStatus = {
  id?: string;
  location?: string;
  properties?: {
    availabilityState?: string;
    summary?: string;
    reasonType?: string;
    reasonChronicity?: string;
    occurredTime?: string;
    reportedTime?: string;
  };
};

type ArmAvailabilityStatusPage = {
  value?: ArmAvailabilityStatus[];
  nextLink?: string;
};

/**
 * Fetch all availability statuses for a subscription, following nextLink pagination.
 */
async function fetchAllAvailabilityStatuses(
  fetcher: { fetchJson: <T>(url: string) => Promise<T> },
  subId: string,
): Promise<ArmAvailabilityStatus[]> {
  const all: ArmAvailabilityStatus[] = [];
  let url: string | undefined =
    `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2024-02-01`;

  while (url) {
    const currentUrl: string = url;
    const page: ArmAvailabilityStatusPage = await fetcher.fetchJson<ArmAvailabilityStatusPage>(currentUrl);
    all.push(...(page.value ?? []));
    url = page.nextLink;
  }
  return all;
}

function mapArmItem(item: ArmAvailabilityStatus, subId: string): ResourceHealthStatus {
  const rawId = item.id ?? "";
  const resourceId = rawId.replace(
    /\/providers\/Microsoft\.ResourceHealth\/availabilityStatuses\/current$/i,
    "",
  );
  // Extract subscription ID from resource ID if not provided
  const subMatch = resourceId.match(/subscriptions\/([^/]+)/i);
  const resolvedSubId = subMatch?.[1] ?? subId;

  const parts = parseResourceId(resourceId);
  const p = item.properties ?? {};
  return {
    resourceId,
    resourceName: parts.name,
    resourceType: parts.type,
    resourceGroup: parts.resourceGroup,
    subscriptionId: resolvedSubId,
    location: item.location,
    availabilityState: mapAvailability(p.availabilityState),
    summary: p.summary,
    reasonType: p.reasonType,
    reasonChronicity: p.reasonChronicity,
    occurredTime: p.occurredTime,
    reportedTime: p.reportedTime,
  };
}

/**
 * Fetch resource health summary from Azure Resource Health API.
 * Uses OBO if bearer token available, falls back to SP credentials.
 * Supports multiple subscriptions and full pagination.
 */
export async function tryGetHealthSummary(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<HealthSummary | null> {
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;

  const allSubIds = parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS);
  // If a specific subscriptionId is requested, use only that one; otherwise all
  const subIds = opts?.subscriptionId
    ? [opts.subscriptionId]
    : allSubIds;
  if (subIds.length === 0) return null;

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const key = `${prefix}:health:${subIds.join(",")}`;
  const cached = healthCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Aggregate across all subscriptions in parallel
  const perSubResults = await Promise.allSettled(
    subIds.map((subId) => fetchAllAvailabilityStatuses(fetcher, subId)),
  );

  const resources: ResourceHealthStatus[] = [];
  for (let i = 0; i < perSubResults.length; i++) {
    const result = perSubResults[i];
    if (result.status === "fulfilled") {
      for (const item of result.value) {
        resources.push(mapArmItem(item, subIds[i]!));
      }
    } else {
      console.warn(`[health] subscription ${subIds[i]} failed:`, result.reason);
    }
  }

  const summary: HealthSummary = {
    generatedAt: new Date().toISOString(),
    available: resources.filter((r) => r.availabilityState === "Available").length,
    degraded: resources.filter((r) => r.availabilityState === "Degraded").length,
    unavailable: resources.filter((r) => r.availabilityState === "Unavailable").length,
    unknown: resources.filter((r) => r.availabilityState === "Unknown").length,
    resources,
    subscriptions: subIds,
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
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const key = `${prefix}:health:events:${subId}`;
  const cached = eventsCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);
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
