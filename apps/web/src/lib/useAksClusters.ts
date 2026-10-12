"use client";

import { useState } from "react";
import type { KubernetesClustersResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";

/**
 * AKS clusters (optionally scoped to a subscription) plus the selected one.
 * Until the user picks one, the first cluster is selected.
 */
export function useAksClusters(subscriptionId?: string) {
  const query = useApiQuery(`aks-clusters:${subscriptionId ?? ""}`, (token) =>
    fetchJsonWithBearer<KubernetesClustersResponse>(apiUrl("/api/kubernetes/clusters", { subscriptionId }), token),
  );
  const clusters = query.data?.clusters ?? [];
  const [chosen, setClusterId] = useState("");
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
