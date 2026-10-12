"use client";

import type { DiagramSpecResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";

export function useDiagramSpec(diagramId: string) {
  const { data, error, loading } = useApiQuery(
    `diagram-spec:${diagramId}`,
    (token) => fetchJsonWithBearer<DiagramSpecResponse>(apiUrl(`/api/live/diagrams/${encodeURIComponent(diagramId)}`), token),
    { tokenOptional: true },
  );
  // Never show a previous diagram's spec while the new one loads
  const spec = data?.diagram?.id === diagramId ? data.diagram : null;
  return { spec, error, loading };
}
