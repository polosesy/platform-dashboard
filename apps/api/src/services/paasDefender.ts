// Defender for Cloud recommendations on the Azure resources a cluster talks to (보안 고도화 P5 — 구독 범위). The posture
// view lists at most 5 sample resources per recommendation, so "is this Key Vault in a High recommendation?" cannot be
// answered from it. Here the assessments are read by exact resource ID instead and summed per resource. No row at all =
// Defender holds no assessment for it (plan off or type not covered) — `notAssessed`, never "healthy".
import type { PaasDefender, PolicyInsightsResponse } from "@aud/types";
import type { Env } from "../env.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { maskGuids } from "../infra/requestParams.js";
import type { AzureEndpoint } from "./policyInsights.js";

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";
const MAX_IDS = 200;
const TOP = 3;

/** One row per resource: counts by severity + the Unhealthy titles (ordered by severity on our side) */
export type DefenderRow = { rid: string; high: number; medium: number; low: number; healthy: number; top?: Array<{ t?: string; s?: string }> };

/** Resource Graph query: the assessments of exactly these resources (lowercase ARM IDs), summed per resource */
export function paasDefenderQuery(ids: string[]): string {
  const list = ids.map((i) => `'${i.toLowerCase().replace(/'/g, "")}'`).join(",");
  return "securityresources | where type == 'microsoft.security/assessments'"
    + " | extend rid=tolower(tostring(properties.resourceDetails.Id)), st=tostring(properties.status.code), sev=tostring(properties.metadata.severity)"
    + ` | where rid in (${list}) and st in ('Unhealthy','Healthy')`
    + " | summarize high=countif(st=='Unhealthy' and sev=='High'), medium=countif(st=='Unhealthy' and sev=='Medium'),"
    + " low=countif(st=='Unhealthy' and sev !in ('High','Medium')), healthy=countif(st=='Healthy'),"
    + " top=make_list_if(pack('t', tostring(properties.displayName), 's', sev), st=='Unhealthy', 30) by rid";
}

/** Pure: per-resource rows → per resource (lowercase ID). IDs with no row are `notAssessed`. */
export function defenderByResource(ids: string[], rows: DefenderRow[]): Map<string, PaasDefender> {
  const out = new Map<string, PaasDefender>();
  for (const id of ids) out.set(id.toLowerCase(), { state: "notAssessed" });
  const rank = { High: 0, Medium: 1, Low: 2 } as const;
  for (const r of rows) {
    const id = String(r.rid ?? "").toLowerCase();
    if (!out.has(id)) continue;
    const top = (r.top ?? [])
      .map((x) => ({ title: maskGuids(String(x.t ?? "")).slice(0, 200), severity: (x.s === "High" || x.s === "Medium" ? x.s : "Low") as "High" | "Medium" | "Low" }))
      .filter((x) => x.title)
      .sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title))
      .slice(0, TOP);
    out.set(id, { state: "ok", high: Number(r.high) || 0, medium: Number(r.medium) || 0, low: Number(r.low) || 0, healthy: Number(r.healthy) || 0, top });
  }
  return out;
}

/**
 * Attach `defender` to the PaaS nodes of the insights network (mutates). A node gets a value only when its network id
 * matches exactly one endpoint (the same rule as `containment.resources`). Throws on a failed read — the nodes are
 * marked null first, the caller lists the gap.
 */
export async function attachPaasDefender(env: Env, bearerToken: string | undefined, insights: PolicyInsightsResponse, endpoints: AzureEndpoint[]): Promise<void> {
  const idOf = new Map<string, string>();
  for (const n of insights.network.nodes) {
    if (n.kind !== "paas") continue;
    const same = endpoints.filter((x) => `azure:${x.type}/${x.name}` === n.id);
    if (same.length === 1 && same[0]!.armId) idOf.set(n.id, same[0]!.armId.toLowerCase());
  }
  const ids = [...new Set(idOf.values())].slice(0, MAX_IDS);
  if (!ids.length) return;
  const subs = [...new Set(ids.map((i) => /^\/subscriptions\/([^/]+)\//.exec(i)?.[1]).filter((s): s is string => !!s))];
  try {
    const arm = await getArmFetcherAuto(env, bearerToken);
    const r = await arm.postJson<{ data?: DefenderRow[] }>(ARG, { subscriptions: subs, query: paasDefenderQuery(ids), options: { resultFormat: "objectArray" } }, { timeoutMs: 20_000 });
    const by = defenderByResource(ids, r.data ?? []);
    for (const n of insights.network.nodes) {
      const id = idOf.get(n.id);
      if (id && by.has(id)) n.defender = by.get(id)!;
    }
  } catch (e) {
    for (const n of insights.network.nodes) if (idOf.has(n.id)) n.defender = null;
    throw e;
  }
}
