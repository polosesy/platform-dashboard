import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureEdge,
  GraphNodeKind,
} from "../types";
import type {
  DiagramSpec,
  DiagramNodeSpec,
  DiagramEdgeSpec,
  DiagramGroupSpec,
  DiagramIconKind,
  MetricBinding,
} from "@aud/types";

// ── Kinds to exclude (infra-only, not useful for live monitoring) ──

const EXCLUDED_KINDS: Set<GraphNodeKind> = new Set([
  "subscription",
  "resourceGroup",
  "nic",
  "nsg",
  "dns",
  "logAnalytics",
]);

// ── GraphNodeKind → DiagramIconKind ──

const KIND_TO_ICON: Record<GraphNodeKind, DiagramIconKind> = {
  subscription: "subscription",
  resourceGroup: "resourceGroup",
  vnet: "vnet",
  subnet: "subnet",
  nsg: "nsg",
  nic: "nic",
  vm: "vm",
  vmss: "vmss",
  lb: "lb",
  appGateway: "appGateway",
  frontDoor: "frontDoor",
  trafficManager: "trafficManager",
  aks: "aks",
  containerApp: "containerApp",
  privateEndpoint: "privateEndpoint",
  storage: "storage",
  sql: "sql",
  cosmosDb: "cosmosDb",
  redis: "redis",
  postgres: "postgres",
  keyVault: "keyVault",
  appInsights: "appInsights",
  logAnalytics: "logAnalytics",
  firewall: "firewall",
  functionApp: "functionApp",
  appService: "appService",
  serviceBus: "serviceBus",
  eventHub: "eventHub",
  dns: "dns",
  unknown: "custom",
};

// ── Default Azure Monitor metric bindings per resource type ──

const NODE_BINDINGS: Record<string, Record<string, MetricBinding>> = {
  aks: {
    cpu: { source: "monitor", metric: "node_cpu_usage_percentage", aggregation: "avg" },
    memory: { source: "monitor", metric: "node_memory_rss_percentage", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [
        { metric: "cpu", op: "<", threshold: 80, weight: 0.5 },
        { metric: "memory", op: "<", threshold: 85, weight: 0.5 },
      ],
    },
  },
  appGateway: {
    rps: { source: "monitor", metric: "TotalRequests", aggregation: "total" },
    latency: { source: "monitor", metric: "BackendLastByteResponseTime", aggregation: "p95" },
    health: {
      source: "composite",
      rules: [
        { metric: "rps", op: ">", threshold: 0, weight: 0.5 },
        { metric: "latency", op: "<", threshold: 500, weight: 0.5 },
      ],
    },
  },
  vm: {
    cpu: { source: "monitor", metric: "Percentage CPU", aggregation: "avg" },
    network: { source: "monitor", metric: "Network In Total", aggregation: "total" },
    health: {
      source: "composite",
      rules: [
        { metric: "cpu", op: "<", threshold: 85, weight: 0.6 },
        { metric: "network", op: ">", threshold: 0, weight: 0.4 },
      ],
    },
  },
  sql: {
    dtu: { source: "monitor", metric: "dtu_consumption_percent", aggregation: "avg" },
    connections: { source: "monitor", metric: "connection_successful", aggregation: "total" },
    health: {
      source: "composite",
      rules: [
        { metric: "dtu", op: "<", threshold: 90, weight: 0.6 },
        { metric: "connections", op: ">", threshold: 0, weight: 0.4 },
      ],
    },
  },
  storage: {
    transactions: { source: "monitor", metric: "Transactions", aggregation: "total" },
    availability: { source: "monitor", metric: "Availability", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [
        { metric: "availability", op: ">", threshold: 99, weight: 0.7 },
        { metric: "transactions", op: ">", threshold: 0, weight: 0.3 },
      ],
    },
  },
  lb: {
    dataPath: { source: "monitor", metric: "VipAvailability", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [{ metric: "dataPath", op: ">", threshold: 90, weight: 1.0 }],
    },
  },
  redis: {
    cpu: { source: "monitor", metric: "percentProcessorTime", aggregation: "avg" },
    memory: { source: "monitor", metric: "usedmemorypercentage", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [
        { metric: "cpu", op: "<", threshold: 80, weight: 0.5 },
        { metric: "memory", op: "<", threshold: 80, weight: 0.5 },
      ],
    },
  },
  cosmosDb: {
    ru: { source: "monitor", metric: "NormalizedRUConsumption", aggregation: "avg" },
    requests: { source: "monitor", metric: "TotalRequests", aggregation: "total" },
    health: {
      source: "composite",
      rules: [
        { metric: "ru", op: "<", threshold: 80, weight: 0.6 },
        { metric: "requests", op: ">", threshold: 0, weight: 0.4 },
      ],
    },
  },
  postgres: {
    cpu: { source: "monitor", metric: "cpu_percent", aggregation: "avg" },
    storage: { source: "monitor", metric: "storage_percent", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [
        { metric: "cpu", op: "<", threshold: 80, weight: 0.5 },
        { metric: "storage", op: "<", threshold: 85, weight: 0.5 },
      ],
    },
  },
  keyVault: {
    availability: { source: "monitor", metric: "Availability", aggregation: "avg" },
    health: {
      source: "composite",
      rules: [{ metric: "availability", op: ">", threshold: 99, weight: 1.0 }],
    },
  },
  functionApp: {
    executions: { source: "monitor", metric: "FunctionExecutionCount", aggregation: "total" },
    errors: { source: "monitor", metric: "Http5xx", aggregation: "total" },
    health: {
      source: "composite",
      rules: [
        { metric: "executions", op: ">", threshold: 0, weight: 0.5 },
        { metric: "errors", op: "<", threshold: 10, weight: 0.5 },
      ],
    },
  },
  appService: {
    requests: { source: "monitor", metric: "Requests", aggregation: "total" },
    errors: { source: "monitor", metric: "Http5xx", aggregation: "total" },
    health: {
      source: "composite",
      rules: [
        { metric: "requests", op: ">", threshold: 0, weight: 0.5 },
        { metric: "errors", op: "<", threshold: 10, weight: 0.5 },
      ],
    },
  },
};

const EDGE_BINDINGS: Record<string, Record<string, MetricBinding>> = {
  appGateway: {
    throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" },
  },
  lb: {
    throughput: { source: "monitor", metric: "ByteCount", aggregation: "total" },
  },
};

// ── Tier-based layout ──

const KIND_TIER: Record<string, number> = {
  appGateway: 0,
  lb: 0,
  frontDoor: 0,
  trafficManager: 0,
  firewall: 0,
  aks: 1,
  vm: 1,
  vmss: 1,
  containerApp: 1,
  functionApp: 1,
  appService: 1,
  sql: 2,
  storage: 2,
  redis: 2,
  cosmosDb: 2,
  postgres: 2,
  privateEndpoint: 2,
  keyVault: 2,
  serviceBus: 2,
  eventHub: 2,
};

const X_STEP = 320;
const Y_STEP = 150;
const BASE_X = 80;
const BASE_Y = 60;

function computePositions(
  nodes: Array<{ id: string; kind: string }>,
): Map<string, { x: number; y: number }> {
  const tiers = new Map<number, string[]>();

  for (const node of nodes) {
    const tier = KIND_TIER[node.kind] ?? 1;
    const arr = tiers.get(tier) ?? [];
    arr.push(node.id);
    tiers.set(tier, arr);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [tier, nodeIds] of tiers) {
    for (let row = 0; row < nodeIds.length; row++) {
      positions.set(nodeIds[row]!, {
        x: BASE_X + tier * X_STEP,
        y: BASE_Y + row * Y_STEP,
      });
    }
  }

  return positions;
}

// ── Derive short stable ID from Azure resource ID ──

function shortId(azureId: string): string {
  const parts = azureId.split("/");
  const name = parts[parts.length - 1] ?? azureId;
  // Keep alphanumeric + dash, lowercase
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// ── Main generator ──

export function generateDiagramSpec(
  graph: ArchitectureGraph,
  subscriptionId: string,
): DiagramSpec {
  const now = new Date().toISOString();

  // Filter nodes — exclude infra-only kinds
  const filteredNodes = graph.nodes.filter(
    (n) => !EXCLUDED_KINDS.has(n.kind),
  );

  // Build node ID set for edge filtering
  const nodeOriginalIds = new Set(filteredNodes.map((n) => n.id));

  // Map original IDs → short IDs
  const idMap = new Map<string, string>();
  for (const node of filteredNodes) {
    idMap.set(node.id, shortId(node.azureId ?? node.id));
  }

  // Compute positions
  const positions = computePositions(
    filteredNodes.map((n) => ({ id: idMap.get(n.id)!, kind: n.kind })),
  );

  // Build DiagramNodeSpec[]
  const diagramNodes: DiagramNodeSpec[] = filteredNodes.map((node) => {
    const id = idMap.get(node.id)!;
    return {
      id,
      label: node.name,
      icon: KIND_TO_ICON[node.kind] ?? "custom",
      azureResourceId: node.azureId,
      groupId: inferGroup(node),
      position: positions.get(id),
      bindings: NODE_BINDINGS[node.kind] ?? {
        health: { source: "composite", rules: [] },
      },
    };
  });

  // Filter edges — only "connects", both endpoints must survive filtering
  const connectEdges = graph.edges.filter(
    (e) =>
      e.kind === "connects" &&
      nodeOriginalIds.has(e.source) &&
      nodeOriginalIds.has(e.target),
  );

  // Deduplicate edges by source→target pair
  const edgeSeen = new Set<string>();
  const uniqueEdges: ArchitectureEdge[] = [];
  for (const edge of connectEdges) {
    const key = `${edge.source}→${edge.target}`;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      uniqueEdges.push(edge);
    }
  }

  // Build DiagramEdgeSpec[]
  const diagramEdges: DiagramEdgeSpec[] = uniqueEdges.map((edge) => {
    const srcId = idMap.get(edge.source)!;
    const tgtId = idMap.get(edge.target)!;
    const srcNode = filteredNodes.find((n) => n.id === edge.source);
    const srcKind = srcNode?.kind ?? "unknown";

    return {
      id: `${srcId}-to-${tgtId}`,
      source: srcId,
      target: tgtId,
      bindings: EDGE_BINDINGS[srcKind] ?? {},
      animation: "flow" as const,
    };
  });

  // Build groups
  const groups = inferGroups(filteredNodes);

  // Sanitize subscription ID for spec ID
  const specId = `auto-${subscriptionId.slice(0, 8)}`;

  return {
    version: "1.0",
    id: specId,
    name: `Azure Resources (${subscriptionId.slice(0, 8)}…)`,
    description: `Auto-generated from Azure Resource Graph at ${now}`,
    createdAt: now,
    updatedAt: now,
    nodes: diagramNodes,
    edges: diagramEdges,
    groups,
    settings: {
      refreshIntervalSec: 30,
      defaultTimeRange: "5m",
      layout: "manual",
    },
  };
}

// ── Group inference ──

function inferGroup(node: ArchitectureNode): string {
  const kind = node.kind;
  if (kind === "appGateway" || kind === "lb" || kind === "frontDoor" || kind === "trafficManager" || kind === "firewall") return "ingress";
  if (kind === "aks" || kind === "vm" || kind === "vmss" || kind === "containerApp" || kind === "functionApp" || kind === "appService") return "compute";
  if (kind === "sql" || kind === "storage" || kind === "privateEndpoint" || kind === "cosmosDb" || kind === "redis" || kind === "postgres" || kind === "keyVault" || kind === "serviceBus" || kind === "eventHub") return "data";
  if (kind === "vnet" || kind === "subnet" || kind === "dns") return "network";
  if (kind === "appInsights" || kind === "logAnalytics") return "monitoring";
  return "other";
}

function inferGroups(
  nodes: ArchitectureNode[],
): DiagramGroupSpec[] {
  const groupLabels: Record<string, string> = {
    ingress: "Ingress",
    compute: "Compute",
    data: "Data & Storage",
    network: "Networking",
    monitoring: "Monitoring",
    other: "Other",
  };

  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(inferGroup(node));
  }

  return Array.from(seen)
    .map((id) => ({
      id,
      label: groupLabels[id] ?? id,
      layout: "row" as const,
    }));
}
