import { createHash } from "node:crypto";
import type { Env } from "../env.js";
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
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto, type ArmFetcher } from "../infra/azureClientFactory.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import type { Lang } from "../infra/lang.js";

const ACCEPT_LANGUAGE: Record<Lang, string> = { ko: "ko-KR", en: "en-US" };

// ────────────────────────────────────────────
// Azure Resource Health — Availability Status
// ────────────────────────────────────────────

const healthCache = new CacheManager<HealthSummary>(50);

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

/** Safety limit: max pagination pages per subscription to prevent infinite loops. */
const MAX_PAGINATION_PAGES = 20;

/** Overall timeout for the entire health summary operation (ms).
 *  Individual ARM calls may take up to 60s for large subscriptions. */
const HEALTH_SUMMARY_TIMEOUT_MS = 90_000;

/**
 * Fetch all availability statuses for a subscription, following nextLink pagination.
 */
/** Per-page timeout for health ARM calls (60s — larger responses need more time). */
const HEALTH_PAGE_TIMEOUT_MS = 60_000;

async function fetchAllAvailabilityStatuses(
  fetcher: ArmFetcher,
  subId: string,
  lang: Lang,
): Promise<ArmAvailabilityStatus[]> {
  const all: ArmAvailabilityStatus[] = [];
  let url: string | undefined =
    `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2024-02-01&$top=200`;
  let page_count = 0;

  while (url) {
    if (++page_count > MAX_PAGINATION_PAGES) {
      console.warn(`[health] subscription ${subId}: hit max pagination limit (${MAX_PAGINATION_PAGES} pages, ${all.length} items)`);
      break;
    }
    // Resource Health writes `summary` in the Accept-Language (ko-KR verified) — no translator needed for this tab
    const page: ArmAvailabilityStatusPage = await fetcher.fetchJson<ArmAvailabilityStatusPage>(url, { timeoutMs: HEALTH_PAGE_TIMEOUT_MS, language: ACCEPT_LANGUAGE[lang] });
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
 * Bounded by HEALTH_SUMMARY_TIMEOUT_MS to prevent hanging requests.
 */
export async function tryGetHealthSummary(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string; lang?: Lang },
): Promise<HealthSummary | null> {
  const subIds = opts?.subscriptionId ? [opts.subscriptionId] : parseSubscriptionIds(env);
  if (subIds.length === 0) return null;
  const lang = opts?.lang ?? "ko";

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const key = `${prefix}:health:${lang}:${subIds.join(",")}`;
  const cached = healthCache.get(key);
  if (cached) return cached;

  // Overall timeout — prevents the entire operation from hanging indefinitely
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Health summary timed out after ${HEALTH_SUMMARY_TIMEOUT_MS}ms`)), HEALTH_SUMMARY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      _fetchHealthSummaryCore(env, bearerToken, subIds, key, lang),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function _fetchHealthSummaryCore(
  env: Env,
  bearerToken: string | undefined,
  subIds: string[],
  cacheKey: string,
  lang: Lang,
): Promise<HealthSummary> {
  const fetcher = await getArmFetcherAuto(env, bearerToken);

  const perSubResults = await Promise.allSettled(
    subIds.map((subId) => fetchAllAvailabilityStatuses(fetcher, subId, lang)),
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

  healthCache.set(cacheKey, summary, env.AZURE_HEALTH_CACHE_TTL_MS);
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

/** Azure Status RSS feed URLs — try in order until one succeeds. */
const AZURE_STATUS_RSS_URLS = [
  "https://azure.status.microsoft/en-us/status/feed/",
  "https://rssfeed.azure.status.microsoft/en-us/status/feed/",
];

/** Timeout for RSS feed fetch (ms). */
const RSS_FETCH_TIMEOUT_MS = 10_000;

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&") // last — "&amp;lt;" must stay "&lt;"
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

const REGIONS_LONGEST_FIRST = [...KNOWN_REGIONS].sort((a, b) => b.length - a.length);

function parseIncidentMeta(title: string, description: string): {
  regions: string[];
  services: string[];
  status: GlobalStatusIncidentStatus;
} {
  const text = `${title} ${description}`;
  const regions: string[] = [];

  // Longest names first, consuming each match, so "East US 2" does not also
  // count as "East US" and "North Central US" not as "Central US".
  let remaining = text.toLowerCase();
  for (const r of REGIONS_LONGEST_FIRST) {
    const needle = r.toLowerCase();
    if (remaining.includes(needle)) {
      regions.push(r);
      remaining = remaining.split(needle).join(" | ");
    }
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
 * Fetch RSS XML from a URL with timeout.
 */
async function fetchRssXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Azure Status RSS ${resp.status}: ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse Azure global status RSS feed.
 * Public endpoint — no auth required.
 * Tries multiple URLs with timeout, returns null if all fail.
 */
export async function tryGetGlobalStatus(
  env: Env,
): Promise<GlobalStatusResponse | null> {
  const key = "global:azure-status";
  const cached = globalStatusCache.get(key);
  if (cached) return cached;

  let xml: string | null = null;
  let lastError: Error | null = null;

  for (const url of AZURE_STATUS_RSS_URLS) {
    try {
      xml = await fetchRssXml(url);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[health] RSS feed ${url} failed:`, lastError.message);
    }
  }

  if (!xml) {
    throw lastError ?? new Error("All Azure Status RSS feeds unreachable");
  }

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
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env)[0];
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
      id: item.name ?? `${p.eventType ?? "event"}:${p.title ?? ""}:${p.impactStartTime ?? ""}`,
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
// Translation of Service Health event text (the events tab's "한국어" toggle)
// Service Health events come in English only (Accept-Language is ignored for them), so they need a translator:
//   1. Azure Translator (AZURE_TRANSLATOR_KEY [+ AZURE_TRANSLATOR_REGION]) — a Translator resource, or a
//      multi-service AI Services / Cognitive Services key with its region. When a key is set, nothing else is tried:
//      event text is not sent to another service behind the operator's back.
//   2. No key: the keyless Google endpoint (best effort — unofficial, often 429 from server addresses)
//   3. Built-in translations of the sample events
// Failures carry a reason the page can name (no key, key/region rejected, quota …) instead of one generic message.
// ─────────────────────────────────────────────────────────

type AzureTranslateItem = { translations: Array<{ text: string; to: string }> };

export type TranslateFailure = "not_configured" | "translator_auth" | "translator_quota" | "translator_error";
export type TranslateResult =
  | { ok: true; translations: string[]; provider: "azure" | "free" | "builtin" | "cache" }
  /** status: HTTP status of the translator that answered; freeStatus: why the keyless fallback failed (no key) */
  | { ok: false; reason: TranslateFailure; status?: number; freeStatus?: number | "network" };

/** Timeout for one translation request (ms). */
const TRANSLATE_TIMEOUT_MS = 10_000;
/** Translator v3 limits are 1,000 array elements and 50,000 characters per request — stay below both */
export const AZ_MAX_ITEMS = 100;
export const AZ_MAX_CHARS = 40_000;
/** The keyless endpoint takes the text in the URL — keep each request's text short */
const FREE_MAX_CHARS = 1_800;

/** Translations by (from, to, text) — event text repeats across refreshes and users; the key is billed per character */
const translationCache = new CacheManager<string>(5_000, 24 * 60 * 60_000);
const cacheKey = (from: string, to: string, text: string) => `${from}>${to}:${createHash("sha256").update(text).digest("base64url")}`;

/**
 * Built-in Korean translations for mock event strings.
 * Last-resort fallback when no translation API is available.
 */
const BUILTIN_KO: Record<string, string> = {
  "Azure Kubernetes Service — Connectivity Issue in Korea Central":
    "Azure Kubernetes Service — Korea Central 리전 연결 문제",
  "Some customers using AKS in Korea Central may experience intermittent connectivity issues. Engineering teams are actively investigating the root cause.":
    "Korea Central에서 AKS를 사용하는 일부 고객에게 간헐적인 연결 문제가 발생할 수 있습니다. 엔지니어링 팀이 근본 원인을 적극적으로 조사 중입니다.",
  "Azure SQL Database — Planned Maintenance Window":
    "Azure SQL Database — 계획된 유지 관리 기간",
  "Routine maintenance for Azure SQL Database in East US 2. Expected duration: 2 hours. Minimal impact is anticipated with automatic failover enabled.":
    "East US 2의 Azure SQL Database에 대한 정기 유지 관리입니다. 예상 소요 시간: 2시간. 자동 장애 조치가 활성화된 상태에서 최소한의 영향이 예상됩니다.",
  "Azure App Service — Managed Certificate Rotation Advisory":
    "Azure App Service — 관리형 인증서 교체 권고",
  "Managed SSL certificates for Azure App Service will undergo routine rotation. Action required for customers using certificate pinning in their applications.":
    "Azure App Service의 관리형 SSL 인증서가 정기 교체됩니다. 인증서 고정(certificate pinning)을 사용하는 고객은 조치가 필요합니다.",
};

/** Indices of `texts` grouped so that no group has more than `maxItems` texts or `maxChars` characters (pure) */
export function chunkTexts(texts: readonly string[], maxItems: number, maxChars: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= maxItems || chars + t.length > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

class TranslatorHttpError extends Error {
  constructor(readonly status: number) { super(`translator ${status}`); }
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try { return await run(controller.signal); } finally { clearTimeout(timer); }
}

async function azureTranslate(env: Env, texts: string[], from: string, to: string, doFetch: typeof fetch): Promise<string[]> {
  const params = new URLSearchParams({ "api-version": "3.0", from, to });
  const out: string[] = new Array(texts.length);
  for (const group of chunkTexts(texts, AZ_MAX_ITEMS, AZ_MAX_CHARS)) {
    const data = await withTimeout(async (signal) => {
      const resp = await doFetch(`https://api.cognitive.microsofttranslator.com/translate?${params.toString()}`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY!,
          // A regional / multi-service key is rejected (401) without its region; a global Translator needs none
          ...(env.AZURE_TRANSLATOR_REGION ? { "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION } : {}),
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(group.map((i) => ({ Text: texts[i] }))),
        signal,
      });
      // The error body is not passed on (it may echo request details) — the status says enough
      if (!resp.ok) throw new TranslatorHttpError(resp.status);
      return (await resp.json()) as AzureTranslateItem[];
    });
    group.forEach((idx, k) => { out[idx] = data[k]?.translations[0]?.text ?? texts[idx]!; });
  }
  return out;
}

async function freeTranslate(texts: string[], from: string, to: string, doFetch: typeof fetch): Promise<string[]> {
  const out: string[] = new Array(texts.length);
  // One text per request when long, several short ones joined (the endpoint keeps paragraph breaks)
  for (const group of chunkTexts(texts, 20, FREE_MAX_CHARS)) {
    const SEP = "\n\n⸻\n\n";
    const joined = group.map((i) => texts[i]!).join(SEP);
    const translated = await withTimeout(async (signal) => {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(joined)}`;
      const resp = await doFetch(url, { signal });
      if (!resp.ok) throw new TranslatorHttpError(resp.status);
      const data = (await resp.json()) as Array<unknown>;
      // Response: [[["translated segment","original segment",...],...], ...]
      const segments = data[0] as Array<[string, string]> | null;
      return segments ? segments.map((seg) => seg[0]).join("") : joined;
    });
    const parts = translated.split(/\s*⸻\s*/);
    group.forEach((idx, k) => { out[idx] = parts[k]?.trim() || texts[idx]!; });
  }
  return out;
}

/**
 * Batch-translate English Service Health text. Empty strings pass through; cached per text for a day.
 * `doFetch` is injected by the tests.
 */
export async function translateTexts(
  env: Env,
  texts: string[],
  to = "ko",
  from = "en",
  doFetch: typeof fetch = fetch,
): Promise<TranslateResult> {
  const result = texts.map((t) => (t.trim() ? translationCache.get(cacheKey(from, to, t)) : t));
  const missing = [...new Set(texts.filter((t, i) => result[i] === undefined))];
  if (!missing.length) return { ok: true, translations: result as string[], provider: "cache" };
  const fill = (got: string[], provider: "azure" | "free" | "builtin"): TranslateResult => {
    const byText = new Map(missing.map((t, i) => [t, got[i] ?? t]));
    // Only real translations are cached (the built-in table is already in memory)
    if (provider !== "builtin") for (const [t, v] of byText) translationCache.set(cacheKey(from, to, t), v);
    return { ok: true, translations: texts.map((t, i) => result[i] ?? byText.get(t) ?? t), provider };
  };

  // ── 1. Azure Translator ──
  if (env.AZURE_TRANSLATOR_KEY) {
    try {
      return fill(await azureTranslate(env, missing, from, to, doFetch), "azure");
    } catch (e: unknown) {
      const status = e instanceof TranslatorHttpError ? e.status : undefined;
      debug(`[health] Azure Translator failed: ${status ?? (e instanceof Error ? e.name : "error")}`);
      if (status === 401 || status === 403) return { ok: false, reason: "translator_auth", status };
      if (status === 429) return { ok: false, reason: "translator_quota", status };
      return { ok: false, reason: "translator_error", ...(status ? { status } : {}) };
    }
  }

  // ── 3 first when it covers everything: the sample events need no network ──
  if (to === "ko" && missing.every((t) => BUILTIN_KO[t])) return fill(missing.map((t) => BUILTIN_KO[t]!), "builtin");

  // ── 2. Keyless endpoint ──
  let freeStatus: number | "network" = "network";
  try {
    const got = await freeTranslate(missing, from, to, doFetch);
    if (got.some((r, i) => r !== missing[i])) return fill(got, "free");
  } catch (e: unknown) {
    if (e instanceof TranslatorHttpError) freeStatus = e.status;
    debug(`[health] keyless translation failed: ${freeStatus}`);
  }
  if (to === "ko" && missing.some((t) => BUILTIN_KO[t])) return fill(missing.map((t) => BUILTIN_KO[t] ?? t), "builtin");
  return { ok: false, reason: "not_configured", freeStatus };
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

/** Query Azure Resource Graph for distinct resource locations across subscriptions. */
async function fetchResourceLocations(fetcher: ArmFetcher, subIds: string[]): Promise<string[]> {
  // Resource Graph returns objectArray by default (2022-10-01):
  //   { data: [{ location: "koreacentral" }, ...] }
  // OR table format if requested:
  //   { data: { columns: [...], rows: [["koreacentral"], ...] } }
  type RGResp = {
    data?: Array<{ location: string }> | { rows?: unknown[][] };
  };
  const json = await fetcher.postJson<RGResp>(
    "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    { subscriptions: subIds, query: "Resources | summarize by location" },
  );

  let locations: string[] = [];
  if (Array.isArray(json.data)) {
    locations = json.data.map((r) => r.location).filter(Boolean);
  } else if (json.data && "rows" in json.data) {
    locations = (json.data.rows ?? []).map((r) => String(r[0])).filter(Boolean);
  }

  debug(`[health] ResourceGraph returned ${locations.length} distinct locations for ${subIds.length} subscription(s):`, locations.join(", "));
  return locations;
}

/**
 * Get regional health status for user's deployed regions.
 * Combines Resource Graph location query with Service Health Events data.
 *
 * Required RBAC permissions:
 *   - Reader (or Microsoft.ResourceGraph/resources/read) on each subscription
 *   - Reader (or Microsoft.ResourceHealth/events/read) on each subscription
 */
/** Overall timeout for regional status operation (ms). */
const REGIONAL_STATUS_TIMEOUT_MS = 45_000;

export async function tryGetRegionalStatus(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<RegionalStatusResponse | null> {
  const subIds = opts?.subscriptionId ? [opts.subscriptionId] : parseSubscriptionIds(env);
  if (subIds.length === 0) return null;

  const prefix = bearerToken ? bearerKeyPrefix(bearerToken) : "sp";
  const key = `${prefix}:health:regional:${subIds.join(",")}`;
  const cached = regionalCache.get(key);
  if (cached) return cached;

  // Overall timeout
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Regional status timed out after ${REGIONAL_STATUS_TIMEOUT_MS}ms`)), REGIONAL_STATUS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      _fetchRegionalStatusCore(env, bearerToken, subIds, key),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function _fetchRegionalStatusCore(
  env: Env,
  bearerToken: string | undefined,
  subIds: string[],
  cacheKey: string,
): Promise<RegionalStatusResponse> {
  const fetcher = await getArmFetcherAuto(env, bearerToken);

  // Resource locations span every subscription, so service health events must too
  const [locResult, ...eventsResults] = await Promise.allSettled([
    fetchResourceLocations(fetcher, subIds),
    ...subIds.map((subscriptionId) => tryGetServiceHealthEvents(env, bearerToken, { subscriptionId })),
  ]);

  const locations = locResult.status === "fulfilled" ? (locResult.value as string[]) : [];

  let locError: string | undefined;
  if (locResult.status === "rejected") {
    const reason = locResult.reason;
    locError = reason instanceof Error ? reason.message : String(reason);
    console.error("[health] fetchResourceLocations failed:", locError);
  }

  // Events can repeat across subscriptions (same tracking id) — de-duplicate
  const eventsById = new Map<string, ServiceHealthEvent>();
  for (const r of eventsResults) {
    if (r.status !== "fulfilled" || !r.value) continue;
    for (const e of (r.value as ServiceHealthEventsResponse).events) eventsById.set(e.id, e);
  }
  const allEvents = [...eventsById.values()];

  // Filter out non-regional locations (e.g. "global")
  const physicalLocations = locations.filter((loc) => loc.toLowerCase() !== "global");

  // Map each location to regional health status
  const regions: RegionHealthStatus[] = physicalLocations.map((loc) => {
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
    ...(regions.length === 0 && locError ? { note: `ResourceGraph query failed: ${locError}` } : {}),
  };

  if (regions.length > 0) {
    regionalCache.set(cacheKey, result, env.AZURE_HEALTH_CACHE_TTL_MS);
  }
  return result;
}
