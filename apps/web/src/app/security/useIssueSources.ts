"use client";

// The issue list's sources (2026-11-19 — moved out of 통합 위험 so 노출 관리 counts the same queue with the same
// function): the selected cluster's insights · workload identity · advisories · watched questions, the subscription's
// Azure combinations · Defender alerts · team states, and the issue sightings (first / last seen — the SLA's start).
// Only responses of the current subscription and cluster are used — a previous selection's data never mixes in.

import { useEffect, useMemo, useState } from "react";
import type {
  AdvisoriesResponse, AzureRiskResponse, IssueSighting, IssueSightingsResponse, IssueState, IssueStatesResponse, IssueStatus,
  PolicyInsightsResponse, SavedQueriesResponse, WorkloadIdentityResponse,
} from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { buildIssueQueue, type IssueSource, type QueueItem } from "@/lib/issueQueue";
import { useAksClusters } from "@/lib/useAksClusters";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { useAzurePathTitle, useAzureTitle } from "./risk/AzureRiskPanel";
import type { SaveResult, SourceState } from "./risk/IssueQueue";
import { useSecurity } from "./SecurityContext";

// mockClusters (API fallback) use the all-zero subscription — never query insights for them
const MOCK_SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/";

export function useIssueSources() {
  const { locale } = useI18n();
  const { subscriptionId, posture, loading: postureLoading, ready } = useSecurity();
  const sub = subscriptionId || undefined;
  const { clusters, clusterId, setClusterId, loading: clustersLoading, error: clustersError } = useAksClusters(ready ? sub : undefined);
  const clustersMock = clusters.length > 0 && clusters.every((c) => c.id.toLowerCase().startsWith(MOCK_SUB));
  const insightsQ = useApiQuery(ready && clusterId && !clustersMock && !clustersLoading ? `k8s-policy-insights:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<PolicyInsightsResponse>(apiUrl("/api/kubernetes/policies/insights", { clusterId, lang: locale }), token),
  );
  const insights = !insightsQ.loading && insightsQ.data && insightsQ.data.clusterId.toLowerCase() === clusterId.toLowerCase() ? insightsQ.data : undefined;
  const freshPosture = postureLoading ? undefined : posture;
  const cluster = clusters.find((c) => c.id === clusterId);
  const sample = freshPosture?.source === "mock" || clustersMock;

  const live = ready && !!clusterId && !clustersMock && !clustersLoading;
  const wiQ = useApiQuery(live ? `k8s-wi:${clusterId}:${locale}:false` : null, (token) =>
    fetchJsonWithBearer<WorkloadIdentityResponse>(apiUrl("/api/kubernetes/policies/workload-identity", { clusterId, lang: locale }), token),
  );
  const azQ = useApiQuery(ready && !sample ? `azure-risk:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<AzureRiskResponse>(apiUrl("/api/security/azure-risk", { subscriptionId: sub }), token),
  );
  const azureRisk = !azQ.loading && azQ.data && (!sub || azQ.data.subscriptionId.toLowerCase() === sub.toLowerCase()) ? azQ.data : undefined;
  const azureTitle = useAzureTitle();
  const azurePathTitle = useAzurePathTitle();
  const advQ = useApiQuery(live ? `advisories:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<AdvisoriesResponse>(apiUrl("/api/security/advisories", { clusterId, lang: locale }), token),
  );
  const statesQ = useApiQuery(ready && !sample ? `issue-states:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<IssueStatesResponse>(apiUrl("/api/security/issue-states", { subscriptionId: sub }), token),
  );
  const queriesQ = useApiQuery(ready && !sample ? `saved-queries:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<SavedQueriesResponse>(apiUrl("/api/security/saved-queries", { subscriptionId: sub }), token),
  );
  const [saved, setSaved] = useState<Record<string, IssueState>>({});
  const getToken = useApiToken();
  const wi = !wiQ.loading && wiQ.data?.clusterId.toLowerCase() === clusterId.toLowerCase() ? wiQ.data : undefined;
  const adv = !advQ.loading && advQ.data?.clusterId?.toLowerCase() === clusterId.toLowerCase() ? advQ.data : undefined;
  const states = useMemo(() => ({ ...(statesQ.data?.states ?? {}), ...saved }), [statesQ.data, saved]);
  const queue = useMemo(() => buildIssueQueue({
    clusterId: cluster?.id ?? null, insights, wi, advisories: adv, queries: queriesQ.data?.queries ?? null,
    alerts: freshPosture && !freshPosture.gaps.some((g) => g.section === "alerts") ? freshPosture.alerts : null,
    alertsAt: freshPosture?.generatedAt ?? null, states, owners: statesQ.data?.owners ?? [], now: new Date(),
    azureRisk: azureRisk ?? null, azureTitle, azurePathTitle,
  }), [cluster, insights, wi, adv, queriesQ.data, freshPosture, states, statesQ.data?.owners, azureRisk, azureTitle, azurePathTitle]);
  const srcState = (loading: boolean, error: unknown, data: unknown, on: boolean): SourceState => (!on ? "off" : loading ? "loading" : error ? "failed" : data ? "ok" : "loading");
  const sources: Record<IssueSource, SourceState> = {
    combo: srcState(insightsQ.loading, insightsQ.error, insights, live),
    wi: srcState(wiQ.loading, wiQ.error, wi, live),
    vuln: srcState(advQ.loading, advQ.error, adv, live),
    // No watched question = nothing to read ("n/a"); otherwise it rests on the questions and the cluster insights
    query: !live ? "off" : queriesQ.loading ? "loading" : queriesQ.error ? "failed" : !queriesQ.data?.queries.some((q) => q.watch) ? "off"
      : srcState(insightsQ.loading, insightsQ.error, insights, true),
    alert: postureLoading ? "loading" : !freshPosture || freshPosture.gaps.some((g) => g.section === "alerts") ? "failed" : "ok",
    azure: sample || !ready ? "off" : azQ.loading ? "loading" : azQ.error ? "failed" : azureRisk ? (azureRisk.gaps.length ? "failed" : "ok") : "loading",
  };

  // Sightings: report the keys this queue computed (the server stamps first / last with its own clock) — once per key set
  const [sightings, setSightings] = useState<{ sub: string; map: Record<string, IssueSighting>; durable: boolean } | null>(null);
  const signedIn = statesQ.data?.signedIn ?? false;
  const reportKey = useMemo(() => queue.items.map((i) => `${i.key}=${i.sev}`).sort().join("\n"), [queue.items]);
  useEffect(() => {
    if (!sub || sample || !signedIn || !queue.items.length) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const token = await getToken().catch(() => null);
        const r = await fetchJsonWithBearer<IssueSightingsResponse>(apiUrl("/api/security/issue-sightings", { subscriptionId: sub }), token, {
          method: "POST", body: JSON.stringify({ items: queue.items.slice(0, 5000).map((i) => ({ key: i.key, sev: i.sev })) }),
        });
        if (!cancelled) setSightings({ sub, map: r.sightings, durable: r.durable });
      } catch { /* the SLA figures say "not known" */ }
    }, 1500); // the sources arrive one by one — report the settled list, not each step
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, sample, signedIn, reportKey]);

  const saveState = async (item: QueueItem, change: { status: IssueStatus; note?: string; assignee?: string; until?: string }): Promise<SaveResult> => {
    try {
      const token = await getToken().catch(() => null);
      const r = await fetchJsonWithBearer<{ state: IssueState }>(apiUrl("/api/security/issue-states", { subscriptionId: sub, key: item.key }), token,
        { method: "PUT", body: JSON.stringify({ ...change, baseRev: item.stored?.rev ?? null }) });
      setSaved((m) => ({ ...m, [item.key]: r.state }));
      return "ok";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone changed it since this page loaded — show theirs, the user decides again
        await statesQ.reload?.();
        setSaved((m) => { const n = { ...m }; delete n[item.key]; return n; });
        return "conflict";
      }
      return e instanceof ApiError && e.code ? e.code : "issue_state_write_failed";
    }
  };

  return {
    subscriptionId, sub, ready, freshPosture, postureLoading,
    clusters, clusterId, setClusterId, clustersLoading, clustersError, clustersMock, cluster,
    insightsQ, insights, azQ, azureRisk, statesQ, states, queue, sources, sample, saveState,
    sightings: sightings && sub && sightings.sub === sub ? sightings : null,
  };
}
