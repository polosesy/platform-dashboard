// Workload identity map — collection. Kubernetes: the policy inventory (pods carry SA name + webhook traces) and the
// ServiceAccount list (only azure.workload.identity/* annotations are kept). Azure (the connection's credential):
// Resource Graph for user-assigned identities by client ID and their role assignments (authorizationresources,
// scope filter AtScopeAboveAndBelow — PIM-eligible assignments are not included), ARM per identity for its federated
// credentials (api-version 2024-11-30; GET limit 0.5 rps per resource → cached 5 min). Every failure is a gap; the
// builder (services/workloadIdentity.ts) keeps unknowns unknown.

import * as k8s from "@kubernetes/client-node";
import type { WorkloadIdentityResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { kqlString, safeMessage } from "../infra/requestParams.js";
import { withLang, type Lang } from "../infra/lang.js";
import { k8sFailureReason, k8sStatusOf, withK8sRetry } from "../infra/k8sRetry.js";
import { loadKubeConfig } from "./kubernetes.js";
import { collectPolicyInventory } from "./k8sPolicyCollector.js";
import { getClusterContext, mapLimit } from "./azureEndpoints.js";
import {
  SCAN_CAP, WI_ANN, buildWorkloadIdentityMap, isGuid,
  type InvFicList, type InvIdentity, type InvRoleAssignment, type InvServiceAccount,
} from "./workloadIdentity.js";

const ARG = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01";
const FIC_API = "2024-11-30";
const MAX_CLIENT_IDS = 200;
const MAX_PRINCIPALS = 100;
const UAMI_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourcegroups\/[^/]+\/providers\/microsoft\.managedidentity\/userassignedidentities\/[^/]+$/i;

const responseCache = new CacheManager<WorkloadIdentityResponse>(10, 120_000);
const saCache = new CacheManager<InvServiceAccount[]>(10, 60_000);
const ficCache = new CacheManager<InvFicList>(200, 300_000);

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

  const [invR, ctxR, saR] = await Promise.allSettled([
    collectPolicyInventory(env, bearerToken, clusterId, lang),
    getClusterContext(env, bearerToken, clusterId),
    listServiceAccounts(env, bearerToken, clusterId),
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

  // Client IDs: SA annotations + what running pods carry (works without the SA list)
  const clientIds = [
    ...(serviceAccounts ?? []).map((s) => s.annotations[WI_ANN.clientId]),
    ...inventory.pods.map((p) => p.wi?.clientId),
  ].filter(isGuid).map((x) => x.trim().toLowerCase());

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
    clientIds.length
      ? argRows<IdRow>(uamiByClientIdQuery(clientIds)).then((rows) => {
        for (const r of rows) identities.push({ armId: r.id, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, location: r.location, clientId: r.clientId, principalId: r.principalId, tenantId: r.tenantId, scanned: "annotated" });
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
  const ficBad = [...fics.values()].filter((f) => f.status !== "ok");
  if (ficBad.length) gaps.push(tr(`페더레이션 자격 증명 목록 실패 ${ficBad.length}개 (${[...new Set(ficBad.map((f) => f.status))].join(", ")})`, `Federated credential lists failed: ${ficBad.length} (${[...new Set(ficBad.map((f) => f.status))].join(", ")})`));

  const out = withLang(lang, () => buildWorkloadIdentityMap({
    clusterId, inventory, serviceAccounts, saStatus, cluster, identities, identityLookup, fics,
    roleAssignments: roleAssignments ?? null, subNames, scan, gaps,
  }));
  responseCache.set(key, out);
  return out;
}
