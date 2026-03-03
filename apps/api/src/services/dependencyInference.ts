/**
 * Dependency Inference Engine
 *
 * Replaces the naive Cartesian-product (compute × data) approach with
 * proximity-based scoring that only emits edges when resources share
 * meaningful organisational or network context.
 *
 * Scoring rubric (max 100):
 *   +40  Same Resource Group
 *   +30  Same VNet (both have subnets in the same virtual network)
 *   +20  Shared environment tag (e.g. env=prod on both)
 *   +10  Shared name prefix (first segment before '-')
 *
 * Edges with score < 40 are dropped.  score / 100 → confidence.
 */

import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureEdge,
  EdgeKind,
} from "../types";

// ── Resource role classification ──

const COMPUTE_KINDS = new Set<string>([
  "aks", "vm", "vmss", "containerApp", "functionApp", "appService",
]);

const DATA_KINDS = new Set<string>([
  "sql", "storage", "redis", "cosmosDb", "postgres", "keyVault", "serviceBus", "eventHub",
]);

// ── Helpers ──

/** Extract the resource group name from an ARM resource ID. */
function rgFromId(azureId: string | undefined): string | undefined {
  if (!azureId) return undefined;
  const m = azureId.match(/\/resourceGroups\/([^/]+)/i);
  return m?.[1]?.toLowerCase();
}

/** First segment before '-' (e.g. "myapp-sql" → "myapp"). */
function namePrefix(name: string): string {
  const idx = name.indexOf("-");
  return (idx > 0 ? name.slice(0, idx) : name).toLowerCase();
}

const ENV_TAG_KEYS = ["env", "environment", "stage"];

function envTagValue(tags: Record<string, string> | undefined): string | undefined {
  if (!tags) return undefined;
  for (const key of ENV_TAG_KEYS) {
    const lower = Object.entries(tags).find(([k]) => k.toLowerCase() === key);
    if (lower) return lower[1].toLowerCase();
  }
  return undefined;
}

// ── VNet membership index ──

/**
 * Build a map: resourceOrigId → Set<vnetOrigId>
 * by resolving containment edges (VNet→Subnet) and network edges (Subnet→Resource).
 */
function buildVNetMembership(graph: ArchitectureGraph): Map<string, Set<string>> {
  const nodeKind = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  // subnet → vnet
  const subnetToVnet = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== "contains") continue;
    if (nodeKind.get(e.source) === "vnet" && nodeKind.get(e.target) === "subnet") {
      subnetToVnet.set(e.target, e.source);
    }
  }

  // NIC → subnet
  const nicToSubnet = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== "network" && e.kind !== "connects") continue;
    if (nodeKind.get(e.source) === "subnet" && nodeKind.get(e.target) === "nic") {
      nicToSubnet.set(e.target, e.source);
    }
  }

  // resource → vnets
  const membership = new Map<string, Set<string>>();

  function addVnet(resId: string, subnetId: string) {
    const vnet = subnetToVnet.get(subnetId);
    if (!vnet) return;
    let s = membership.get(resId);
    if (!s) { s = new Set(); membership.set(resId, s); }
    s.add(vnet);
  }

  for (const e of graph.edges) {
    if (e.kind !== "network" && e.kind !== "connects") continue;
    const srcKind = nodeKind.get(e.source);
    const tgtKind = nodeKind.get(e.target);

    // subnet → resource (direct)
    if (srcKind === "subnet" && tgtKind && tgtKind !== "nic" && tgtKind !== "vnet" && tgtKind !== "subnet") {
      addVnet(e.target, e.source);
    }

    // NIC → resource (indirect through NIC→subnet)
    if (srcKind === "nic") {
      const sub = nicToSubnet.get(e.source);
      if (sub) addVnet(e.target, sub);
    }
  }

  return membership;
}

// ── Protocol inference ──

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

// ── Main export ──

export interface InferredEdge extends ArchitectureEdge {
  kind: "inferred";
  confidence: number;
  metadata: { protocol: string };
}

/**
 * Infer implicit compute→data edges using proximity scoring.
 *
 * @param graph          Full architecture graph (before filtering)
 * @param filteredNodes  Nodes that will appear in the diagram (after EXCLUDED_KINDS removal)
 * @param existingEdgePairs  Set of "sourceShortId→targetShortId" pairs already present
 *                           (to avoid duplicate edges)
 * @param idMap          Original Azure ID → diagram short ID mapping
 */
export function inferImplicitEdges(
  graph: ArchitectureGraph,
  filteredNodes: ArchitectureNode[],
  existingEdgePairs: Set<string>,
  idMap: Map<string, string>,
): InferredEdge[] {
  const computeNodes = filteredNodes.filter((n) => COMPUTE_KINDS.has(n.kind));
  const dataNodes = filteredNodes.filter((n) => DATA_KINDS.has(n.kind));

  if (computeNodes.length === 0 || dataNodes.length === 0) return [];

  // Pre-build indexes
  const vnetMembership = buildVNetMembership(graph);
  const results: InferredEdge[] = [];

  for (const compute of computeNodes) {
    for (const data of dataNodes) {
      const cId = idMap.get(compute.id);
      const dId = idMap.get(data.id);
      if (!cId || !dId) continue;

      // Skip if explicit edge already exists
      if (existingPairs(existingEdgePairs, cId, dId)) continue;

      let score = 0;

      // 1. Same Resource Group (+40)
      const cRg = compute.resourceGroup ?? rgFromId(compute.azureId);
      const dRg = data.resourceGroup ?? rgFromId(data.azureId);
      if (cRg && dRg && cRg.toLowerCase() === dRg.toLowerCase()) {
        score += 40;
      }

      // 2. Same VNet (+30)
      const cVnets = vnetMembership.get(compute.id);
      const dVnets = vnetMembership.get(data.id);
      if (cVnets && dVnets) {
        for (const v of cVnets) {
          if (dVnets.has(v)) { score += 30; break; }
        }
      }

      // 3. Shared environment tag (+20)
      const cEnv = envTagValue(compute.tags);
      const dEnv = envTagValue(data.tags);
      if (cEnv && dEnv && cEnv === dEnv) {
        score += 20;
      }

      // 4. Name prefix similarity (+10)
      if (namePrefix(compute.name) === namePrefix(data.name)) {
        score += 10;
      }

      // Threshold check
      if (score < 40) continue;

      const edgeId = `e:inferred:${compute.id}:${data.id}`;
      results.push({
        id: edgeId,
        source: compute.id,
        target: data.id,
        kind: "inferred",
        confidence: Math.min(score / 100, 1),
        metadata: { protocol: inferProtocol(data.kind) },
      });
    }
  }

  return results;
}

function existingPairs(set: Set<string>, a: string, b: string): boolean {
  return set.has(`${a}→${b}`) || set.has(`${b}→${a}`);
}
