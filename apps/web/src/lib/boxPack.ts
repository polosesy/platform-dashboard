// Nested box packing — pure. Shared by the infrastructure diagram (archModel.layoutArch) and the live
// diagram (liveLayout). A box lays its children out in rows (wrapping at maxW) or in a single column,
// below its header; leaves have a fixed size.

export type PackLeaf<S> = { t: "leaf"; shape: S; w: number; h: number };

export type PackBox<S> = {
  t: "box";
  shape: S;
  dir: "row" | "col";
  children: PackNode<S>[];
  /** Height reserved above the children (the box header) */
  head: number;
  /** Inner padding left / right / bottom (the header covers the top) */
  pad: number;
  gap: number;
  /** Unframed boxes only position their children: no padding, no empty-box height */
  framed: boolean;
  minW?: number;
  /** Row width at which children wrap (ignored for "col") */
  maxW: number;
  /** Children that are boxes take the full height of their row (tidy grids of uneven boxes) */
  stretch?: boolean;
};

export type PackNode<S> = PackLeaf<S> | PackBox<S>;

export type Measured<S> = { n: PackNode<S>; w: number; h: number; rows: Measured<S>[][] };

export type Placed<S> = { shape: S; x: number; y: number; w: number; h: number; depth: number; parent: S | null; leaf: boolean };

export function measure<S>(n: PackNode<S>): Measured<S> {
  if (n.t === "leaf") return { n, w: n.w, h: n.h, rows: [] };
  const kids = n.children.map((c) => measure(c));
  const maxW = n.dir === "col" ? 0 : n.maxW;
  const rows: Measured<S>[][] = [[]];
  let rw = 0;
  for (const c of kids) {
    const cur = rows[rows.length - 1]!;
    if (cur.length && rw + n.gap + c.w > maxW) { rows.push([]); rw = 0; }
    rw += (rows[rows.length - 1]!.length ? n.gap : 0) + c.w;
    rows[rows.length - 1]!.push(c);
  }
  const packed = rows.filter((r) => r.length);
  const innerW = Math.max(0, ...packed.map((r) => r.reduce((s, c) => s + c.w, 0) + n.gap * (r.length - 1)));
  const innerH = packed.reduce((s, r) => s + Math.max(...r.map((c) => c.h)), 0) + n.gap * Math.max(0, packed.length - 1);
  const pad = n.framed ? n.pad : 0;
  return {
    n,
    w: Math.max(innerW + pad * 2, n.framed ? n.minW ?? 0 : 0),
    h: n.head + (packed.length === 0 ? (n.framed ? 10 : 0) : innerH + pad),
    rows: packed,
  };
}

/** Absolute positions (top-left at x, y) of every box and leaf, parents before children. */
export function place<S>(m: Measured<S>, x = 0, y = 0): Placed<S>[] {
  const out: Placed<S>[] = [];
  const walk = (cur: Measured<S>, cx0: number, cy0: number, depth: number, parent: S | null, h: number) => {
    out.push({ shape: cur.n.shape, x: cx0, y: cy0, w: cur.w, h, depth, parent, leaf: cur.n.t === "leaf" });
    if (cur.n.t === "leaf") return;
    const box = cur.n;
    const pad = box.framed ? box.pad : 0;
    let cy = cy0 + box.head;
    for (const row of cur.rows) {
      let cx = cx0 + pad;
      const rh = Math.max(...row.map((c) => c.h));
      for (const c of row) {
        walk(c, cx, cy, depth + 1, box.shape, box.stretch && c.n.t === "box" ? rh : c.h);
        cx += c.w + box.gap;
      }
      cy += rh + box.gap;
    }
  };
  walk(m, x, y, 0, null, m.h);
  return out;
}
