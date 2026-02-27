"use client";

import { useEffect, useState } from "react";
import type { DiagramSpec, DiagramSpecResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

export function useDiagramSpec(diagramId: string) {
  const getApiToken = useApiToken();
  const [spec, setSpec] = useState<DiagramSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSpec(null); // Clear stale spec immediately on diagram change
    setLoading(true);
    setError(null);

    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<DiagramSpecResponse>(
          `${apiBaseUrl()}/api/live/diagrams/${diagramId}`,
          token,
        ),
      )
      .then((resp) => {
        if (cancelled) return;
        setSpec(resp.diagram);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load diagram spec");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, getApiToken]);

  return { spec, error, loading };
}
