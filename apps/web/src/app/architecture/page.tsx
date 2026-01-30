"use client";

import "reactflow/dist/style.css";

import { useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Node as FlowNode,
  type Edge as FlowEdge,
  useEdgesState,
  useNodesState,
} from "reactflow";
import styles from "./styles.module.css";
import type { ArchitectureGraph, ArchitectureNode } from "@/lib/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

function fallbackGraph(): ArchitectureGraph {
  return {
    generatedAt: new Date().toISOString(),
    nodes: [
      { id: "sub:prod", kind: "subscription", name: "prod-subscription", health: "ok" },
      { id: "rg:core", kind: "resourceGroup", name: "rg-core", health: "ok" },
      { id: "vnet:core", kind: "vnet", name: "vnet-core", location: "koreacentral", health: "ok" },
      { id: "subnet:app", kind: "subnet", name: "subnet-app", health: "ok" },
      {
        id: "aks:platform",
        kind: "aks",
        name: "aks-platform",
        health: "warning",
        metrics: { cpuUtil: 62, podRestarts: 3 },
      },
      { id: "appgw:edge", kind: "appGateway", name: "appgw-edge", health: "ok", metrics: { p99LatencyMs: 240 } },
    ],
    edges: [
      { id: "e1", source: "sub:prod", target: "rg:core", kind: "contains" },
      { id: "e2", source: "rg:core", target: "vnet:core", kind: "contains" },
      { id: "e3", source: "vnet:core", target: "subnet:app", kind: "contains" },
      { id: "e4", source: "subnet:app", target: "aks:platform", kind: "contains" },
      { id: "e5", source: "subnet:app", target: "appgw:edge", kind: "contains" },
    ],
  };
}

function healthTone(health: ArchitectureNode["health"]) {
  switch (health) {
    case "ok":
      return "ok";
    case "warning":
      return "warning";
    case "critical":
      return "critical";
    default:
      return "unknown";
  }
}

function layoutGraph(graph: ArchitectureGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const kindOrder: ArchitectureNode["kind"][] = [
    "subscription",
    "resourceGroup",
    "vnet",
    "subnet",
    "appGateway",
    "lb",
    "aks",
    "vm",
    "sql",
    "storage",
    "privateEndpoint",
    "unknown",
  ];
  const orderIndex = new Map(kindOrder.map((k, i) => [k, i] as const));

  const groups = new Map<number, ArchitectureNode[]>();
  for (const n of graph.nodes) {
    const idx = orderIndex.get(n.kind) ?? kindOrder.length - 1;
    const arr = groups.get(idx) ?? [];
    arr.push(n);
    groups.set(idx, arr);
  }

  const nodes: FlowNode[] = [];
  const xStep = 240;
  const yStep = 120;
  const baseX = 60;
  const baseY = 60;

  for (const [idx, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
    for (let row = 0; row < arr.length; row++) {
      const n = arr[row];
      nodes.push({
        id: n.id,
        position: { x: baseX + idx * xStep, y: baseY + row * yStep },
        data: { node: n },
        type: "default",
        draggable: true,
      });
    }
  }

  const edges: FlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: e.kind === "connects",
    style: { strokeWidth: e.kind === "connects" ? 2 : 1 },
  }));

  return { nodes, edges };
}

async function loadGraph(bearerToken: string | null): Promise<ArchitectureGraph> {
  const url = `${apiBaseUrl()}/api/architecture/graph`;
  try {
    return await fetchJsonWithBearer<ArchitectureGraph>(url, bearerToken);
  } catch (err) {
    console.warn("Failed to load architecture graph, using fallback.", err);
    return fallbackGraph();
  }
}

export default function ArchitecturePage() {
  const [selected, setSelected] = useState<ArchitectureNode | null>(null);
  const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const getApiToken = useApiToken();

  const initial = useMemo(() => ({ nodes: [] as FlowNode[], edges: [] as FlowEdge[] }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .then((token) => loadGraph(token))
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
  }, [getApiToken, setEdges, setNodes]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Architecture Map</div>
          <div className={styles.subTitle}>
            {graph ? `Generated: ${new Date(graph.generatedAt).toLocaleString()}` : "Loading..."}
          </div>
        </div>
        <div className={styles.meta}>
          <span className={styles.metaKey}>API</span>
          <span className={styles.metaValue}>{apiBaseUrl()}</span>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}

      <div className={styles.canvas}>
        <div className={styles.flowWrap}>
          <ReactFlow
            nodes={nodes.map((n) => {
              const node = (n.data as { node: ArchitectureNode }).node;
              const tone = healthTone(node.health);
              return {
                ...n,
                data: {
                  label: (
                    <div className={`${styles.node} ${styles[`node_${tone}`]}`}>
                      <div className={styles.nodeName}>{node.name}</div>
                      <div className={styles.nodeKind}>{node.kind}</div>
                    </div>
                  ),
                  node,
                },
              };
            })}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_e, n) => setSelected(((n.data as { node?: ArchitectureNode })?.node ?? null) as ArchitectureNode | null)}
            fitView
          >
            <Background gap={18} size={1} color="rgba(20,21,23,0.08)" />
            <Controls />
          </ReactFlow>
        </div>

        <aside className={styles.inspector}>
          <div className={styles.inspectorTitle}>Inspector</div>

          {!selected ? (
            <div className={styles.inspectorEmpty}>Select a node to see details.</div>
          ) : (
            <div className={styles.inspectorBody}>
              <div className={styles.row}>
                <div className={styles.key}>Name</div>
                <div className={styles.value}>{selected.name}</div>
              </div>
              <div className={styles.row}>
                <div className={styles.key}>Kind</div>
                <div className={styles.value}>{selected.kind}</div>
              </div>
              <div className={styles.row}>
                <div className={styles.key}>Health</div>
                <div className={styles.value}>{selected.health ?? "unknown"}</div>
              </div>
              {selected.location ? (
                <div className={styles.row}>
                  <div className={styles.key}>Location</div>
                  <div className={styles.value}>{selected.location}</div>
                </div>
              ) : null}
              {selected.azureId ? (
                <div className={styles.row}>
                  <div className={styles.key}>Azure ID</div>
                  <div className={styles.valueMono}>{selected.azureId}</div>
                </div>
              ) : null}

              {selected.metrics ? (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>Key metrics</div>
                  {Object.entries(selected.metrics).map(([k, v]) => (
                    <div key={k} className={styles.row}>
                      <div className={styles.key}>{k}</div>
                      <div className={styles.value}>{v}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {selected.tags ? (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>Tags</div>
                  {Object.entries(selected.tags).map(([k, v]) => (
                    <div key={k} className={styles.row}>
                      <div className={styles.key}>{k}</div>
                      <div className={styles.value}>{v}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
