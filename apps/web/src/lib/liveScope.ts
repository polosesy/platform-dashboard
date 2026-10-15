// Live diagram scope and edge layers — pure functions (no React), unit-tested from apps/api/test/liveScope.test.ts.
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec, FaultImpact, LiveDiagramSnapshot } from "@aud/types";

// ── Edge evidence and layers ──

/** A guessed link (naming / grouping), never a configured one. Older specs carry only `edgeKind: "inferred"`. */
export function isInferredEdge(e: Pick<DiagramEdgeSpec, "edgeKind" | "evidence">): boolean {
  return e.evidence === "inferred" || e.edgeKind === "inferred";
}

/** What the toolbar's "연결선" menu switches. Every edge belongs to exactly one layer. */
export type EdgeLayer = "config" | "privateLink" | "privateLinkUsage" | "ingress" | "egress" | "peering" | "publicIp" | "inferred";

export const EDGE_LAYERS: readonly EdgeLayer[] = ["config", "privateLink", "privateLinkUsage", "ingress", "egress", "peering", "publicIp", "inferred"];

/**
 * Configured links and observed Private Link use are on by default; public IP exposure and guesses are opt-in.
 * (Observed use comes from logs, added after layout — lib/plUsage.ts — never from the spec.)
 */
export const DEFAULT_EDGE_LAYERS: ReadonlySet<EdgeLayer> = new Set<EdgeLayer>(["config", "privateLink", "privateLinkUsage", "ingress", "egress", "peering"]);

const isPublicIp = (n: DiagramNodeSpec | undefined) => n?.resourceKind === "publicIP" || n?.icon === "publicIP";

export function edgeLayer(e: DiagramEdgeSpec, nodeById: ReadonlyMap<string, DiagramNodeSpec>): EdgeLayer {
  if (isInferredEdge(e)) return "inferred";
  if (e.edgeKind === "privateLinkUsage") return "privateLinkUsage";
  if (e.edgeKind === "privateLink") return "privateLink";
  if (e.edgeKind === "peering") return "peering";
  if (e.edgeKind === "outbound-internet" || e.edgeKind === "natgw-association" || e.flowType === "egress") return "egress";
  if (isPublicIp(nodeById.get(e.source)) || isPublicIp(nodeById.get(e.target))) return "publicIp";
  // Inbound = lines that start at the Internet; LB / App Gateway → backend routing is configuration
  const src = nodeById.get(e.source);
  if ((src?.resourceKind ?? src?.icon) === "internet") return "ingress";
  return "config";
}

/** Kinds whose direction means something (traffic or a dependency goes one way). Associations get no arrowhead. */
export function isDirectedEdge(e: Pick<DiagramEdgeSpec, "edgeKind" | "flowType" | "evidence">): boolean {
  if (isInferredEdge(e)) return false;
  if (e.edgeKind === "routes" || e.edgeKind === "privateLink" || e.edgeKind === "privateLinkUsage" || e.edgeKind === "outbound-internet") return true;
  return e.flowType === "ingress" || e.flowType === "control";
}

// ── Scope (VNet / region filter) ──

const isGroup = (n: DiagramNodeSpec) => n.nodeType === "group";

/**
 * The part of a diagram the page shows for the selected VNets / regions.
 *
 * 1. The core is frozen first: the selected VNets with everything inside them (or, with only regions
 *    selected, the top-level items in those regions with their contents).
 * 2. It is widened once, along configured links: a top-level neighbour (PaaS, Internet, NAT…) is shown
 *    as is; a neighbour inside another VNet becomes a ghost stub — no parent chain is pulled in, so
 *    exactly the selected VNets appear as boxes. Guessed links widen it only with `includeInferred`
 *    (the "추정 의존성" layer on), so a guess never adds anything to the default view.
 * The result does not depend on edge order. Nothing selected → the whole diagram.
 */
export function scopeSpec(
  spec: DiagramSpec,
  selectedVnets: ReadonlySet<string>,
  selectedRegions: ReadonlySet<string> = new Set(),
  opts: { includeInferred?: boolean } = {},
): DiagramSpec {
  if (selectedVnets.size === 0 && selectedRegions.size === 0) return spec;

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const rootOf = (n: DiagramNodeSpec): DiagramNodeSpec => {
    let cur = n;
    const seen = new Set<string>();
    while (cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = byId.get(cur.parentId);
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  const roots = new Map(spec.nodes.map((n) => [n.id, rootOf(n)]));

  const inScope = (root: DiagramNodeSpec) =>
    (selectedVnets.size === 0 || selectedVnets.has(root.id)) &&
    (selectedRegions.size === 0 || (root.location != null && selectedRegions.has(root.location)));

  const core = new Set(spec.nodes.filter((n) => inScope(roots.get(n.id)!)).map((n) => n.id));

  const extra = new Map<string, DiagramNodeSpec>();
  for (const e of spec.edges) {
    if (isInferredEdge(e) && !opts.includeInferred) continue;
    const pairs: Array<[string, string]> = [[e.source, e.target], [e.target, e.source]];
    for (const [inside, other] of pairs) {
      if (!core.has(inside) || core.has(other) || extra.has(other)) continue;
      const node = byId.get(other);
      if (!node || isGroup(node)) continue;
      const root = roots.get(other)!;
      extra.set(
        other,
        root.id === node.id
          ? node
          : { ...node, parentId: undefined, metadata: { ...node.metadata, ghostOf: root.label } },
      );
    }
  }

  const nodes = spec.nodes.flatMap((n) => (core.has(n.id) ? [n] : extra.has(n.id) ? [extra.get(n.id)!] : []));
  const visible = new Set(nodes.map((n) => n.id));
  const edges = spec.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
  return { ...spec, nodes, edges };
}

// ── Coverage of what is on screen ──

export type ScopeCoverage = {
  nodesWithMetrics: number;
  nodesWithBindings: number;
  edgesWithTraffic: number;
  configuredEdges: number;
};

/** A resource the snapshot can read metrics for (a monitor / log binding, not only the composite health rule) */
export function hasMetricBinding(n: DiagramNodeSpec): boolean {
  return Object.values(n.bindings).some((b) => b.source !== "composite");
}

/** Same counts as the API's `coverage`, restricted to the nodes and edges in view (numerator ⊆ denominator). */
export function scopeCoverage(spec: DiagramSpec, snapshot: LiveDiagramSnapshot | null): ScopeCoverage {
  const liveNodes = new Map((snapshot?.nodes ?? []).map((n) => [n.id, n]));
  const liveEdges = new Map((snapshot?.edges ?? []).map((e) => [e.id, e]));
  const bound = spec.nodes.filter((n) => !isGroup(n) && hasMetricBinding(n));
  return {
    nodesWithBindings: bound.length,
    nodesWithMetrics: bound.filter((n) => Object.values(liveNodes.get(n.id)?.metrics ?? {}).some((v) => v != null)).length,
    configuredEdges: spec.edges.filter((e) => !isInferredEdge(e)).length,
    edgesWithTraffic: spec.edges.filter((e) => liveEdges.get(e.id)?.metricsSource === "measured").length,
  };
}

// ── Fault impact in view ──

/**
 * Fault impacts whose failing resource is on screen, with neighbours outside the view dropped.
 * The toolbar count, the canvas dimming and the panels all read this one list — an impact elsewhere in the
 * subscription must never dim this view while the toolbar says "장애 영향 (0)".
 */
export function scopeImpacts(impacts: readonly FaultImpact[] | undefined, visibleIds: ReadonlySet<string>): FaultImpact[] {
  return (impacts ?? [])
    .filter((fi) => visibleIds.has(fi.sourceNodeId))
    .map((fi) => ({ ...fi, affectedNodeIds: fi.affectedNodeIds.filter((id) => visibleIds.has(id)) }));
}

export type ImpactView = {
  /** Something in view is failing — the rest of the view is dimmed */
  active: boolean;
  roles: Map<string, "source" | "affected">;
  edgeIds: Set<string>;
};

/** Roles for the canvas from the scoped impacts (empty list = toggle off or nothing failing here = nothing dimmed) */
export function impactView(impacts: readonly FaultImpact[]): ImpactView {
  const roles = new Map<string, "source" | "affected">();
  const edgeIds = new Set<string>();
  for (const fi of impacts) {
    for (const id of fi.affectedNodeIds) if (!roles.has(id)) roles.set(id, "affected");
    roles.set(fi.sourceNodeId, "source");
    for (const id of fi.affectedEdgeIds) edgeIds.add(id);
  }
  return { active: roles.size > 0, roles, edgeIds };
}

/**
 * Lines drawn only while one of their ends is hovered or selected: the subnet → NAT association, and a subnet's
 * default outbound path to the Internet (dashed — the subnet header chip already says it). NAT / LB SNAT →
 * Internet stay visible. Not layout edges, so hiding them moves nothing.
 */
export function isFocusOnlyEdge(e: Pick<DiagramEdgeSpec, "edgeKind" | "animation" | "source">, nodeById: ReadonlyMap<string, DiagramNodeSpec>): boolean {
  if (e.edgeKind === "natgw-association") return true;
  const src = nodeById.get(e.source);
  return e.edgeKind === "outbound-internet" && e.animation === "dash" && (src?.icon === "subnet" || src?.resourceKind === "subnet");
}
