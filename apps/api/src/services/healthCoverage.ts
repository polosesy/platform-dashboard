// What Azure Resource Health covers in a subscription (GET /api/health/coverage): the inventory by type (one
// Resource Graph summarize) against the types Resource Health returned a status for and Microsoft's supported list
// (rhSupportedTypes.ts). Counts by type only — no names, ids or subscriptions leave this module.
// Unit-tested from apps/api/test/healthCoverage.test.ts.
import type { HealthCoverage, HealthCoverageType } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import type { Lang } from "../infra/lang.js";
import { queryResourceGraph } from "./azure.js";
import { tryGetHealthSummary } from "./health.js";
import { RH_CHECKS, RH_DOC, RH_SUPPORTED_TYPES } from "./rhSupportedTypes.js";

/** Pure: buckets for the types without a status, and the listed-or-not note for those with one */
export function classifyCoverage(
  inventory: Array<{ type: string; count: number }>,
  statusTypes: Set<string>,
  supported: Set<string> = RH_SUPPORTED_TYPES,
): { types: HealthCoverageType[]; inventoryResources: number; noStatusResources: number } {
  const byType = new Map<string, number>();
  for (const r of inventory) {
    const t = r.type.toLowerCase();
    byType.set(t, (byType.get(t) ?? 0) + Number(r.count || 0));
  }
  const types: HealthCoverageType[] = [];
  for (const [type, count] of byType) {
    if (!statusTypes.has(type)) types.push({ type, count, bucket: supported.has(type) ? "noStatusListed" : "noStatusUnlisted" });
  }
  // A status for a type the list does not name: still shown in the heatmap, noted here (count = from the inventory)
  for (const type of statusTypes) {
    if (!supported.has(type)) types.push({ type, count: byType.get(type) ?? 0, bucket: "statusUnlisted" });
  }
  const order = { noStatusListed: 0, noStatusUnlisted: 1, statusUnlisted: 2 } as const;
  types.sort((a, b) => order[a.bucket] - order[b.bucket] || b.count - a.count || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const inventoryResources = [...byType.values()].reduce((s, n) => s + n, 0);
  const noStatusResources = types.filter((t) => t.bucket !== "statusUnlisted").reduce((s, t) => s + t.count, 0);
  return { types, inventoryResources, noStatusResources };
}

/** Executed checks for the types with a status, in the request language */
export function checksFor(statusTypes: Iterable<string>, lang: Lang): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of statusTypes) {
    const c = RH_CHECKS[t];
    if (c) out[t] = lang === "en" ? c.en : c.ko;
  }
  return out;
}

const cache = new CacheManager<HealthCoverage>(50);

export async function tryGetHealthCoverage(
  env: Env,
  bearerToken: string | undefined,
  opts: { subscriptionId?: string; lang?: Lang } = {},
): Promise<HealthCoverage | null> {
  const subIds = opts.subscriptionId ? [opts.subscriptionId] : parseSubscriptionIds(env);
  if (!subIds.length) return null;
  const lang = opts.lang ?? "ko";
  const key = `${bearerToken ? bearerKeyPrefix(bearerToken) : "sp"}:rhcov:${lang}:${subIds.join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const gaps: HealthCoverage["gaps"] = [];
  let firstError: unknown;
  const failed = (what: string) => (e: unknown) => { firstError ??= e; debug(`[rhcov] ${what} not read: ${String(e).slice(0, 120)}`); return null; };
  // The summary is cached by the instance tab — usually a hit
  const [summary, inventory] = await Promise.all([
    tryGetHealthSummary(env, bearerToken, { subscriptionId: opts.subscriptionId, lang }).catch(failed("health")),
    queryResourceGraph<{ type: string; count: number }>(env, bearerToken, "resources | summarize count = count() by type = tolower(type)", subIds).catch(failed("inventory")),
  ]);
  // Nothing read (sign-in required, no access …): the route's own handling answers (sample data, signin note)
  if (!summary && !inventory && firstError) throw firstError;
  if (!summary) gaps.push("health");
  if (!inventory) gaps.push("inventory");
  const statusTypes = new Set((summary?.resources ?? []).map((r) => r.resourceType.toLowerCase()));
  // Without either side a comparison would be invented: no numbers, only the gap
  const cls = summary && inventory ? classifyCoverage(inventory, statusTypes) : { types: [], inventoryResources: 0, noStatusResources: 0 };
  const out: HealthCoverage = {
    generatedAt: new Date().toISOString(),
    doc: { ...RH_DOC },
    ...cls,
    checks: checksFor(statusTypes, lang),
    gaps,
  };
  // A partial answer is not kept long
  cache.set(key, out, gaps.length ? 60_000 : env.AZURE_HEALTH_CACHE_TTL_MS);
  return out;
}
