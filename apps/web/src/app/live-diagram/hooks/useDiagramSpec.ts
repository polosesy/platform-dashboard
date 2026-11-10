"use client";

import type { DiagramSpecResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { diagramLoadKey } from "@/lib/liveRestore";

/** Empty `diagramId` = nothing chosen yet: no request, no spec.
 * `rev` = which load of this id (lib/liveRestore): a new generate keeps the id but must not read the last load's 404 */
export function useDiagramSpec(diagramId: string, rev = 0) {
  const loadKey = diagramLoadKey(diagramId, rev);
  const { data, error, loading } = useApiQuery(
    loadKey ? `diagram-spec:${loadKey}` : null,
    (token) => fetchJsonWithBearer<DiagramSpecResponse>(apiUrl(`/api/live/diagrams/${encodeURIComponent(diagramId)}`), token),
    { tokenOptional: true },
  );
  // Never show a previous diagram's spec while the new one loads
  const spec = data?.diagram?.id === diagramId ? data.diagram : null;
  return { spec, error, loading };
}
