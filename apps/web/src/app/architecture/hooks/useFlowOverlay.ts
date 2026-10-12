"use client";

import type { ArchitectureFlowOverlayResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";

/**
 * Observed subnet-to-subnet traffic (NSG flow logs / Traffic Analytics) for the diagram's
 * "observed traffic" layer. Nothing is requested while the layer is off.
 */
export function useFlowOverlay(subscriptionId: string, enabled: boolean, lookbackMinutes: number) {
  const q = useApiQuery(enabled ? `flow:${subscriptionId}:${lookbackMinutes}` : null, (token) =>
    fetchJsonWithBearer<ArchitectureFlowOverlayResponse>(
      apiUrl("/api/architecture/flow-overlay", { subscriptionId: subscriptionId || undefined, lookbackMinutes, top: 30 }),
      token,
    ),
  );
  return { overlay: enabled ? q.data : undefined, error: enabled ? q.error : null, loading: enabled && q.loading };
}
