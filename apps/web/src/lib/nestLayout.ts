// ──────────────────────────────────────────────────────────────
// Nested containment layout (pure)
//
// Boxes contain boxes or leaves. Post-order measure with shelf packing,
// pre-order placement. Same input → same coordinates; no DOM access.
// ──────────────────────────────────────────────────────────────

export type NestLeaf = { id: string; kind: "leaf" };
export type NestBox = {
  id: string;
  kind: "box" | "group";
  /** "col" stacks children vertically; default packs rows up to maxW */
  dir?: "row" | "col";
  maxW?: number;
  gap?: number;
  /** Minimum width for the box's own label */
  labelW?: number;
  children: NestNode[];
};
export type NestNode = NestLeaf | NestBox;

export type NestRect = { x: number; y: number; w: number; h: number; collapsed: boolean };

export const NEST = { LEAF_W: 136, LEAF_H: 78, GAP: 12, PAD: 14, FOOT: 38, PILL_W: 184, PILL_H: 58, MIN_BOX_W: 170 } as const;

/** Lay out `tree`. `collapsed` boxes become pills and hide their children. */
export function layoutNest(tree: NestNode, collapsed: ReadonlySet<string>, origin = { x: 16, y: 16 }): Map<string, NestRect> {
  type Measured = { node: NestNode; w: number; h: number; rows: Measured[][]; collapsed: boolean };
  const measure = (n: NestNode): Measured => {
    if (n.kind === "leaf") return { node: n, w: NEST.LEAF_W, h: NEST.LEAF_H, rows: [], collapsed: false };
    if (n.kind === "box" && collapsed.has(n.id)) return { node: n, w: NEST.PILL_W, h: NEST.PILL_H, rows: [], collapsed: true };
    const kids = n.children.map(measure);
    const gap = n.gap ?? NEST.GAP;
    const maxW = n.dir === "col" ? 0 : n.maxW ?? Infinity;
    const rows: Measured[][] = [[]];
    let rw = 0;
    for (const c of kids) {
      const cur = rows[rows.length - 1]!;
      if (cur.length && rw + gap + c.w > maxW) { rows.push([]); rw = 0; }
      rw += (rows[rows.length - 1]!.length ? gap : 0) + c.w;
      rows[rows.length - 1]!.push(c);
    }
    const packed = rows.filter((r) => r.length);
    const innerW = Math.max(0, ...packed.map((r) => r.reduce((s, c) => s + c.w, 0) + gap * (r.length - 1)));
    const innerH = packed.reduce((s, r) => s + Math.max(...r.map((c) => c.h)), 0) + gap * Math.max(0, packed.length - 1);
    const box = n.kind === "box";
    return {
      node: n,
      w: Math.max(innerW + (box ? NEST.PAD * 2 : 0), box ? Math.max(NEST.MIN_BOX_W, (n.labelW ?? 0) + 64) : 0),
      h: innerH + (box ? NEST.PAD + NEST.FOOT : 0),
      rows: packed,
      collapsed: false,
    };
  };
  const out = new Map<string, NestRect>();
  const place = (m: Measured, x: number, y: number) => {
    out.set(m.node.id, { x, y, w: m.w, h: m.h, collapsed: m.collapsed });
    if (!m.rows.length) return;
    const n = m.node as NestBox;
    const gap = n.gap ?? NEST.GAP;
    const box = n.kind === "box";
    let cy = y + (box ? NEST.PAD : 0);
    for (const r of m.rows) {
      const rh = Math.max(...r.map((c) => c.h));
      let cx = x + (box ? NEST.PAD : 0);
      // Bottom-align within a row so box labels (at the bottom) line up
      for (const c of r) { place(c, cx, n.dir === "col" ? cy : cy + rh - c.h); cx += c.w + gap; }
      cy += rh + gap;
    }
  };
  place(measure(tree), origin.x, origin.y);
  return out;
}

/** Parent id of every node (for "nearest visible ancestor" edge roll-up). */
export function parentsOf(tree: NestNode): Map<string, string> {
  const p = new Map<string, string>();
  const walk = (n: NestNode) => {
    if (n.kind === "leaf") return;
    for (const c of n.children) { p.set(c.id, n.id); walk(c); }
  };
  walk(tree);
  return p;
}

/** The node itself, or its outermost collapsed ancestor box. */
export function visibleAncestor(id: string, parents: Map<string, string>, collapsed: ReadonlySet<string>): string {
  let hit = id;
  for (let p = parents.get(id); p; p = parents.get(p)) if (collapsed.has(p)) hit = p;
  return hit;
}
