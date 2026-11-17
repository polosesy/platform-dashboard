// 보안 › 이슈·통합 위험 › Azure 위험 조합 (docs/architecture/security-roadmap.md 5.3 ②) — Wiz toxic combinations on
// Azure resources, from facts only, per resource (exact ARM id join, lower-case — never by display name):
//   exposure  VM: the NSG verdict the infrastructure diagram computes (nsgExposure — open / scoped = yes, closed / noNsg
//             = no, else unknown). PaaS: publicNetworkAccess + the network rules in its body (paasExposure — open = yes,
//             closed / restricted = no; rules in child resources or no publicNetworkAccess = unknown).
//   high      Defender: unhealthy assessments of severity High on that resource (every one — not the 5 samples a
//             recommendation carries).
//   identity  its managed identities (system-assigned principal, user-assigned identities' principals) → role
//             assignments → owner / contributor / user access administrator / RBAC administrator by definition ID.
// A combination = two or more "yes". "unknown" is never "no": a resource with one "yes" and an unknown factor is
// counted as undetermined, not dropped silently. No score — the kind and its evidence.

import type { AzureAttackPath, AzureFactorState, AzureJewelKind, AzurePathRole, AzureRiskCombo, AzureRiskResponse, InboundExposure } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { safeMessage } from "../infra/requestParams.js";
import { tryGetArchitectureGraphFromAzure } from "./azure.js";
import { CHILD_RULES, networkRulesOf, readChildRules } from "./azureEndpoints.js";
import { paasExposure } from "./policyInsights.js";
import { query } from "./securityPosture.js";
import { DATA_ROLES, PRIVILEGED_ROLES } from "./workloadIdentity.js";

type Props = Record<string, unknown>;
export type ExposureIn = { id: string; name: string; type: string; resourceGroup: string; state: AzureFactorState; detail?: string; reason?: string; limited?: boolean };
export type RoleIn = { principalId: string; roleDefGuid: string; scope: string };
export type CombosInput = {
  /** VM and PaaS exposure verdicts (resources not listed: exposure n/a) */
  exposure: ExposureIn[] | null;
  /** lower-case top-level resource id → High unhealthy assessments (own + its child entities'); null = not read */
  high: Map<string, { count: number; names: string[]; name: string; type: string; resourceGroup: string; children?: number }> | null;
  /** lower-case resource id → its managed identity principals; null = not read */
  identities: Map<string, { principals: string[]; name: string; type: string; resourceGroup: string }> | null;
  /** role assignments of those principals; null = not read */
  roles: RoleIn[] | null;
  /** a part of the exposure read failed: VMs (the diagram) or PaaS (publicNetworkAccess) — missing ones are unknown, not n/a */
  exposureUnread?: { vm: boolean; paas: boolean };
  /** this subscription's data stores (Key Vault · Storage · databases); null = not read */
  jewels?: Array<{ id: string; name: string; type: string }> | null;
};

/**
 * Management roles that reach the data anyway (by definition ID): storage keys can be listed (listKeys → full data
 * access), a vault's access policies can be written (vaults on the access-policy model). stg 2026-11-17: a VM identity
 * held the Storage Account Key Operator role — invisible to a data-role-only check.
 */
export const KEY_ROLES: Record<string, { svc: "keyVault" | "storage" }> = {
  "81a9662b-bebf-436f-a333-f67b29880f12": { svc: "storage" },  // Storage Account Key Operator Service Role (listKeys / regenerateKey)
  "17d1049b-9a84-46fb-8f53-869881c3d3ab": { svc: "storage" },  // Storage Account Contributor (listKeys)
  "f25e0fa2-a7c8-4377-a976-54943a77a395": { svc: "keyVault" }, // Key Vault Contributor (accessPolicies/write)
};

/** Data stores a path can end at, by ARM type */
export const JEWEL_TYPES: Record<string, AzureJewelKind> = {
  "microsoft.keyvault/vaults": "keyVault",
  "microsoft.storage/storageaccounts": "storage",
  "microsoft.sql/servers": "database",
  "microsoft.documentdb/databaseaccounts": "database",
  "microsoft.dbforpostgresql/flexibleservers": "database",
  "microsoft.dbformysql/flexibleservers": "database",
};
const JEWEL_ORDER: AzureJewelKind[] = ["keyVault", "storage", "database"];

/** Pure: a resource id lies inside a role's scope (the scope itself, or below it — never a sibling with the same prefix) */
export function inScope(resourceId: string, scope: string): boolean {
  const r = lc(resourceId), sc = lc(scope).replace(/\/+$/, "");
  if (scopeKind(sc) === "managementGroup") return true; // a management group above this subscription covers all of it
  return r === sc || r.startsWith(`${sc}/`);
}

const lc = (s: string) => s.toLowerCase();
const ascii = (s: string, max = 400) => s.normalize("NFKD").replace(/[^\x21-\x7e]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, max);
/** Pure: the issue key of a resource — rg / provider/type / name (no subscription: the state file is per subscription) */
export const azureRiskKey = (resourceGroup: string, type: string, name: string) => `azure:${ascii(lc(`${resourceGroup}/${type}/${name}`))}`;

/**
 * Pure: name / full type / resource group from any ARM id — nested types too (`…/registries/r/…` child resources,
 * VM extensions, subscription-level resources): a one-level parse dropped 669 of 699 High-finding resources on stg
 */
export function fromId(rid: string): { resourceGroup: string; type: string; name: string } | null {
  const m = /^\/subscriptions\/[^/]+(?:\/resourcegroups\/([^/]+))?\/providers\/([^/]+)\/(.+)$/i.exec(rid);
  if (!m) return null;
  const parts = m[3]!.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length % 2) return null;
  const types = parts.filter((_, i) => i % 2 === 0);
  return { resourceGroup: m[1] ?? "", type: lc(`${m[2]}/${types.join("/")}`), name: parts[parts.length - 1]! };
}

/** Pure: a role assignment's scope kind */
export function scopeKind(scope: string): "managementGroup" | "subscription" | "resourceGroup" | "resource" {
  const s = lc(scope);
  if (s.startsWith("/providers/microsoft.management/managementgroups/") || s === "/") return "managementGroup";
  if (/^\/subscriptions\/[^/]+\/?$/.test(s)) return "subscription";
  if (/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/?$/.test(s)) return "resourceGroup";
  return "resource";
}

/** Pure: a VM's exposure factor from the diagram's NSG verdict */
export function vmExposure(e: InboundExposure | undefined): Pick<ExposureIn, "state" | "detail" | "reason" | "limited"> {
  if (!e) return { state: "no", detail: "no public IP" };
  // scoped = listed source ranges / service tags only (stg 2026-11-17: all 5 exposed VMs) — exposed, but not to anyone
  if (e.state === "open" || e.state === "scoped") return { state: "yes", ...(e.state === "scoped" ? { limited: true } : {}), detail: `${e.state} · ${e.ports.slice(0, 6).join(", ") || "*"} · ${e.sources}` };
  if (e.state === "closed" || e.state === "noNsg") return { state: "no", detail: e.state };
  return { state: "unknown", reason: e.reasons?.[0] ?? "nsgUnknown" };
}

/** Pure: a PaaS resource's exposure factor from its body (the same verdict the cluster graph uses for PaaS it reaches) */
/**
 * Pure: an AKS cluster's API server exposure from its body — private cluster = no; public with authorized IP ranges =
 * yes, limited; public without = yes (any Internet address reaches the API server — it still asks for credentials)
 */
export function aksExposureFactor(p: Props): Pick<ExposureIn, "state" | "detail" | "reason" | "limited"> {
  const api = (p.apiServerAccessProfile ?? {}) as Props;
  if (api.enablePrivateCluster === true) return { state: "no", detail: "private cluster" };
  if (p.publicNetworkAccess === "Disabled") return { state: "no", detail: "publicNetworkAccess Disabled" };
  const ranges = Array.isArray(api.authorizedIPRanges) ? api.authorizedIPRanges.length : 0;
  if (api.enablePrivateCluster === false || api.enablePrivateCluster === undefined) {
    return ranges ? { state: "yes", limited: true, detail: `API server · ${ranges} authorized IP ranges` } : { state: "yes", detail: "API server · any address" };
  }
  return { state: "unknown", reason: "aksAccessUnknown" };
}

/**
 * Pure: the top-level resource a finding belongs to — Defender's per-image / per-container entities
 * (`…/registries/r/securityentitydata/x`, `…/managedClusters/c/securityentitydata/x`) are their registry's / cluster's
 * (stg 2026-11-17: 669 of 699 High-finding "resources" were such entities — no identity, no exposure of their own)
 */
export function topLevelId(rid: string): { id: string; child: boolean } {
  const m = /^(\/subscriptions\/[^/]+(?:\/resourcegroups\/[^/]+)?\/providers\/[^/]+\/[^/]+\/[^/]+)(\/.*)?$/i.exec(rid);
  return m ? { id: lc(m[1]!), child: !!m[2] } : { id: lc(rid), child: false };
}

export function paasExposureFactor(armType: string, p: Props): Pick<ExposureIn, "state" | "detail" | "reason" | "limited"> {
  if (armType === "microsoft.containerservice/managedclusters") return aksExposureFactor(p);
  const pna = typeof p.publicNetworkAccess === "string" ? p.publicNetworkAccess : typeof (p.network as Props | undefined)?.publicNetworkAccess === "string" ? String((p.network as Props).publicNetworkAccess) : null;
  if (pna === "Disabled") return { state: "no", detail: "publicNetworkAccess Disabled" };
  if (pna === null) return { state: "unknown", reason: "publicAccessUnset" };
  const rules = networkRulesOf(armType, p);
  if (!rules) return { state: "unknown", reason: "childRules" };
  return rulesExposure(pna, rules);
}

/**
 * Pure: exposure from public access + network rules — the VMs' rule applied to PaaS: any address = yes; public IP
 * allow rules only = yes, limited (like an NSG "scoped"); VNet rules only / closed = no
 */
export function rulesExposure(pna: string | null, rules: ReturnType<typeof networkRulesOf>): Pick<ExposureIn, "state" | "detail" | "reason" | "limited"> {
  const v = paasExposure(pna, rules);
  if (v === "open") return { state: "yes", detail: `publicNetworkAccess ${pna} · ${rules?.noIpFirewall ? "no IP firewall" : "any address allowed"}` };
  if (v === "restricted" && (rules?.ipRules ?? 0) > 0) return { state: "yes", limited: true, detail: `publicNetworkAccess ${pna} · ${rules!.ipRules} IP allow rules` };
  if (v === "unknown") return { state: "unknown", reason: "rulesUnknown" };
  return { state: "no", detail: v === "restricted" ? "virtual network rules only" : v };
}

const KIND: Record<string, AzureRiskCombo["kind"]> = { "111": "exposedHighIdentity", "101": "exposedIdentity", "110": "exposedHigh", "011": "highIdentity" };
const SEV: Record<AzureRiskCombo["kind"], AzureRiskCombo["sev"]> = { exposedHighIdentity: "critical", exposedIdentity: "high", exposedHigh: "high", highIdentity: "medium" };
const LOWER: Record<AzureRiskCombo["sev"], AzureRiskCombo["sev"]> = { critical: "high", high: "medium", medium: "medium" };

/** Pure: the combinations — every resource with a factor "yes", judged on all three; two or more = a combination */
export function judgeCombos(input: CombosInput, subscriptionId: string): { combos: AzureRiskCombo[]; counts: Omit<AzureRiskResponse["counts"], "paths">; undetermined: AzureRiskResponse["undetermined"] } {
  type Res = { name: string; type: string; resourceGroup: string };
  const all = new Map<string, Res>();
  const expo = new Map((input.exposure ?? []).map((e) => [lc(e.id), e]));
  for (const [id, e] of expo) all.set(id, e);
  for (const [id, h] of input.high ?? []) if (!all.has(id)) all.set(id, h);
  for (const [id, i] of input.identities ?? []) if (!all.has(id)) all.set(id, i);
  const rolesOf = new Map<string, RoleIn[]>();
  for (const r of input.roles ?? []) if (PRIVILEGED_ROLES[lc(r.roleDefGuid)]) (rolesOf.get(lc(r.principalId)) ?? rolesOf.set(lc(r.principalId), []).get(lc(r.principalId))!).push(r);

  const combos: AzureRiskCombo[] = [];
  const pending: AzureRiskResponse["undetermined"] = [];
  let exposed = 0, high = 0, privileged = 0, undetermined = 0;
  for (const [id, res] of all) {
    const e = expo.get(id);
    const isVm = res.type === "microsoft.compute/virtualmachines";
    const unread = input.exposure === null || (isVm ? input.exposureUnread?.vm : input.exposureUnread?.paas);
    const exposure: AzureRiskCombo["exposure"] = e ? { state: e.state, ...(e.limited ? { limited: true } : {}), ...(e.detail ? { detail: e.detail } : {}), ...(e.reason ? { reason: e.reason } : {}) }
      : unread ? { state: "unknown", reason: "exposureUnread" } : { state: "na" };
    const h = input.high?.get(id);
    const hi: AzureRiskCombo["high"] = input.high === null ? { state: "unknown", reason: "findingsUnread" }
      : h ? { state: "yes", count: h.count, ...(h.children ? { children: h.children } : {}), detail: h.names.join(" · ") } : { state: "no" };
    const ids = input.identities?.get(id);
    let identity: AzureRiskCombo["identity"];
    if (input.identities === null) identity = { state: "unknown", reason: "identitiesUnread" };
    else if (!ids?.principals.length) identity = { state: "no", detail: "no managed identity" };
    else if (input.roles === null) identity = { state: "unknown", reason: "rolesUnread" };
    else {
      const rs = ids.principals.flatMap((p) => rolesOf.get(lc(p)) ?? []);
      identity = rs.length
        ? { state: "yes", roles: rs.map((r) => ({ role: PRIVILEGED_ROLES[lc(r.roleDefGuid)]!, scope: scopeKind(r.scope) })).filter((r, i, l) => l.findIndex((x) => x.role === r.role && x.scope === r.scope) === i) }
        : { state: "no", detail: "no privileged role" };
    }
    if (exposure.state === "yes") exposed++;
    if (hi.state === "yes") high++;
    if (identity.state === "yes") privileged++;
    const yes = [exposure, hi, identity].map((f) => f.state === "yes");
    const n = yes.filter(Boolean).length;
    if (n < 2) {
      // one "yes" and a factor we could not tell → could be a combination: said, not dropped
      if (n === 1 && [exposure, hi, identity].some((f) => f.state === "unknown")) {
        undetermined++;
        const named = [["exposure", exposure], ["high", hi], ["identity", identity]] as const;
        if (pending.length < 50) pending.push({
          name: res.name, type: res.type, resourceGroup: res.resourceGroup,
          yes: named.filter(([, f]) => f.state === "yes").map(([k]) => k),
          unknown: named.filter(([, f]) => f.state === "unknown").map(([k, f]) => ({ factor: k, ...(f.reason ? { reason: f.reason } : {}) })),
        });
      }
      continue;
    }
    const kind = KIND[yes.map((b) => (b ? "1" : "0")).join("")]!;
    combos.push({
      key: azureRiskKey(res.resourceGroup, res.type, res.name), name: res.name, type: res.type, resourceGroup: res.resourceGroup,
      kind, sev: exposure.state === "yes" && exposure.limited ? LOWER[SEV[kind]] : SEV[kind], exposure, high: hi, identity,
      portalUrl: `https://portal.azure.com/#@/resource/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(res.resourceGroup)}/providers/${res.type}/${encodeURIComponent(res.name)}`,
      resourceId: id,
    });
  }
  const rank = { critical: 0, high: 1, medium: 2 } as const;
  combos.sort((a, b) => rank[a.sev] - rank[b.sev] || (b.high.count ?? 0) - (a.high.count ?? 0) || a.key.localeCompare(b.key));
  return { combos, counts: { exposed, high, privileged, combos: combos.length, undetermined }, undetermined: pending };
}

/**
 * Pure: attack paths — for every exposed entry, Internet → entry → its High findings → its managed identity's
 * privileged and data roles → this subscription's data stores inside each role's scope. Only evidence links:
 * a role must be the entry's own identity's, a data store must lie inside the role's scope (ARM id prefix), a data role
 * reaches its own service only. An exposed entry with neither a finding nor a role that reaches anything is not a path.
 */
export function attackPaths(input: CombosInput): AzureAttackPath[] {
  const byPrincipal = new Map<string, RoleIn[]>();
  for (const r of input.roles ?? []) (byPrincipal.get(lc(r.principalId)) ?? byPrincipal.set(lc(r.principalId), []).get(lc(r.principalId))!).push(r);
  const jewels = (input.jewels ?? []).map((j) => ({ ...j, kind: JEWEL_TYPES[lc(j.type)] })).filter((j): j is { id: string; name: string; type: string; kind: AzureJewelKind } => !!j.kind);
  const out: AzureAttackPath[] = [];
  for (const e of input.exposure ?? []) {
    if (e.state !== "yes") continue;
    const id = lc(e.id);
    const h = input.high?.get(id);
    const principals = input.identities?.get(id)?.principals ?? [];
    const identityUnknown = input.identities === null || (principals.length > 0 && input.roles === null);
    const roles: AzurePathRole[] = [];
    let otherRoles = 0;
    for (const p of principals) {
      for (const r of byPrincipal.get(lc(p)) ?? []) {
        const priv = PRIVILEGED_ROLES[lc(r.roleDefGuid)];
        const keys = KEY_ROLES[lc(r.roleDefGuid)];
        const data = DATA_ROLES[lc(r.roleDefGuid)] ?? (keys ? { svc: keys.svc, write: true } : undefined);
        if (!priv && !data) { otherRoles++; continue; }
        const inside = jewels.filter((j) => inScope(j.id, r.scope) && (!data || priv || j.kind === data.svc));
        const sk = scopeKind(r.scope);
        const scopeName = sk === "resourceGroup" || sk === "resource" ? r.scope.split("/").filter(Boolean).pop() : undefined;
        const role: AzurePathRole = {
          kind: priv ? "privileged" : "data", role: priv ?? data!.svc, ...(data && !priv ? { write: data.write } : {}), ...(keys && !priv ? { viaKeys: true } : {}), scope: sk,
          ...(scopeName ? { scopeName } : {}),
          reaches: JEWEL_ORDER.map((k) => { const l = inside.filter((j) => j.kind === k); return { kind: k, count: l.length, names: l.slice(0, 5).map((j) => j.name) }; }).filter((x) => x.count > 0),
        };
        if (!roles.some((x) => x.kind === role.kind && x.role === role.role && x.scope === role.scope && x.scopeName === role.scopeName && x.write === role.write && x.viaKeys === role.viaKeys)) roles.push(role);
      }
    }
    const reachesData = roles.some((r) => r.reaches.length > 0);
    const control = roles.some((r) => r.kind === "privileged");
    if (!h && !reachesData && !control && !identityUnknown) continue; // exposed only — a fact on its own, not a path
    const ends: AzureAttackPath["ends"] = reachesData ? "data" : control ? "control" : "entry";
    let sev: AzureAttackPath["sev"] = ends !== "entry" ? (h ? "critical" : "high") : "medium";
    if (e.limited) sev = sev === "critical" ? "high" : "medium";
    out.push({
      key: azureRiskKey(e.resourceGroup, e.type, e.name).replace(/^azure:/, "path:"),
      entry: { name: e.name, type: e.type, resourceGroup: e.resourceGroup, ...(e.detail ? { detail: e.detail } : {}), ...(e.limited ? { limited: true } : {}), resourceId: id },
      vuln: h ? { count: h.count, names: h.names } : null,
      roles, ends, sev, ...(identityUnknown ? { identityUnknown: true } : {}), identity: { principals: principals.length, otherRoles },
    });
  }
  const rank = { critical: 0, high: 1, medium: 2 } as const;
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || (a.ends === b.ends ? 0 : a.ends === "data" ? -1 : b.ends === "data" ? 1 : 0) || a.key.localeCompare(b.key));
}

/** Pure: High findings per top-level resource — a child entity's (image, container) count toward its parent */
export function rollUpHigh(rows: Array<{ rid: string; count: number; names?: string[] }>): NonNullable<CombosInput["high"]> {
  const out: NonNullable<CombosInput["high"]> = new Map();
  for (const r of rows) {
    const top = topLevelId(r.rid);
    const p = fromId(top.id);
    if (!p) continue;
    const cur = out.get(top.id) ?? { count: 0, names: [], children: 0, ...p };
    cur.count += Number(r.count) || 0;
    if (top.child) cur.children = (cur.children ?? 0) + 1;
    for (const n of r.names ?? []) if (cur.names.length < 3 && !cur.names.includes(n)) cur.names.push(n);
    out.set(top.id, cur);
  }
  for (const v of out.values()) if (!v.children) delete v.children;
  return out;
}

// ── Reading ──

const HIGH_Q = "securityresources | where type == 'microsoft.security/assessments' and properties.status.code == 'Unhealthy' and properties.metadata.severity == 'High'" +
  " | extend rid = tolower(tostring(properties.resourceDetails.Id)), dn = tostring(properties.displayName)" +
  " | where rid has '/providers/' | summarize count = count(), names = make_set(dn, 3) by rid";
const PUBLIC_Q = "resources | where isnotempty(properties.publicNetworkAccess) or isnotempty(properties.network.publicNetworkAccess) or type =~ 'microsoft.containerservice/managedclusters'" +
  " | project id = tolower(id), name, type = tolower(type), resourceGroup, properties | limit 3000";
const IDENTITY_Q = "resources | where isnotempty(identity) and (identity.type contains 'SystemAssigned' or identity.type contains 'UserAssigned')" +
  " | project id = tolower(id), name, type = tolower(type), resourceGroup, sp = tostring(identity.principalId), ua = bag_keys(identity.userAssignedIdentities) | limit 3000";
const JEWELS_Q = `resources | where type in~ (${Object.keys(JEWEL_TYPES).map((t) => `'${t}'`).join(",")}) | project id = tolower(id), name, type = tolower(type) | limit 3000`;
const UAMI_Q = "resources | where type =~ 'microsoft.managedidentity/userassignedidentities' | project id = tolower(id), principalId = tostring(properties.principalId)";
const ROLES_Q = (principals: string[]) => "authorizationresources | where type =~ 'microsoft.authorization/roleassignments'" +
  ` | extend p = tolower(tostring(properties.principalId)) | where p in (${principals.map((x) => `'${x.replace(/[^0-9a-f-]/gi, "")}'`).join(",")})` +
  " | project principalId = p, roleDefGuid = tolower(tostring(split(properties.roleDefinitionId, '/')[-1])), scope = tostring(properties.scope)";

const cache = new CacheManager<AzureRiskResponse>(30, 5 * 60_000);
/** Child-rule reads per request (ARM GET each) */
const CHILD_READS = 20;

export async function getAzureRiskCombos(env: Env, bearerToken: string, subscriptionId: string, deps?: { arm?: Pick<ArmFetcher, "postJson">; graphExposure?: () => Promise<ExposureIn[] | null> }): Promise<AzureRiskResponse> {
  const key = `${cachePrefix(bearerToken)}:azure-risk:${lc(subscriptionId)}`;
  const hit = deps ? undefined : cache.get(key);
  if (hit) return hit;
  const arm = deps?.arm ?? (await getArmFetcher(env, bearerToken));
  const subs = [subscriptionId];
  const gaps: AzureRiskResponse["gaps"] = [];
  const read = async <T>(section: AzureRiskResponse["gaps"][number]["section"], fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e: unknown) { gaps.push({ section, message: safeMessage(e) }); return null; }
  };
  const vmExpo = read("exposureVm", deps?.graphExposure ?? (async () => {
    const g = await tryGetArchitectureGraphFromAzure(env, bearerToken, { subscriptionId });
    if (!g) throw new Error("infrastructure graph not available");
    return g.nodes.filter((n) => n.kind === "vm" && n.azureId).map((n) => ({
      id: n.azureId!, name: n.name, type: "microsoft.compute/virtualmachines", resourceGroup: n.resourceGroup ?? "",
      ...vmExposure(n.metadata?.inboundExposure as InboundExposure | undefined),
    }));
  }));
  // One after another: the diagram already spends part of the caller's Resource Graph quota (15 per 5 s); six more at
  // once made stg's identity read fail with 429 — and every resource's identity "unknown"
  const vms = await vmExpo;
  const paas = await read("exposurePaas", () => query<{ id: string; name: string; type: string; resourceGroup: string; properties?: Props }>(arm, subs, PUBLIC_Q));
  const highRows = await read("findings", () => query<{ rid: string; count: number; names: string[] }>(arm, subs, HIGH_Q));
  const idRows = await read("identities", () => query<{ id: string; name: string; type: string; resourceGroup: string; sp?: string; ua?: string[] }>(arm, subs, IDENTITY_Q));
  const uamis = await read("identities", () => query<{ id: string; principalId: string }>(arm, subs, UAMI_Q));
  const jewels = await read("jewels", () => query<{ id: string; name: string; type: string }>(arm, subs, JEWELS_Q));
  const uamiPrincipal = new Map((uamis ?? []).map((u) => [lc(u.id), u.principalId]));
  const identities = idRows && uamis ? new Map(idRows.map((r) => [r.id, {
    name: r.name, type: r.type, resourceGroup: r.resourceGroup,
    principals: [...new Set([r.sp, ...(r.ua ?? []).map((u) => uamiPrincipal.get(lc(u)))].filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))],
  }])) : null;
  const principals = [...new Set([...(identities?.values() ?? [])].flatMap((i) => i.principals))];
  let roles: RoleIn[] | null = identities ? [] : null;
  if (identities && principals.length) {
    roles = await read("roles", async () => {
      const out: RoleIn[] = [];
      for (let i = 0; i < principals.length; i += 200) out.push(...await query<RoleIn>(arm, subs, ROLES_Q(principals.slice(i, i + 200))));
      return out;
    });
  }
  const high = highRows ? rollUpHigh(highRows) : null;
  const paasFacts = (paas ?? []).map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, ...paasExposureFactor(r.type, r.properties ?? {}) }));
  // Rules kept in child resources (PostgreSQL / MySQL / SQL firewall rules …): read them for the resources that matter —
  // those with a High finding or a managed identity (stg: 3 PostgreSQL servers were "can't tell" without this)
  const childOk = "fetchJson" in arm && typeof (arm as Partial<ArmFetcher>).fetchJson === "function";
  const needRules = paasFacts.filter((f) => f.reason === "childRules" && CHILD_RULES[f.type] && (high?.has(lc(f.id)) || identities?.has(lc(f.id)))).slice(0, CHILD_READS);
  if (childOk && needRules.length) {
    const fetcher = arm as Pick<ArmFetcher, "fetchJson">;
    for (let i = 0; i < needRules.length; i += 4) {
      await Promise.all(needRules.slice(i, i + 4).map(async (f) => {
        try {
          const raw = (paas ?? []).find((r) => r.id === f.id)?.properties ?? {};
          const pna = typeof raw.publicNetworkAccess === "string" ? raw.publicNetworkAccess : String(((raw.network ?? {}) as Props).publicNetworkAccess ?? "");
          const { network } = await readChildRules(fetcher as never, f.id, f.type);
          const v = rulesExposure(pna || null, network);
          if (v.state !== "unknown") { delete f.reason; Object.assign(f, v); }
        } catch { /* stays unknown: childRules */ }
      }));
    }
  }
  const exposure: ExposureIn[] | null = vms === null && paas === null ? null : [...(vms ?? []), ...paasFacts];
  const input: CombosInput = { exposure, high, identities, roles, exposureUnread: { vm: vms === null, paas: paas === null }, jewels };
  const judged = judgeCombos(input, subscriptionId);
  const paths = attackPaths(input);
  const out: AzureRiskResponse = {
    subscriptionId, generatedAt: new Date().toISOString(),
    combos: judged.combos, undetermined: judged.undetermined, paths, counts: { ...judged.counts, paths: paths.length }, gaps,
  };
  if (!gaps.length && !deps) cache.set(key, out);
  return out;
}
