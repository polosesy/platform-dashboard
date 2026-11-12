// 보안 권고의 한국어 문구 — Microsoft's own localized recommendation text, not a machine translation.
//
// Resource Graph (`securityresources`) answers recommendation metadata in English only. The Defender
// `assessmentMetadata` list answers the same texts in the language of `Accept-Language` (2026-11-11 measured with
// ko-KR: 845 of the first 1,000 titles in Korean) — keyed by the assessment key the recommendations already carry.
// So the Korean view overlays title · description · remediation by key; a key the list does not have (a custom
// recommendation, a preview one without a translation) keeps its English text. Nothing is sent to a translator and
// no tenant data is involved: the list is Microsoft's public catalogue, read with the subscription's connection.
//
// Cached a day per (connection scope, language); a read that fails leaves the English text and says so
// (`textLanguage: "en"`) — retried after a minute, never cached as "no Korean".
import { alertTranslator, localizeAlerts } from "./alertTextsKo.js";
import type { Env } from "../env.js";
import type { PostureRecommendation, SecurityPostureResponse } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { debug } from "../infra/logger.js";
import { plainText } from "./securityPosture.js";

export type AssessmentText = { title?: string; description?: string; remediation?: string };
type MetaPage = { value?: Array<{ name?: string; properties?: { displayName?: string; description?: string; remediationDescription?: string } }>; nextLink?: string };

/** Languages the overlay is read for (the app's languages other than English) → Accept-Language */
export const TEXT_LANGUAGES: Record<string, string> = { ko: "ko-KR" };
const MAX_PAGES = 8;
const DAY = 24 * 3600_000;

/** Pure: one page of assessment metadata → texts by lower-case assessment key (HTML stripped like the English ones) */
export function textsFromMetadata(page: MetaPage, into = new Map<string, AssessmentText>()): Map<string, AssessmentText> {
  for (const m of page.value ?? []) {
    const key = (m.name ?? "").toLowerCase();
    if (!key) continue;
    const p = m.properties ?? {};
    const t: AssessmentText = {
      ...(plainText(p.displayName, 300) ? { title: plainText(p.displayName, 300)! } : {}),
      ...(plainText(p.description, 1200) ? { description: plainText(p.description, 1200)! } : {}),
      ...(plainText(p.remediationDescription, 4000) ? { remediation: plainText(p.remediationDescription, 4000)! } : {}),
    };
    if (t.title || t.description || t.remediation) into.set(key, t);
  }
  return into;
}

/**
 * Pure: the recommendations with their texts replaced where the catalogue has them (field by field — a missing
 * field keeps the English one); `localized` = how many got a title
 */
export function localizeRecommendations(recs: PostureRecommendation[], texts: Map<string, AssessmentText>): { recommendations: PostureRecommendation[]; localized: number } {
  let localized = 0;
  const recommendations = recs.map((r) => {
    const t = texts.get(r.key.toLowerCase());
    if (!t) return r;
    if (t.title) localized++;
    return { ...r, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), ...(t.remediation ? { remediation: t.remediation } : {}) };
  });
  return { recommendations, localized };
}

const cache = new CacheManager<Map<string, AssessmentText>>(8, DAY);
const failedAt = new Map<string, number>();
const inflight = new Map<string, Promise<Map<string, AssessmentText> | null>>();

/** The catalogue's texts in `lang` (null = not read: unsupported language, anonymous, or the read failed) */
export async function getAssessmentTexts(env: Env, bearerToken: string | undefined, subscriptionId: string, lang: string): Promise<Map<string, AssessmentText> | null> {
  const acceptLanguage = TEXT_LANGUAGES[lang];
  if (!acceptLanguage || !bearerToken || !subscriptionId) return null;
  const key = `${cachePrefix(bearerToken)}:assessment-texts:${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (Date.now() - (failedAt.get(key) ?? 0) < 60_000) return null;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const arm = await getArmFetcherAuto(env, bearerToken);
      const out = new Map<string, AssessmentText>();
      let url: string | undefined = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Security/assessmentMetadata?api-version=2021-06-01`;
      for (let i = 0; url && i < MAX_PAGES; i++) {
        const page: MetaPage = await arm.fetchJson<MetaPage>(url, { language: acceptLanguage, timeoutMs: 20_000 });
        textsFromMetadata(page, out);
        // Follow Azure's own next page only (same host and path)
        url = page.nextLink && page.nextLink.startsWith("https://management.azure.com/") ? page.nextLink : undefined;
      }
      if (!out.size) throw new Error("no assessment metadata returned");
      cache.set(key, out);
      return out;
    } catch (e) {
      debug(`[security] assessment texts (${lang}) not read: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
      failedAt.set(key, Date.now());
      return null;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** The posture with its recommendation texts in `lang` where Microsoft publishes them; says which language it carries */
export async function localizePosture(
  env: Env, bearerToken: string | undefined, posture: SecurityPostureResponse, subscriptionId: string | undefined, lang: string,
): Promise<SecurityPostureResponse> {
  if (!TEXT_LANGUAGES[lang] || posture.source !== "azure") return posture;
  // Alerts: Azure has no Korean for them (services/alertTextsKo.ts) — the platform's table, then the translator if configured
  const alerts = lang === "ko" && posture.alerts.length ? (await localizeAlerts(posture.alerts, alertTranslator(env))).alerts : posture.alerts;
  if (!posture.recommendations.length) return { ...posture, alerts };
  const texts = subscriptionId ? await getAssessmentTexts(env, bearerToken, subscriptionId, lang) : null;
  if (!texts) return { ...posture, alerts, textLanguage: "en" };
  const { recommendations, localized } = localizeRecommendations(posture.recommendations, texts);
  return { ...posture, alerts, recommendations, textLanguage: lang as "ko", textLocalized: localized };
}
