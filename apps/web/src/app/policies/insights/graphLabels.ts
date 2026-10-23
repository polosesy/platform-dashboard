// Attack-path graph geometry (pure): lane bands and edge-label placement. Labels are chips drawn above the nodes,
// placed where they cover no node, node caption or other label — a checked fix fades the edge but its label stays
// readable (struck through, "차단됨"), never hidden or covered.

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

/** Lane bands between column centres: the first starts at 0, the last ends at `width` — no gaps, no overlaps */
export function laneBounds(centers: number[], width: number): { x0: number; x1: number }[] {
  return centers.map((c, i) => ({
    x0: i === 0 ? 0 : (centers[i - 1]! + c) / 2,
    x1: i === centers.length - 1 ? width : (c + centers[i + 1]!) / 2,
  }));
}

// Hangul Jamo, CJK punctuation/ideographs, Hangul syllables, full-width forms (code points — no literal text here)
const WIDE: [number, number][] = [[0x1100, 0x11ff], [0x3000, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef]];
const wide = (c: number) => WIDE.some(([a, b]) => c >= a && c <= b);

/** Approximate rendered width at 10.5 px: CJK ≈ 10.5 px, others ≈ 6.2 px */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += wide(ch.codePointAt(0) ?? 0) ? 10.5 : 6.2;
  return Math.ceil(w);
}

/** "a, b, c" → "a +2"; long names cut at `max` characters (the full text goes in a tooltip) */
export function shortLabel(s: string, max = 26): string {
  const parts = s.split(/,\s*/).filter(Boolean);
  const first = parts[0] ?? s;
  const head = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return parts.length > 1 ? `${head} +${parts.length - 1}` : head;
}

/** A point on the edge's cubic curve (the same curve the graph draws: horizontal tangents at both ends) */
export function curvePoint(a: Pt, b: Pt, t: number): Pt {
  const mx = (a.x + b.x) / 2;
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y,
  };
}

const hit = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

export type LabelReq = { key: string; from: Pt; to: Pt; w: number; h: number; priority?: number };
/** A node centre; `captionW` = the widest caption line under it (defaults to `opts.captionW`) */
export type LabelNode = Pt & { captionW?: number };

const area = (p: Box, q: Box) =>
  Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));

/**
 * Chip boxes for edge labels, first come first served (higher priority first — e.g. blocked edges, whose state
 * must stay visible): candidates along the curve, each also nudged up/down. A candidate that covers nothing wins at
 * once; otherwise the one covering least (node circle ×4, other labels ×2, captions ×1) — a narrow gap between two
 * columns must not drop the chip onto a caption just because no spot is perfectly free.
 */
export function placeEdgeLabels(reqs: LabelReq[], nodes: LabelNode[], opts: { nodeR?: number; captionW?: number; captionH?: number } = {}): Map<string, Box> {
  const r = opts.nodeR ?? 30, ch = opts.captionH ?? 42;
  const circles: Box[] = nodes.map((n) => ({ x: n.x - r, y: n.y - r, w: 2 * r, h: 2 * r }));
  const captions: Box[] = nodes.map((n) => {
    const cw = n.captionW ?? opts.captionW ?? 150;
    return { x: n.x - cw / 2, y: n.y + r - 2, w: cw, h: ch }; // label + sub lines
  });
  const placed = new Map<string, Box>();
  const order = [...reqs].sort((p, q) => (q.priority ?? 0) - (p.priority ?? 0));
  for (const req of order) {
    let best: Box | null = null;
    let bestCost = Infinity;
    outer: for (const t of [0.5, 0.38, 0.62, 0.75, 0.25, 0.85, 0.3, 0.7]) {
      const c = curvePoint(req.from, req.to, t);
      // also slide along x: a chip wider than the gap between two columns fits beside, not on, a caption
      for (const [dx, dy] of [0, 0.35, -0.35].flatMap((fx) => [-12, 0, 12, -24, 24, -36, 36].map((d) => [fx * req.w, d] as const))) {
        const box = { x: c.x - req.w / 2 + dx, y: c.y - req.h / 2 + dy, w: req.w, h: req.h };
        const cost =
          circles.reduce((s, b) => s + 4 * area(box, b), 0) +
          [...placed.values()].reduce((s, b) => s + 2 * area(box, b), 0) +
          captions.reduce((s, b) => s + area(box, b), 0) +
          (Math.abs(dy) + Math.abs(dx)) * 0.01; // ties → closer to the curve
        if (cost < bestCost) { best = box; bestCost = cost; }
        if (cost < 1) break outer;
      }
    }
    placed.set(req.key, best!);
  }
  return placed;
}

/** Widest caption line under a graph node (label is bold ~7 px/char, sub lines ~6 px/char) — for `placeEdgeLabels` */
export function captionWidth(label: string, subLines: string[]): number {
  const lw = Math.min(label.length, 26) * 7;
  return Math.max(lw, ...subLines.map((s) => textWidth(s) * 0.95)) + 8;
}
