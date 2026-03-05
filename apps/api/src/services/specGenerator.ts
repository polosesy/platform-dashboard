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
  SubResource,
  SubResourceKind,
} from "@aud/types";
import { inferImplicitEdges } from "./dependencyInference";
import ELK from "elkjs";

// ── Kinds to exclude (infra-only, not useful for live monitoring) ──

const EXCLUDED_KINDS: Set<GraphNodeKind> = new Set([
  "subscription",
  "resourceGroup",
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
  publicIP: "publicIP",
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
  nic: {
    health: { source: "composite", rules: [] },
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
const NODE_H = 100;
const NODE_GAP = 20;
const SUBNET_INNER_PAD = 44;
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

export type ContainmentDiagnostics = {
  subnetParentCount: number;
  resourceSubnetCount: number;
  pass1: number;
  pass1b: number;
  pass2Nic: number;
  pass2Other: number;
  pass3: number;
  pass4: number;
  pass5: number;
  /** Sample containment chains for debugging */
  sampleChains: string[];
  /** Edge kind distribution in the graph */
  edgeKindCounts: Record<string, number>;
  /** Graph-level node counts by kind */
  graphNodeCounts: { vnet: number; subnet: number; nic: number; total: number };
};

type ContainmentMap = {
  subnetParent: Map<string, string>;   // subnetOrigId → vnetOrigId
  resourceSubnet: Map<string, string>; // resourceOrigId → subnetOrigId
  diagnostics: ContainmentDiagnostics;
};

function buildContainmentMap(graph: ArchitectureGraph): ContainmentMap {
  const subnetParent = new Map<string, string>();
  const resourceSubnet = new Map<string, string>();
  const sampleChains: string[] = [];

  const nodeKindMap = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const nodeNameMap = new Map(graph.nodes.map((n) => [n.id, n.name]));

  // Edge kind distribution for diagnostics
  const edgeKindCounts: Record<string, number> = {};
  for (const e of graph.edges) {
    edgeKindCounts[e.kind] = (edgeKindCounts[e.kind] ?? 0) + 1;
  }

  // ── Pass 1: VNet → Subnet (contains edges) ──
  let pass1Count = 0;
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);
    if (srcKind === "vnet" && tgtKind === "subnet") {
      subnetParent.set(edge.target, edge.source);
      pass1Count++;
    }
  }

  // Diagnostic: report Pass 1 result
  if (pass1Count === 0) {
    const vnets = graph.nodes.filter(n => n.kind === "vnet");
    const subnets = graph.nodes.filter(n => n.kind === "subnet");
    const containsEdges = graph.edges.filter(e => e.kind === "contains");
    console.log(`[containment] Pass 1: 0 subnet→vnet. VNets=${vnets.length}, Subnets=${subnets.length}, Contains edges=${containsEdges.length}`);
    for (const e of containsEdges.slice(0, 5)) {
      console.log(`[containment]   ${e.source.slice(0, 60)}.. (${nodeKindMap.get(e.source) ?? "?"}) → ${e.target.slice(0, 60)}.. (${nodeKindMap.get(e.target) ?? "?"})`);
    }
    if (vnets.length > 0) console.log(`[containment] Sample VNet ID: ${vnets[0]!.id.slice(0, 120)}`);
    if (subnets.length > 0) console.log(`[containment] Sample Subnet ID: ${subnets[0]!.id.slice(0, 120)}`);
  } else {
    console.log(`[containment] Pass 1: ${pass1Count} subnet→vnet from contains edges`);
  }

  // ── Pass 1b: Fallback — infer VNet→Subnet from Azure resource ID hierarchy ──
  let pass1bCount = 0;
  for (const node of graph.nodes) {
    if (node.kind !== "subnet") continue;
    if (subnetParent.has(node.id)) continue;
    const idx = node.id.lastIndexOf("/subnets/");
    if (idx <= 0) continue;
    const parentVnetId = node.id.slice(0, idx);
    const parentKind = nodeKindMap.get(parentVnetId);
    if (parentKind === "vnet") {
      subnetParent.set(node.id, parentVnetId);
      pass1bCount++;
    } else {
      console.log(`[containment] Pass 1b: parent "${parentVnetId.slice(0, 80)}" kind=${parentKind ?? "NOT_FOUND"}`);
    }
  }
  if (pass1bCount > 0) {
    console.log(`[containment] Pass 1b: ID-fallback resolved ${pass1bCount} subnet→vnet`);
  }

  // ── Pass 2: Subnet → Resource (network/connects/attached-to/bound-to edges) ──
  const NETWORK_EDGE_KINDS: Set<EdgeKind> = new Set(["connects", "network", "attached-to", "bound-to"]);
  const nicToSubnet = new Map<string, string>();
  let pass2Nic = 0;
  let pass2Other = 0;
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    const tgtKind = nodeKindMap.get(edge.target);

    if (srcKind === "subnet" && tgtKind === "nic") {
      nicToSubnet.set(edge.target, edge.source);
      resourceSubnet.set(edge.target, edge.source);
      pass2Nic++;
      sampleChains.push(
        `Subnet "${nodeNameMap.get(edge.source) ?? "?"}" → NIC "${nodeNameMap.get(edge.target) ?? "?"}" [${edge.kind}]`,
      );
    } else if (srcKind === "subnet" && tgtKind && !NETWORK_CONTAINER_KINDS.has(tgtKind) && tgtKind !== "aks") {
      resourceSubnet.set(edge.target, edge.source);
      pass2Other++;
      if (pass2Other <= 5) {
        sampleChains.push(
          `Subnet "${nodeNameMap.get(edge.source) ?? "?"}" → ${tgtKind} "${nodeNameMap.get(edge.target) ?? "?"}" [${edge.kind}]`,
        );
      }
    }
  }
  console.log(`[containment] Pass 2: ${pass2Nic} subnet→nic, ${pass2Other} subnet→other`);

  // ── Pass 3: NIC → Resource: resolve through NIC to subnet ──
  let pass3Count = 0;
  for (const edge of graph.edges) {
    if (!NETWORK_EDGE_KINDS.has(edge.kind)) continue;
    const srcKind = nodeKindMap.get(edge.source);
    if (srcKind !== "nic") continue;
    const subnetId = nicToSubnet.get(edge.source);
    if (subnetId && !resourceSubnet.has(edge.target)) {
      resourceSubnet.set(edge.target, subnetId);
      pass3Count++;
      sampleChains.push(
        `NIC "${nodeNameMap.get(edge.source) ?? "?"}" → ${nodeKindMap.get(edge.target) ?? "?"} "${nodeNameMap.get(edge.target) ?? "?"}" via subnet "${nodeNameMap.get(subnetId) ?? "?"}" [${edge.kind}]`,
      );
    }
  }
  console.log(`[containment] Pass 3: ${pass3Count} resources resolved via NIC chain`);

  // ── Pass 4: Resource Group proximity fallback ──
  const subnetRgMap = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "subnet") continue;
    if (!node.resourceGroup) continue;
    const rg = node.resourceGroup.toLowerCase();
    const arr = subnetRgMap.get(rg) ?? [];
    arr.push(node.id);
    subnetRgMap.set(rg, arr);
  }

  let pass4Count = 0;
  for (const node of graph.nodes) {
    if (NETWORK_CONTAINER_KINDS.has(node.kind)) continue;
    if (EXCLUDED_KINDS.has(node.kind)) continue;
    if (resourceSubnet.has(node.id)) continue;
    if (!node.resourceGroup) continue;
    // Skip PaaS resources — they belong outside VNet (connected via PE if at all)
    if (DATA_KINDS.has(node.kind)) continue;
    if (node.kind === "appInsights" || node.kind === "logAnalytics") continue;
    // Public IP addresses are not subnet resources — always external
    if (node.kind === "publicIP") continue;
    const rg = node.resourceGroup.toLowerCase();
    const rgSubnets = subnetRgMap.get(rg);
    if (!rgSubnets || rgSubnets.length === 0) continue;

    // Prefer the subnet that already has the most children
    let bestSubnet = rgSubnets[0]!;
    for (const sid of rgSubnets) {
      if (resourceSubnet.size > 0) {
        const count = [...resourceSubnet.values()].filter(v => v === sid).length;
        const bestCount = [...resourceSubnet.values()].filter(v => v === bestSubnet).length;
        if (count > bestCount) bestSubnet = sid;
      }
    }
    resourceSubnet.set(node.id, bestSubnet);
    pass4Count++;
    if (pass4Count <= 5) {
      sampleChains.push(
        `[RG-fallback] ${node.kind} "${node.name}" → subnet "${nodeNameMap.get(bestSubnet) ?? "?"}" (RG: ${node.resourceGroup})`,
      );
    }
  }
  if (pass4Count > 0) {
    console.log(`[containment] Pass 4: RG-proximity assigned ${pass4Count} resources to subnets`);
  }

  // ── Pass 5: Nuclear failsafe — if containment is still empty, force-assign ──
  // Uses node.id hierarchy (not edges) to force VNet→Subnet containment.
  // Then assigns ALL remaining resources to the nearest subnet by resource group.
  let pass5Count = 0;
  if (subnetParent.size === 0) {
    const vnetNodes = graph.nodes.filter(n => n.kind === "vnet");
    const subnetNodesLocal = graph.nodes.filter(n => n.kind === "subnet");
    console.log(`[containment] Pass 5: FAILSAFE — subnetParent is empty! VNets=${vnetNodes.length}, Subnets=${subnetNodesLocal.length}`);

    if (vnetNodes.length > 0 && subnetNodesLocal.length > 0) {
      // Force VNet→Subnet containment from node IDs
      const vnetIdSet = new Set(vnetNodes.map(n => n.id));
      for (const sub of subnetNodesLocal) {
        const idx = sub.id.lastIndexOf("/subnets/");
        if (idx > 0) {
          const parentVnetId = sub.id.slice(0, idx);
          if (vnetIdSet.has(parentVnetId)) {
            subnetParent.set(sub.id, parentVnetId);
            pass5Count++;
            sampleChains.push(`[Pass5-ID] subnet "${sub.name}" → vnet "${parentVnetId.split("/").pop()}"`);
          } else {
            // Try case-insensitive match
            const match = vnetNodes.find(v => v.id.toLowerCase() === parentVnetId.toLowerCase());
            if (match) {
              subnetParent.set(sub.id, match.id);
              pass5Count++;
              sampleChains.push(`[Pass5-CI] subnet "${sub.name}" → vnet "${match.name}" (case-insensitive)`);
            } else {
              console.log(`[containment] Pass 5: subnet "${sub.name}" parent VNet "${parentVnetId.split("/").pop()}" NOT FOUND in ${vnetNodes.length} VNets`);
              // Dump first VNet ID for comparison
              if (vnetNodes.length > 0) {
                console.log(`[containment] Pass 5: expected="${parentVnetId}"`);
                console.log(`[containment] Pass 5: actual  ="${vnetNodes[0]!.id}"`);
              }
            }
          }
        } else {
          // No /subnets/ in ID — assign to first VNet in same RG
          if (sub.resourceGroup) {
            const sameRgVnet = vnetNodes.find(v => v.resourceGroup?.toLowerCase() === sub.resourceGroup?.toLowerCase());
            if (sameRgVnet) {
              subnetParent.set(sub.id, sameRgVnet.id);
              pass5Count++;
              sampleChains.push(`[Pass5-RG] subnet "${sub.name}" → vnet "${sameRgVnet.name}" (same RG: ${sub.resourceGroup})`);
            }
          }
        }
      }

      // Force resource→subnet containment if still empty
      if (resourceSubnet.size === 0 && subnetParent.size > 0) {
        console.log(`[containment] Pass 5: Also forcing resource→subnet by RG proximity`);
        // Rebuild subnet RG map with freshly resolved subnets
        const subRgMap5 = new Map<string, string[]>();
        for (const sub of subnetNodesLocal) {
          if (!subnetParent.has(sub.id)) continue;
          if (!sub.resourceGroup) continue;
          const rg = sub.resourceGroup.toLowerCase();
          const arr = subRgMap5.get(rg) ?? [];
          arr.push(sub.id);
          subRgMap5.set(rg, arr);
        }

        for (const node of graph.nodes) {
          if (NETWORK_CONTAINER_KINDS.has(node.kind)) continue;
          if (EXCLUDED_KINDS.has(node.kind)) continue;
          if (resourceSubnet.has(node.id)) continue;
          if (!node.resourceGroup) continue;
          // Skip PaaS resources — external to VNet
          if (DATA_KINDS.has(node.kind)) continue;
          if (node.kind === "appInsights" || node.kind === "logAnalytics") continue;
          if (node.kind === "publicIP") continue;
          const rg = node.resourceGroup.toLowerCase();
          const rgSubnets = subRgMap5.get(rg);
          if (!rgSubnets || rgSubnets.length === 0) continue;
          resourceSubnet.set(node.id, rgSubnets[0]!);
          pass5Count++;
          if (pass5Count <= 10) {
            sampleChains.push(`[Pass5-Res] ${node.kind} "${node.name}" → subnet (RG: ${node.resourceGroup})`);
          }
        }
      }
    }
  }
  if (pass5Count > 0) {
    console.log(`[containment] Pass 5: FAILSAFE resolved ${pass5Count} containment entries`);
  }

  // Graph-level node counts
  const graphNodeCounts = {
    vnet: graph.nodes.filter(n => n.kind === "vnet").length,
    subnet: graph.nodes.filter(n => n.kind === "subnet").length,
    nic: graph.nodes.filter(n => n.kind === "nic").length,
    total: graph.nodes.length,
  };

  console.log(`[containment] Final: ${subnetParent.size} subnet→vnet, ${resourceSubnet.size} resource→subnet`);

  // Log all sample chains for server-side debugging
  for (const chain of sampleChains) {
    console.log(`[containment]   ${chain}`);
  }

  return {
    subnetParent,
    resourceSubnet,
    diagnostics: {
      subnetParentCount: subnetParent.size,
      resourceSubnetCount: resourceSubnet.size,
      pass1: pass1Count,
      pass1b: pass1bCount,
      pass2Nic,
      pass2Other,
      pass3: pass3Count,
      pass4: pass4Count,
      pass5: pass5Count,
      sampleChains,
      edgeKindCounts,
      graphNodeCounts,
    },
  };
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

export type GenerateDiagramResult = {
  spec: DiagramSpec;
  containmentDiagnostics: ContainmentDiagnostics;
};

export async function generateDiagramSpec(
  graph: ArchitectureGraph,
  subscriptionId: string,
  layoutMode: DiagramLayoutKind = "elk",
): Promise<GenerateDiagramResult> {
  const now = new Date().toISOString();

  // Build containment map from FULL graph (before filtering)
  const containment = buildContainmentMap(graph);

  // ── Build NIC→VM absorption map ──
  // NICs "bound-to" a VM get embedded as subResources instead of separate nodes.
  const nodeKindLookup = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const nicToVmBound = new Map<string, string>(); // nicOrigId → vmOrigId
  const vmBoundNics = new Map<string, ArchitectureNode[]>(); // vmOrigId → NIC nodes
  for (const edge of graph.edges) {
    if (edge.kind !== "bound-to") continue;
    const srcKind = nodeKindLookup.get(edge.source);
    const tgtKind = nodeKindLookup.get(edge.target);
    if (srcKind === "nic" && (tgtKind === "vm" || tgtKind === "vmss")) {
      nicToVmBound.set(edge.source, edge.target);
      const arr = vmBoundNics.get(edge.target) ?? [];
      const nicNode = graph.nodes.find((n) => n.id === edge.source);
      if (nicNode) arr.push(nicNode);
      vmBoundNics.set(edge.target, arr);
    }
  }

  // ── Build AppGW Frontend IP absorption map ──
  const appGwFrontendIPs = new Map<string, SubResource[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "appGateway") continue;
    if (!node.endpoint) continue;
    appGwFrontendIPs.set(node.id, [{
      id: `${node.id}/frontendIP/0`,
      label: "Frontend IP",
      kind: "frontendIP" as SubResourceKind,
      endpoint: node.endpoint,
      azureResourceId: node.azureId,
    }]);
  }

  // ── Build LB Frontend IP absorption map ──
  function isPrivateIp(ip: string): boolean {
    return /^10\./.test(ip)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      || /^192\.168\./.test(ip);
  }

  const lbFrontendIPs = new Map<string, SubResource[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "lb") continue;
    if (!node.endpoint) continue;
    const isPublic = !isPrivateIp(node.endpoint);
    lbFrontendIPs.set(node.id, [{
      id: `${node.id}/frontendIP/0`,
      label: isPublic ? "Public IP" : "Frontend IP",
      kind: (isPublic ? "publicIP" : "frontendIP") as SubResourceKind,
      endpoint: node.endpoint,
      azureResourceId: node.azureId,
    }]);
  }

  if (vmBoundNics.size > 0) {
    console.log(`[specGenerator] NIC absorption: ${nicToVmBound.size} NICs → ${vmBoundNics.size} VMs`);
  }
  if (appGwFrontendIPs.size > 0) {
    console.log(`[specGenerator] AppGW Frontend IPs: ${appGwFrontendIPs.size} AppGWs with frontend IPs`);
  }
  if (lbFrontendIPs.size > 0) {
    console.log(`[specGenerator] LB Frontend IPs: ${lbFrontendIPs.size} LBs with frontend IPs`);
  }

  /** Collect sub-resources (NICs, Frontend IPs) for a given node by its original ID. */
  function collectSubResources(nodeOrigId: string): SubResource[] | undefined {
    const subs: SubResource[] = [];
    const boundNics = vmBoundNics.get(nodeOrigId);
    if (boundNics) {
      for (const nic of boundNics) {
        subs.push({
          id: idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id),
          label: nic.name,
          kind: "nic" as SubResourceKind,
          endpoint: nic.endpoint,
          azureResourceId: nic.azureId,
        });
        // If the NIC has a public IP (resolved in azure.ts), add as a separate sub-resource
        const pubIp = typeof nic.metadata?.publicIP === "string" ? nic.metadata.publicIP : undefined;
        if (pubIp) {
          subs.push({
            id: `${idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id)}/publicip`,
            label: "Public IP",
            kind: "publicIP" as SubResourceKind,
            endpoint: pubIp,
          });
        }
      }
    }
    const feIPs = appGwFrontendIPs.get(nodeOrigId);
    if (feIPs) subs.push(...feIPs);
    const lbFeIPs = lbFrontendIPs.get(nodeOrigId);
    if (lbFeIPs) subs.push(...lbFeIPs);

    // AKS — show API server connectivity type (private vs public)
    const aksNode = graph.nodes.find((n) => n.id === nodeOrigId && n.kind === "aks");
    if (aksNode?.endpoint) {
      const isPrivate = aksNode.metadata?.isPrivateCluster === true;
      subs.push({
        id: `${nodeOrigId}/apiserver`,
        label: isPrivate ? "Private API" : "Public API",
        kind: "frontendIP" as SubResourceKind,
        endpoint: aksNode.endpoint,
      });
    }

    return subs.length > 0 ? subs : undefined;
  }

  // Filter nodes — exclude infra-only kinds + absorbed NICs + absorbed Public IPs (but keep VNet/Subnet)
  const filteredNodes = graph.nodes.filter(
    (n) =>
      !EXCLUDED_KINDS.has(n.kind) &&
      !(n.kind === "nic" && nicToVmBound.has(n.id)) &&
      !(n.kind === "publicIP" && n.metadata?.absorbed === true),
  );

  // Build node ID set for edge filtering
  const nodeOriginalIds = new Set(filteredNodes.map((n) => n.id));

  // Map original IDs → unique short IDs
  const idMap = buildUniqueIdMap(filteredNodes);

  // Categorize nodes
  const vnetNodes = filteredNodes.filter((n) => n.kind === "vnet");
  const subnetNodes = filteredNodes.filter((n) => n.kind === "subnet");
  const resourceNodes = filteredNodes.filter((n) => !NETWORK_CONTAINER_KINDS.has(n.kind));

  // ── Diagnostic: containment resolution ──
  console.log(`[specGenerator] Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  console.log(`[specGenerator] Filtered: ${vnetNodes.length} VNets, ${subnetNodes.length} Subnets, ${resourceNodes.length} resources`);
  console.log(`[specGenerator] Containment: ${containment.subnetParent.size} subnet→vnet, ${containment.resourceSubnet.size} resource→subnet`);
  if (containment.subnetParent.size === 0 && subnetNodes.length > 0) {
    console.warn(`[specGenerator] WARNING: ${subnetNodes.length} subnets found but none mapped to VNets!`);
    // Log sample subnet IDs and contains edges for debugging
    const containsEdges = graph.edges.filter(e => e.kind === "contains");
    console.warn(`[specGenerator] Contains edges: ${containsEdges.length} total`);
    const vnetSubContains = containsEdges.filter(e => {
      const nodeKindMap = new Map(graph.nodes.map(n => [n.id, n.kind]));
      return nodeKindMap.get(e.source) === "vnet" && nodeKindMap.get(e.target) === "subnet";
    });
    console.warn(`[specGenerator] VNet→Subnet contains edges: ${vnetSubContains.length}`);
    if (subnetNodes.length > 0) {
      console.warn(`[specGenerator] Sample subnet ID: ${subnetNodes[0]!.id.slice(0, 80)}...`);
    }
  }

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

  // ── Diagnostic: final containment ──
  for (const [vShortId, subs] of vnetSubnets) {
    const childCounts = subs.map(s => `${s.shortId}(${subnetChildren.get(s.shortId)?.length ?? 0} children)`);
    console.log(`[specGenerator] VNet "${vShortId}" → ${subs.length} subnets: [${childCounts.join(", ")}]`);
  }

  // Height of sub-resource chip row (NIC/Frontend IP embedded in parent)
  const SUB_RESOURCE_CHIP_H = 26;

  // Effective node height accounting for embedded sub-resources
  function effectiveNodeH(node: ArchitectureNode): number {
    const nicCount = vmBoundNics.get(node.id)?.length ?? 0;
    const feIpCount = appGwFrontendIPs.get(node.id)?.length ?? 0;
    const subCount = nicCount + feIpCount;
    return NODE_H + (subCount > 0 ? SUB_RESOURCE_CHIP_H : 0);
  }

  // Compute subnet dimensions and tier
  const subnetInfo = new Map<string, { width: number; height: number; tier: number }>();
  for (const [subShortId, children] of subnetChildren) {
    const childKinds = new Set(children.map((c) => c.node.kind));
    const w = NODE_W + 2 * SUBNET_INNER_PAD;
    const totalChildH = children.reduce((sum, c) => sum + effectiveNodeH(c.node), 0);
    const h = SUBNET_HEADER + totalChildH + Math.max(0, children.length - 1) * NODE_GAP + SUBNET_INNER_PAD;
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
      label: vnet.name,
      icon: "vnet",
      nodeType: "group",
      width: vSize.width,
      height: vSize.height,
      azureResourceId: vnet.azureId,
      endpoint: vnet.endpoint,
      position: { x: 40, y: cursorY },
      bindings: {},
      metadata: vnet.endpoint ? { addressSpace: vnet.endpoint } : undefined,
      resourceKind: "vnet",
      location: vnet.location,
      resourceGroup: vnet.resourceGroup,
      tags: vnet.tags,
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
        label: sub.node.name,
        icon: "subnet",
        nodeType: "group",
        parentId: vShortId,
        width: sInfo.width,
        height: sInfo.height,
        azureResourceId: sub.node.azureId,
        endpoint: sub.node.endpoint,
        position: { x: subX, y: VNET_HEADER },
        bindings: {},
        metadata: sub.node.endpoint ? { prefix: sub.node.endpoint } : undefined,
        resourceKind: "subnet",
        location: sub.node.location,
        resourceGroup: sub.node.resourceGroup,
      });

      // Place resources within subnet
      const children = subnetChildren.get(sub.shortId) ?? [];
      let childY = SUBNET_HEADER;
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci]!;

        // Build subResources for VM (bound NICs) and AppGW (frontend IPs)
        const childSubResources: SubResource[] = [];
        const boundNics = vmBoundNics.get(child.node.id);
        if (boundNics) {
          for (const nic of boundNics) {
            childSubResources.push({
              id: idMap.get(nic.id) ?? shortId(nic.azureId ?? nic.id),
              label: nic.name,
              kind: "nic" as SubResourceKind,
              endpoint: nic.endpoint,
              azureResourceId: nic.azureId,
            });
          }
        }
        const feIPs = appGwFrontendIPs.get(child.node.id);
        if (feIPs) {
          childSubResources.push(...feIPs);
        }
        const lbFeIPs = lbFrontendIPs.get(child.node.id);
        if (lbFeIPs) {
          childSubResources.push(...lbFeIPs);
        }

        diagramNodes.push({
          id: child.shortId,
          label: child.node.name,
          icon: KIND_TO_ICON[child.node.kind] ?? "custom",
          azureResourceId: child.node.azureId,
          endpoint: child.node.endpoint,
          parentId: sub.shortId,
          groupId: inferGroup(child.node),
          position: { x: SUBNET_INNER_PAD, y: childY },
          bindings: NODE_BINDINGS[child.node.kind] ?? {
            health: { source: "composite", rules: [] },
          },
          metadata: child.node.endpoint ? { privateIP: child.node.endpoint } : undefined,
          resourceKind: child.node.kind,
          location: child.node.location,
          resourceGroup: child.node.resourceGroup,
          tags: child.node.tags,
          subResources: childSubResources.length > 0 ? childSubResources : undefined,
        });
        childY += effectiveNodeH(child.node) + NODE_GAP;
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

  // ── ResourceGroup fallback: When no VNet/Subnet exists, group by RG ──
  if (vnetNodes.length === 0 && subnetNodes.length === 0 && externalResources.length > 0) {
    console.log(`[specGenerator] No VNet/Subnet found — using ResourceGroup-based grouping for ${externalResources.length} resources`);
    const rgGroups = new Map<string, ArchitectureNode[]>();
    for (const res of externalResources) {
      const rg = res.resourceGroup ?? "ungrouped";
      const arr = rgGroups.get(rg) ?? [];
      arr.push(res);
      rgGroups.set(rg, arr);
    }

    const rgContainedIds = new Set<string>();
    for (const [rgName, members] of rgGroups) {
      if (members.length < 2) continue; // Skip single-resource RGs
      const rgShortId = `rg-${rgName.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      const rgH = VNET_HEADER + members.length * NODE_H + Math.max(0, members.length - 1) * NODE_GAP + VNET_PAD;
      const rgW = NODE_W + 2 * VNET_PAD;

      diagramNodes.push({
        id: rgShortId,
        label: rgName,
        icon: "resourceGroup",
        nodeType: "group",
        width: rgW,
        height: rgH,
        position: { x: 40, y: cursorY },
        bindings: {},
      });

      for (let ci = 0; ci < members.length; ci++) {
        const res = members[ci]!;
        const resShortId = idMap.get(res.id)!;
        rgContainedIds.add(resShortId);
        diagramNodes.push({
          id: resShortId,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          parentId: rgShortId,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: { x: VNET_PAD, y: VNET_HEADER + ci * (NODE_H + NODE_GAP) },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
        });
      }
      cursorY += rgH + EXTERNAL_GAP;
    }

    // Place remaining ungrouped resources (single-resource RGs)
    const ungrouped = externalResources.filter(r => !rgContainedIds.has(idMap.get(r.id)!));
    if (ungrouped.length > 0) {
      ungrouped.sort((a, b) => {
        const tierA = DATA_KINDS.has(a.kind) ? 0 : COMPUTE_KINDS.has(a.kind) ? 1 : 2;
        const tierB = DATA_KINDS.has(b.kind) ? 0 : COMPUTE_KINDS.has(b.kind) ? 1 : 2;
        return tierA - tierB;
      });
      const cols = Math.min(ungrouped.length, 5);
      for (let i = 0; i < ungrouped.length; i++) {
        const res = ungrouped[i]!;
        const row = Math.floor(i / cols);
        const col = i % cols;
        diagramNodes.push({
          id: idMap.get(res.id)!,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: {
            x: 40 + col * (NODE_W + NODE_GAP + 20),
            y: cursorY + row * (NODE_H + NODE_GAP),
          },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
        });
      }
    }
  }

  // Place external resources below VNets — PaaS resources near their PE's subnet (when VNets exist)
  if ((vnetNodes.length > 0 || subnetNodes.length > 0) && externalResources.length > 0) {
    // ── Build PE → PaaS target mapping ──
    // privateLink edges: PE → target PaaS resource
    const peTargetMap = new Map<string, string>(); // PE origId → PaaS origId
    const paasToSubnetPos = new Map<string, { subnetX: number; vnetX: number }>(); // PaaS shortId → position hint
    for (const edge of graph.edges) {
      if (edge.kind !== "privateLink") continue;
      const srcKind = nodeKindLookup.get(edge.source);
      if (srcKind === "privateEndpoint") {
        peTargetMap.set(edge.source, edge.target);
      }
    }

    // For each PE with a target, find the subnet the PE lives in and its horizontal position
    for (const [peOrigId, paasOrigId] of peTargetMap) {
      const peShortId = idMap.get(peOrigId);
      const paasShortId = idMap.get(paasOrigId);
      if (!peShortId || !paasShortId) continue;

      // Find the PE's subnet via containment
      const peSubnetOrigId = containment.resourceSubnet.get(peOrigId);
      if (!peSubnetOrigId) continue;
      const peSubnetShortId = idMap.get(peSubnetOrigId);
      if (!peSubnetShortId) continue;

      // Find the subnet's position in the diagram
      const subnetSpec = diagramNodes.find(n => n.id === peSubnetShortId);
      if (!subnetSpec || !subnetSpec.parentId) continue;
      const vnetSpec = diagramNodes.find(n => n.id === subnetSpec.parentId);
      if (!vnetSpec) continue;

      // Compute absolute X position of the subnet
      const subnetAbsX = (vnetSpec.position?.x ?? 0) + (subnetSpec.position?.x ?? 0);
      paasToSubnetPos.set(paasShortId, { subnetX: subnetAbsX, vnetX: vnetSpec.position?.x ?? 0 });
    }

    // Split external resources: PE-connected PaaS vs others
    const peConnectedPaaS: ArchitectureNode[] = [];
    const otherExternal: ArchitectureNode[] = [];
    for (const res of externalResources) {
      const sid = idMap.get(res.id)!;
      if (paasToSubnetPos.has(sid)) {
        peConnectedPaaS.push(res);
      } else {
        otherExternal.push(res);
      }
    }

    // Place PE-connected PaaS near their PE's subnet (aligned horizontally)
    if (peConnectedPaaS.length > 0) {
      console.log(`[specGenerator] PE-connected PaaS: ${peConnectedPaaS.length} resources positioned near their PE subnet`);
      // Group by approximate X position to avoid overlaps
      const placed = new Set<string>();
      const usedPositions: Array<{ x: number; y: number }> = [];

      for (const res of peConnectedPaaS) {
        const sid = idMap.get(res.id)!;
        const posHint = paasToSubnetPos.get(sid)!;
        let targetX = posHint.subnetX;
        let targetY = cursorY;

        // Avoid overlaps with previously placed PaaS nodes
        for (const used of usedPositions) {
          if (Math.abs(targetX - used.x) < NODE_W + NODE_GAP && Math.abs(targetY - used.y) < NODE_H + NODE_GAP) {
            targetX = used.x + NODE_W + NODE_GAP + 20;
          }
        }

        usedPositions.push({ x: targetX, y: targetY });
        placed.add(sid);

        diagramNodes.push({
          id: sid,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: { x: targetX, y: targetY },
          bindings: NODE_BINDINGS[res.kind] ?? { health: { source: "composite", rules: [] } },
          subResources: collectSubResources(res.id),
        });
      }

      // Advance cursor past PE-connected PaaS row
      cursorY += NODE_H + EXTERNAL_GAP;
    }

    // Place remaining external resources in a flat row
    if (otherExternal.length > 0) {
      otherExternal.sort((a, b) => {
        const tierA = DATA_KINDS.has(a.kind) ? 0 : COMPUTE_KINDS.has(a.kind) ? 1 : 2;
        const tierB = DATA_KINDS.has(b.kind) ? 0 : COMPUTE_KINDS.has(b.kind) ? 1 : 2;
        return tierA - tierB;
      });

      const cols = Math.min(otherExternal.length, 5);
      for (let i = 0; i < otherExternal.length; i++) {
        const res = otherExternal[i]!;
        const row = Math.floor(i / cols);
        const col = i % cols;

        diagramNodes.push({
          id: idMap.get(res.id)!,
          label: res.name,
          icon: KIND_TO_ICON[res.kind] ?? "custom",
          azureResourceId: res.azureId,
          endpoint: res.endpoint,
          groupId: inferGroup(res),
          resourceKind: res.kind,
          location: res.location,
          resourceGroup: res.resourceGroup,
          tags: res.tags,
          position: {
            x: 40 + col * (NODE_W + NODE_GAP + 20),
            y: cursorY + row * (NODE_H + NODE_GAP),
          },
          bindings: NODE_BINDINGS[res.kind] ?? {
            health: { source: "composite", rules: [] },
          },
          subResources: collectSubResources(res.id),
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ██ FORCE parentId INJECTION (post-processing safety net) ██
  // Even if containment maps worked, this ensures parentId is ALWAYS set.
  // Uses Azure resource ID hierarchy as the source of truth.
  // ══════════════════════════════════════════════════════════════════

  // Build lowercase azureResourceId → spec node lookup
  const azureIdToSpecNode = new Map<string, DiagramNodeSpec>();
  for (const n of diagramNodes) {
    if (n.azureResourceId) {
      azureIdToSpecNode.set(n.azureResourceId.toLowerCase(), n);
    }
  }

  let forceSubnetParent = 0;
  let forceResourceParent = 0;

  // (A) Force Subnet → VNet parentId from Azure resource ID
  for (const n of diagramNodes) {
    if (n.parentId) continue;
    if (n.icon !== "subnet") continue;
    if (!n.azureResourceId) continue;

    const azIdLower = n.azureResourceId.toLowerCase();
    const idx = azIdLower.lastIndexOf("/subnets/");
    if (idx <= 0) continue;
    const parentVnetAzureId = azIdLower.slice(0, idx);
    const parentSpec = azureIdToSpecNode.get(parentVnetAzureId);
    if (parentSpec) {
      n.parentId = parentSpec.id;
      if (!parentSpec.nodeType) parentSpec.nodeType = "group";
      forceSubnetParent++;
      console.log(`[force-parentId] Subnet "${n.id}" → VNet "${parentSpec.id}"`);
    }
  }

  // (B) Force NIC/Resource → Subnet parentId from containment maps
  // Build reverse: original graph ID → spec short ID using idMap
  const origIdToSpecId = new Map<string, string>();
  for (const [origId, sId] of idMap) {
    origIdToSpecId.set(origId.toLowerCase(), sId);
  }

  for (const n of diagramNodes) {
    if (n.parentId) continue;
    if (n.nodeType === "group") continue;
    if (!n.azureResourceId) continue;

    // Skip PaaS/data resources — they're external services positioned outside VNet.
    // Only their Private Endpoints belong inside subnets, not the PaaS resources themselves.
    if (n.resourceKind && DATA_KINDS.has(n.resourceKind)) continue;
    // Also skip App Insights / Log Analytics — always external PaaS
    if (n.resourceKind === "appInsights" || n.resourceKind === "logAnalytics") continue;

    // Try containment.resourceSubnet (uses original graph IDs)
    const azIdLower = n.azureResourceId.toLowerCase();
    // Find original graph ID that matches (may differ in case from azureResourceId)
    let subnetOrigId: string | undefined;
    for (const [origId, subId] of containment.resourceSubnet) {
      if (origId.toLowerCase() === azIdLower) {
        subnetOrigId = subId;
        break;
      }
    }
    if (!subnetOrigId) continue;

    // Find subnet spec node
    const subnetSpecId = origIdToSpecId.get(subnetOrigId.toLowerCase());
    if (subnetSpecId) {
      const subnetSpec = diagramNodes.find(sn => sn.id === subnetSpecId);
      if (subnetSpec) {
        n.parentId = subnetSpecId;
        if (!subnetSpec.nodeType) subnetSpec.nodeType = "group";
        forceResourceParent++;
      }
    }
  }

  if (forceSubnetParent > 0 || forceResourceParent > 0) {
    console.log(`[force-parentId] Forced ${forceSubnetParent} subnet→VNet + ${forceResourceParent} resource→subnet parentIds`);
  }

  // ── Retarget edges from embedded NICs to their parent VMs ──
  // When a NIC is absorbed as a sub-resource of a VM, edges like LB→NIC
  // would be dropped because the NIC is no longer a separate node.
  // We redirect them to the parent VM so the flow is preserved.
  const retargetedEdges = graph.edges.map((e) => {
    const newSource = nicToVmBound.get(e.source);
    const newTarget = nicToVmBound.get(e.target);
    if (!newSource && !newTarget) return e;
    return { ...e, source: newSource ?? e.source, target: newTarget ?? e.target };
  }).filter((e) => e.source !== e.target); // drop self-loops

  // ── Build edges (all non-containment edges between visible nodes) ──
  const CONTAINMENT_KINDS: Set<EdgeKind> = new Set(["contains"]);
  const filteredEdgesNoNetwork = retargetedEdges.filter(
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
      case "attached-to": return "attached-to";
      case "bound-to": return "bound-to";
      default: return undefined;
    }
  }

  // Edge label helpers for typed edges
  function edgeKindLabel(kind: EdgeKind, edge: ArchitectureEdge): string | undefined {
    switch (kind) {
      case "peering": return `VNet Peering (${edge.metadata?.peeringState ?? "Connected"})`;
      case "privateLink": return "Private Link";
      case "logging": return edge.metadata?.diagnosticCategory ?? "Diagnostics";
      case "attached-to": return "Attached";
      case "bound-to": return "NIC Binding";
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

  // ── Checkpoint 1: Validate parentId references ──
  const specNodeIds = new Set(diagramNodes.map((n) => n.id));
  let validParentCount = 0;
  let brokenParentCount = 0;
  const groupNodesWithSize: string[] = [];

  for (const n of diagramNodes) {
    if (n.parentId) {
      if (specNodeIds.has(n.parentId)) {
        validParentCount++;
      } else {
        brokenParentCount++;
        console.error(`[CP1] BROKEN parentId: "${n.id}" → "${n.parentId}" (parent not found in spec)`);
        n.parentId = undefined; // Remove broken reference to prevent ReactFlow errors
      }
    }
    if (n.nodeType === "group") {
      groupNodesWithSize.push(`${n.id}(${n.width}x${n.height}, parent=${n.parentId ?? "ROOT"})`);
    }
  }

  console.log(`[CP1] parentId validation: ${validParentCount} valid, ${brokenParentCount} broken (fixed)`);
  console.log(`[CP1] Group nodes: ${groupNodesWithSize.join(", ")}`);

  // Sample parentId chain for debugging
  const sampleChildren = diagramNodes.filter((n) => n.parentId).slice(0, 8);
  if (sampleChildren.length > 0) {
    console.log(`[CP1] Sample parentId chains:`);
    for (const c of sampleChildren) {
      const parent = diagramNodes.find((n) => n.id === c.parentId);
      console.log(`  "${c.id}" (${c.nodeType ?? "leaf"}) → "${c.parentId}" (${parent?.nodeType ?? "??"})`);
    }
  }

  const specId = `auto-${subscriptionId.slice(0, 8)}`;

  return {
    spec: {
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
    },
    containmentDiagnostics: containment.diagnostics,
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
