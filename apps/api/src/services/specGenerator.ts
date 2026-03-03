import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureEdge,
  GraphNodeKind,
  EdgeKind,
} from "../types";
import type {
  DiagramSpec,
  DiagramNodeSpec,
  DiagramEdgeSpec,
  DiagramEdgeKind,
  DiagramGroupSpec,
  DiagramIconKind,
  DiagramLayoutKind,
  MetricBinding,
} from "@aud/types";
import { inferImplicitEdges } from "./dependencyInference";
import ELK from "elkjs";

// ── Kinds to exclude (infra-only, not useful for live monitoring) ──

const EXCLUDED_KINDS: Set<GraphNodeKind> = new Set([
  "subscription",
  "resourceGroup",
  "nic",
  "nsg",
  "dns",
  "logAnalytics",
]);

// ── Network container kinds (rendered as group nodes) ──

const NETWORK_CONTAINER_KINDS = new Set<GraphNodeKind>(["vnet", "subnet"]);

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

// ── Dependency inference sets ──

const COMPUTE_KINDS = new Set<string>([
  "aks", "vm", "vmss", "containerApp", "functionApp", "appService",
]);

const DATA_KINDS = new Set<string>([
  "sql", "storage", "redis", "cosmosDb", "postgres", "keyVault", "serviceBus", "eventHub",
]);

const INGRESS_KINDS = new Set<string>([
  "appGateway", "lb", "frontDoor", "trafficManager", "firewall",
]);

function inferProtocol(dataKind: string): string {
  switch (dataKind) {
    case "sql": case "postgres": return "TCP/1433";
    case "redis": return "TCP/6380";
    case "cosmosDb": return "HTTPS/443";
    case "storage": return "HTTPS/443";
    case "keyVault": return "HTTPS/443";
    case "serviceBus": case "eventHub": return "AMQP/5671";
    default: return "TCP";
  }
}

function buildEdgeLabel(srcNode: ArchitectureNode | undefined, tgtNode: ArchitectureNode | undefined): string | undefined {
  if (!srcNode?.endpoint && !tgtNode?.endpoint) return undefined;
  const parts: string[] = [];
  if (srcNode?.endpoint) parts.push(truncateEndpoint(srcNode.endpoint));
  if (tgtNode?.endpoint) parts.push(truncateEndpoint(tgtNode.endpoint));
  return parts.join(" → ");
}

function truncateEndpoint(ep: string): string {
  if (/^\d+\.\d+/.test(ep)) return ep;
  const first = ep.split(".")[0];
  return first && first.length < ep.length ? first : ep.slice(0, 24);
}

// ── Layout constants ──

const NODE_W = 220;
const NODE_H = 80;
const NODE_GAP = 16;
const SUBNET_INNER_PAD = 30;
const SUBNET_HEADER = 44;
const VNET_PAD = 30;
const VNET_HEADER = 48;
const SUBNET_GAP = 24;
const EXTERNAL_GAP = 40;

// ── Subnet tier classification ──

function subnetTier(childKinds: Set<string>): number {
  for (const k of childKinds) {
    if (INGRESS_KINDS.has(k)) return 0;
  }
  for (const k of childKinds) {
    if (COMPUTE_KINDS.has(k)) return 1;
  }
  return 2;
}

// ── Derive short stable ID from Azure resource ID ──

function shortId(azureId: string): string {
  const parts = azureId.split("/");
  const name = parts[parts.length - 1] ?? azureId;
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function buildUniqueIdMap(nodes: ArchitectureNode[]): Map<string, string> {
  const idMap = new Map<string, string>();
  const seen = new Map<string, number>();

  for (const node of nodes) {
    let sid = shortId(node.azureId ?? node.id);
    const count = seen.get(sid) ?? 0;
    seen.set(sid, count + 1);
    if (count > 0) {
      sid = `${sid}-${count + 1}`;
    }
    idMap.set(node.id, sid);
  }

  return idMap;
}

// ── Containment map builder ──

type ContainmentMap = {
  subnetParent: Map<string, string>;   // subnetOrigId → vnetOrigId
  resourceSubnet: Map<string, string>; // resourceOrigId → subnetOrigId
};

function buildContainmentMap(graph: ArchitectureGraph): ContainmentMap {
  const subnetParent = new Map<string, string>();
  const resourceSubnet = new Map<string, string>();

  const nodeKindMap = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  // VNet → Subnet (contains edges)
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);
    if (srcKind === "vnet" && tgtKind === "subnet") {
      subnetParent.set(edge.target, edge.source);
    }
  }

  // Subnet → Resource (network/connects edges, direct or via NIC)
  const NETWORK_EDGE_KINDS: Set<EdgeKind> = new Set(["connects", "network"]);
  const nicToSubnet = new Map<string, string>();
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);

    if (srcKind === "subnet" && tgtKind === "nic") {
      nicToSubnet.set(edge.target, edge.source);
    } else if (srcKind === "subnet" && tgtKind && !NETWORK_CONTAINER_KINDS.has(tgtKind)) {
      resourceSubnet.set(edge.target, edge.source);
    }
  }

  // NIC → Resource: resolve through NIC to subnet
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    if (srcKind !== "nic") continue;
    const subnetId = nicToSubnet.get(edge.source);
    if (subnetId && !resourceSubnet.has(edge.target)) {
      resourceSubnet.set(edge.target, subnetId);
    }
  }

  return { subnetParent, resourceSubnet };
}

// ── ELK Layout Engine ──

const elk = new ELK();

async function applyElkLayout(
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
): Promise<void> {
  // Build ELK graph with compound nodes
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const rootChildren: ElkNode[] = [];
  const parentChildrenMap = new Map<string, ElkNode[]>();

  type ElkNode = {
    id: string;
    width: number;
    height: number;
    children?: ElkNode[];
    layoutOptions?: Record<string, string>;
  };

  // Sort nodes: parents first, then children
  const groupNodes = nodes.filter((n) => n.nodeType === "group");
  const leafNodes = nodes.filter((n) => n.nodeType !== "group");

  // Create ELK nodes for groups
  for (const gn of groupNodes) {
    const elkNode: ElkNode = {
      id: gn.id,
      width: gn.width ?? 400,
      height: gn.height ?? 200,
      children: [],
      layoutOptions: {
        "elk.padding": "[top=50,left=30,bottom=30,right=30]",
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
      },
    };
    if (gn.parentId) {
      const siblings = parentChildrenMap.get(gn.parentId) ?? [];
      siblings.push(elkNode);
      parentChildrenMap.set(gn.parentId, siblings);
    } else {
      rootChildren.push(elkNode);
    }
    parentChildrenMap.set(gn.id, elkNode.children!);
  }

  // Create ELK nodes for leaf resources
  for (const ln of leafNodes) {
    const elkNode: ElkNode = {
      id: ln.id,
      width: NODE_W,
      height: NODE_H,
    };
    if (ln.parentId) {
      const siblings = parentChildrenMap.get(ln.parentId) ?? [];
      siblings.push(elkNode);
      parentChildrenMap.set(ln.parentId, siblings);
    } else {
      rootChildren.push(elkNode);
    }
  }

  // Wire children into group nodes
  for (const gn of groupNodes) {
    const elkChildren = parentChildrenMap.get(gn.id) ?? [];
    // Find the elkNode in rootChildren or nested
    const findElk = (arr: ElkNode[], id: string): ElkNode | undefined => {
      for (const n of arr) {
        if (n.id === id) return n;
        if (n.children) {
          const found = findElk(n.children, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const elkNode = findElk(rootChildren, gn.id);
    if (elkNode) elkNode.children = elkChildren;
  }

  // Build ELK edges (only between nodes at the same level or cross-hierarchy)
  const elkEdges = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.edgeEdge": "20",
      "elk.spacing.componentComponent": "60",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
    },
    children: rootChildren,
    edges: elkEdges,
  };

  try {
    const layout = await elk.layout(elkGraph);

    // Apply positions back from ELK result
    const applyPositions = (elkNodes: typeof rootChildren, parentX = 0, parentY = 0) => {
      for (const en of elkNodes) {
        const node = nodeMap.get(en.id);
        if (node) {
          const x = (en as { x?: number }).x ?? 0;
          const y = (en as { y?: number }).y ?? 0;
          // For nodes with a parent, position is relative to parent
          if (node.parentId) {
            node.position = { x, y };
          } else {
            node.position = { x: x + parentX, y: y + parentY };
          }
          // Update group dimensions from ELK
          if (node.nodeType === "group") {
            const w = (en as { width?: number }).width;
            const h = (en as { height?: number }).height;
            if (w) node.width = w;
            if (h) node.height = h;
          }
        }
        if (en.children) {
          const nx = (en as { x?: number }).x ?? 0;
          const ny = (en as { y?: number }).y ?? 0;
          applyPositions(en.children, parentX + nx, parentY + ny);
        }
      }
    };

    applyPositions(layout.children ?? []);
  } catch {
    // ELK failed — positions remain from manual layout as fallback
  }
}

// ── Main generator ──

export async function generateDiagramSpec(
  graph: ArchitectureGraph,
  subscriptionId: string,
  layoutMode: DiagramLayoutKind = "elk",
): Promise<DiagramSpec> {
  const now = new Date().toISOString();

  // Build containment map from FULL graph (before filtering)
  const containment = buildContainmentMap(graph);

  // Filter nodes — exclude infra-only kinds (but keep VNet/Subnet)
  const filteredNodes = graph.nodes.filter(
    (n) => !EXCLUDED_KINDS.has(n.kind),
  );

  // Build node ID set for edge filtering
  const nodeOriginalIds = new Set(filteredNodes.map((n) => n.id));

  // Map original IDs → unique short IDs
  const idMap = buildUniqueIdMap(filteredNodes);

  // Categorize nodes
  const vnetNodes = filteredNodes.filter((n) => n.kind === "vnet");
  const subnetNodes = filteredNodes.filter((n) => n.kind === "subnet");
  const resourceNodes = filteredNodes.filter((n) => !NETWORK_CONTAINER_KINDS.has(n.kind));

  // Build subnet → children map (using short IDs)
  const subnetChildren = new Map<string, Array<{ node: ArchitectureNode; shortId: string }>>();
  for (const res of resourceNodes) {
    const subnetOrigId = containment.resourceSubnet.get(res.id);
    if (!subnetOrigId) continue;
    const subnetShortId = idMap.get(subnetOrigId);
    if (!subnetShortId) continue;
    const arr = subnetChildren.get(subnetShortId) ?? [];
    arr.push({ node: res, shortId: idMap.get(res.id)! });
    subnetChildren.set(subnetShortId, arr);
  }

  // Build VNet → subnets map (using short IDs)
  const vnetSubnets = new Map<string, Array<{ node: ArchitectureNode; shortId: string }>>();
  for (const sub of subnetNodes) {
    const vnetOrigId = containment.subnetParent.get(sub.id);
    if (!vnetOrigId) continue;
    const vnetShortId = idMap.get(vnetOrigId);
    if (!vnetShortId) continue;
    const arr = vnetSubnets.get(vnetShortId) ?? [];
    arr.push({ node: sub, shortId: idMap.get(sub.id)! });
    vnetSubnets.set(vnetShortId, arr);
  }

  // Compute subnet dimensions and tier
  const subnetInfo = new Map<string, { width: number; height: number; tier: number }>();
  for (const [subShortId, children] of subnetChildren) {
    const childKinds = new Set(children.map((c) => c.node.kind));
    const w = NODE_W + 2 * SUBNET_INNER_PAD;
    const h = SUBNET_HEADER + children.length * NODE_H + Math.max(0, children.length - 1) * NODE_GAP + SUBNET_INNER_PAD;
    subnetInfo.set(subShortId, { width: w, height: Math.max(h, SUBNET_HEADER + NODE_H + SUBNET_INNER_PAD), tier: subnetTier(childKinds) });
  }

  // Include empty subnets with minimal size
  for (const sub of subnetNodes) {
    const sid = idMap.get(sub.id)!;
    if (!subnetInfo.has(sid)) {
      subnetInfo.set(sid, { width: NODE_W + 2 * SUBNET_INNER_PAD, height: SUBNET_HEADER + SUBNET_INNER_PAD + 20, tier: 2 });
    }
  }

  // Compute VNet dimensions
  const vnetInfo = new Map<string, { width: number; height: number }>();
  for (const vnet of vnetNodes) {
    const vShortId = idMap.get(vnet.id)!;
    const subs = vnetSubnets.get(vShortId) ?? [];
    subs.sort((a, b) => {
      const ta = subnetInfo.get(a.shortId)?.tier ?? 2;
      const tb = subnetInfo.get(b.shortId)?.tier ?? 2;
      return ta - tb;
    });

    let totalSubW = 0;
    let maxSubH = 0;
    for (const sub of subs) {
      const info = subnetInfo.get(sub.shortId);
      if (!info) continue;
      totalSubW += info.width;
      maxSubH = Math.max(maxSubH, info.height);
    }
    totalSubW += Math.max(0, subs.length - 1) * SUBNET_GAP;

    const vW = Math.max(totalSubW + 2 * VNET_PAD, 400);
    const vH = VNET_HEADER + maxSubH + VNET_PAD + 10;
    vnetInfo.set(vShortId, { width: vW, height: Math.max(vH, 200) });
  }

  // ── Compute positions ──
  const diagramNodes: DiagramNodeSpec[] = [];
  let cursorY = 40;

  // Place VNets
  for (const vnet of vnetNodes) {
    const vShortId = idMap.get(vnet.id)!;
    const vSize = vnetInfo.get(vShortId) ?? { width: 600, height: 300 };

    diagramNodes.push({
      id: vShortId,
      label: `${vnet.name}${vnet.endpoint ? ` (${vnet.endpoint})` : ""}`,
      icon: "vnet",
      nodeType: "group",
      width: vSize.width,
      height: vSize.height,
      azureResourceId: vnet.azureId,
      endpoint: vnet.endpoint,
      position: { x: 40, y: cursorY },
      bindings: {},
    });

    // Place subnets within VNet (sorted by tier)
    const subs = vnetSubnets.get(vShortId) ?? [];
    subs.sort((a, b) => {
      const ta = subnetInfo.get(a.shortId)?.tier ?? 2;
      const tb = subnetInfo.get(b.shortId)?.tier ?? 2;
      return ta - tb;
    });

    let subX = VNET_PAD;
    for (const sub of subs) {
      const sInfo = subnetInfo.get(sub.shortId);
      if (!sInfo) continue;

      diagramNodes.push({
        id: sub.shortId,
        label: `${sub.node.name}${sub.node.endpoint ? ` (${sub.node.endpoint})` : ""}`,
        icon: "subnet",
        nodeType: "group",
        parentId: vShortId,
        width: sInfo.width,
        height: sInfo.height,
        azureResourceId: sub.node.azureId,
        endpoint: sub.node.endpoint,
        position: { x: subX, y: VNET_HEADER },
        bindings: {},
      });

      // Place resources within subnet
      const children = subnetChildren.get(sub.shortId) ?? [];
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci]!;
        diagramNodes.push({
          id: child.shortId,
          label: child.node.name,
          icon: KIND_TO_ICON[child.node.kind] ?? "custom",
          azureResourceId: child.node.azureId,
          endpoint: child.node.endpoint,
          parentId: sub.shortId,
          groupId: inferGroup(child.node),
          position: { x: SUBNET_INNER_PAD, y: SUBNET_HEADER + ci * (NODE_H + NODE_GAP) },
          bindings: NODE_BINDINGS[child.node.kind] ?? {
            health: { source: "composite", rules: [] },
          },
        });
      }

      subX += sInfo.width + SUBNET_GAP;
    }

    cursorY += vSize.height + EXTERNAL_GAP;
  }

  // Identify resources NOT inside any subnet
  const containedResourceIds = new Set<string>();
  for (const children of subnetChildren.values()) {
    for (const c of children) containedResourceIds.add(c.shortId);
  }

  const vnetSubnetIds = new Set([
    ...vnetNodes.map((n) => idMap.get(n.id)!),
    ...subnetNodes.map((n) => idMap.get(n.id)!),
  ]);

  const externalResources = resourceNodes.filter((n) => {
    const sid = idMap.get(n.id)!;
    return !containedResourceIds.has(sid) && !vnetSubnetIds.has(sid);
  });

  // Place external resources horizontally below VNets
  if (externalResources.length > 0) {
    externalResources.sort((a, b) => {
      const tierA = DATA_KINDS.has(a.kind) ? 0 : COMPUTE_KINDS.has(a.kind) ? 1 : 2;
      const tierB = DATA_KINDS.has(b.kind) ? 0 : COMPUTE_KINDS.has(b.kind) ? 1 : 2;
      return tierA - tierB;
    });

    const cols = Math.min(externalResources.length, 5);
    for (let i = 0; i < externalResources.length; i++) {
      const res = externalResources[i]!;
      const row = Math.floor(i / cols);
      const col = i % cols;

      diagramNodes.push({
        id: idMap.get(res.id)!,
        label: res.name,
        icon: KIND_TO_ICON[res.kind] ?? "custom",
        azureResourceId: res.azureId,
        endpoint: res.endpoint,
        groupId: inferGroup(res),
        position: {
          x: 40 + col * (NODE_W + NODE_GAP + 20),
          y: cursorY + row * (NODE_H + NODE_GAP),
        },
        bindings: NODE_BINDINGS[res.kind] ?? {
          health: { source: "composite", rules: [] },
        },
      });
    }
  }

  // ── Build edges (all non-containment edges between visible nodes) ──
  const CONTAINMENT_KINDS: Set<EdgeKind> = new Set(["contains"]);
  const filteredEdgesNoNetwork = graph.edges.filter(
    (e) =>
      !CONTAINMENT_KINDS.has(e.kind) &&
      nodeOriginalIds.has(e.source) &&
      nodeOriginalIds.has(e.target) &&
      !isNetworkContainer(graph, e.source) &&
      !isNetworkContainer(graph, e.target),
  );

  const edgeSeen = new Set<string>();
  const uniqueEdges: ArchitectureEdge[] = [];
  for (const edge of filteredEdgesNoNetwork) {
    const key = `${edge.source}→${edge.target}`;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      uniqueEdges.push(edge);
    }
  }

  const edgeIdSeen = new Set<string>();

  function makeEdge(
    srcId: string,
    tgtId: string,
    srcKind: string,
    label?: string,
    protocol?: string,
    edgeKind?: DiagramEdgeKind,
    confidence?: number,
  ): DiagramEdgeSpec {
    let edgeId = `${srcId}-to-${tgtId}`;
    if (edgeIdSeen.has(edgeId)) {
      let suffix = 2;
      while (edgeIdSeen.has(`${edgeId}-${suffix}`)) suffix++;
      edgeId = `${edgeId}-${suffix}`;
    }
    edgeIdSeen.add(edgeId);

    return {
      id: edgeId,
      source: srcId,
      target: tgtId,
      label,
      protocol,
      edgeKind,
      confidence,
      bindings: EDGE_BINDINGS[srcKind] ?? {},
      animation: edgeKind === "logging" || edgeKind === "inferred" ? "dash" as const : "flow" as const,
    };
  }

  // Map ArchitectureEdge.kind → DiagramEdgeKind
  function toDiagramEdgeKind(kind: EdgeKind): DiagramEdgeKind | undefined {
    switch (kind) {
      case "network": case "connects": return "network";
      case "peering": return "peering";
      case "privateLink": return "privateLink";
      case "routes": return "routes";
      case "logging": return "logging";
      case "inferred": return "inferred";
      default: return undefined;
    }
  }

  // Edge label helpers for typed edges
  function edgeKindLabel(kind: EdgeKind, edge: ArchitectureEdge): string | undefined {
    switch (kind) {
      case "peering": return `VNet Peering (${edge.metadata?.peeringState ?? "Connected"})`;
      case "privateLink": return "Private Link";
      case "logging": return edge.metadata?.diagnosticCategory ?? "Diagnostics";
      default: return undefined;
    }
  }

  // Topology-based edges (explicit from azure.ts)
  const diagramEdges: DiagramEdgeSpec[] = uniqueEdges.map((edge) => {
    const srcId = idMap.get(edge.source)!;
    const tgtId = idMap.get(edge.target)!;
    const srcNode = filteredNodes.find((n) => n.id === edge.source);
    const tgtNode = filteredNodes.find((n) => n.id === edge.target);
    const srcKind = srcNode?.kind ?? "unknown";
    const label = edgeKindLabel(edge.kind, edge) ?? buildEdgeLabel(srcNode, tgtNode);
    const protocol = edge.metadata?.protocol;
    return makeEdge(srcId, tgtId, srcKind, label, protocol, toDiagramEdgeKind(edge.kind));
  });

  // Dependency-based edges: proximity-scored inference (replaces Cartesian product)
  const existingPairs = new Set<string>();
  for (const e of diagramEdges) {
    existingPairs.add(`${e.source}→${e.target}`);
    existingPairs.add(`${e.target}→${e.source}`);
  }

  const inferredEdges = inferImplicitEdges(graph, filteredNodes, existingPairs, idMap);
  for (const inf of inferredEdges) {
    const cId = idMap.get(inf.source)!;
    const dId = idMap.get(inf.target)!;
    if (!cId || !dId) continue;
    if (existingPairs.has(`${cId}→${dId}`) || existingPairs.has(`${dId}→${cId}`)) continue;

    const srcNode = filteredNodes.find((n) => n.id === inf.source);
    const tgtNode = filteredNodes.find((n) => n.id === inf.target);
    const label = buildEdgeLabel(srcNode, tgtNode);
    diagramEdges.push(makeEdge(cId, dId, srcNode?.kind ?? "unknown", label, inf.metadata.protocol, "inferred", inf.confidence));
    existingPairs.add(`${cId}→${dId}`);
  }

  // Build groups
  const groups = inferGroups(filteredNodes);

  // Apply ELK auto-layout if requested (repositions nodes + resizes containers)
  if (layoutMode === "elk") {
    await applyElkLayout(diagramNodes, diagramEdges);
  }

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
      layout: layoutMode,
    },
  };
}

// ── Helpers ──

function isNetworkContainer(graph: ArchitectureGraph, nodeId: string): boolean {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node ? NETWORK_CONTAINER_KINDS.has(node.kind) : false;
}

function inferGroup(node: ArchitectureNode): string {
  const kind = node.kind;
  if (INGRESS_KINDS.has(kind)) return "ingress";
  if (COMPUTE_KINDS.has(kind)) return "compute";
  if (DATA_KINDS.has(kind) || kind === "privateEndpoint") return "data";
  if (kind === "vnet" || kind === "subnet") return "network";
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
