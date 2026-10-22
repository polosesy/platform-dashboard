// Live diagram line routing — pure (tested in apps/api/test/liveRoute.test.ts).
//
// Each line gets a source / target handle (every node has hidden handles on all four sides) and a path:
//  - "step"   right-angled, its vertical part pinned to a corridor between layers or to the gap next to the
//             inbound lane, so lines run through the empty space between boxes instead of across them
//  - "bezier" lines to the right-hand lanes (PaaS, outside, other VNets, egress) and hover-only associations
//  - "exit"   a line to a right-hand lane whose curve would cross another card or a subnet header: out through the
//             corridor next to its layer, along a free channel to the VNet's right edge, then the curve
// Stacked cards of one subnet are linked by a C on a free side (in the subnet padding / slot gap), never straight down
// through the cards between them; lines from one card share that side as a trunk. Lines are drawn under the cards
// (LiveCanvas), so what still crosses passes behind a card, never over its text.
import type { DiagramEdgeSpec } from "@aud/types";
import { LIVE, type LiveLayout, type Rect } from "./liveLayout";

export type HandleId = "s-l" | "s-r" | "s-t" | "s-b" | "t-l" | "t-r" | "t-t" | "t-b";

export type Route = {
  kind: "step" | "bezier" | "exit";
  sourceHandle: HandleId;
  targetHandle: HandleId;
  /** step only: x of the vertical part, y of the horizontal part, distance before the first bend */
  centerX?: number;
  centerY?: number;
  offset?: number;
  /** exit only: x where the curve to the lane starts (the VNet's right edge); centerX = corridor, centerY = channel */
  railX?: number;
  /** exit only: from railX go on with right angles (down / up to the target's height, then in) instead of a curve */
  railStep?: boolean;
};

const cxOf = (r: Rect) => r.x + r.w / 2;
const cyOf = (r: Rect) => r.y + r.h / 2;
const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

/** Kinds drawn as curves: associations and peerings (shown on hover / as stubs), outbound to the rail */
const CURVED_KINDS = new Set(["natgw-association", "peering", "outbound-internet", "udr-route"]);
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

    const cls = (id: string) => meta.cardClass.get(id);
    const busyL = (id: string) => cls(id) === "L" || cls(id) === "LR";
    const busyR = (id: string) => cls(id) === "R" || cls(id) === "LR";
    // Same subnet, stacked: a C on a free side — in the subnet padding / slot gap, so it passes no card between them.
    // Both sides busy: rows next to each other keep bottom → top (nothing between), otherwise the left side
    if (sSub && sSub === tSub && !forward && !backward) {
      const down = cyOf(T) > cyOf(S);
      const adjacent = down ? T.y - bottom(S) <= LIVE.GAP + 1 : S.y - bottom(T) <= LIVE.GAP + 1;
      if (!busyL(e.source) && !busyL(e.target)) out.set(e.id, { kind: "step", sourceHandle: "s-l", targetHandle: "t-l", offset: CLEAR });
      else if (!busyR(e.source) && !busyR(e.target)) out.set(e.id, { kind: "step", sourceHandle: "s-r", targetHandle: "t-r", offset: CLEAR });
      else if (adjacent && down) out.set(e.id, { kind: "step", sourceHandle: "s-b", targetHandle: "t-t", centerY: (bottom(S) + T.y) / 2 });
      else if (adjacent) out.set(e.id, { kind: "step", sourceHandle: "s-t", targetHandle: "t-b", centerY: (bottom(T) + S.y) / 2 });
      else out.set(e.id, { kind: "step", sourceHandle: "s-l", targetHandle: "t-l", offset: CLEAR });
      continue;
    }
    const sMeta = sSub ? meta.subnet.get(sSub) : undefined;
    const tMeta = tSub ? meta.subnet.get(tSub) : undefined;
    // Different subnets of one layer (stacked in one column): a C through the corridor on their right
    if (sMeta && tMeta && sSub !== tSub && sMeta.band === tMeta.band && sMeta.layer === tMeta.layer && !forward && !backward) {
      // The right side already carries a line (a Private Endpoint's line to its PaaS): the C goes left instead
      if (busyR(e.source) || busyR(e.target)) {
        const leftCorridor = sMeta.layer > 0 ? meta.corridorX.get(`${sMeta.band}:${sMeta.layer - 1}`) : undefined;
        const subX = Math.min(abs.get(sSub!)?.x ?? S.x, abs.get(tSub!)?.x ?? T.x);
        const leftX = leftCorridor ?? subX - LIVE.PAD / 2;
        out.set(e.id, { kind: "step", sourceHandle: "s-l", targetHandle: "t-l", offset: Math.max(CLEAR, Math.min(S.x, T.x) - leftX) });
        continue;
      }
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
      // A card of a subnet → a right-hand lane: when the plain curve would cross another card or a subnet header,
      // leave through the corridor and a free channel to the VNet's edge first
      const ex = forward && tLane && !left(tLane) && sMeta && !CURVED_KINDS.has(e.edgeKind ?? "") ? exitRoute(layout, e.source, e.target, S, T, sMeta) : null;
      // The Internet → a VM's public IP (exposure) or an entry point: when the curve would cross a card of the
      // inbound lane, a right angle through a free gap instead
      const rescue = !ex && forward && (!!e.exposure || meta.terminals.has(e.source)) ? rescueStep(layout, e.source, e.target, S, T) : null;
      out.set(e.id, ex ?? rescue ?? { kind: "bezier", sourceHandle, targetHandle });
      continue;
    }

    // Where the vertical part runs
    let centerX: number;
    if (sMeta && tMeta && sMeta.band === tMeta.band && Math.abs(sMeta.layer - tMeta.layer) === 1) {
      centerX = meta.corridorX.get(`${sMeta.band}:${Math.min(sMeta.layer, tMeta.layer)}`) ?? (right(S) + T.x) / 2;
    } else if (left(sLane) && left(tLane)) {
      // Front Door → its origin LB in the next column of the inbound lane: bend in the gap between the two
      centerX = (right(S) + T.x) / 2;
    } else if (meta.terminals.has(e.source)) {
      // Internet terminal → public LB of the lane, or straight into a VNet entry point
      centerX = meta.laneInnerGapX ?? meta.ingressGapX;
    } else if (left(sLane) || left(tLane)) {
      // Public LB → its backends, gateway → on-premises site: bend in the gap between the left lanes and the VNet
      centerX = meta.ingressGapX;
    } else {
      centerX = forward ? (right(S) + T.x) / 2 : (right(T) + S.x) / 2;
    }
    const step: Route = { kind: "step", sourceHandle, targetHandle, centerX, centerY: (cyOf(S) + cyOf(T)) / 2 };
    // A line that starts in the inbound lane (the Internet → a public LB beyond a Front Door of the same row, a Front
    // Door → an origin past an LB) must not run through a card of that lane: a free gap instead
    const fromLeft = forward && (meta.terminals.has(e.source) || left(sLane));
    out.set(e.id, (fromLeft ? rescueStep(layout, e.source, e.target, S, T, step) : null) ?? step);
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
  if (route.sourceHandle === "s-l" && route.targetHandle === "t-l") {
    const x = Math.min(sx, tx) - (route.offset ?? 24);
    return [[sx, sy], [x, sy], [x, ty], [tx, ty]];
  }
  const mx = route.centerX ?? (sx + tx) / 2;
  return [[sx, sy], [mx, sy], [mx, ty], [tx, ty]];
}

// ── Geometry (also used by the tests) ──

/** Does the segment a→b pass through r shrunk by `inset` (touching an edge is not a hit)? Liang–Barsky. */
export function segmentHitsRect(a: readonly [number, number], b: readonly [number, number], r: Rect, inset = 1): boolean {
  const x0 = r.x + inset, x1 = r.x + r.w - inset, y0 = r.y + inset, y1 = r.y + r.h - inset;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as const) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9;
}

/** React Flow 11's bezier control points (getControlWithCurvature, curvature 0.25) for a right → left line */
export function bezierControls(sx: number, sy: number, tx: number, ty: number): [[number, number], [number, number]] {
  const off = (d: number) => (d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d));
  return [[sx + off(tx - sx), sy], [tx - off(tx - sx), ty]];
}

function sampleBezier(p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number], n = 24): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

/** Points along any route (tests, hit checks): the step corners, or the sampled curve */
export function routePoints(route: Route, S: Rect, T: Rect, samples = 24): Array<[number, number]> {
  if (route.kind === "step") return stepPolyline(route, S, T);
  const sx = route.sourceHandle === "s-l" ? S.x : right(S), sy = cyOf(S);
  const tx = route.targetHandle === "t-r" ? right(T) : T.x, ty = cyOf(T);
  if (route.kind === "exit" && route.centerX != null && route.centerY != null && route.railX != null) {
    if (route.railStep) return [[sx, sy], [route.centerX, sy], [route.centerX, route.centerY], [route.railX, route.centerY], [route.railX, ty], [tx, ty]];
    const [c1, c2] = bezierControls(route.railX, route.centerY, tx, ty);
    return [[sx, sy], [route.centerX, sy], [route.centerX, route.centerY], ...sampleBezier([route.railX, route.centerY], c1, c2, [tx, ty], samples)];
  }
  const [c1, c2] = bezierControls(sx, sy, tx, ty);
  return sampleBezier([sx, sy], c1, c2, [tx, ty], samples);
}

/** The first rect (id) the polyline passes through, skipping `skip` */
export function firstHit(points: ReadonlyArray<[number, number]>, rects: Iterable<[string, Rect]>, skip: ReadonlySet<string>): string | null {
  for (const [id, r] of rects) {
    if (skip.has(id)) continue;
    for (let i = 0; i + 1 < points.length; i++) if (segmentHitsRect(points[i]!, points[i + 1]!, r)) return id;
  }
  return null;
}

type VnetGeometry = { vnet: Rect; obstacles: Array<[string, Rect]> };
const geometryCache = new WeakMap<LiveLayout, Map<string, VnetGeometry>>();

/** Cards and subnet header strips inside one top-level box (the VNet), cached per layout */
function vnetGeometry(layout: LiveLayout, vnetId: string): VnetGeometry | null {
  let byVnet = geometryCache.get(layout);
  if (!byVnet) { byVnet = new Map(); geometryCache.set(layout, byVnet); }
  const hit = byVnet.get(vnetId);
  if (hit) return hit;
  const vnet = layout.abs.get(vnetId);
  if (!vnet) return null;
  const top = (id: string) => {
    let cur = layout.items.get(id);
    while (cur?.parent) cur = layout.items.get(cur.parent);
    return cur?.id;
  };
  const obstacles: Array<[string, Rect]> = [];
  for (const b of [...layout.items.values()].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0))) {
    if (!b.parent || top(b.id) !== vnetId) continue;
    const r = layout.abs.get(b.id);
    if (!r) continue;
    if (layout.placeMeta.subnetIds.has(b.id)) obstacles.push([`head:${b.id}`, { x: r.x, y: r.y, w: r.w, h: Math.min(r.h, LIVE.SUBNET_HEAD) }]);
    else obstacles.push([b.id, r]);
  }
  const g = { vnet, obstacles };
  byVnet.set(vnetId, g);
  return g;
}

/**
 * The exit route of a card's line to a right-hand lane, or null when the plain curve already passes no other card
 * (or no corridor / channel exists — then the curve stays, drawn under the cards). Deterministic.
 */
function exitRoute(layout: LiveLayout, sourceId: string, targetId: string, S: Rect, T: Rect, sMeta: { band: number; layer: number }): Route | null {
  let vnetId: string | undefined = sourceId;
  for (let cur = layout.items.get(sourceId); cur?.parent; cur = layout.items.get(cur.parent)) vnetId = cur.parent;
  if (!vnetId || vnetId === sourceId) return null;
  const g = vnetGeometry(layout, vnetId);
  if (!g) return null;
  const railX = right(g.vnet);
  if (T.x <= railX) return null;
  const skip = new Set([sourceId, targetId]);
  const sx = right(S), sy = cyOf(S), tx = T.x, ty = cyOf(T);
  const [c1, c2] = bezierControls(sx, sy, tx, ty);
  if (!firstHit(sampleBezier([sx, sy], c1, c2, [tx, ty]), g.obstacles, skip)) return null;
  const centerX = layout.placeMeta.corridorX.get(`${sMeta.band}:${sMeta.layer}`) ?? sx + CLEAR;
  if (centerX < sx) return null;
  // Free horizontal channels across [centerX, railX]: the gaps between the obstacles that span that range
  const blocked = g.obstacles
    .filter(([id, r]) => !skip.has(id) && r.x < railX && right(r) > centerX)
    .map(([, r]) => [r.y - 4, bottom(r) + 4] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of blocked) {
    const lastIv = merged[merged.length - 1];
    if (lastIv && iv[0] <= lastIv[1]) lastIv[1] = Math.max(lastIv[1], iv[1]);
    else merged.push([...iv]);
  }
  const lo = g.vnet.y + 4, hi = bottom(g.vnet) - 4;
  const candidates: number[] = [];
  let from = lo;
  for (const [a, b] of merged) {
    if (a - from >= 6) candidates.push(Math.round((from + Math.min(a, hi)) / 2));
    from = Math.max(from, b);
  }
  if (hi - from >= 6) candidates.push(Math.round((from + hi) / 2));
  // A straight run at the source's height when it is free
  if (!merged.some(([a, b]) => sy > a && sy < b) && sy > lo && sy < hi) candidates.push(sy);
  if (!candidates.length) return null;
  const centerY = candidates.sort((a, b) => Math.abs(a - sy) + Math.abs(a - ty) - (Math.abs(b - sy) + Math.abs(b - ty)) || a - b)[0]!;
  // The vertical in the corridor must not run through a card either (it is free space by layout — check anyway)
  if (firstHit([[centerX, sy], [centerX, centerY]], g.obstacles, skip)) return null;
  return { kind: "exit", sourceHandle: "s-r", targetHandle: "t-l", centerX, centerY, railX };
}

/** SVG path of an exit route: rounded right angles to the VNet's edge, then React Flow's curve to the lane */
export function exitPath(sx: number, sy: number, tx: number, ty: number, route: Route, radius = 8): { d: string; labelX: number; labelY: number; length: number } {
  const cx = route.centerX ?? sx, cy = route.centerY ?? sy, rx = route.railX ?? tx;
  const tail: Array<[number, number]> = route.railStep ? [[rx, ty], [tx, ty]] : [];
  const pts: Array<[number, number]> = ([[sx, sy], [cx, sy], [cx, cy], [rx, cy], ...tail] as Array<[number, number]>).filter((p, i, a) => i === 0 || p[0] !== a[i - 1]![0] || p[1] !== a[i - 1]![1]) as Array<[number, number]>;
  let d = `M ${sx} ${sy}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    const next = pts[i + 1];
    if (!next) { d += ` L ${x} ${y}`; break; }
    const [px, py] = pts[i - 1]!;
    const r = Math.min(radius, Math.abs(x - px) / 2 + Math.abs(y - py) / 2, Math.abs(next[0] - x) / 2 + Math.abs(next[1] - y) / 2);
    const inX = x - Math.sign(x - px) * r, inY = y - Math.sign(y - py) * r;
    const outX = x + Math.sign(next[0] - x) * r, outY = y + Math.sign(next[1] - y) * r;
    d += ` L ${inX} ${inY} Q ${x} ${y} ${outX} ${outY}`;
  }
  if (route.railStep) {
    const length = Math.abs(cx - sx) + Math.abs(cy - sy) + Math.abs(rx - cx) + Math.abs(ty - cy) + Math.abs(tx - rx);
    return { d, labelX: (cx + rx) / 2, labelY: cy, length };
  }
  const [c1, c2] = bezierControls(rx, cy, tx, ty);
  d += ` C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${tx} ${ty}`;
  const length = Math.abs(cx - sx) + Math.abs(cy - sy) + Math.abs(rx - cx) + 1.15 * Math.hypot(tx - rx, ty - cy);
  return { d, labelX: (cx + rx) / 2, labelY: cy, length };
}

const allObstacles = new WeakMap<LiveLayout, Array<[string, Rect]>>();

/** Every card and every subnet box of the layout (sorted by id), cached */
function layoutObstacles(layout: LiveLayout): Array<[string, Rect]> {
  const hit = allObstacles.get(layout);
  if (hit) return hit;
  const out: Array<[string, Rect]> = [];
  for (const b of [...layout.items.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const r = layout.abs.get(b.id);
    if (r && b.parent) out.push([b.id, r]);
  }
  allObstacles.set(layout, out);
  return out;
}

/**
 * A curve that would cross a card: try right angles whose vertical part runs in a known empty gap (between the
 * Internet terminals and the inbound cards, between the inbound lane and the VNets, the corridors between layers);
 * the first one that passes no card and no other subnet wins. Null = none is free (the curve stays, under the cards).
 */
function rescueStep(layout: LiveLayout, sourceId: string, targetId: string, S: Rect, T: Rect, first?: Route): Route | null {
  const meta = layout.placeMeta;
  const own = new Set<string>([sourceId, targetId]);
  for (const id of [sourceId, targetId]) for (let cur = layout.items.get(id); cur?.parent; cur = layout.items.get(cur.parent)) own.add(cur.parent);
  const obstacles = layoutObstacles(layout);
  const sx = right(S), sy = cyOf(S), tx = T.x, ty = cyOf(T);
  // Nothing to rescue when the route it would replace (a curve, or the given step) is clear
  if (first) {
    if (!firstHit(stepPolyline(first, S, T), obstacles, own)) return null;
  } else {
    const [c1, c2] = bezierControls(sx, sy, tx, ty);
    if (!firstHit(sampleBezier([sx, sy], c1, c2, [tx, ty]), obstacles, own)) return null;
  }
  const mid = (sx + tx) / 2;
  const xs = [meta.laneInnerGapX, meta.ingressGapX, ...(meta.ingressTierGapX ?? []), ...meta.corridorX.values()]
    .filter((x): x is number => x != null && x > sx + CLEAR && x < tx - CLEAR)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  for (const centerX of [...new Set(xs)]) {
    const route: Route = { kind: "step", sourceHandle: "s-r", targetHandle: "t-l", centerX, centerY: (sy + ty) / 2 };
    if (!firstHit(stepPolyline(route, S, T), obstacles, own)) return route;
  }
  // Two gaps: down the first, across through a free slot between the cards, down the second to the target's height
  const gaps = [...new Set(xs)].sort((a, b) => a - b);
  for (let i = 0; i < gaps.length; i++) for (let j = i + 1; j < gaps.length; j++) {
    const x1 = gaps[i]!, x2 = gaps[j]!;
    const spanning = obstacles.filter(([id, r]) => !own.has(id) && r.x < x2 && right(r) > x1).map(([, r]) => [r.y - 6, bottom(r) + 6] as [number, number]).sort((a, b) => a[0] - b[0]);
    const free: number[] = [];
    let from = Math.min(sy, ty) - 400;
    for (const [a, b] of spanning) {
      if (a - from >= 4) free.push(Math.round((from + a) / 2));
      from = Math.max(from, b);
    }
    free.push(Math.round(from + 12));
    const want = (sy + ty) / 2;
    for (const y of free.sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)) {
      const route: Route = { kind: "exit", sourceHandle: "s-r", targetHandle: "t-l", centerX: x1, centerY: y, railX: x2, railStep: true };
      if (!firstHit(routePoints(route, S, T), obstacles, own)) return route;
    }
  }
  return null;
}
