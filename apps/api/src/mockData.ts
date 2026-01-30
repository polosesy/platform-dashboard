import type { ArchitectureGraph } from "./types";

export const mockArchitectureGraph: ArchitectureGraph = {
  generatedAt: new Date().toISOString(),
  nodes: [
    {
      id: "sub:prod",
      kind: "subscription",
      name: "prod-subscription",
      health: "ok"
    },
    {
      id: "rg:core",
      kind: "resourceGroup",
      name: "rg-core",
      health: "ok"
    },
    {
      id: "vnet:core",
      kind: "vnet",
      name: "vnet-core",
      location: "koreacentral",
      health: "ok"
    },
    {
      id: "subnet:app",
      kind: "subnet",
      name: "subnet-app",
      health: "ok"
    },
    {
      id: "aks:platform",
      kind: "aks",
      name: "aks-platform",
      health: "warning",
      metrics: {
        cpuUtil: 62,
        podRestarts: 3
      }
    },
    {
      id: "appgw:edge",
      kind: "appGateway",
      name: "appgw-edge",
      health: "ok",
      metrics: {
        p99LatencyMs: 240,
        rps: 85
      }
    },
    {
      id: "sql:orders",
      kind: "sql",
      name: "sql-orders",
      health: "ok",
      metrics: {
        dtus: 38
      }
    }
  ],
  edges: [
    { id: "e1", source: "sub:prod", target: "rg:core", kind: "contains" },
    { id: "e2", source: "rg:core", target: "vnet:core", kind: "contains" },
    { id: "e3", source: "vnet:core", target: "subnet:app", kind: "contains" },
    { id: "e4", source: "subnet:app", target: "aks:platform", kind: "contains" },
    { id: "e5", source: "subnet:app", target: "appgw:edge", kind: "contains" },
    { id: "e6", source: "aks:platform", target: "sql:orders", kind: "connects" }
  ]
};
