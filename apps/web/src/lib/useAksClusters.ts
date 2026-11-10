"use client";

import type { KubernetesClustersResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";
import { sharedLoad, useScopeChoice } from "./scopeStore";

/**
 * AKS clusters (optionally scoped to a subscription) plus the selected one — shared by every screen and the scope bar
 * (lib/scopeStore). Until the user picks one, the first cluster is selected.
 */
export function useAksClusters(subscriptionId?: string) {
  const query = useApiQuery(`aks-clusters:${subscriptionId ?? ""}`, (token) =>
    sharedLoad(`aks-clusters|${subscriptionId ?? ""}|${token ? "user" : "anon"}`, () => fetchJsonWithBearer<KubernetesClustersResponse>(apiUrl("/api/kubernetes/clusters", { subscriptionId }), token)),
  );
  const clusters = query.data?.clusters ?? [];
  const [chosen, setClusterId] = useScopeChoice("cluster");
  const clusterId = chosen && clusters.some((c) => c.id === chosen) ? chosen : (clusters[0]?.id ?? chosen);

  return {
    clusters,
    clusterId,
    setClusterId,
    note: query.data?.note,
    loading: query.loading,
    error: query.error,
    reload: query.reload,
  };
}
