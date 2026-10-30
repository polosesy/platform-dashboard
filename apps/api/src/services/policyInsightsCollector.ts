import { HttpError } from "../infra/requestParams.js";
import type { HubbleFlowSet, PolicyInsightsResponse } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { withLang, type Lang } from "../infra/lang.js";
import { debug } from "../infra/logger.js";
import { collectClusterPolicies, collectPolicyInventory } from "./k8sPolicyCollector.js";
import { getHubbleFlows } from "./hubbleClient.js";
import { getClusterContext, listAzureEndpoints, type ClusterContext } from "./azureEndpoints.js";
import { buildPolicyInsights } from "./policyInsights.js";
import { getServiceTagIndex, type ServiceTagIndex } from "./azureServiceTags.js";
import { collectImageVulns } from "./imageVulns.js";

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

  const images = [...new Set(inventory.workloads.flatMap((w) => (w.security?.containers ?? []).map((c) => c.image)).filter((i): i is string => !!i))];
  const [flowsR, azureR, ctxR, vulnR] = await Promise.allSettled([
    env.HUBBLE_ENABLED
      ? getHubbleFlows(env, bearerToken, clusterId, { last: Math.min(env.HUBBLE_FLOW_LIMIT, 10_000), lang })
      : Promise.reject(new Error(tr("HUBBLE_ENABLED=false — 관측 트래픽 없이 구성·권한만 분석", "HUBBLE_ENABLED=false — configuration and permissions only, no observed traffic"))),
    listAzureEndpoints(env, bearerToken),
    getClusterContext(env, bearerToken, clusterId),
    // The entry point of attack paths: Defender scans + exact-version SBOM lookups of the running images
    collectImageVulns(env, bearerToken, clusterId, images),
  ]);
  const vulns = vulnR.status === "fulfilled" ? vulnR.value : null;
  if (vulnR.status === "rejected") gaps.push(`${tr("이미지 취약성", "Image vulnerabilities")}: ${msg(vulnR.reason)}`);
  else if (vulns && vulns.coverage.defender === "failed") gaps.push(tr("이미지 취약성: Defender 결과를 읽지 못함 — SBOM 결과만", "Image vulnerabilities: Defender findings could not be read — SBOM results only"));

  let flows: HubbleFlowSet | null = null;
  let flowsError: string | undefined;
  if (flowsR.status === "fulfilled") {
    flows = flowsR.value;
    if (flows.coverage.nodesObserved === 0) { flowsError = tr("Hubble agent에서 flow를 읽지 못했습니다", "No flows could be read from the Hubble agents"); flows = null; }
  } else if (flowsR.reason instanceof HttpError && flowsR.reason.code === "hubble_exec_disabled") {
    // Not a failure: this deployment does not exec into cilium agents and the cluster sends no flow logs — the code
    // lets the UI say "not collected" (how to get it) instead of "could not read"
    flowsError = `hubble_exec_disabled — ${tr("이 배포는 Hubble exec를 쓰지 않고 ACNS 흐름 로그도 없음", "this deployment does not use Hubble exec and the cluster sends no ACNS flow logs")}`;
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
      identity: { issuerUrl: null, oidcEnabled: null, wiEnabled: null },
      containment: {
        subscription: null,
        resourceGroup: m?.[1] ?? "",
        cluster: { name: m?.[2] ?? clusterId, location: "", k8sVersion: inventory.nodes?.[0]?.kubelet?.replace(/^v/, "") ?? "", nodes: inventory.nodes?.length ?? 0, privateCluster: null, authorizedIpRanges: null, localAccounts: null, entraIntegrated: null, azureRbac: null, outboundType: null },
        resources: [],
      },
    };
  }

  // Names for public IPs that match no resource: the official service tags of the cluster's region (only when there is traffic to name)
  let serviceTags: ServiceTagIndex | null | undefined;
  const sub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1];
  if (flows && sub && ctx.containment.cluster.location) {
    try {
      serviceTags = await getServiceTagIndex(env, bearerToken, sub, ctx.containment.cluster.location);
    } catch (e) {
      serviceTags = null;
      gaps.push(`${tr("Azure 서비스 태그", "Azure service tags")}: ${msg(e)}`);
    }
  }

  const result = withLang(lang, () => buildPolicyInsights({
    clusterId, inventory, policy, flows, flowsError,
    azure: { ...azure, apiServerIps: ctx.apiServerIps, serviceTags },
    containment: ctx.containment, gaps, vulns,
  }));
  debug(`[policy-insights] ${clusterId}: ${result.rows.length} rows, ${result.issues.length} issues, ${result.network.edges.length} edges, gaps ${gaps.length}`);
  insightsCache.set(cacheKey, result);
  return result;
}
