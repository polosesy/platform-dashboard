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
  RegionHealthStatus,
  RegionalStatusResponse,
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
      summary: stripHtml(p.summary ?? "").slice(0, 1000),
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
    tenantId: env.AZURE_AD_TENANT_ID,
  };

  eventsCache.set(key, result, env.AZURE_HEALTH_CACHE_TTL_MS);
  return result;
}

// ─────────────────────────────────────────────────────────
// Azure Translator Text — optional batch translation
// ─────────────────────────────────────────────────────────

type AzureTranslateItem = { translations: Array<{ text: string; to: string }> };

/**
 * Batch-translate an array of English strings to the target language.
 * Requires AZURE_TRANSLATOR_KEY (+ optionally AZURE_TRANSLATOR_REGION) in env.
 * Returns null when the translator is not configured.
 */
export async function translateTexts(
  env: Env,
  texts: string[],
  to = "ko",
  from = "en",
): Promise<string[] | null> {
  if (!env.AZURE_TRANSLATOR_KEY || texts.length === 0) return null;

  const params = new URLSearchParams({ "api-version": "3.0", from, to });
  const resp = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?${params.toString()}`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY,
        "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION ?? "global",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(texts.map((t) => ({ Text: t }))),
    },
  );

  if (!resp.ok) {
    throw new Error(`Azure Translator ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as AzureTranslateItem[];
  return data.map((item) => item.translations[0]?.text ?? "");
}

// ─────────────────────────────────────────────────────────
// Regional Status — user's deployed regions × service health
// ─────────────────────────────────────────────────────────

const regionalCache = new CacheManager<RegionalStatusResponse>(50);

/** Azure internal location name → display name mapping */
const REGION_DISPLAY: Record<string, string> = {
  eastus: "East US", eastus2: "East US 2",
  westus: "West US", westus2: "West US 2", westus3: "West US 3",
  centralus: "Central US", northcentralus: "North Central US",
  southcentralus: "South Central US", westcentralus: "West Central US",
  canadacentral: "Canada Central", canadaeast: "Canada East",
  brazilsouth: "Brazil South", brazilsoutheast: "Brazil Southeast",
  northeurope: "North Europe", westeurope: "West Europe",
  uksouth: "UK South", ukwest: "UK West",
  francecentral: "France Central", francesouth: "France South",
  germanywestcentral: "Germany West Central", germanynorth: "Germany North",
  switzerlandnorth: "Switzerland North", switzerlandwest: "Switzerland West",
  norwayeast: "Norway East", norwaywest: "Norway West",
  swedencentral: "Sweden Central", polandcentral: "Poland Central",
  italynorth: "Italy North", spaincentral: "Spain Central",
  southeastasia: "Southeast Asia", eastasia: "East Asia",
  koreacentral: "Korea Central", koreasouth: "Korea South",
  japaneast: "Japan East", japanwest: "Japan West",
  australiaeast: "Australia East", australiasoutheast: "Australia Southeast",
  australiacentral: "Australia Central",
  centralindia: "Central India", southindia: "South India", westindia: "West India",
  jioindiawest: "Jio India West", jioindiacentral: "Jio India Central",
  uaenorth: "UAE North", uaecentral: "UAE Central",
  southafricanorth: "South Africa North", southafricawest: "South Africa West",
  qatarcentral: "Qatar Central", israelcentral: "Israel Central",
  mexicocentral: "Mexico Central", newzealandnorth: "New Zealand North",
};

/**
 * Query Azure Resource Graph for distinct resource locations across subscriptions.
 * Uses POST to the Resource Graph REST API with the existing ARM token.
 */
async function fetchResourceLocations(armToken: string, subIds: string[]): Promise<string[]> {
  type RGResp = { data?: { rows?: unknown[][] } };
  const resp = await fetch(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${armToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriptions: subIds,
        query: "Resources | distinct location | project location",
      }),
    },
  );
  if (!resp.ok) throw new Error(`ResourceGraph ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as RGResp;
  return (data.data?.rows ?? []).map((r) => String(r[0])).filter(Boolean);
}

/**
 * Get regional health status for user's deployed regions.
 * Combines Resource Graph location query with Service Health Events data.
 *
 * Required RBAC permissions:
 *   - Reader (or Microsoft.ResourceGraph/resources/read) on each subscription
 *   - Reader (or Microsoft.ResourceHealth/events/read) on each subscription
 */
export async function tryGetRegionalStatus(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<RegionalStatusResponse | null> {
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;

  const allSubIds = parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS);
  const subIds = opts?.subscriptionId ? [opts.subscriptionId] : allSubIds;
  if (subIds.length === 0) return null;

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const key = `${prefix}:health:regional:${subIds.join(",")}`;
  const cached = regionalCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Fetch user's resource locations and service health events in parallel
  const [locations, eventsResp] = await Promise.all([
    fetchResourceLocations(fetcher.armToken, subIds),
    tryGetServiceHealthEvents(env, bearerToken, opts).catch(() => null),
  ]);

  const allEvents = eventsResp?.events ?? [];

  // Map each location to regional health status
  const regions: RegionHealthStatus[] = locations.map((loc) => {
    const displayName = REGION_DISPLAY[loc.toLowerCase()] ?? loc;
    // Match events by display name (case-insensitive) or internal name
    const regionEvents = allEvents.filter((e) =>
      e.affectedRegions.some(
        (r) =>
          r.toLowerCase() === displayName.toLowerCase() ||
          r.toLowerCase() === loc.toLowerCase(),
      ),
    );
    const activeEvents = regionEvents.filter((e) => !e.isResolved);
    const serviceIssueCount = activeEvents.filter((e) => e.eventType === "ServiceIssue").length;
    const maintenanceCount = activeEvents.filter((e) => e.eventType === "PlannedMaintenance").length;
    const affectedServices = [...new Set(activeEvents.flatMap((e) => e.affectedServices))];

    return {
      name: loc,
      displayName,
      hasActiveIssues: serviceIssueCount > 0 || maintenanceCount > 0,
      serviceIssueCount,
      maintenanceCount,
      affectedServices,
      events: regionEvents,
    };
  });

  // Sort: affected first, then by display name
  regions.sort((a, b) => {
    if (a.hasActiveIssues !== b.hasActiveIssues) return a.hasActiveIssues ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const result: RegionalStatusResponse = {
    generatedAt: new Date().toISOString(),
    regions,
    totalAffected: regions.filter((r) => r.hasActiveIssues).length,
  };

  regionalCache.set(key, result, env.AZURE_HEALTH_CACHE_TTL_MS);
  return result;
}
