// Orthogonal line routing for the infrastructure diagram — pure (no React, no DOM; tested in
// apps/api/test/archRoute.test.ts). Reference-diagram rules (Azure Architecture Center style):
//   · lines are axis-aligned and run in the gaps — between tiles, inside a box's padding, between boxes —
//     never through a tile or a box header (the name strip)
//   · each end leaves / enters a tile side at its middle with a short straight stub (the arrowhead sits on it);
//     the side is whichever gives the cheapest path, so it follows where the other end is
//   · cost = length + a penalty per bend (few corners beat a slightly shorter zig-zag)
//   · collinear runs of different sources in one gap are spread a few pixels apart; runs of one source share a
//     track (a trunk), so "one gateway → many backends" reads as one line that branches
// Search: A* on a grid made only of those gap lines (plus the tiles' middle lines for the ports), restricted to a
// window around the two ends first, then the whole diagram; when nothing is free an L-shaped fallback is drawn and
// flagged (counted by the tests, never silent). Deterministic: same input → same points.

export type Side = "l" | "r" | "t" | "b";
export type RRect = { x: number; y: number; w: number; h: number };
/** A framed container: its header strip is an obstacle; with an id it can also be a line end (subnet → NAT, peering) */
export type RouteBox = RRect & { head: number; id?: string };
export type RouteInput = { id: string; source: string; target: string; /** runs with the same bundle share a track (default: the source) */ bundle?: string };
export type Routed = {
  /** Absolute polyline: the source tile's side → … → the target tile's side */
  points: Array<[number, number]>;
  sourceSide: Side;
  targetSide: Side;
  /** No free path — an L through whatever is in the way */
  fallback: boolean;
};

export const ROUTE = {
  /** Port stub length — half the gap between tiles, so a stub ends on the gap's middle line */
  STUB: 7,
  /** Lines inside a box run this far from its border; lines outside a box too */
  LANE: 6,
  /** Penalty per corner (in px of length) */
  BEND: 36,
  /** Distance between parallel runs of different sources */
  NUDGE: 4,
  /** Search window around the two ends before trying the whole diagram */
  WINDOW: 260,
} as const;

type Dir = 0 | 1 | 2 | 3; // 0 = +x, 1 = +y, 2 = −x, 3 = −y
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;
const OUT: Record<Side, Dir> = { r: 0, b: 1, l: 2, t: 3 };
const SIDES: Side[] = ["l", "r", "t", "b"];

const uniqSorted = (v: number[]) => [...new Set(v.map((n) => Math.round(n)))].sort((a, b) => a - b);

/** A line end: a tile (all four sides) or a box (its body below the header — left, right, bottom) */
type End = { rect: RRect; stub: number; sides: Side[]; /** the side midpoints' y range starts below the header */ top: number };

function portOf(r: RRect, s: Side, stub: number, top = r.y): { border: [number, number]; port: [number, number] } {
  const cx = Math.round(r.x + r.w / 2), cy = Math.round(top + (r.y + r.h - top) / 2);
  if (s === "l") return { border: [r.x, cy], port: [r.x - stub, cy] };
  if (s === "r") return { border: [r.x + r.w, cy], port: [r.x + r.w + stub, cy] };
  if (s === "t") return { border: [cx, r.y], port: [cx, r.y - stub] };
  return { border: [cx, r.y + r.h], port: [cx, r.y + r.h + stub] };
}

/** Does an axis-aligned segment cross the open interior of r? (touching an edge is not a hit) */
export function crossesOpen(a: readonly [number, number], b: readonly [number, number], r: RRect): boolean {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  if (x0 === x1) return x0 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
  if (y0 === y1) return y0 > r.y && y0 < r.y + r.h && x1 > r.x && x0 < r.x + r.w;
  return false;
}

/** Binary min-heap of [priority, payload] */
class Heap {
  private a: Array<[number, number, number]> = [];
  get size() { return this.a.length; }
  push(p: number, tie: number, v: number) {
    const a = this.a;
    a.push([p, tie, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j]![0] < p || (a[j]![0] === p && a[j]![1] <= tie)) break;
      [a[i], a[j]] = [a[j]!, a[i]!];
      i = j;
    }
  }
  pop(): [number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const lt = (x: number, y: number) => a[x]![0] < a[y]![0] || (a[x]![0] === a[y]![0] && a[x]![1] < a[y]![1]);
        if (l < a.length && lt(l, m)) m = l;
        if (r < a.length && lt(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

/** Drop repeated and collinear interior points */
function simplify(pts: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    const o = out[out.length - 2];
    if (o && q && ((o[0] === q[0] && q[0] === p[0]) || (o[1] === q[1] && q[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * Routes every edge between the tiles it names. `tiles` = every drawn leaf (also obstacles); `boxes` = framed
 * containers (their header strip is an obstacle; their borders are crossed freely).
 */
export function routeOrthogonal(tiles: ReadonlyMap<string, RRect>, boxes: readonly RouteBox[], edges: readonly RouteInput[]): Map<string, Routed> {
  const { STUB, LANE, BEND, WINDOW } = ROUTE;
  const obstacles: RRect[] = [...tiles.values(), ...boxes.filter((b) => b.head > 0).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.head }))];
  const boxById = new Map(boxes.filter((b) => b.id).map((b) => [b.id!, b]));
  const endOf = (id: string): End | null => {
    const t = tiles.get(id);
    if (t) return { rect: t, stub: STUB, sides: SIDES, top: t.y };
    const b = boxById.get(id);
    return b ? { rect: b, stub: LANE, sides: ["l", "r", "b"], top: b.y + b.head } : null;
  };
  const boxEnds = new Set(edges.flatMap((e) => [e.source, e.target]).filter((id) => !tiles.has(id) && boxById.has(id)));

  // ── grid lines: tile gaps (stub ends) and middles, box padding and outside lanes ──
  const xv: number[] = [], yv: number[] = [];
  for (const r of tiles.values()) {
    xv.push(r.x - STUB, r.x + r.w + STUB, r.x + r.w / 2);
    yv.push(r.y - STUB, r.y + r.h + STUB, r.y + r.h / 2);
  }
  for (const id of boxEnds) {
    const b = boxById.get(id)!;
    xv.push(b.x + b.w / 2);
    yv.push(b.y + b.head + (b.h - b.head) / 2);
  }
  for (const b of boxes) {
    xv.push(b.x - LANE, b.x + LANE, b.x + b.w - LANE, b.x + b.w + LANE, b.x - 2 * LANE - 2, b.x + b.w + 2 * LANE + 2);
    yv.push(b.y - LANE, b.y + b.head + LANE, b.y + b.h - LANE, b.y + b.h + LANE, b.y - 2 * LANE - 2, b.y + b.h + 2 * LANE + 2);
  }
  const xs = uniqSorted(xv), ys = uniqSorted(yv);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const NY = ys.length;

  // Obstacle intervals crossing each grid line (lazy): x-line → [y0, y1] of obstacles whose open x-range holds it
  const vCache = new Map<number, Array<[number, number]>>(), hCache = new Map<number, Array<[number, number]>>();
  const vLine = (i: number) => {
    let l = vCache.get(i);
    if (!l) { const X = xs[i]!; l = obstacles.filter((o) => X > o.x && X < o.x + o.w).map((o) => [o.y, o.y + o.h] as [number, number]); vCache.set(i, l); }
    return l;
  };
  const hLine = (j: number) => {
    let l = hCache.get(j);
    if (!l) { const Y = ys[j]!; l = obstacles.filter((o) => Y > o.y && Y < o.y + o.h).map((o) => [o.x, o.x + o.w] as [number, number]); hCache.set(j, l); }
    return l;
  };
  const free = (line: Array<[number, number]>, a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (const [s, e] of line) if (s < hi && e > lo) return false;
    return true;
  };
  /** Is the grid point itself inside an obstacle? */
  const inside = (i: number, j: number) => vLine(i).some(([s, e]) => ys[j]! > s && ys[j]! < e);

  type Port = { side: Side; border: [number, number]; port: [number, number]; i: number; j: number };
  const portsOf = (end: End): Port[] =>
    end.sides.map((side) => {
      const p = portOf(end.rect, side, end.stub, end.top);
      return { side, ...p, i: xi.get(Math.round(p.port[0]))!, j: yi.get(Math.round(p.port[1]))! };
    }).filter((p) => p.i !== undefined && p.j !== undefined && !inside(p.i, p.j));

  const search = (S: End, T: End, win: RRect | null): { path: Array<[number, number]>; s: Port; t: Port } | null => {
    const sp = portsOf(S), tp = portsOf(T);
    if (!sp.length || !tp.length) return null;
    const goal = new Map<number, Port[]>();
    for (const p of tp) { const k = p.i * NY + p.j; (goal.get(k) ?? goal.set(k, []).get(k)!).push(p); }
    const h = (i: number, j: number) => Math.min(...tp.map((p) => Math.abs(xs[i]! - p.port[0]) + Math.abs(ys[j]! - p.port[1])));
    const inWin = (i: number, j: number) => !win || (xs[i]! >= win.x && xs[i]! <= win.x + win.w && ys[j]! >= win.y && ys[j]! <= win.y + win.h);
    const g = new Map<number, number>();
    const prev = new Map<number, number>();
    const startOf = new Map<number, Port>();
    const heap = new Heap();
    let tie = 0;
    for (const p of sp) {
      const st = (p.i * NY + p.j) * 4 + OUT[p.side];
      g.set(st, 0);
      startOf.set(st, p);
      heap.push(h(p.i, p.j), tie++, st);
    }
    // Final pseudo-states: −1 − index into `finals`
    const finals: Array<{ st: number; t: Port }> = [];
    while (heap.size) {
      const [f, , st] = heap.pop();
      if (st < 0) {
        const { st: last, t } = finals[-1 - st]!;
        const pts: Array<[number, number]> = [];
        let cur: number | undefined = last;
        let first = last;
        while (cur !== undefined) {
          const cell = cur >> 2;
          pts.push([xs[Math.floor(cell / NY)]!, ys[cell % NY]!]);
          first = cur;
          cur = prev.get(cur);
        }
        pts.reverse();
        return { path: pts, s: startOf.get(first)!, t };
      }
      const gc = g.get(st)!;
      if (f - h(Math.floor((st >> 2) / NY), (st >> 2) % NY) > gc + 1e-6) continue; // stale
      const cell = st >> 2, d = (st & 3) as Dir;
      const i = Math.floor(cell / NY), j = cell % NY;
      const goals = goal.get(cell);
      if (goals) for (const t of goals) {
        // Arriving straight into the side costs nothing; a corner at the port costs a bend
        const extra = d === ((OUT[t.side] + 2) % 4) ? 0 : BEND;
        finals.push({ st, t });
        heap.push(gc + extra, tie++, -finals.length);
      }
      for (const nd of [0, 1, 2, 3] as Dir[]) {
        if (nd === (d + 2) % 4) continue;
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= xs.length || nj >= NY || !inWin(ni, nj)) continue;
        const ok = nd % 2 === 0 ? free(hLine(j), xs[i]!, xs[ni]!) : free(vLine(i), ys[j]!, ys[nj]!);
        if (!ok) continue;
        const ns = (ni * NY + nj) * 4 + nd;
        const ng = gc + Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!) + (nd === d ? 0 : BEND);
        if (ng < (g.get(ns) ?? Infinity)) {
          g.set(ns, ng);
          prev.set(ns, st);
          heap.push(ng + h(ni, nj), tie++, ns);
        }
      }
    }
    return null;
  };

  const out = new Map<string, Routed>();
  const order = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of order) {
    const SE = endOf(e.source), TE = endOf(e.target);
    if (!SE || !TE) continue;
    const S = SE.rect, T = TE.rect;
    const x0 = Math.min(S.x, T.x) - WINDOW, y0 = Math.min(S.y, T.y) - WINDOW;
    const win = { x: x0, y: y0, w: Math.max(S.x + S.w, T.x + T.w) + WINDOW - x0, h: Math.max(S.y + S.h, T.y + T.h) + WINDOW - y0 };
    const found = search(SE, TE, win) ?? search(SE, TE, null);
    if (found) {
      out.set(e.id, { points: simplify([found.s.border, ...found.path, found.t.border]), sourceSide: found.s.side, targetSide: found.t.side, fallback: false });
      continue;
    }
    // Fallback: right of the source → left of the target, one corner column in between
    const a = portOf(S, "r", SE.stub, SE.top), b = portOf(T, "l", TE.stub, TE.top);
    const mx = Math.round((a.port[0] + b.port[0]) / 2);
    out.set(e.id, { points: simplify([a.border, a.port, [mx, a.port[1]], [mx, b.port[1]], b.port, b.border]), sourceSide: "r", targetSide: "l", fallback: true });
  }
  nudge(out, edges, obstacles);
  return out;
}

/**
 * Spread collinear runs of different bundles (default: the source) in the same lane: track 0 stays, then +n, −n,
 * +2n, −2n. A shift that would touch an obstacle is skipped (the runs overlap rather than cut a tile).
 */
function nudge(routes: Map<string, Routed>, edges: readonly RouteInput[], obstacles: readonly RRect[]) {
  const bundleOf = new Map(edges.map((e) => [e.id, e.bundle ?? e.source]));
  type Seg = { id: string; k: number; bundle: string; lo: number; hi: number; vertical: boolean; at: number };
  const groups = new Map<string, Seg[]>();
  const ids = [...routes.keys()].sort();
  for (const id of ids) {
    const pts = routes.get(id)!.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [a, b] = [pts[k]!, pts[k + 1]!];
      const vertical = a[0] === b[0];
      const at = vertical ? a[0] : a[1];
      const lo = vertical ? Math.min(a[1], b[1]) : Math.min(a[0], b[0]);
      const hi = vertical ? Math.max(a[1], b[1]) : Math.max(a[0], b[0]);
      const key = `${vertical ? "v" : "h"}:${at}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push({ id, k, bundle: bundleOf.get(id) ?? id, lo, hi, vertical, at });
    }
  }
  const offsets = [0, 1, -1, 2, -2];
  for (const key of [...groups.keys()].sort()) {
    const segs = groups.get(key)!;
    if (segs.length < 2) continue;
    segs.sort((p, q) => (p.bundle < q.bundle ? -1 : p.bundle > q.bundle ? 1 : p.lo - q.lo || (p.id < q.id ? -1 : 1)));
    const tracks: Array<Array<{ bundle: string; lo: number; hi: number }>> = [];
    for (const s of segs) {
      let t = tracks.findIndex((tr) => tr.every((o) => o.bundle === s.bundle || o.hi <= s.lo || o.lo >= s.hi));
      if (t < 0) { tracks.push([]); t = tracks.length - 1; }
      if (t >= offsets.length) t = 0;
      tracks[t]!.push(s);
      const off = offsets[t]! * ROUTE.NUDGE;
      if (!off) continue;
      const pts = routes.get(s.id)!.points;
      const a = pts[s.k]!, b = pts[s.k + 1]!;
      const na: [number, number] = s.vertical ? [a[0] + off, a[1]] : [a[0], a[1] + off];
      const nb: [number, number] = s.vertical ? [b[0] + off, b[1]] : [b[0], b[1] + off];
      // the shifted run and the two neighbours it stretches must stay clear (a tile's own side is fine)
      const before = pts[s.k - 1], after = pts[s.k + 2];
      const checks: Array<[[number, number], [number, number]]> = [[na, nb]];
      if (before) checks.push([before, na]);
      if (after) checks.push([nb, after]);
      if (checks.some(([p, q]) => obstacles.some((o) => crossesOpen(p, q, o)))) continue;
      pts[s.k] = na;
      pts[s.k + 1] = nb;
    }
  }
}

/** SVG path of a polyline with rounded corners (radius capped by half of each neighbouring run) */
export function roundedPath(points: ReadonlyArray<readonly [number, number]>, radius = 6): string {
  if (points.length < 2) return "";
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let k = 1; k < points.length - 1; k++) {
    const [p, c, n] = [points[k - 1]!, points[k]!, points[k + 1]!];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { d += ` L${c[0]},${c[1]}`; continue; }
    const a: [number, number] = [c[0] - ((c[0] - p[0]) / l1) * r, c[1] - ((c[1] - p[1]) / l1) * r];
    const b: [number, number] = [c[0] + ((n[0] - c[0]) / l2) * r, c[1] + ((n[1] - c[1]) / l2) * r];
    d += ` L${a[0]},${a[1]} Q${c[0]},${c[1]} ${b[0]},${b[1]}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${last[0]},${last[1]}`;
}

/** Where a count label goes: the middle of the longest run, away from both ends */
export function labelPoint(points: ReadonlyArray<readonly [number, number]>): [number, number] {
  let best = 0, at: [number, number] = [points[0]![0], points[0]![1]];
  for (let k = 0; k + 1 < points.length; k++) {
    const [a, b] = [points[k]!, points[k + 1]!];
    const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    if (len > best) { best = len; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  }
  return at;
}
