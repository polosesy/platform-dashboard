// Cause records for the live lifecycle (services/lifecycle.ts) — Resource Graph, read with the caller's connection
// credentials, ids limited to the caller's own subscriptions (like resourceHealthCollector):
//   changes     — `resourcechanges` of the last 6 h for the diagram's resources (who: changedByType; what: before →
//                 after per property). Records arrive within ~5 min and are kept 14 days. Cached 2 min per caller.
//   maintenance — active Service Health planned-maintenance events whose impacted resources list one of the ids
//                 (`servicehealthresources`, impactedresources joined to its event by tracking id). Cached 10 min.
// Learn: https://learn.microsoft.com/azure/governance/resource-graph/changes/get-resource-changes ·
//        https://learn.microsoft.com/azure/service-health/resource-graph-samples
// A failure returns an empty result: the cause stays "unknown", never guessed.
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { debug } from "../infra/logger.js";
import { callerSubscriptions } from "../infra/azureClientFactory.js";
import { queryResourceGraph } from "./azure.js";
import type { ChangeRow } from "./lifecycle.js";

const changeCache = new CacheManager<Map<string, ChangeRow[]>>(200, 2 * 60_000);
const maintenanceCache = new CacheManager<Set<string>>(200, 10 * 60_000);
const MAX_IDS = 200;

function mine(env: Env, bearerToken: string | undefined, ids: string[]): string[] {
  const subs = new Set(callerSubscriptions(env, bearerToken).map((x) => x.toLowerCase()));
  return [...new Set(ids.map((x) => x.toLowerCase()))].filter((id) => subs.has(id.split("/")[2] ?? "")).sort().slice(0, MAX_IDS);
}
const kqlIds = (ids: string[]) => ids.map((id) => `'${id.replace(/'/g, "")}'`).join(",");
const subsOf = (ids: string[]) => [...new Set(ids.map((id) => id.split("/")[2]!))];

/** Change records of the last 6 h per resource id (lower-case), newest first */
export async function collectRecentChanges(env: Env, bearerToken: string | undefined, ids: string[]): Promise<Map<string, ChangeRow[]>> {
  const wanted = mine(env, bearerToken, ids);
  if (!wanted.length) return new Map();
  const key = `${bearerToken ? cachePrefix(bearerToken) : "anon"}:chg:${wanted.join(",")}`;
  const hit = changeCache.get(key);
  if (hit) return hit;
  const query =
    "resourcechanges" +
    " | extend at = todatetime(properties.changeAttributes.timestamp), rid = tolower(tostring(properties.targetResourceId))" +
    ` | where at > ago(6h) and rid in (${kqlIds(wanted)})` +
    " | project rid, at, changeType = tostring(properties.changeType), byType = tostring(properties.changeAttributes.changedByType), changes = properties.changes" +
    " | order by at desc | take 500";
  const out = new Map<string, ChangeRow[]>();
  try {
    for (const r of await queryResourceGraph<{ rid: string; at: string; changeType?: string; byType?: string; changes?: ChangeRow["changes"] }>(env, bearerToken, query, subsOf(wanted))) {
      const row: ChangeRow = { rid: r.rid, at: new Date(r.at).toISOString(), ...(r.changeType ? { changeType: r.changeType } : {}), ...(r.byType ? { byType: r.byType } : {}), ...(r.changes ? { changes: r.changes } : {}) };
      (out.get(r.rid) ?? out.set(r.rid, []).get(r.rid)!).push(row);
    }
  } catch (e) {
    debug(`[lifecycle] changes not read: ${String(e).slice(0, 160)}`);
  }
  changeCache.set(key, out);
  return out;
}

/** Resource ids (lower-case) that an active planned-maintenance event lists as impacted */
export async function collectPlannedMaintenance(env: Env, bearerToken: string | undefined, ids: string[]): Promise<Set<string>> {
  const wanted = mine(env, bearerToken, ids);
  if (!wanted.length) return new Set();
  const key = `${bearerToken ? cachePrefix(bearerToken) : "anon"}:pm:${wanted.join(",")}`;
  const hit = maintenanceCache.get(key);
  if (hit) return hit;
  // The impacted-resource row's id is …/providers/Microsoft.ResourceHealth/events/<trackingId>/impactedResources/…
  const query =
    "servicehealthresources | where type =~ 'microsoft.resourcehealth/events/impactedresources'" +
    " | extend rid = tolower(tostring(properties.targetResourceId)), trackingId = tostring(split(split(id, '/events/', 1)[0], '/impactedResources', 0)[0])" +
    ` | where rid in (${kqlIds(wanted)})` +
    " | join kind=inner (servicehealthresources | where type =~ 'microsoft.resourcehealth/events'" +
    "   | extend trackingId = tostring(name), eventType = tostring(properties.EventType), status = tostring(properties.Status)" +
    "   | where eventType =~ 'PlannedMaintenance' and status =~ 'Active') on trackingId" +
    " | project rid";
  const out = new Set<string>();
  try {
    for (const r of await queryResourceGraph<{ rid: string }>(env, bearerToken, query, subsOf(wanted))) out.add(r.rid);
  } catch (e) {
    debug(`[lifecycle] planned maintenance not read: ${String(e).slice(0, 160)}`);
  }
  maintenanceCache.set(key, out);
  return out;
}
