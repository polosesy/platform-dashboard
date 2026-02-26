import type { Node as FlowNode, Edge as FlowEdge } from "reactflow";
import type { ArchitectureGraph, ArchitectureNode } from "@aud/types";

export function fallbackGraph(): ArchitectureGraph {
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

export function healthTone(health: ArchitectureNode["health"]): string {
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

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  const digits = idx === 0 ? 0 : idx === 1 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[idx]}`;
}

export function layoutGraph(graph: ArchitectureGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
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
