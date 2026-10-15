// Azure Resource Health availability for the resource types Azure supports it on — one Resource Graph query over
// `healthresources` per snapshot (not one call per resource). Read with the caller's connection credentials;
// cached 3 minutes per caller. Feeds services/healthEvidence.ts.
// Learn: https://learn.microsoft.com/azure/service-health/resource-health-overview (Available / Degraded /
// Unavailable / Unknown) · supported types https://learn.microsoft.com/azure/service-health/resource-health-checks-resource-types
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { debug } from "../infra/logger.js";
import { callerSubscriptions } from "../infra/azureClientFactory.js";
import { queryResourceGraph } from "./azure.js";

export type RhState = "Available" | "Degraded" | "Unavailable" | "Unknown";

/** Types on the Learn list that the diagrams draw without a quality metric of their own (lower-case ARM types) */
export const RH_SUPPORTED = new Set([
  "microsoft.network/natgateways", "microsoft.network/loadbalancers", "microsoft.network/applicationgateways",
  "microsoft.network/azurefirewalls", "microsoft.network/dnszones", "microsoft.network/frontdoors", "microsoft.cdn/profiles",
  "microsoft.network/bastionhosts", "microsoft.network/virtualnetworkgateways", "microsoft.network/connections",
  "microsoft.network/trafficmanagerprofiles",
]);

const armType = (id: string) => {
  const m = /\/providers\/([^/]+\/[^/]+)\/[^/]+$/i.exec(id);
  return m ? m[1]!.toLowerCase() : "";
};
export const rhSupported = (id: string | undefined) => !!id && RH_SUPPORTED.has(armType(id));

const cache = new CacheManager<Map<string, RhState>>(200, 3 * 60_000);
const STATES = new Set<RhState>(["Available", "Degraded", "Unavailable", "Unknown"]);

/** Availability state per resource id (lower-case) for the supported ids among `ids`; failures → empty map */
export async function collectResourceHealth(env: Env, bearerToken: string | undefined, ids: string[]): Promise<Map<string, RhState>> {
  // Ids come from a stored spec: only resources in the caller's own managed subscriptions are asked about
  const mine = new Set(callerSubscriptions(env, bearerToken).map((x) => x.toLowerCase()));
  const wanted = [...new Set(ids.filter(rhSupported).map((x) => x.toLowerCase()))].filter((id) => mine.has(id.split("/")[2] ?? "")).sort();
  if (!wanted.length) return new Map();
  const key = `${bearerToken ? cachePrefix(bearerToken) : "anon"}:rh:${wanted.join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const subs = [...new Set(wanted.map((id) => id.split("/")[2]!))];
  const list = wanted.map((id) => `'${id.replace(/'/g, "")}'`).join(",");
  const query =
    "healthresources | where type =~ 'microsoft.resourcehealth/availabilitystatuses'" +
    " | extend rid = tolower(substring(id, 0, indexof(tolower(id), '/providers/microsoft.resourcehealth/')))" +
    ` | where rid in (${list}) | project rid, state = tostring(properties.availabilityState)`;
  const out = new Map<string, RhState>();
  try {
    for (const r of await queryResourceGraph<{ rid: string; state: string }>(env, bearerToken, query, subs)) {
      if (STATES.has(r.state as RhState)) out.set(r.rid, r.state as RhState);
    }
  } catch (e) {
    debug(`[rh] not read: ${String(e).slice(0, 160)}`);
    return out;
  }
  cache.set(key, out);
  return out;
}
