"use client";

// 보안 › 그래프 탐색 (docs/architecture/security-roadmap.md 5.3 ① — Wiz Security Graph Explorer): the cluster's
// workloads as a graph of facts — exposure, image vulnerabilities, runtime, RBAC, Azure identity and roles, network,
// the Azure resources they talk to — asked with conditions (AND), "unknown" kept apart. The same panel and the same pure
// model (lib/securityGraph.ts) as AKS 보안 점검 › 위험 개요 › 그래프 탐색: one implementation, reached from the security
// menu directly. Watched team questions feed the issue list; ?cluster=&q= opens a question.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PolicyInsightsResponse, WorkloadIdentityResponse } from "@aud/types";
import { EmptyState, ErrorNotice, LoadingState, PageHeader } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useAksClusters } from "@/lib/useAksClusters";
import { useApiQuery } from "@/lib/useApiQuery";
import { ExplorePanel } from "../../policies/insights/ExplorePanel";
import type { InsightsNav } from "../../policies/insights/model";

export default function SecurityExplorePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ExploreInner />
    </Suspense>
  );
}

function ExploreInner() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { clusters, clusterId, setClusterId, loading: clustersLoading, error: clustersError } = useAksClusters();
  // ?cluster=<ARM id> (from the issue list's watched questions) chooses the cluster once
  const [linkApplied, setLinkApplied] = useState(false);
  useEffect(() => {
    if (linkApplied || !clusters.length) return;
    setLinkApplied(true);
    const want = params.get("cluster");
    const c = want && clusters.find((x) => x.id.toLowerCase() === want.toLowerCase());
    if (c) setClusterId(c.id);
  }, [clusters, linkApplied, params, setClusterId]);

  // The same reads as AKS 보안 점검 (same API, same cache keys)
  const insightsQuery = useApiQuery(clusterId ? `k8s-policy-insights:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<PolicyInsightsResponse>(apiUrl("/api/kubernetes/policies/insights", { clusterId, lang: locale }), token),
  );
  const wiQuery = useApiQuery(clusterId ? `k8s-wi:${clusterId}:${locale}:false` : null, (token) =>
    fetchJsonWithBearer<WorkloadIdentityResponse>(apiUrl("/api/kubernetes/policies/workload-identity", { clusterId, lang: locale }), token),
  );
  const insights = insightsQuery.data?.clusterId === clusterId ? insightsQuery.data : undefined;
  const wi = wiQuery.data?.clusterId === clusterId ? wiQuery.data : undefined;

  // A workload, a network node or a risk combination opens where it is explained in full (AKS 보안 점검)
  const to = (q: Record<string, string>) => router.push(`/policies?${new URLSearchParams({ cluster: clusterId, ...q }).toString()}`);
  const nav: InsightsNav = {
    openHeatRow: (row) => to({ tab: "overview", row }),
    openNet: (net) => to({ tab: "network", net }),
    openIssue: (issue) => to({ tab: "overview", issue }),
  };

  return (
    <div>
      <PageHeader meta={insights ? <span>{t("ex.page.meta", { at: new Date(insights.generatedAt).toLocaleString(dateLocale(locale)), n: insights.rows.length })}</span> : undefined} />
      <ErrorNotice error={clustersError ?? insightsQuery.error} />
      {!clusterId && !clustersLoading ? <EmptyState title={t("ex.page.noCluster")}>{t("ex.page.noClusterHint")}</EmptyState>
        : !insights ? (insightsQuery.error ? null : <LoadingState label={t("ex.page.loading")} />)
        : <ExplorePanel key={clusterId} clusterId={clusterId} insights={insights} wi={wi ?? null} wiState={wi ? "ok" : wiQuery.error ? "failed" : "loading"} nav={nav} />}
    </div>
  );
}
