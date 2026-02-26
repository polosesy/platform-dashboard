"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { LiveDiagramSnapshot } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

type UpdateMode = "polling" | "sse";

export function useLiveSnapshot(
  diagramId: string,
  mode: UpdateMode = "polling",
  intervalSec = 30,
) {
  const getApiToken = useApiToken();
  const [snapshot, setSnapshot] = useState<LiveDiagramSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Manual refresh
  const refresh = useCallback(async () => {
    try {
      const token = await getApiToken();
      const data = await fetchJsonWithBearer<LiveDiagramSnapshot>(
        `${apiBaseUrl()}/api/live/snapshot?diagramId=${diagramId}`,
        token,
      );
      setSnapshot(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [diagramId, getApiToken]);

  useEffect(() => {
    let cancelled = false;

    if (mode === "sse") {
      const es = new EventSource(
        `${apiBaseUrl()}/api/live/stream?diagramId=${diagramId}`,
      );
      eventSourceRef.current = es;
      setConnected(true);

      es.onmessage = (e) => {
        if (cancelled) return;
        try {
          setSnapshot(JSON.parse(e.data));
          setError(null);
        } catch {
          /* ignore parse errors */
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        setError("SSE connection lost, reconnecting...");
      };

      return () => {
        cancelled = true;
        es.close();
        setConnected(false);
      };
    }

    // Polling mode
    setConnected(true);
    const load = async () => {
      if (cancelled) return;
      try {
        const token = await getApiToken();
        const data = await fetchJsonWithBearer<LiveDiagramSnapshot>(
          `${apiBaseUrl()}/api/live/snapshot?diagramId=${diagramId}`,
          token,
        );
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      }
    };

    load();
    const timer = window.setInterval(load, intervalSec * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      setConnected(false);
    };
  }, [diagramId, mode, intervalSec, getApiToken]);

  return { snapshot, error, connected, refresh };
}
