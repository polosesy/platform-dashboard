"use client";

import { useEffect, useMemo, useState } from "react";
import { MarkerType, type Edge as FlowEdge } from "reactflow";
import type { ArchitectureFlowOverlayResponse, ArchitectureFlowEdgeMetric } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

export type PlaybackItem = {
  edgeId: string;
  metric: ArchitectureFlowEdgeMetric;
};

async function loadFlowOverlay(
  bearerToken: string | null,
  subscriptionId: string | undefined,
  lookbackMinutes: number,
  top: number
): Promise<ArchitectureFlowOverlayResponse> {
  const url = new URL(`${apiBaseUrl()}/api/architecture/flow-overlay`);
  if (subscriptionId) url.searchParams.set("subscriptionId", subscriptionId);
  url.searchParams.set("lookbackMinutes", String(lookbackMinutes));
  url.searchParams.set("top", String(top));
  return await fetchJsonWithBearer<ArchitectureFlowOverlayResponse>(url.toString(), bearerToken);
}

export function useFlowOverlay(subscriptionId: string) {
  const getApiToken = useApiToken();
  const [flowEnabled, setFlowEnabled] = useState(true);
  const [flowStage, setFlowStage] = useState<1 | 2>(1);
  const [flowLookbackMinutes, setFlowLookbackMinutes] = useState(60);
  const [flowTop, setFlowTop] = useState(30);
  const [flowOverlay, setFlowOverlay] = useState<ArchitectureFlowOverlayResponse | null>(null);
  const [playbackEdgeId, setPlaybackEdgeId] = useState<string | null>(null);
  const [playbackIndex, setPlaybackIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!flowEnabled) {
      setFlowOverlay(null);
      return;
    }
    getApiToken()
      .then((token) => loadFlowOverlay(token, subscriptionId || undefined, flowLookbackMinutes, flowTop))
      .then((o) => {
        if (cancelled) return;
        setFlowOverlay(o);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFlowOverlay({
          generatedAt: new Date().toISOString(),
          lookbackMinutes: flowLookbackMinutes,
          level: "subnet",
          edges: [],
          unmatchedPairs: [],
          note: e instanceof Error ? e.message : "flow overlay error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [flowEnabled, flowLookbackMinutes, flowTop, getApiToken, subscriptionId]);

  const flowEdges: FlowEdge[] = useMemo(() => {
    if (!flowOverlay || flowOverlay.edges.length === 0) return [];
    const maxBytes = Math.max(1, ...flowOverlay.edges.map((e) => e.totalBytes));
    return flowOverlay.edges.map((e) => {
      const t = Math.max(0, Math.min(1, e.totalBytes / maxBytes));
      const width = 1.5 + t * 7;
      const alpha = 0.18 + t * 0.58;
      const denyHot = e.deniedFlows > 0;
      const stroke = denyHot ? `rgba(216,59,1,${alpha})` : `rgba(0,120,212,${alpha})`;
      const id = `flow:${e.source}->${e.target}`;
      const isPlayback = flowEnabled && flowStage === 2;
      const isActive = isPlayback && playbackEdgeId === id;
      const playbackStroke = denyHot ? "rgba(216,59,1,0.92)" : "rgba(0,120,212,0.92)";
      const baseStroke = isPlayback ? `rgba(20,21,23,${0.08 + t * 0.2})` : stroke;
      return {
        id,
        source: e.source,
        target: e.target,
        animated: true,
        selectable: false,
        focusable: false,
        style: {
          stroke: isActive ? playbackStroke : baseStroke,
          strokeWidth: isActive ? width + 3.5 : isPlayback ? Math.max(1, width - 1.2) : width,
          strokeDasharray: isActive ? "1 6" : denyHot ? "4 4" : "1 0",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: isActive ? playbackStroke : stroke,
        },
      };
    });
  }, [flowEnabled, flowOverlay, flowStage, playbackEdgeId]);

  const overlayTopList = useMemo(() => {
    const list = flowOverlay?.edges ?? [];
    return [...list].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 8);
  }, [flowOverlay]);

  const playbackList: PlaybackItem[] = useMemo(() => {
    if (!flowOverlay || overlayTopList.length === 0) return [];
    return overlayTopList.map((e) => ({
      edgeId: `flow:${e.source}->${e.target}`,
      metric: e,
    }));
  }, [flowOverlay, overlayTopList]);

  useEffect(() => {
    if (!flowEnabled || flowStage !== 2) {
      setPlaybackEdgeId(null);
      return;
    }
    if (playbackList.length === 0) {
      setPlaybackEdgeId(null);
      return;
    }

    setPlaybackIndex(0);
    setPlaybackEdgeId(playbackList[0]!.edgeId);

    const interval = window.setInterval(() => {
      setPlaybackIndex((prev) => {
        const next = (prev + 1) % playbackList.length;
        setPlaybackEdgeId(playbackList[next]!.edgeId);
        return next;
      });
    }, 900);

    return () => {
      window.clearInterval(interval);
    };
  }, [flowEnabled, flowStage, playbackList]);

  return {
    flowEnabled,
    setFlowEnabled,
    flowStage,
    setFlowStage,
    flowLookbackMinutes,
    setFlowLookbackMinutes,
    flowTop,
    setFlowTop,
    flowOverlay,
    flowEdges,
    overlayTopList,
    playbackList,
    playbackIndex,
  };
}
