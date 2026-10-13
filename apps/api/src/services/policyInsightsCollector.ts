import type { HubbleFlowSet, PolicyInsightsResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { withLang, type Lang } from "../infra/lang.js";
import { debug } from "../infra/logger.js";
import { collectClusterPolicies, collectPolicyInventory } from "./k8sPolicyCollector.js";
import { getHubbleFlows } from "./hubbleClient.js";
import { getClusterContext, listAzureEndpoints, type ClusterContext } from "./azureEndpoints.js";
import { buildPolicyInsights } from "./policyInsights.js";

// ──────────────────────────────────────────────────────────────
// Policy insights collector
//
// Gathers the inputs of the pure insights builder. Each source fails on
// its own: a missing source empties its section and is listed in `gaps`.
// ──────────────────────────────────────────────────────────────

const insightsCache = new CacheManager<PolicyInsightsResponse>(10, 60_000);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function collectPolicyInsights(env: Env, bearerToken: string | undefined, clusterId: string, lang: Lang = "ko"): Promise<PolicyInsightsResponse> {
  const cacheKey = `${cachePrefix(bearerToken)}:policy-insights:${clusterId.toLowerCase()}:${lang}`;
  // Async code — pick texts directly (L() is only valid inside withLang)
  const tr = (ko: string, en: string) => (lang === "en" ? en : ko);
  const cached = insightsCache.get(cacheKey);
  if (cached) return cached;

  const gaps: string[] = [];
  const [inventory, policy] = await Promise.all([
    collectPolicyInventory(env, bearerToken, clusterId, lang),
    collectClusterPolicies(env, bearerToken, clusterId, lang),
  ]);
  gaps.push(...inventory.capabilities.unavailable.map((u) => `Kubernetes ${u}`));

  const [flowsR, azureR, ctxR] = await Promise.allSettled([
    env.HUBBLE_ENABLED
      ? getHubbleFlows(env, bearerToken, clusterId, { last: Math.min(env.HUBBLE_FLOW_LIMIT, 10_000), lang })
      : Promise.reject(new Error(tr("HUBBLE_ENABLED=false — 관측 트래픽 없이 구성·권한만 분석", "HUBBLE_ENABLED=false — configuration and permissions only, no observed traffic"))),
    listAzureEndpoints(env, bearerToken),
    getClusterContext(env, bearerToken, clusterId),
  ]);

  let flows: HubbleFlowSet | null = null;
  let flowsError: string | undefined;
  if (flowsR.status === "fulfilled") {
    flows = flowsR.value;
    if (flows.coverage.nodesObserved === 0) { flowsError = tr("Hubble agent에서 flow를 읽지 못했습니다", "No flows could be read from the Hubble agents"); flows = null; }
  } else {
    flowsError = msg(flowsR.reason);
  }
  if (flowsError) gaps.push(`Hubble: ${flowsError}`);

  const azure = azureR.status === "fulfilled"
    ? { available: true, endpoints: azureR.value.endpoints }
    : { available: false, endpoints: [] };
  if (azureR.status === "rejected") gaps.push(`${tr("Azure 리소스 매칭", "Azure resource matching")}: ${msg(azureR.reason)}`);

  let ctx: ClusterContext;
  if (ctxR.status === "fulfilled") {
    ctx = ctxR.value;
  } else {
    gaps.push(`${tr("AKS 설정(ARM)", "AKS settings (ARM)")}: ${msg(ctxR.reason)}`);
    const m = /\/resourcegroups\/([^/]+)\/.*\/managedclusters\/([^/]+)$/i.exec(clusterId);
    ctx = {
      apiServerIps: [],
      containment: {
        subscription: null,
        resourceGroup: m?.[1] ?? "",
        cluster: { name: m?.[2] ?? clusterId, location: "", k8sVersion: inventory.nodes?.[0]?.kubelet?.replace(/^v/, "") ?? "", nodes: inventory.nodes?.length ?? 0, privateCluster: null, authorizedIpRanges: null, localAccounts: null, entraIntegrated: null, azureRbac: null, outboundType: null },
        resources: [],
      },
    };
  }

  const result = withLang(lang, () => buildPolicyInsights({
    clusterId, inventory, policy, flows, flowsError,
    azure: { ...azure, apiServerIps: ctx.apiServerIps },
    containment: ctx.containment, gaps,
  }));
  debug(`[policy-insights] ${clusterId}: ${result.rows.length} rows, ${result.issues.length} issues, ${result.network.edges.length} edges, gaps ${gaps.length}`);
  insightsCache.set(cacheKey, result);
  return result;
}
