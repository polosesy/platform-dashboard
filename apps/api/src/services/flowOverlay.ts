import type { ArchitectureGraph } from "../types";
import type { NetworkFlowPair } from "../types";
import type { ArchitectureFlowEdgeMetric } from "../types";

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function subnetKeyCandidates(raw: string): string[] {
  const s = normalize(raw);
  if (!s) return [];
  const out = new Set<string>();
  out.add(s);

  const i = s.indexOf("/subnets/");
  if (i >= 0) {
    out.add(s.slice(i + "/subnets/".length));
  }

  // Some traffic analytics fields can be formatted like "vnet/subnet".
  if (s.includes("/")) {
    out.add(s.split("/").at(-1) ?? s);
  }

  return [...out].filter(Boolean);
}

export function mapSubnetPairsToGraphEdgeMetrics(graph: ArchitectureGraph, pairs: NetworkFlowPair[]): {
  edges: ArchitectureFlowEdgeMetric[];
  unmatchedPairs: NetworkFlowPair[];
} {
  const subnetIdByKey = new Map<string, string>();

  for (const n of graph.nodes) {
    if (n.kind !== "subnet") continue;
    const id = n.id;
    const name = n.name;
    const azureId = n.azureId ?? "";

    for (const k of subnetKeyCandidates(id)) subnetIdByKey.set(k, id);
    for (const k of subnetKeyCandidates(azureId)) subnetIdByKey.set(k, id);
    for (const k of subnetKeyCandidates(name)) subnetIdByKey.set(k, id);
  }

  const edges: ArchitectureFlowEdgeMetric[] = [];
  const unmatchedPairs: NetworkFlowPair[] = [];

  for (const p of pairs) {
    const src = subnetIdByKey.get(normalize(p.src)) ?? subnetKeyCandidates(p.src).map((k) => subnetIdByKey.get(k)).find(Boolean);
    const dest =
      subnetIdByKey.get(normalize(p.dest)) ?? subnetKeyCandidates(p.dest).map((k) => subnetIdByKey.get(k)).find(Boolean);
    if (!src || !dest) {
      unmatchedPairs.push(p);
      continue;
    }
    edges.push({
      source: src,
      target: dest,
      totalBytes: p.totalBytes,
      allowedFlows: p.allowedFlows,
      deniedFlows: p.deniedFlows,
    });
  }

  return { edges, unmatchedPairs };
}
