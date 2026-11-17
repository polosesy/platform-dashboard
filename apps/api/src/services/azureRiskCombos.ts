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

import type { AzureFactorState, AzureRiskCombo, AzureRiskResponse, InboundExposure } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { safeMessage } from "../infra/requestParams.js";
import { tryGetArchitectureGraphFromAzure } from "./azure.js";
import { networkRulesOf } from "./azureEndpoints.js";
import { paasExposure } from "./policyInsights.js";
import { query } from "./securityPosture.js";
import { PRIVILEGED_ROLES } from "./workloadIdentity.js";

type Props = Record<string, unknown>;
export type ExposureIn = { id: string; name: string; type: string; resourceGroup: string; state: AzureFactorState; detail?: string; reason?: string; limited?: boolean };
export type RoleIn = { principalId: string; roleDefGuid: string; scope: string };
export type CombosInput = {
  /** VM and PaaS exposure verdicts (resources not listed: exposure n/a) */
  exposure: ExposureIn[] | null;
  /** lower-case resource id → High unhealthy assessments (count + up to 3 names); null = not read */
  high: Map<string, { count: number; names: string[]; name: string; type: string; resourceGroup: string }> | null;
  /** lower-case resource id → its managed identity principals; null = not read */
  identities: Map<string, { principals: string[]; name: string; type: string; resourceGroup: string }> | null;
  /** role assignments of those principals; null = not read */
  roles: RoleIn[] | null;
  /** a part of the exposure read failed: VMs (the diagram) or PaaS (publicNetworkAccess) — missing ones are unknown, not n/a */
  exposureUnread?: { vm: boolean; paas: boolean };
};

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
export function paasExposureFactor(armType: string, p: Props): Pick<ExposureIn, "state" | "detail" | "reason" | "limited"> {
  const pna = typeof p.publicNetworkAccess === "string" ? p.publicNetworkAccess : typeof (p.network as Props | undefined)?.publicNetworkAccess === "string" ? String((p.network as Props).publicNetworkAccess) : null;
  if (pna === "Disabled") return { state: "no", detail: "publicNetworkAccess Disabled" };
  if (pna === null) return { state: "unknown", reason: "publicAccessUnset" };
  const rules = networkRulesOf(armType, p);
  if (!rules) return { state: "unknown", reason: "childRules" };
  const v = paasExposure(pna, rules);
  return v === "open" ? { state: "yes", detail: `publicNetworkAccess ${pna} · ${rules.noIpFirewall ? "no IP firewall" : `defaultAction ${rules.defaultAction ?? "?"}`}` }
    : v === "unknown" ? { state: "unknown", reason: "rulesUnknown" } : { state: "no", detail: v };
}

const KIND: Record<string, AzureRiskCombo["kind"]> = { "111": "exposedHighIdentity", "101": "exposedIdentity", "110": "exposedHigh", "011": "highIdentity" };
const SEV: Record<AzureRiskCombo["kind"], AzureRiskCombo["sev"]> = { exposedHighIdentity: "critical", exposedIdentity: "high", exposedHigh: "high", highIdentity: "medium" };
const LOWER: Record<AzureRiskCombo["sev"], AzureRiskCombo["sev"]> = { critical: "high", high: "medium", medium: "medium" };

/** Pure: the combinations — every resource with a factor "yes", judged on all three; two or more = a combination */
export function judgeCombos(input: CombosInput, subscriptionId: string): Pick<AzureRiskResponse, "combos" | "counts"> {
  type Res = { name: string; type: string; resourceGroup: string };
  const all = new Map<string, Res>();
  const expo = new Map((input.exposure ?? []).map((e) => [lc(e.id), e]));
  for (const [id, e] of expo) all.set(id, e);
  for (const [id, h] of input.high ?? []) if (!all.has(id)) all.set(id, h);
  for (const [id, i] of input.identities ?? []) if (!all.has(id)) all.set(id, i);
  const rolesOf = new Map<string, RoleIn[]>();
  for (const r of input.roles ?? []) if (PRIVILEGED_ROLES[lc(r.roleDefGuid)]) (rolesOf.get(lc(r.principalId)) ?? rolesOf.set(lc(r.principalId), []).get(lc(r.principalId))!).push(r);

  const combos: AzureRiskCombo[] = [];
  let exposed = 0, high = 0, privileged = 0, undetermined = 0;
  for (const [id, res] of all) {
    const e = expo.get(id);
    const isVm = res.type === "microsoft.compute/virtualmachines";
    const unread = input.exposure === null || (isVm ? input.exposureUnread?.vm : input.exposureUnread?.paas);
    const exposure: AzureRiskCombo["exposure"] = e ? { state: e.state, ...(e.limited ? { limited: true } : {}), ...(e.detail ? { detail: e.detail } : {}), ...(e.reason ? { reason: e.reason } : {}) }
      : unread ? { state: "unknown", reason: "exposureUnread" } : { state: "na" };
    const h = input.high?.get(id);
    const hi: AzureRiskCombo["high"] = input.high === null ? { state: "unknown", reason: "findingsUnread" }
      : h ? { state: "yes", count: h.count, detail: h.names.join(" · ") } : { state: "no" };
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
      if (n === 1 && [exposure, hi, identity].some((f) => f.state === "unknown")) undetermined++;
      continue;
    }
    const kind = KIND[yes.map((b) => (b ? "1" : "0")).join("")]!;
    combos.push({
      key: azureRiskKey(res.resourceGroup, res.type, res.name), name: res.name, type: res.type, resourceGroup: res.resourceGroup,
      kind, sev: exposure.state === "yes" && exposure.limited ? LOWER[SEV[kind]] : SEV[kind], exposure, high: hi, identity,
      portalUrl: `https://portal.azure.com/#@/resource/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(res.resourceGroup)}/providers/${res.type}/${encodeURIComponent(res.name)}`,
    });
  }
  const rank = { critical: 0, high: 1, medium: 2 } as const;
  combos.sort((a, b) => rank[a.sev] - rank[b.sev] || (b.high.count ?? 0) - (a.high.count ?? 0) || a.key.localeCompare(b.key));
  return { combos, counts: { exposed, high, privileged, combos: combos.length, undetermined } };
}

// ── Reading ──

const HIGH_Q = "securityresources | where type == 'microsoft.security/assessments' and properties.status.code == 'Unhealthy' and properties.metadata.severity == 'High'" +
  " | extend rid = tolower(tostring(properties.resourceDetails.Id)), dn = tostring(properties.displayName)" +
  " | where rid has '/providers/' | summarize count = count(), names = make_set(dn, 3) by rid";
const PUBLIC_Q = "resources | where isnotempty(properties.publicNetworkAccess) or isnotempty(properties.network.publicNetworkAccess)" +
  " | project id = tolower(id), name, type = tolower(type), resourceGroup, properties | limit 3000";
const IDENTITY_Q = "resources | where isnotempty(identity) and (identity.type contains 'SystemAssigned' or identity.type contains 'UserAssigned')" +
  " | project id = tolower(id), name, type = tolower(type), resourceGroup, sp = tostring(identity.principalId), ua = bag_keys(identity.userAssignedIdentities) | limit 3000";
const UAMI_Q = "resources | where type =~ 'microsoft.managedidentity/userassignedidentities' | project id = tolower(id), principalId = tostring(properties.principalId)";
const ROLES_Q = (principals: string[]) => "authorizationresources | where type =~ 'microsoft.authorization/roleassignments'" +
  ` | extend p = tolower(tostring(properties.principalId)) | where p in (${principals.map((x) => `'${x.replace(/[^0-9a-f-]/gi, "")}'`).join(",")})` +
  " | project principalId = p, roleDefGuid = tolower(tostring(split(properties.roleDefinitionId, '/')[-1])), scope = tostring(properties.scope)";

const cache = new CacheManager<AzureRiskResponse>(30, 5 * 60_000);

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
  const [vms, paas, highRows, idRows, uamis] = await Promise.all([
    vmExpo,
    read("exposurePaas", () => query<{ id: string; name: string; type: string; resourceGroup: string; properties?: Props }>(arm, subs, PUBLIC_Q)),
    read("findings", () => query<{ rid: string; count: number; names: string[] }>(arm, subs, HIGH_Q)),
    read("identities", () => query<{ id: string; name: string; type: string; resourceGroup: string; sp?: string; ua?: string[] }>(arm, subs, IDENTITY_Q)),
    read("identities", () => query<{ id: string; principalId: string }>(arm, subs, UAMI_Q)),
  ]);
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
  const high = highRows ? new Map(highRows.flatMap((r) => { const p = fromId(r.rid); return p ? [[r.rid, { count: Number(r.count) || 0, names: r.names ?? [], ...p }] as const] : []; })) : null;
  const exposure: ExposureIn[] | null = vms === null && paas === null ? null : [
    ...(vms ?? []),
    ...(paas ?? []).map((r) => ({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, ...paasExposureFactor(r.type, r.properties ?? {}) })),
  ];
  const out: AzureRiskResponse = {
    subscriptionId, generatedAt: new Date().toISOString(),
    ...judgeCombos({ exposure, high, identities, roles, exposureUnread: { vm: vms === null, paas: paas === null } }, subscriptionId), gaps,
  };
  if (!gaps.length && !deps) cache.set(key, out);
  return out;
}
