// 노출 관리 (CTEM) — the Azure half of Wiz's Exposure Management dashboard (docs/architecture/security-roadmap.md 6절).
// Scoping (what is covered), Discovery (what Defender found), Defender's own contextual risk, and the mitigating
// controls in place — each number one Resource Graph query (`EXPOSURE_Q`, sent back in `queries`), counted here by a
// pure function. Prioritization, validation and remediation come from the issue list on the page (same function).
//
// Counting rules:
//   assets     resources of the class's ARM types; an application endpoint = a public IP bound to an ipConfiguration
//              (inbound-capable — a NAT gateway's egress IPs are not endpoints), an Azure Front Door endpoint, an App
//              Service site, a Container App or an API Management service (an Application Gateway counts by its IP)
//   covered    a Defender plan covers it: the resource-level plan if one exists (it overrides), else the subscription's;
//              tier Standard. A class no plan covers (Redis, Front Door endpoints) has covered = null for that part
//   findings   Unhealthy assessments (a resource once per recommendation) — per-package vulnerability assessments
//              (`additionalData.CvesDetails`) split by where they are (registry image · running container · host), the
//              rest by Defender category; resources = distinct `resourceDetails.Id` (exact — counted from rows, no dcount)
//   secrets    assessments about secret findings (Defender CSPM agentless secret scanning) — 0 is real only where
//              Defender CSPM is on (note: someSubscriptions / noPlan)
//   endOfLife  Defender software inventory rows whose endOfSupportStatus is set (not None) — no inventory = null
//   threats    active Defender alerts

import type { ExposureAsset, ExposureAssetClass, ExposureControl, ExposureControlId, ExposureFinding, ExposureFindingClass, ExposureResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { query, safeMessage } from "./securityPosture.js";

const lc = (s: string) => s.toLowerCase();

/** ARM type → asset class and the Defender plan that covers it (null = none) */
export const ASSET_TYPES: Record<string, { cls: ExposureAssetClass; plan: string | null }> = {
  "microsoft.containerservice/managedclusters": { cls: "kubernetesClusters", plan: "Containers" },
  "microsoft.compute/virtualmachines": { cls: "virtualMachines", plan: "VirtualMachines" },
  "microsoft.compute/virtualmachinescalesets": { cls: "virtualMachines", plan: "VirtualMachines" },
  "microsoft.containerregistry/registries": { cls: "containerRegistries", plan: "Containers" },
  "microsoft.storage/storageaccounts": { cls: "dataStores", plan: "StorageAccounts" },
  "microsoft.dbforpostgresql/flexibleservers": { cls: "dataStores", plan: "OpenSourceRelationalDatabases" },
  "microsoft.dbformysql/flexibleservers": { cls: "dataStores", plan: "OpenSourceRelationalDatabases" },
  "microsoft.sql/servers": { cls: "dataStores", plan: "SqlServers" },
  "microsoft.documentdb/databaseaccounts": { cls: "dataStores", plan: "CosmosDbs" },
  "microsoft.documentdb/mongoclusters": { cls: "dataStores", plan: null },
  "microsoft.cache/redis": { cls: "dataStores", plan: null },
  "microsoft.cache/redisenterprise": { cls: "dataStores", plan: null },
  "microsoft.keyvault/vaults": { cls: "keyVaults", plan: "KeyVaults" },
  "microsoft.managedidentity/userassignedidentities": { cls: "identities", plan: "CloudPosture" },
  "microsoft.network/publicipaddresses": { cls: "applicationEndpoints", plan: null },
  "microsoft.cdn/profiles/afdendpoints": { cls: "applicationEndpoints", plan: null },
  "microsoft.web/sites": { cls: "applicationEndpoints", plan: "AppServices" },
  "microsoft.app/containerapps": { cls: "applicationEndpoints", plan: null },
  "microsoft.apimanagement/service": { cls: "applicationEndpoints", plan: "Api" },
  "microsoft.cognitiveservices/accounts": { cls: "aiWorkloads", plan: "AI" },
  "microsoft.machinelearningservices/workspaces": { cls: "aiWorkloads", plan: "AI" },
  "microsoft.search/searchservices": { cls: "aiWorkloads", plan: "AI" },
  "microsoft.hybridcompute/machines": { cls: "onPremServers", plan: "VirtualMachines" },
};
export const ASSET_ORDER: ExposureAssetClass[] = ["subscriptions", "kubernetesClusters", "virtualMachines", "containerRegistries", "dataStores", "keyVaults", "identities", "applicationEndpoints", "aiWorkloads", "onPremServers"];
export const FINDING_ORDER: ExposureFindingClass[] = ["vulnImages", "vulnContainers", "vulnHosts", "cloudConfig", "containerConfig", "identity", "secrets", "endOfLife", "threats"];
export const CONTROL_ORDER: ExposureControlId[] = ["wafPrevention", "wafDetection", "appGatewayNoWaf", "azureFirewalls", "ddosPlans", "aksPolicyAddon", "aksDefenderSensor", "storageDenyByDefault", "keyVaultPrivate"];

const UNHEALTHY = "securityresources | where type == 'microsoft.security/assessments' and tostring(properties.status.code) == 'Unhealthy'";
const FINDING_BASE = `${UNHEALTHY}` +
  " | extend rt = tolower(tostring(properties.resourceDetails.ResourceType)), cv = isnotempty(tostring(properties.additionalData.CvesDetails)), cat = tostring(properties.metadata.categories), dn = tolower(tostring(properties.displayName))" +
  " | extend cls = case(cv and rt == '.containerimage', 'vulnImages', cv and rt == 'k8s-container', 'vulnContainers', cv, 'vulnHosts', dn has 'secrets findings' or dn has 'secret findings', 'secrets', cat has 'IdentityAndAccess', 'identity', rt == 'k8s-container' or cat has 'Container', 'containerConfig', 'cloudConfig')";
export const EXPOSURE_Q = {
  subscriptions: "resourcecontainers | where type == 'microsoft.resources/subscriptions' | project sub = tolower(subscriptionId)",
  assets: `resources | where type in~ (${Object.keys(ASSET_TYPES).map((t) => `'${t}'`).join(", ")})` +
    " | where not(type =~ 'microsoft.network/publicipaddresses') or isnotempty(properties.ipConfiguration)" +
    " | project id = tolower(id), type = tolower(type), sub = tolower(subscriptionId)",
  plans: "securityresources | where type == 'microsoft.security/pricings' | project id = tolower(id), name = tostring(name), tier = tostring(properties.pricingTier)",
  findings: `${FINDING_BASE} | summarize n = count() by cls, sev = tostring(properties.metadata.severity)`,
  /** distinct resources per class — exact: one row per (class, resource) first, then counted */
  findingResources: `${FINDING_BASE} | summarize by cls, rid = tolower(tostring(properties.resourceDetails.Id)) | summarize r = count() by cls`,
  risk: `${UNHEALTHY} | where isnotempty(tostring(properties.risk.level)) | summarize n = count() by level = tostring(properties.risk.level)`,
  inventory: "securityresources | where type == 'microsoft.security/softwareinventories'" +
    " | summarize n = count() by eos = tostring(properties.endOfSupportStatus), vm = tolower(tostring(split(tolower(id), '/providers/microsoft.security/')[0]))",
  alerts: "securityresources | where type == 'microsoft.security/locations/alerts' and tostring(properties.Status) == 'Active' | summarize n = count() by sev = tostring(properties.Severity)",
  controls: "resources | where type in~ ('microsoft.network/frontdoorwebapplicationfirewallpolicies', 'microsoft.network/applicationgatewaywebapplicationfirewallpolicies', 'microsoft.network/applicationgateways', 'microsoft.network/azurefirewalls', 'microsoft.network/ddosprotectionplans', 'microsoft.containerservice/managedclusters', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults')" +
    " | extend t = tolower(type), p = properties" +
    " | extend on = tostring(p.policySettings.enabledState) =~ 'Enabled' or tostring(p.policySettings.state) =~ 'Enabled', mode = tostring(p.policySettings.mode)" +
    " | extend c = case(t endswith 'webapplicationfirewallpolicies' and on and mode =~ 'Prevention', 'wafPrevention', t endswith 'webapplicationfirewallpolicies' and on and mode =~ 'Detection', 'wafDetection', t endswith 'webapplicationfirewallpolicies', 'wafOff'," +
    " t == 'microsoft.network/applicationgateways' and (not(tostring(p.sku.tier) startswith 'WAF') or (isempty(tostring(p.firewallPolicy.id)) and tobool(p.webApplicationFirewallConfiguration.enabled) != true)), 'appGateway:noWaf', t == 'microsoft.network/applicationgateways', 'appGateway:waf'," +
    " t == 'microsoft.network/azurefirewalls', 'azureFirewalls', t == 'microsoft.network/ddosprotectionplans', 'ddosPlans'," +
    " t == 'microsoft.containerservice/managedclusters', strcat('aks:', iff(tobool(p.addonProfiles.azurepolicy.enabled), 'p', '-'), iff(tobool(p.securityProfile.defender.securityMonitoring.enabled), 'd', '-'))," +
    " t == 'microsoft.storage/storageaccounts', iff(tostring(p.publicNetworkAccess) =~ 'Disabled' or tostring(p.networkAcls.defaultAction) =~ 'Deny', 'storage:deny', 'storage:open')," +
    " iff(tostring(p.publicNetworkAccess) =~ 'Disabled' or tostring(p.networkAcls.defaultAction) =~ 'Deny', 'kv:deny', 'kv:open'))" +
    " | summarize n = count() by c",
} as const;

export type ExposureRaw = {
  subscriptions: Array<{ sub: string }> | null;
  assets: Array<{ id: string; type: string; sub: string }> | null;
  plans: Array<{ id: string; name: string; tier: string }> | null;
  findings: Array<{ cls: string; sev: string; n: number }> | null;
  findingResources: Array<{ cls: string; r: number }> | null;
  risk: Array<{ level: string; n: number }> | null;
  inventory: Array<{ eos: string; vm: string; n: number }> | null;
  alerts: Array<{ sev: string; n: number }> | null;
  controls: Array<{ c: string; n: number }> | null;
};

const PLAN_ID = /^\/subscriptions\/([^/]+)\/providers\/microsoft\.security\/pricings\/([^/]+)$/;
const RES_PLAN_ID = /^(\/subscriptions\/.+)\/providers\/microsoft\.security\/pricings\/([^/]+)$/;

/** Is a plan Standard for this resource: the resource-level plan wins over the subscription's */
export function planCovers(plans: NonNullable<ExposureRaw["plans"]>): (resourceId: string, sub: string, plan: string) => boolean {
  const subPlan = new Map<string, boolean>(), resPlan = new Map<string, boolean>();
  for (const p of plans) {
    const id = lc(p.id), on = lc(p.tier) === "standard";
    const s = PLAN_ID.exec(id);
    if (s) { subPlan.set(`${s[1]}|${lc(s[2]!)}`, on); continue; }
    const r = RES_PLAN_ID.exec(id);
    if (r) resPlan.set(`${r[1]}|${lc(r[2]!)}`, on);
  }
  return (resourceId, sub, plan) => {
    const k = lc(plan);
    const own = resPlan.get(`${lc(resourceId)}|${k}`);
    return own ?? subPlan.get(`${lc(sub)}|${k}`) ?? false;
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Pure: raw rows → the response's numbers */
export function aggregateExposure(raw: ExposureRaw): Pick<ExposureResponse, "assets" | "findings" | "defenderRisk" | "controls"> {
  const covers = raw.plans ? planCovers(raw.plans) : null;
  const subs = raw.subscriptions?.map((s) => s.sub) ?? [];
  const assets: ExposureAsset[] = ASSET_ORDER.map((id) => {
    if (id === "subscriptions") {
      return { id, total: raw.subscriptions ? subs.length : null, covered: covers && raw.subscriptions ? subs.filter((s) => covers(`/subscriptions/${s}`, s, "CloudPosture")).length : null, coverable: raw.subscriptions ? subs.length : null, plans: ["CloudPosture"] };
    }
    const types = Object.entries(ASSET_TYPES).filter(([, v]) => v.cls === id);
    const plans = [...new Set(types.map(([, v]) => v.plan).filter((p): p is string => !!p))];
    if (!raw.assets) return { id, total: null, covered: null, coverable: null, plans };
    const rows = raw.assets.filter((a) => ASSET_TYPES[lc(a.type)]?.cls === id);
    const withPlan = rows.filter((a) => !!ASSET_TYPES[lc(a.type)]!.plan);
    const covered = !plans.length || !covers ? null : withPlan.filter((a) => covers(a.id, a.sub, ASSET_TYPES[lc(a.type)]!.plan!)).length;
    return { id, total: rows.length, covered, coverable: plans.length ? withPlan.length : null, plans };
  });

  const cspmSubs = covers ? subs.filter((s) => covers(`/subscriptions/${s}`, s, "CloudPosture")).length : null;
  const findings: ExposureFinding[] = FINDING_ORDER.map((id) => {
    if (id === "endOfLife") {
      if (!raw.inventory) return { id, count: null, resources: null };
      if (!raw.inventory.length) return { id, count: null, resources: null, note: "noInventory" };
      const eol = raw.inventory.filter((r) => r.eos && lc(r.eos) !== "none");
      return { id, count: sum(eol.map((r) => r.n)), resources: new Set(eol.map((r) => r.vm)).size };
    }
    if (id === "threats") {
      if (!raw.alerts) return { id, count: null, resources: null };
      return { id, count: sum(raw.alerts.map((r) => r.n)), resources: null, bySeverity: Object.fromEntries(raw.alerts.map((r) => [r.sev, r.n])) };
    }
    if (!raw.findings) return { id, count: null, resources: null };
    const rows = raw.findings.filter((r) => r.cls === id);
    const bySeverity: Record<string, number> = {};
    for (const r of rows) bySeverity[r.sev || "Unknown"] = (bySeverity[r.sev || "Unknown"] ?? 0) + r.n;
    const resources = raw.findingResources ? raw.findingResources.find((r) => r.cls === id)?.r ?? 0 : null;
    const f: ExposureFinding = { id, count: sum(rows.map((r) => r.n)), resources, bySeverity };
    if (id === "secrets" && cspmSubs !== null) {
      if (cspmSubs === 0) return { id, count: null, resources: null, note: "noPlan" };
      if (cspmSubs < subs.length) f.note = "someSubscriptions";
    }
    return f;
  });

  const defenderRisk = raw.risk ? {
    high: sum(raw.risk.filter((r) => lc(r.level) === "high").map((r) => r.n)),
    medium: sum(raw.risk.filter((r) => lc(r.level) === "medium").map((r) => r.n)),
    low: sum(raw.risk.filter((r) => lc(r.level) === "low").map((r) => r.n)),
  } : null;

  const c = raw.controls;
  const n = (...keys: string[]) => (c ? sum(c.filter((r) => keys.includes(r.c)).map((r) => r.n)) : null);
  const aks = (flag: "p" | "d") => (c ? sum(c.filter((r) => r.c.startsWith("aks:") && r.c.slice(4).includes(flag)).map((r) => r.n)) : null);
  const aksAll = c ? sum(c.filter((r) => r.c.startsWith("aks:")).map((r) => r.n)) : null;
  const controls: ExposureControl[] = [
    { id: "wafPrevention", count: n("wafPrevention"), of: n("wafPrevention", "wafDetection", "wafOff") },
    { id: "wafDetection", count: n("wafDetection") },
    { id: "appGatewayNoWaf", count: n("appGateway:noWaf"), of: n("appGateway:noWaf", "appGateway:waf") },
    { id: "azureFirewalls", count: n("azureFirewalls") },
    { id: "ddosPlans", count: n("ddosPlans") },
    { id: "aksPolicyAddon", count: aks("p"), of: aksAll },
    { id: "aksDefenderSensor", count: aks("d"), of: aksAll },
    { id: "storageDenyByDefault", count: n("storage:deny"), of: n("storage:deny", "storage:open") },
    { id: "keyVaultPrivate", count: n("kv:deny"), of: n("kv:deny", "kv:open") },
  ];
  return { assets, findings, defenderRisk, controls };
}

const cache = new CacheManager<ExposureResponse>(30, 5 * 60_000);

/** Read the sections one after another (the caller's Resource Graph quota is shared — 15 per 5 s) — each fails alone */
export async function getExposure(env: Env, bearerToken: string, subscriptionIds: string[], deps?: { arm?: Pick<ArmFetcher, "postJson"> }): Promise<ExposureResponse> {
  const subs = [...new Set(subscriptionIds.map(lc))].sort();
  const key = `${cachePrefix(bearerToken)}:exposure:${subs.join(",")}`;
  const hit = deps ? undefined : cache.get(key);
  if (hit) return hit;
  const arm = deps?.arm ?? (await getArmFetcher(env, bearerToken));
  const gaps: ExposureResponse["gaps"] = [];
  const read = async <T>(section: ExposureResponse["gaps"][number]["section"], q: string): Promise<T[] | null> => {
    try { return await query<T>(arm, subs, q); } catch (e: unknown) { gaps.push({ section, message: safeMessage(e) }); return null; }
  };
  const raw: ExposureRaw = {
    subscriptions: await read("assets", EXPOSURE_Q.subscriptions),
    assets: await read("assets", EXPOSURE_Q.assets),
    plans: await read("plans", EXPOSURE_Q.plans),
    findings: await read("findings", EXPOSURE_Q.findings),
    findingResources: await read("findings", EXPOSURE_Q.findingResources),
    risk: await read("findings", EXPOSURE_Q.risk),
    inventory: await read("inventory", EXPOSURE_Q.inventory),
    alerts: await read("alerts", EXPOSURE_Q.alerts),
    controls: await read("controls", EXPOSURE_Q.controls),
  };
  if (raw.assets && raw.assets.length >= 10_000) gaps.push({ section: "assets", message: "truncated at 10,000 resources" });
  const out: ExposureResponse = {
    subscriptionIds: subs, generatedAt: new Date().toISOString(),
    ...aggregateExposure(raw),
    notConnected: ["codeRepositories", "workstations", "saas", "penTests"],
    queries: { ...EXPOSURE_Q },
    gaps,
  };
  if (!gaps.length && !deps) cache.set(key, out);
  return out;
}
