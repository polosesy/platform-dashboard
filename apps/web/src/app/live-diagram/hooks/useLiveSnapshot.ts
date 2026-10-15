"use client";

import { useEffect, useState, useCallback } from "react";
import type { LiveDiagramSnapshot } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

export type UpdateMode = "polling" | "sse";

type SnapshotState = {
  /** `${diagramId}:${mode}` the state belongs to — anything else is stale. */
  key: string;
  snapshot: LiveDiagramSnapshot | null;
  error: string | null;
  connected: boolean;
};

const EMPTY = { snapshot: null, error: null, connected: false };

export function useLiveSnapshot(
  diagramId: string,
  mode: UpdateMode = "polling",
  intervalSec = 30,
) {
  const getApiToken = useApiToken();
  const key = `${diagramId}:${mode}`;
  const [state, setState] = useState<SnapshotState>({ key: "", ...EMPTY });

  const fetchSnapshot = useCallback(async () => {
    const token = await getApiToken().catch(() => null);
    return fetchJsonWithBearer<LiveDiagramSnapshot>(apiUrl("/api/live/snapshot", { diagramId }), token);
  }, [diagramId, getApiToken]);

  // Manual refresh
  const refresh = useCallback(async () => {
    try {
      const snapshot = await fetchSnapshot();
      setState({ key, snapshot, error: null, connected: true });
    } catch (e: unknown) {
      setState((s) => ({ ...(s.key === key ? s : { key, ...EMPTY }), error: e instanceof Error ? e.message : "Unknown error" }));
    }
  }, [fetchSnapshot, key]);

  useEffect(() => {
    if (!diagramId) return; // nothing chosen yet
    let cancelled = false;
    const update = (patch: Partial<Omit<SnapshotState, "key">>) => {
      if (cancelled) return;
      setState((s) => ({ ...(s.key === key ? s : { key, ...EMPTY }), ...patch }));
    };

    // A diagram generated from Azure belongs to the signed-in user: EventSource cannot carry the token, so it is
    // polled (the stream serves the public samples only)
    if (mode === "sse" && !diagramId.startsWith("auto-")) {
      // EventSource cannot send an Authorization header — the stream is served without the user's token
      const es = new EventSource(apiUrl("/api/live/stream", { diagramId }));
      es.onopen = () => update({ connected: true });
      es.onmessage = (e) => {
        try {
          update({ snapshot: JSON.parse(e.data) as LiveDiagramSnapshot, error: null, connected: true });
        } catch {
          /* ignore parse errors */
        }
      };
      es.onerror = () => update({ connected: false, error: "SSE connection lost, reconnecting..." });

      return () => {
        cancelled = true;
        es.close();
      };
    }

    // Polling mode
    const load = () =>
      fetchSnapshot().then(
        (snapshot) => update({ snapshot, error: null, connected: true }),
        (e: unknown) => update({ error: e instanceof Error ? e.message : "Unknown error", connected: false }),
      );

    void load();
    const timer = window.setInterval(load, intervalSec * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, diagramId, mode, intervalSec, fetchSnapshot]);

  const current = state.key === key ? state : { key, ...EMPTY };
  return { snapshot: current.snapshot, error: current.error, connected: current.connected, refresh };
}
