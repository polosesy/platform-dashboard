// 보안 개요 팀 범위 (docs/architecture/security-roadmap.md 5.7 ⑤ — 2026-11-17). Raw counts per resource group of one
// subscription — the web partitions them by the connection's owner rules with the issue list's own `teamOf`, so a
// resource group belongs to the same team on both screens. Only facts that split by resource group are here: Defender
// findings (assessments on resources), distinct affected resources, active alerts (the resources they name) and the
// inventory. The secure score, its controls, compliance standards and plans are subscription-level resources — they
// can't be split by team, and the page says so.
//
// Counting rules (exact — no dcount estimates):
//   affected   one resource once per severity: `summarize by rid, rg, sev | summarize count() by rg, sev`. A resource has
//              one group, so a team's number is the sum of its groups' numbers — and teams + unowned + subscription-level
//              add up to the subscription's number (tested; checked on stg against independent KQL)
//   findings   unhealthy assessments per (group, recommendation key, severity) — a resource once per recommendation
//   alerts     one row per active alert with the groups of the resources it names (no alert ids leave the API); an alert
//              naming two teams' resources counts for both (said on screen), one naming none has no group
// Resource group "" = no group (assessments on the subscription itself, alerts without an Azure resource).

import type { OwnerRule, SecurityTeamScopeResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { connectionForSubscription } from "../infra/connectionRegistry.js";
import { query, safeMessage } from "./securityPosture.js";

const A = "securityresources | where type == 'microsoft.security/assessments'" +
  " | extend st = tostring(properties.status.code), rid = tolower(tostring(properties.resourceDetails.Id)), sev = tostring(properties.metadata.severity)" +
  " | where st == 'Unhealthy' and isnotempty(rid) | extend rg = tolower(extract('/resourcegroups/([^/]+)', 1, rid))";

export const TEAM_Q = {
  inventory: "resources | summarize n = count() by rg = tolower(resourceGroup)",
  affected: `${A} | summarize by rid, rg, sev | summarize n = count() by rg, sev`,
  findings: `${A} | summarize n = count() by rg, key = name, sev`,
  // An alert without ResourceIdentifiers keeps its row (mv-expand drops empty arrays) — it has no group
  alerts: "securityresources | where type == 'microsoft.security/locations/alerts' | where tostring(properties.Status) in ('Active','InProgress')" +
    " | extend ri = properties.ResourceIdentifiers | extend ri = iff(array_length(ri) > 0, ri, pack_array(dynamic({})))" +
    // lower-case BEFORE the match: alert ids say "/resourceGroups/" (stg: the one active alert went to "no group")
    " | mv-expand r = ri | extend rg = extract('/resourcegroups/([^/]+)', 1, tolower(tostring(r.AzureResourceId)))" +
    " | summarize rgs = make_set(rg) by id, sev = tostring(properties.Severity)",
} as const;

/** query() reads at most 10 pages of 1,000: a full read may have stopped short */
export const ROW_CAP = 10_000;

type Section = SecurityTeamScopeResponse["gaps"][number]["section"];
const SEVS = ["High", "Medium", "Low"] as const;

/** Pure: Resource Graph rows → the response (exported for tests) */
export function buildTeamScope(input: {
  subscriptionId: string; owners: OwnerRule[];
  inventory: Array<{ rg?: string; n?: number }> | null;
  affected: Array<{ rg?: string; sev?: string; n?: number }> | null;
  findings: Array<{ rg?: string; key?: string; sev?: string; n?: number }> | null;
  alerts: Array<{ id?: string; sev?: string; rgs?: unknown }> | null;
  gaps: SecurityTeamScopeResponse["gaps"];
}): SecurityTeamScopeResponse {
  const groups = new Map<string, SecurityTeamScopeResponse["groups"][number]>();
  const group = (rg: string) => groups.get(rg) ?? groups.set(rg, { rg, resources: input.inventory ? 0 : null, affected: { High: 0, Medium: 0, Low: 0 } }).get(rg)!;
  for (const r of input.inventory ?? []) group(r.rg ?? "").resources = Number(r.n) || 0;
  for (const r of input.affected ?? []) {
    const sev = SEVS.find((s) => s === r.sev);
    if (sev) group(r.rg ?? "").affected[sev] += Number(r.n) || 0;
  }
  const findings = (input.findings ?? []).filter((r) => r.key).map((r) => {
    group(r.rg ?? "");
    return { rg: r.rg ?? "", key: r.key!, severity: (SEVS.find((s) => s === r.sev) ?? "Low") as "High" | "Medium" | "Low", n: Number(r.n) || 0 };
  });
  const alerts = (input.alerts ?? []).map((a) => {
    const rgs = [...new Set((Array.isArray(a.rgs) ? a.rgs : []).filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
    for (const rg of rgs) group(rg);
    return { severity: typeof a.sev === "string" && a.sev ? a.sev : "Informational", rgs };
  });
  return {
    subscriptionId: input.subscriptionId,
    generatedAt: new Date().toISOString(),
    owners: input.owners,
    groups: [...groups.values()].sort((a, b) => a.rg.localeCompare(b.rg)),
    findings,
    alerts,
    gaps: input.gaps,
  };
}

const cache = new CacheManager<SecurityTeamScopeResponse>(30, 5 * 60_000);

export async function getSecurityTeamScope(env: Env, bearerToken: string, subscriptionId: string, deps?: { arm?: Pick<ArmFetcher, "postJson"> }): Promise<SecurityTeamScopeResponse> {
  const key = `${cachePrefix(bearerToken)}:team-scope:${subscriptionId.toLowerCase()}`;
  const hit = deps ? undefined : cache.get(key);
  if (hit) return hit;
  const arm = deps?.arm ?? (await getArmFetcher(env, bearerToken));
  const gaps: SecurityTeamScopeResponse["gaps"] = [];
  // One after another — the caller's Resource Graph quota is 15 per 5 s and the posture read runs beside this one
  const read = async <T>(section: Section, q: string): Promise<T[] | null> => {
    try {
      const rows = await query<T>(arm, [subscriptionId], q);
      if (rows.length >= ROW_CAP) gaps.push({ section, message: `more than ${ROW_CAP} rows — the rest not read` });
      return rows;
    } catch (e: unknown) {
      gaps.push({ section, message: safeMessage(e) });
      return null;
    }
  };
  const inventory = await read<{ rg?: string; n?: number }>("inventory", TEAM_Q.inventory);
  const affected = await read<{ rg?: string; sev?: string; n?: number }>("affected", TEAM_Q.affected);
  const findings = await read<{ rg?: string; key?: string; sev?: string; n?: number }>("findings", TEAM_Q.findings);
  const alerts = await read<{ id?: string; sev?: string; rgs?: unknown }>("alerts", TEAM_Q.alerts);
  if (gaps.length === 4 && !inventory && !affected && !findings && !alerts) throw new Error(gaps[0]!.message);
  const out = buildTeamScope({ subscriptionId, owners: connectionForSubscription(env, subscriptionId)?.owners ?? [], inventory, affected, findings, alerts, gaps });
  if (!gaps.length && !deps) cache.set(key, out);
  return out;
}
