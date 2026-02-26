"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type Node as FlowNode,
  type Edge as FlowEdge,
  useNodesState,
  useEdgesState,
} from "reactflow";
import type {
  ArchitectureGraph,
  ArchitectureNode,
  AzureSubscriptionOption,
  AzureSubscriptionsResponse,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { fallbackGraph, layoutGraph } from "../utils/graphUtils";

async function loadGraph(bearerToken: string | null, subscriptionId?: string): Promise<ArchitectureGraph> {
  const url = new URL(`${apiBaseUrl()}/api/architecture/graph`);
  if (subscriptionId) url.searchParams.set("subscriptionId", subscriptionId);
  try {
    return await fetchJsonWithBearer<ArchitectureGraph>(url.toString(), bearerToken);
  } catch (err) {
    console.warn("Failed to load architecture graph, using fallback.", err);
    return fallbackGraph();
  }
}

async function loadSubscriptions(bearerToken: string | null): Promise<AzureSubscriptionsResponse> {
  const url = new URL(`${apiBaseUrl()}/api/azure/subscriptions`);
  return await fetchJsonWithBearer<AzureSubscriptionsResponse>(url.toString(), bearerToken);
}

export function useArchitectureGraph() {
  const [selected, setSelected] = useState<ArchitectureNode | null>(null);
  const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const getApiToken = useApiToken();

  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>([]);
  const [subscriptionId, setSubscriptionId] = useState<string>("");

  const initial = useMemo(() => ({ nodes: [] as FlowNode[], edges: [] as FlowEdge[] }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .then((token) => loadSubscriptions(token))
      .then((resp) => {
        if (cancelled) return;
        const subs = resp.subscriptions ?? [];
        setSubscriptions(subs);
        setSubscriptionId((prev) => (prev ? prev : subs[0]?.subscriptionId ?? ""));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.warn("Failed to load subscription list", e);
        setSubscriptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [getApiToken]);

  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .then((token) => loadGraph(token, subscriptionId || undefined))
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        const laidOut = layoutGraph(g);
        setNodes(laidOut.nodes);
        setEdges(laidOut.edges);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      });
    return () => {
      cancelled = true;
    };
  }, [getApiToken, setEdges, setNodes, subscriptionId]);

  return {
    selected,
    setSelected,
    graph,
    error,
    subscriptions,
    subscriptionId,
    setSubscriptionId,
    nodes,
    onNodesChange,
    edges,
    onEdgesChange,
  };
}
