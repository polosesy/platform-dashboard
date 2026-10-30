// Workload identity map — collection. Kubernetes: the policy inventory (pods carry SA name + webhook traces) and the
// ServiceAccount list (only azure.workload.identity/* annotations are kept). Azure (the connection's credential):
// Resource Graph for user-assigned identities by client ID and their role assignments (authorizationresources,
// scope filter AtScopeAboveAndBelow — PIM-eligible assignments are not included), ARM per identity for its federated
// credentials (api-version 2024-11-30; GET limit 0.5 rps per resource → cached 5 min). The IMDS path: the cluster's
// networkProfile.podLinkLocalAccess and add-ons (preview api-version — the GA versions don't return it) and the node
// pool scale sets' user-assigned identities (Resource Graph, node resource group). Every failure is a gap; the
// builder (services/workloadIdentity.ts) keeps unknowns unknown.

import * as k8s from "@kubernetes/client-node";
import type { WiRoleUsage, WorkloadIdentityResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto, getLogAnalyticsFetcherAuto, tableToObjects, type LogAnalyticsResponse } from "../infra/azureClientFactory.js";
import { kqlString, safeMessage } from "../infra/requestParams.js";
import { withLang, type Lang } from "../infra/lang.js";
import { k8sFailureReason, k8sStatusOf, withK8sRetry } from "../infra/k8sRetry.js";
import { loadKubeConfig } from "./kubernetes.js";
import { collectPolicyInventory } from "./k8sPolicyCollector.js";
import { getClusterContext, mapLimit, type ClusterContext } from "./azureEndpoints.js";
import {
  DATA_ROLES, SCAN_CAP, USAGE_DAYS, WI_ANN, buildWorkloadIdentityMap, isGuid, roleUsageQuery, usageKey, usageVerdict,
  type InvFicList, type InvIdentity, type InvNodePool, type InvRoleAssignment, type InvServiceAccount, type WiInput,
} from "./workloadIdentity.js";

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01";
const FIC_API = "2024-11-30";
/** networkProfile.podLinkLocalAccess is only in preview api-versions (2025-10-01 GA returns nothing) */
const AKS_PREVIEW_API = "2025-10-02-preview";
const MAX_CLIENT_IDS = 200;
const MAX_PRINCIPALS = 100;
const UAMI_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourcegroups\/[^/]+\/providers\/microsoft\.managedidentity\/userassignedidentities\/[^/]+$/i;

const responseCache = new CacheManager<WorkloadIdentityResponse>(10, 120_000);
const saCache = new CacheManager<InvServiceAccount[]>(10, 60_000);
const ficCache = new CacheManager<InvFicList>(200, 300_000);
const imdsCache = new CacheManager<NodeImds>(10, 300_000);
/** (caller, scope, service, ids) → access-log rows, 10 minutes */
const usageCache = new CacheManager<Array<Record<string, unknown>>>(200, 600_000);

/**
 * Granted vs used (WI-18): for each data-plane role assignment (DATA_ROLES), the resource's own access log at the
 * assignment's scope — a resource-centric Log Analytics query (the logs wherever that scope sends them), last 30 days,
 * one query per (scope, service) for every identity holding a role there. A failed or empty read is "unknown", never
 * "unused". Management-group scopes are not queryable this way (unknown).
 */
export async function collectRoleUsage(
  env: Env, bearerToken: string | undefined,
  identities: Array<{ principalId: string; clientId: string }>, assignments: InvRoleAssignment[],
): Promise<Map<string, WiRoleUsage>> {
  const out = new Map<string, WiRoleUsage>();
  const idsOf = new Map(identities.map((i) => [i.principalId.toLowerCase(), [i.principalId, i.clientId].filter(isGuid)]));
  type Group = { scope: string; svc: "keyVault" | "storage"; ras: InvRoleAssignment[]; ids: Set<string> };
  const groups = new Map<string, Group>();
  for (const r of assignments) {
    const def = DATA_ROLES[r.roleDefGuid.toLowerCase()];
    if (!def) continue;
    if (!/^\/subscriptions\/[0-9a-f-]{36}(\/|$)/i.test(r.scope)) {
      out.set(usageKey(r.principalId, r.roleDefGuid, r.scope), { state: "unknown", source: def.svc, days: USAGE_DAYS, reason: "notCovered" });
      continue;
    }
    const k = `${r.scope.toLowerCase()}|${def.svc}`;
    const g = groups.get(k) ?? { scope: r.scope, svc: def.svc, ras: [], ids: new Set<string>() };
    g.ras.push(r);
    for (const id of idsOf.get(r.principalId.toLowerCase()) ?? [r.principalId]) g.ids.add(id.toLowerCase());
    groups.set(k, g);
  }
  if (!groups.size) return out;
  const la = await getLogAnalyticsFetcherAuto(env, bearerToken);
  await mapLimit([...groups.values()], 4, async (g) => {
    const ids = [...g.ids].sort();
    const ck = `${cachePrefix(bearerToken)}:ra-usage:${g.scope.toLowerCase()}:${g.svc}:${ids.join(",")}`;
    let rows = usageCache.get(ck);
    let reason: WiRoleUsage["reason"] | undefined;
    if (!rows) {
      try {
        const res = await la.queryResource(g.scope, roleUsageQuery(g.svc, ids), `P${USAGE_DAYS}D`) as LogAnalyticsResponse;
        rows = res.tables?.[0] ? tableToObjects(res.tables[0]) : [];
        usageCache.set(ck, rows);
      } catch (e) {
        const m = safeMessage(e);
        // Every table of the union missing = this scope sends no such log anywhere we can read
        reason = /resolve|SEM0100|could not be found|not.*exist/i.test(m) ? "noLogs" : / 40[13]\b/.test(m) ? "noAccess" : "failed";
      }
    }
    for (const r of g.ras) {
      const mine = idsOf.get(r.principalId.toLowerCase()) ?? [r.principalId];
      out.set(usageKey(r.principalId, r.roleDefGuid, r.scope), rows ? usageVerdict(rows, mine, g.svc) : { state: "unknown", source: g.svc, days: USAGE_DAYS, reason: reason ?? "failed" });
    }
  });
  return out;
}

type ArgRows<T> = { data?: T[] };

/** KQL that finds user-assigned identities by client ID (GUIDs only, capped) */
export function uamiByClientIdQuery(clientIds: string[]): string {
  const ids = [...new Set(clientIds.filter(isGuid).map((x) => x.toLowerCase()))].slice(0, MAX_CLIENT_IDS);
  return `resources
| where type =~ 'microsoft.managedidentity/userassignedidentities'
| where tostring(properties.clientId) in~ (${ids.map(kqlString).join(", ") || '""'})
| project id, name, resourceGroup, subscriptionId, location, clientId = tostring(properties.clientId), principalId = tostring(properties.principalId), tenantId = tostring(properties.tenantId)`;
}

/** Role assignments of the principals, joined to role definitions by the definition GUID (scope-format independent) */
export function roleAssignmentsQuery(principalIds: string[]): string {
  const ids = [...new Set(principalIds.filter(isGuid).map((x) => x.toLowerCase()))].slice(0, MAX_PRINCIPALS);
  return `authorizationresources
| where type =~ 'microsoft.authorization/roleassignments'
| extend principalId = tolower(tostring(properties.principalId))
| where principalId in (${ids.map(kqlString).join(", ") || '""'})
| extend rdGuid = tolower(extract("([0-9a-fA-F-]{36})$", 1, tostring(properties.roleDefinitionId))), scope = tostring(properties.scope), hasCondition = isnotempty(tostring(properties.condition))
| join kind=leftouter (
    authorizationresources
    | where type =~ 'microsoft.authorization/roledefinitions'
    | extend rdGuid = tolower(extract("([0-9a-fA-F-]{36})$", 1, id)), roleName = tostring(properties.roleName), roleType = tostring(properties.type), actions = properties.permissions[0].actions
    | project rdGuid, roleName, roleType, actions
  ) on rdGuid
| project principalId, rdGuid, roleName, roleType, scope, hasCondition, actions
| take 1000`;
}

/**
 * Add-ons that the IMDS restriction (preview) doesn't support (Learn: imds-restriction "Limitations") — by the cluster
 * property that turns them on. Cluster extensions (Flux, Dapr …) aren't read.
 */
export const IMDS_BLOCKING_ADDONS: Record<string, string> = {
  ingressApplicationGateway: "Application Gateway Ingress Controller",
  omsagent: "Container Insights",
  aciConnectorLinux: "Virtual nodes",
  azurepolicy: "Azure Policy",
  httpApplicationRouting: "HTTP application routing",
};

type PreviewCluster = {
  properties?: {
    nodeResourceGroup?: string;
    networkProfile?: { podLinkLocalAccess?: string };
    addonProfiles?: Record<string, { enabled?: boolean }>;
    ingressProfile?: { webAppRouting?: { enabled?: boolean } };
    metricsProfile?: { costAnalysis?: { enabled?: boolean } };
  };
};

/** Cluster IMDS facts from the preview api-version (pure) */
export function imdsFacts(mc: PreviewCluster): { podAccess: "allowed" | "restricted" | null; restrictionBlockedBy: string[]; nodeResourceGroup: string | null } {
  const p = mc.properties ?? {};
  const v = p.networkProfile?.podLinkLocalAccess;
  const blocked = Object.entries(p.addonProfiles ?? {}).filter(([k, a]) => a?.enabled && IMDS_BLOCKING_ADDONS[k]).map(([k]) => IMDS_BLOCKING_ADDONS[k]!);
  if (p.ingressProfile?.webAppRouting?.enabled) blocked.push("Application routing");
  if (p.metricsProfile?.costAnalysis?.enabled) blocked.push("Azure cost analysis");
  return {
    podAccess: v === "IMDS" ? "allowed" : v === "None" ? "restricted" : null,
    restrictionBlockedBy: [...new Set(blocked)].sort(),
    nodeResourceGroup: p.nodeResourceGroup ?? null,
  };
}

/** Node pool scale sets and their user-assigned identities (one subscription, the node resource group) */
export function nodePoolIdentitiesQuery(nodeResourceGroup: string): string {
  return `resources
| where type =~ 'microsoft.compute/virtualmachinescalesets' and resourceGroup =~ ${kqlString(nodeResourceGroup)}
| project name, pool = tostring(tags['aks-managed-poolName']), ids = identity.userAssignedIdentities`;
}

type VmssRow = { name: string; pool?: string; ids?: Record<string, { clientId?: string; principalId?: string }> | null };
type NodeImds = NonNullable<WiInput["imds"]> & {
  nodePools: InvNodePool[] | null;
  attached: Array<{ armId: string; clientId: string; principalId: string }>;
  /** The preview GET failed or timed out — pod access stays unknown, the scale sets are still read */
  previewError?: string;
};

/** Scale set rows → pools (tag, else the AKS name pattern aks-<pool>-<n>-vmss) and the identities attached (pure) */
export function nodePoolsFromRows(rows: VmssRow[]): { nodePools: InvNodePool[]; attached: NodeImds["attached"] } {
  const attached = new Map<string, NodeImds["attached"][number]>();
  const nodePools = rows.map((r): InvNodePool => {
    const pool = r.pool || /^aks-([a-z0-9]+)-\d+-vmss$/i.exec(r.name)?.[1] || r.name;
    const ids = Object.entries(r.ids ?? {}).filter(([armId]) => UAMI_ID.test(armId));
    for (const [armId, v] of ids) if (isGuid(v?.clientId) && isGuid(v?.principalId)) attached.set(armId.toLowerCase(), { armId, clientId: v.clientId!, principalId: v.principalId! });
    return { pool, identityArmIds: ids.map(([armId]) => armId) };
  });
  return { nodePools, attached: [...attached.values()] };
}

/**
 * The preview GET only adds pod access and add-ons: the node resource group also comes from the GA cluster context,
 * so a slow or failing preview call (seen once at 20 s) leaves "pods → IMDS ?" but still shows the scale sets.
 */
async function collectNodeImds(env: Env, bearerToken: string | undefined, clusterId: string, ctx: Promise<ClusterContext>): Promise<NodeImds> {
  const key = `${cachePrefix(bearerToken)}:wi-imds:${clusterId.toLowerCase()}`;
  const hit = imdsCache.get(key);
  if (hit) return hit;
  const arm = await getArmFetcherAuto(env, bearerToken);
  const [mcR, ctxR] = await Promise.allSettled([
    arm.fetchJson<PreviewCluster>(`https://management.azure.com${clusterId}?api-version=${AKS_PREVIEW_API}`, { timeoutMs: 20_000 }),
    ctx,
  ]);
  const facts = mcR.status === "fulfilled" ? imdsFacts(mcR.value) : { podAccess: null, restrictionBlockedBy: [], nodeResourceGroup: null };
  const nodeResourceGroup = facts.nodeResourceGroup ?? (ctxR.status === "fulfilled" ? ctxR.value.identity.nodeResourceGroup ?? null : null);
  const sub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1];
  let out: NodeImds = {
    ...facts, nodeResourceGroup, pools: "notRead", nodePools: null, attached: [],
    ...(mcR.status === "rejected" ? { previewError: safeMessage(mcR.reason) } : {}),
  };
  if (nodeResourceGroup && sub) {
    try {
      const r = await arm.postJson<ArgRows<VmssRow>>(ARG, { query: nodePoolIdentitiesQuery(nodeResourceGroup), subscriptions: [sub], options: { resultFormat: "objectArray", $top: 100 } }, { timeoutMs: 20_000 });
      // Resource Graph returns nothing (not an error) for a resource group the identity can't read
      out = { ...out, pools: "ok", ...nodePoolsFromRows(r.data ?? []) };
    } catch (e) {
      out = { ...out, pools: / 403\b|AuthorizationFailed/i.test(safeMessage(e)) ? "forbidden" : "error" };
    }
  }
  // A failed read is retried on the next open, not remembered for 5 minutes
  if (!out.previewError && out.pools === "ok") imdsCache.set(key, out);
  return out;
}

async function listServiceAccounts(env: Env, bearerToken: string | undefined, clusterId: string): Promise<InvServiceAccount[]> {
  const key = `${cachePrefix(bearerToken)}:wi-sa:${clusterId.toLowerCase()}`;
  const hit = saCache.get(key);
  if (hit) return hit;
  const kc = await loadKubeConfig(env, bearerToken, clusterId);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const r = await withK8sRetry(() => core.listServiceAccountForAllNamespaces());
  const keep = new Set<string>(Object.values(WI_ANN));
  const out = (r.items ?? []).map((s): InvServiceAccount => ({
    namespace: s.metadata?.namespace ?? "",
    name: s.metadata?.name ?? "",
    // Only the workload identity annotations — never last-applied configuration or anything else
    annotations: Object.fromEntries(Object.entries(s.metadata?.annotations ?? {}).filter(([k]) => keep.has(k))),
    labels: s.metadata?.labels ?? {},
  }));
  saCache.set(key, out);
  return out;
}

async function listFics(env: Env, bearerToken: string | undefined, armId: string): Promise<InvFicList> {
  const key = `${cachePrefix(bearerToken)}:wi-fic:${armId.toLowerCase()}`;
  const hit = ficCache.get(key);
  if (hit) return hit;
  if (!UAMI_ID.test(armId)) return { status: "error", items: [] };
  const arm = await getArmFetcherAuto(env, bearerToken);
  type Page = { value?: Array<{ name?: string; properties?: { issuer?: string; subject?: string; audiences?: string[] } }>; nextLink?: string };
  try {
    const items: InvFicList["items"] = [];
    let url: string | undefined = `https://management.azure.com${armId}/federatedIdentityCredentials?api-version=${FIC_API}`;
    for (let page = 0; url && page < 2; page++) {
      const r: Page = await arm.fetchJson<Page>(url, { timeoutMs: 10_000 });
      for (const v of r.value ?? []) items.push({ name: v.name ?? "", issuer: v.properties?.issuer ?? "", subject: v.properties?.subject ?? "", audiences: v.properties?.audiences ?? [] });
      url = r.nextLink && new URL(r.nextLink).hostname === "management.azure.com" ? r.nextLink : undefined;
    }
    const out: InvFicList = { status: "ok", items };
    ficCache.set(key, out);
    return out;
  } catch (e) {
    const m = safeMessage(e);
    return { status: / 403\b|AuthorizationFailed/i.test(m) ? "forbidden" : / 429\b|Throttl/i.test(m) ? "throttled" : "error", items: [] };
  }
}

export async function collectWorkloadIdentity(
  env: Env, bearerToken: string | undefined, clusterId: string, lang: Lang, opts: { scan: boolean },
): Promise<WorkloadIdentityResponse> {
  const key = `${cachePrefix(bearerToken)}:wi:${clusterId.toLowerCase()}:${lang}:${opts.scan ? 1 : 0}`;
  const hit = responseCache.get(key);
  if (hit) return hit;
  const tr = (ko: string, en: string) => (lang === "en" ? en : ko);
  const gaps: string[] = [];

  const ctxP = getClusterContext(env, bearerToken, clusterId);
  const [invR, ctxR, saR, imdsR] = await Promise.allSettled([
    collectPolicyInventory(env, bearerToken, clusterId, lang),
    ctxP,
    listServiceAccounts(env, bearerToken, clusterId),
    collectNodeImds(env, bearerToken, clusterId, ctxP),
  ]);
  if (invR.status === "rejected") throw invR.reason;
  const inventory = invR.value;
  const cluster = ctxR.status === "fulfilled" ? ctxR.value.identity : { issuerUrl: null, oidcEnabled: null, wiEnabled: null };
  if (ctxR.status === "rejected") gaps.push(`${tr("AKS 설정(ARM)", "AKS settings (ARM)")}: ${safeMessage(ctxR.reason)}`);
  let saStatus: "ok" | "forbidden" | "error" = "ok";
  if (saR.status === "rejected") {
    saStatus = k8sStatusOf(saR.reason) === 403 ? "forbidden" : "error";
    gaps.push(`${tr("Kubernetes ServiceAccount 목록", "Kubernetes ServiceAccount list")} (${k8sFailureReason(saR.reason)})`);
  }
  const serviceAccounts = saR.status === "fulfilled" ? saR.value : null;
  const nodeImds = imdsR.status === "fulfilled" ? imdsR.value : null;
  if (imdsR.status === "rejected") gaps.push(`${tr("노드 풀 관리 ID(IMDS 경로)", "Node pool identities (IMDS path)")}: ${safeMessage(imdsR.reason)}`);
  if (nodeImds?.previewError) gaps.push(`${tr("파드의 IMDS 접근 설정(ARM 미리 보기 API)", "Pod IMDS access setting (ARM preview API)")}: ${nodeImds.previewError}`);
  if (nodeImds && nodeImds.pools !== "ok") gaps.push(tr(`노드 풀 VMSS의 관리 ID 목록 (${nodeImds.pools}) — 노드 리소스 그룹 Reader 필요`, `Node pool scale set identities (${nodeImds.pools}) — needs Reader on the node resource group`));

  // Client IDs: SA annotations + what running pods carry (works without the SA list)
  const clientIds = [
    ...(serviceAccounts ?? []).map((s) => s.annotations[WI_ANN.clientId]),
    ...inventory.pods.map((p) => p.wi?.clientId),
  ].filter(isGuid).map((x) => x.trim().toLowerCase());
  const nodeClientIds = (nodeImds?.attached ?? []).map((a) => a.clientId.toLowerCase());

  const arm = await getArmFetcherAuto(env, bearerToken);
  type IdRow = { id: string; name: string; resourceGroup: string; subscriptionId: string; location: string; clientId: string; principalId: string; tenantId: string };
  let identityLookup: "ok" | "failed" = "ok";
  const identities: InvIdentity[] = [];
  const subNames = new Map<string, string>();
  const clusterSub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1]?.toLowerCase();
  const clusterRg = /\/resourcegroups\/([^/]+)\//i.exec(clusterId)?.[1] ?? "";
  const scan = { requested: opts.scan, scanned: 0, total: null as number | null, cap: SCAN_CAP };

  const argRows = async <T>(query: string, extra: Record<string, unknown> = {}): Promise<T[]> =>
    (await arm.postJson<ArgRows<T>>(ARG, { query, options: { resultFormat: "objectArray", $top: 1000 }, ...extra }, { timeoutMs: 20_000 })).data ?? [];

  await Promise.all([
    clientIds.length || nodeClientIds.length
      ? argRows<IdRow>(uamiByClientIdQuery([...clientIds, ...nodeClientIds])).then((rows) => {
        for (const r of rows) identities.push({ armId: r.id, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, location: r.location, clientId: r.clientId, principalId: r.principalId, tenantId: r.tenantId, scanned: clientIds.includes(r.clientId.toLowerCase()) ? "annotated" : "nodePool" });
      }).catch((e) => { identityLookup = "failed"; gaps.push(`${tr("관리 ID 조회(Resource Graph)", "Managed identity lookup (Resource Graph)")}: ${safeMessage(e)}`); })
      : Promise.resolve(),
    argRows<{ subscriptionId: string; name: string }>("resourcecontainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name")
      .then((rows) => { for (const r of rows) subNames.set(r.subscriptionId.toLowerCase(), r.name); })
      .catch(() => undefined),
    // Optional: other identities of the cluster's subscription (finds credentials trusting this cluster with no SA)
    opts.scan && clusterSub
      ? Promise.all([
        argRows<IdRow>(`resources | where type =~ 'microsoft.managedidentity/userassignedidentities'
| extend sameRg = resourceGroup =~ ${kqlString(clusterRg)}
| order by sameRg desc, name asc
| take ${SCAN_CAP}
| project id, name, resourceGroup, subscriptionId, location, clientId = tostring(properties.clientId), principalId = tostring(properties.principalId), tenantId = tostring(properties.tenantId)`, { subscriptions: [clusterSub] }),
        argRows<{ n: number }>("resources | where type =~ 'microsoft.managedidentity/userassignedidentities' | summarize n = count()", { subscriptions: [clusterSub] }),
      ]).then(([rows, total]) => {
        scan.total = total[0]?.n ?? null;
        for (const r of rows) {
          scan.scanned++;
          if (!identities.some((i) => i.armId.toLowerCase() === r.id.toLowerCase()))
            identities.push({ armId: r.id, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, location: r.location, clientId: r.clientId, principalId: r.principalId, tenantId: r.tenantId, scanned: "subscriptionScan" });
        }
      }).catch((e) => { gaps.push(`${tr("구독 관리 ID 검사", "Subscription identity scan")}: ${safeMessage(e)}`); })
      : Promise.resolve(),
  ]);
  // An identity found by the scan as well as by annotation counts as annotated
  for (const i of identities) if (i.scanned === "subscriptionScan" && clientIds.includes(i.clientId.toLowerCase())) i.scanned = "annotated";
  // Attached to a node pool but not readable by client ID (identity in a resource group we can't read): the scale set
  // still tells its ARM ID, client and principal — enough for its role assignments
  for (const a of nodeImds?.attached ?? []) {
    if (identities.some((i) => i.armId.toLowerCase() === a.armId.toLowerCase())) continue;
    const m = /^\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)\/.+\/([^/]+)$/i.exec(a.armId);
    identities.push({ armId: a.armId, name: m?.[3] ?? "", resourceGroup: m?.[2] ?? "", subscriptionId: m?.[1] ?? "", location: "", clientId: a.clientId, principalId: a.principalId, tenantId: "", scanned: clientIds.includes(a.clientId.toLowerCase()) ? "annotated" : "nodePool" });
  }

  const fics = new Map<string, InvFicList>();
  const roleQ = identities.length
    ? argRows<{ principalId: string; rdGuid: string; roleName?: string; roleType?: string; scope: string; hasCondition: boolean; actions?: string[] }>(
      roleAssignmentsQuery(identities.map((i) => i.principalId)),
      { options: { resultFormat: "objectArray", $top: 1000, authorizationScopeFilter: "AtScopeAboveAndBelow" } },
    ).then((rows) => rows.map((r): InvRoleAssignment => ({
      principalId: r.principalId, roleDefGuid: r.rdGuid ?? "", roleName: r.roleName || null, roleType: r.roleType || null,
      scope: r.scope, hasCondition: !!r.hasCondition, actions: Array.isArray(r.actions) ? r.actions : [],
    }))).catch((e) => { gaps.push(`${tr("역할 할당(Resource Graph)", "Role assignments (Resource Graph)")}: ${safeMessage(e)}`); return null; })
    : Promise.resolve([] as InvRoleAssignment[]);
  const [, roleAssignments] = await Promise.all([
    mapLimit(identities, 4, async (i) => { fics.set(i.armId.toLowerCase(), await listFics(env, bearerToken, i.armId)); }),
    roleQ,
  ]);
  // Granted vs used — after the role assignments are known; a failure only leaves usage "unknown"
  const roleUsage = roleAssignments
    ? await collectRoleUsage(env, bearerToken, identities, roleAssignments).catch((e) => {
      gaps.push(`${tr("권한 사용 기록(Log Analytics)", "Permission usage (Log Analytics)")}: ${safeMessage(e)}`);
      return null;
    })
    : null;
  const ficBad = [...fics.values()].filter((f) => f.status !== "ok");
  if (ficBad.length) gaps.push(tr(`페더레이션 자격 증명 목록 실패 ${ficBad.length}개 (${[...new Set(ficBad.map((f) => f.status))].join(", ")})`, `Federated credential lists failed: ${ficBad.length} (${[...new Set(ficBad.map((f) => f.status))].join(", ")})`));

  const out = withLang(lang, () => buildWorkloadIdentityMap({
    clusterId, inventory, serviceAccounts, saStatus, cluster, identities, identityLookup, fics,
    roleAssignments: roleAssignments ?? null, roleUsage, subNames, scan, gaps,
    nodePools: nodeImds?.nodePools ?? null,
    imds: nodeImds
      ? { podAccess: nodeImds.podAccess, restrictionBlockedBy: nodeImds.restrictionBlockedBy, pools: nodeImds.pools, nodeResourceGroup: nodeImds.nodeResourceGroup }
      : { podAccess: null, restrictionBlockedBy: [], pools: "notRead", nodeResourceGroup: null },
  }));
  responseCache.set(key, out);
  return out;
}
