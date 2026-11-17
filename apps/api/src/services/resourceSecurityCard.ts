// 보안 › 리소스 보안 카드 (docs/architecture/security-roadmap.md 5.3 ④) — every security fact about one Azure resource
// in one answer (Wiz's resource page): Defender recommendations (its own and its child images' / containers'), active
// alerts naming it, its exposure, what it can do (its managed identities' roles) and who can act on it (role
// assignments whose scope covers it), and the risk combination / attack path it is part of. Read by its ARM id only,
// one query after another (Resource Graph quota), each section with its own state — a section not read is "failed",
// never "none". Judges are the ones the combinations use (exposure, privileged / data / key roles).

import type { AzureRiskFactor, InboundExposure, ResourceSecurityCard } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { kqlString } from "../infra/requestParams.js";
import { tryGetArchitectureGraphFromAzure } from "./azure.js";
import { CHILD_RULES, readChildRules } from "./azureEndpoints.js";
import { KEY_ROLES, azureRiskKey, fromId, getAzureRiskCombos, paasExposureFactor, rulesExposure, scopeKind, vmExposure } from "./azureRiskCombos.js";
import { query } from "./securityPosture.js";
import { DATA_ROLES, PRIVILEGED_ROLES } from "./workloadIdentity.js";

type Props = Record<string, unknown>;
const lc = (s: string) => s.toLowerCase();

/** Pure: a role definition's class for a card — privileged · data-plane · key / access-policy · other */
export function roleClass(roleDefGuid: string): "privileged" | "data" | "keys" | "other" {
  const g = lc(roleDefGuid);
  return PRIVILEGED_ROLES[g] ? "privileged" : DATA_ROLES[g] ? "data" : KEY_ROLES[g] ? "keys" : "other";
}

/** Pure: a role assignment's scope covers the resource (the scope, or above it — never a sibling with the same prefix) */
export function covers(scope: string, resourceId: string): boolean {
  const sc = lc(scope).replace(/\/+$/, ""), r = lc(resourceId);
  return scopeKind(sc) === "managementGroup" || r === sc || r.startsWith(`${sc}/`);
}

const SEV_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const roleNames = new CacheManager<string>(500, 24 * 3_600_000);
const cache = new CacheManager<ResourceSecurityCard>(100, 2 * 60_000);

export async function getResourceSecurityCard(env: Env, bearerToken: string, resourceId: string, deps?: { arm?: Pick<ArmFetcher, "postJson" | "fetchJson"> }): Promise<ResourceSecurityCard> {
  const rid = lc(resourceId);
  const key = `${cachePrefix(bearerToken)}:card:${rid}`;
  const hit = deps ? undefined : cache.get(key);
  if (hit) return hit;
  const sub = /^\/subscriptions\/([^/]+)/i.exec(resourceId)?.[1] ?? "";
  const subs = [sub];
  const arm = deps?.arm ?? (await getArmFetcher(env, bearerToken));
  const R = kqlString(rid);
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const parsed = fromId(rid);

  // 1. the resource itself
  const body = await safe(() => query<{ name: string; type: string; resourceGroup: string; location?: string; identity?: Props; properties?: Props }>(arm, subs,
    `resources | where tolower(id) == ${R} | project name, type = tolower(type), resourceGroup, location, identity, properties | limit 1`));
  const res = body?.[0];
  const type = res?.type ?? parsed?.type ?? "";
  const name = res?.name ?? parsed?.name ?? rid.split("/").pop() ?? "";
  const resourceGroup = res?.resourceGroup ?? parsed?.resourceGroup ?? "";

  // 2. recommendations — on the resource and on its child entities (Defender's images / containers)
  const recs = await safe(() => query<{ dn: string; sev: string; st: string; entities: number; own: number }>(arm, subs,
    "securityresources | where type == 'microsoft.security/assessments' | extend rid = tolower(tostring(properties.resourceDetails.Id))" +
    ` | where rid == ${R} or rid startswith strcat(${R}, '/')` +
    " | extend st = tostring(properties.status.code), sev = tostring(properties.metadata.severity), dn = tostring(properties.displayName)" +
    ` | summarize entities = dcount(rid), own = countif(rid == ${R}) by dn, sev, st`));
  const unhealthy = (recs ?? []).filter((r) => r.st === "Unhealthy");
  const sum = (st: string) => (recs ?? []).filter((r) => r.st === st).reduce((n, r) => n + r.entities, 0);
  const sevN = (s: string) => unhealthy.filter((r) => r.sev === s).reduce((n, r) => n + r.entities, 0);

  // 3. active alerts naming it
  const alerts = await safe(() => query<{ dn: string; sev: string; st: string; t: string }>(arm, subs,
    "securityresources | where type == 'microsoft.security/locations/alerts' | where properties.Status in ('Active', 'InProgress')" +
    " | mv-expand r = properties.ResourceIdentifiers | extend a = tolower(tostring(r.AzureResourceId))" +
    ` | where a == ${R} or a startswith strcat(${R}, '/')` +
    // one row per alert (an alert naming the resource twice is one): project, then distinct — a column named `title`
    // fails to parse with distinct in Resource Graph (every card said "alerts not read" until this was found)
    " | project id, dn = tostring(properties.AlertDisplayName), sev = tostring(properties.Severity), st = tostring(properties.Status), t = tostring(properties.TimeGeneratedUtc)" +
    " | distinct id, dn, sev, st, t"));

  // 4. exposure — the combinations' judges (VM: the diagram's NSG verdict; PaaS / AKS: body + child firewall rules)
  let exposure: ResourceSecurityCard["exposure"];
  if (type === "microsoft.compute/virtualmachines") {
    const g = await safe(() => tryGetArchitectureGraphFromAzure(env, bearerToken, { subscriptionId: sub }));
    const node = g?.nodes.find((n) => n.azureId && lc(n.azureId) === rid);
    exposure = g ? { section: "ok", factor: vmExposure(node?.metadata?.inboundExposure as InboundExposure | undefined) } : { section: "failed", factor: null };
  } else if (!res) {
    exposure = { section: "failed", factor: null };
  } else {
    let f: AzureRiskFactor = paasExposureFactor(type, res.properties ?? {});
    if (f.reason === "childRules" && CHILD_RULES[type] && "fetchJson" in arm) {
      const pna = typeof res.properties?.publicNetworkAccess === "string" ? String(res.properties.publicNetworkAccess) : String(((res.properties?.network ?? {}) as Props).publicNetworkAccess ?? "");
      const rules = await safe(() => readChildRules(arm as never, resourceId, type));
      if (rules) f = rulesExposure(pna || null, rules.network);
    }
    // no public network setting at all and no child rules = a type without a public endpoint of its own
    exposure = f.reason === "publicAccessUnset" ? { section: "na", factor: null } : { section: "ok", factor: f };
  }

  // 5. what it can do — its managed identities' roles
  const idp = (res?.identity ?? {}) as Props;
  const ua = Object.keys((idp.userAssignedIdentities ?? {}) as Props).map(lc);
  const uaPrincipals = ua.length ? await safe(() => query<{ p: string }>(arm, subs,
    `resources | where tolower(id) in (${ua.map(kqlString).join(",")}) | project p = tolower(tostring(properties.principalId))`)) : [];
  const principals = [...new Set([typeof idp.principalId === "string" ? lc(idp.principalId) : "", ...(uaPrincipals ?? []).map((x) => x.p)].filter((x) => /^[0-9a-f-]{36}$/.test(x)))];
  const ownRoles = principals.length ? await safe(() => query<{ def: string; scope: string }>(arm, subs,
    "authorizationresources | where type =~ 'microsoft.authorization/roleassignments'" +
    ` | where tolower(tostring(properties.principalId)) in (${principals.map(kqlString).join(",")})` +
    " | project def = tolower(tostring(split(properties.roleDefinitionId, '/')[-1])), scope = tostring(properties.scope)")) : [];

  // 6. who can act on it — assignments whose scope covers it (privileged / data / key roles)
  const scopes = [`/subscriptions/${lc(sub)}`, ...(resourceGroup ? [`/subscriptions/${lc(sub)}/resourcegroups/${lc(resourceGroup)}`] : [])];
  const inbound = await safe(() => query<{ def: string; scope: string; ptype: string; pid: string }>(arm, subs,
    "authorizationresources | where type =~ 'microsoft.authorization/roleassignments' | extend s = tolower(trim_end('/', tostring(properties.scope)))" +
    ` | where s in (${scopes.map(kqlString).join(",")}) or s == ${R} or s startswith '/providers/microsoft.management/managementgroups/' or ${R} startswith strcat(s, '/')` +
    " | project def = tolower(tostring(split(properties.roleDefinitionId, '/')[-1])), scope = tostring(properties.scope), ptype = tostring(properties.principalType), pid = tolower(tostring(properties.principalId))"));
  const relevant = (inbound ?? []).filter((r) => covers(r.scope, rid) && roleClass(r.def) !== "other");

  // role names (ARM role definitions, a day's cache) for the roles shown
  const defs = [...new Set([...(ownRoles ?? []).map((r) => r.def), ...relevant.map((r) => r.def)])];
  for (const d of defs) {
    if (roleNames.get(d) || !("fetchJson" in arm)) continue;
    const def = await safe(() => (arm as Pick<ArmFetcher, "fetchJson">).fetchJson<{ properties?: { roleName?: string } }>(
      `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${d}?api-version=2022-04-01`));
    if (def?.properties?.roleName) roleNames.set(d, def.properties.roleName);
  }
  const roleName = (d: string) => roleNames.get(d) ?? d;
  const scopeName = (s: string) => { const k = scopeKind(s); return k === "resourceGroup" || k === "resource" ? s.split("/").filter(Boolean).pop() : undefined; };

  // 7. the combination / path it is part of (same keys as the issue list)
  const risk = await safe(() => getAzureRiskCombos(env, bearerToken, sub));
  const ck = azureRiskKey(resourceGroup, type, name);
  const out: ResourceSecurityCard = {
    resourceId: rid, generatedAt: new Date().toISOString(),
    resource: { found: !!res, name, type, resourceGroup, ...(res?.location ? { location: res.location } : {}), portalUrl: `https://portal.azure.com/#@/resource${resourceId}` },
    recommendations: {
      state: recs ? "ok" : "failed",
      counts: { unhealthy: sum("Unhealthy"), healthy: sum("Healthy"), notApplicable: sum("NotApplicable"), high: sevN("High"), medium: sevN("Medium"), low: sevN("Low") },
      items: unhealthy.map((r) => ({ name: r.dn, severity: (["High", "Medium", "Low"].includes(r.sev) ? r.sev : "Low") as "High" | "Medium" | "Low", entities: r.entities, onSelf: r.own > 0 }))
        .sort((a, b) => SEV_RANK[a.severity]! - SEV_RANK[b.severity]! || b.entities - a.entities || a.name.localeCompare(b.name)).slice(0, 100),
    },
    alerts: { state: alerts ? "ok" : "failed", items: (alerts ?? []).map((a) => ({ title: a.dn, severity: a.sev, status: a.st, at: a.t })).sort((a, b) => b.at.localeCompare(a.at)) },
    exposure,
    identity: {
      state: !res ? "failed" : !principals.length ? "na" : ownRoles ? "ok" : "failed",
      principals: principals.length,
      roles: (ownRoles ?? []).map((r) => ({ roleName: roleName(r.def), class: roleClass(r.def), scope: scopeKind(r.scope), ...(scopeName(r.scope) ? { scopeName: scopeName(r.scope)! } : {}) })),
    },
    access: {
      state: inbound ? "ok" : "failed",
      byClass: (["privileged", "data", "keys"] as const).map((c) => {
        const l = relevant.filter((r) => roleClass(r.def) === c);
        return { class: c, assignments: l.length, principals: new Set(l.map((r) => r.pid)).size };
      }).filter((x) => x.assignments > 0),
      // the inbound read asks for every subscription / management-group assignment: none back = this identity can't see them
      aboveHidden: !!inbound && !inbound.some((r) => { const k = scopeKind(r.scope); return k === "subscription" || k === "managementGroup"; }),
      items: relevant.slice(0, 40).map((r) => ({ roleName: roleName(r.def), class: roleClass(r.def) as "privileged" | "data" | "keys", principalType: r.ptype || "Unknown", principalTail: r.pid.slice(-4), scope: scopeKind(r.scope) })),
    },
    combo: risk?.combos.find((c) => c.key === ck) ?? null,
    path: risk?.paths.find((p) => p.key === ck.replace(/^azure:/, "path:")) ?? null,
  };
  if (!deps && out.recommendations.state === "ok" && out.alerts.state === "ok" && out.access.state === "ok") cache.set(key, out);
  return out;
}
