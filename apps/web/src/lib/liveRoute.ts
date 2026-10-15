// Live diagram line routing — pure (tested in apps/api/test/liveRoute.test.ts).
//
// Each line gets a source / target handle (every node has hidden handles on all four sides) and a path:
//  - "step"   right-angled, its vertical part pinned to a corridor between layers or to the gap next to the
//             inbound lane, so lines run through the empty space between boxes instead of across them
//  - "bezier" lines to the right-hand lanes (PaaS, outside, other VNets, egress) and hover-only associations
import type { DiagramEdgeSpec } from "@aud/types";
import type { LiveLayout, Rect } from "./liveLayout";

export type HandleId = "s-l" | "s-r" | "s-t" | "s-b" | "t-l" | "t-r" | "t-t" | "t-b";

export type Route = {
  kind: "step" | "bezier";
  sourceHandle: HandleId;
  targetHandle: HandleId;
  /** step only: x of the vertical part, y of the horizontal part, distance before the first bend */
  centerX?: number;
  centerY?: number;
  offset?: number;
};

const cxOf = (r: Rect) => r.x + r.w / 2;
const cyOf = (r: Rect) => r.y + r.h / 2;
const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

/** Kinds drawn as curves: associations and peerings (shown on hover / as stubs), outbound to the rail */
const CURVED_KINDS = new Set(["natgw-association", "peering", "outbound-internet"]);
/** Horizontal clearance for a line to leave on a side */
const CLEAR = 8;

export function routeEdges(layout: LiveLayout, edges: readonly DiagramEdgeSpec[]): Map<string, Route> {
  const { abs, placeMeta: meta } = layout;
  const parentOf = new Map<string, string | null>([...layout.items.values()].map((b) => [b.id, b.parent]));
  const subnetOf = (id: string) => {
    const p = parentOf.get(id);
    return p && meta.subnetIds.has(p) ? p : null;
  };
  const out = new Map<string, Route>();
  for (const e of edges) {
    const S = abs.get(e.source), T = abs.get(e.target);
    if (!S || !T) continue;
    const sLane = meta.laneOf.get(e.source), tLane = meta.laneOf.get(e.target);
    const sSub = subnetOf(e.source), tSub = subnetOf(e.target);
    const forward = T.x >= right(S) + CLEAR;
    const backward = right(T) <= S.x - CLEAR;

    // Same subnet, stacked: leave from the bottom / top
    if (sSub && sSub === tSub && !forward && !backward) {
      if (cyOf(T) > cyOf(S)) out.set(e.id, { kind: "step", sourceHandle: "s-b", targetHandle: "t-t", centerY: (bottom(S) + T.y) / 2 });
      else out.set(e.id, { kind: "step", sourceHandle: "s-t", targetHandle: "t-b", centerY: (bottom(T) + S.y) / 2 });
      continue;
    }
    const sMeta = sSub ? meta.subnet.get(sSub) : undefined;
    const tMeta = tSub ? meta.subnet.get(tSub) : undefined;
    // Different subnets of one layer (stacked in one column): a C through the corridor on their right
    if (sMeta && tMeta && sSub !== tSub && sMeta.band === tMeta.band && sMeta.layer === tMeta.layer && !forward && !backward) {
      const corridor = meta.corridorX.get(`${sMeta.band}:${sMeta.layer}`);
      const edgeX = Math.max(right(S), right(T));
      out.set(e.id, { kind: "step", sourceHandle: "s-r", targetHandle: "t-r", offset: corridor != null ? Math.max(CLEAR, corridor - edgeX) : 24 });
      continue;
    }

    const sourceHandle: HandleId = backward ? "s-l" : "s-r";
    const targetHandle: HandleId = backward ? "t-r" : "t-l";
    // The inbound and on-premises lanes are on the left; every other lane is on the right
    const left = (l: string | undefined) => l === "ingress" || l === "onprem";
    const toRightLane = (!!tLane && !left(tLane)) || (!!sLane && !left(sLane));
    if (toRightLane || CURVED_KINDS.has(e.edgeKind ?? "") || !!e.exposure || (!forward && !backward)) {
      out.set(e.id, { kind: "bezier", sourceHandle, targetHandle });
      continue;
    }

    // Where the vertical part runs
    let centerX: number;
    if (sMeta && tMeta && sMeta.band === tMeta.band && Math.abs(sMeta.layer - tMeta.layer) === 1) {
      centerX = meta.corridorX.get(`${sMeta.band}:${Math.min(sMeta.layer, tMeta.layer)}`) ?? (right(S) + T.x) / 2;
    } else if (meta.terminals.has(e.source)) {
      // Internet terminal → public LB of the lane, or straight into a VNet entry point
      centerX = meta.laneInnerGapX ?? meta.ingressGapX;
    } else if (left(sLane) || left(tLane)) {
      // Public LB → its backends, gateway → on-premises site: bend in the gap between the left lanes and the VNet
      centerX = meta.ingressGapX;
    } else {
      centerX = forward ? (right(S) + T.x) / 2 : (right(T) + S.x) / 2;
    }
    out.set(e.id, { kind: "step", sourceHandle, targetHandle, centerX, centerY: (cyOf(S) + cyOf(T)) / 2 });
  }
  return out;
}

/** Corner points of a step route (tests and hit checks): source handle → bends → target handle */
export function stepPolyline(route: Route, S: Rect, T: Rect): Array<[number, number]> {
  const port = (h: HandleId, r: Rect): [number, number] => {
    switch (h.slice(2)) {
      case "l": return [r.x, cyOf(r)];
      case "r": return [right(r), cyOf(r)];
      case "t": return [cxOf(r), r.y];
      default: return [cxOf(r), bottom(r)];
    }
  };
  const [sx, sy] = port(route.sourceHandle, S);
  const [tx, ty] = port(route.targetHandle, T);
  if (route.sourceHandle === "s-b" || route.sourceHandle === "s-t") {
    const my = route.centerY ?? (sy + ty) / 2;
    return [[sx, sy], [sx, my], [tx, my], [tx, ty]];
  }
  if (route.sourceHandle === "s-r" && route.targetHandle === "t-r") {
    const x = Math.max(sx, tx) + (route.offset ?? 24);
    return [[sx, sy], [x, sy], [x, ty], [tx, ty]];
  }
  const mx = route.centerX ?? (sx + tx) / 2;
  return [[sx, sy], [mx, sy], [mx, ty], [tx, ty]];
}
