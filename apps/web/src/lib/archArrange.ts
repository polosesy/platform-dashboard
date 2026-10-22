// Manual arrangement and manual connectors on the infrastructure diagram — pure (no React, no DOM; tested in
// apps/api/test/archArrange.test.ts).
//
// Arrangement = ORDER and GRID CELLS, never coordinates: the user moves a tile to another cell of its own container's
// grid (an empty one too — the container grows or keeps the gap), sets a container's column count, or moves a subnet
// / VNet to another slot; the layout (boxPack's tidy rows) places it there — always aligned, lines re-routed, the same
// picture on screen, in draw.io and in PNG. A shape never leaves its container: a VM moved into another subnet would
// misstate where it lives.
// Connectors = the user's geometry for a relationship that EXISTS in the configuration: a pair with no configured
// relationship (any layer, even switched off) is refused with its reason. A manual line replaces the auto line(s)
// of that pair and keeps the relationship's own colour, dash and arrow direction — the meaning never changes.
import { ARCH, ARCH_EDGE_KINDS, type ArchContainerGrid, type ArchDrawEdge, type ArchLayout, type ArchModel, type ArchPlaced } from "./archModel";
import type { RRect, Side } from "./archRoute";

export type LineStyle = "straight" | "curve" | "elbow";
export type ManualLine = {
  source: string; target: string; style: LineStyle;
  /** elbow: where the middle run sits, 0.1..0.9 of the span */
  bend?: number;
  /** curve: how far the middle bulges sideways, as a share of the chord (−1..1; 0 = the plain S curve) */
  bulge?: number;
};
export type Arrangement = {
  order: ReadonlyMap<string, readonly string[]>;
  /** Tile containers: the user's column count and cells (lib/archModel ArchContainerGrid) */
  grid: ReadonlyMap<string, ArchContainerGrid>;
  lines: readonly ManualLine[];
};
export const EMPTY_ARRANGEMENT: Arrangement = { order: new Map(), grid: new Map(), lines: [] };

export type MoveResult =
  | { containerId: string; order: string[] }
  /** A tile container: its new grid (every unit's cell) */
  | { containerId: string; grid: ArchContainerGrid; swapWith: string | null }
  /** A VNet's subnets (vband:<vnet>): every column top → bottom, and the row below */
  | { containerId: string; band: { columns: string[][]; rest: string[] } }
  | { refused: "notMovable" | "outsideParent" | "noChange" | "follower" };

/** One cell of a tile container's grid as the overlay draws it while dragging */
export type DropCell = {
  rect: RRect; col: number; row: number;
  /** The unit in it (tile id, or stack id), null = empty */
  occupant: string | null;
  /** The extra column / row: dropping there grows the container */
  extra: boolean;
  /** A member of an expanded stack: it moves with its stack, not a target */
  locked: boolean;
};

/** What the arrange overlay draws while a shape is dragged (lib/archArrange dropPlan) */
export type DropPlan = {
  containerId: string;
  /** The area the shape may move in (a box's body, or a removed wrapper's span) */
  area: RRect;
  /** The container's slots as drawn now (dashed boxes) */
  slots: RRect[];
  /** Insertion bar where the shape would land; null when the drop is outside the area */
  bar: RRect | null;
  /** The slot the shape takes, when every slot has the same size (tile containers) */
  target: RRect | null;
  /** Outside the area: the drop snaps back */
  refused: boolean;
  /** The order after the drop (absent when refused or unchanged) */
  order?: string[];
  /** Tile containers: every cell (empty ones and the extra column / row too), and the grid after the drop */
  cells?: DropCell[];
  grid?: ArchContainerGrid;
  /** The tile that swaps into the moved tile's old cell */
  swapWith?: string | null;
  /** The container body after the drop, when it grows */
  grow?: RRect | null;
  /** Alignment guides through the target cell (its centre lines across the container) */
  guides?: { x: number; y: number };
  /** VNet subnets: the places a subnet can go — each column, a new column on the right, the row below */
  zones?: Array<{ rect: RRect; kind: "col" | "newCol" | "rest"; active: boolean }>;
  band?: { columns: string[][]; rest: string[] };
};

const rectOf = (s: { x: number; y: number; w: number; h: number }): RRect => ({ x: s.x, y: s.y, w: s.w, h: s.h });
const center = (r: RRect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

/** The drawn shape of a container child id (a stack that is open is drawn as its fold tile) */
function drawnOf(layout: ArchLayout, id: string): ArchPlaced | undefined {
  return layout.shapes.find((s) => s.id === id) ?? layout.shapes.find((s) => s.id === `fold:${id}`);
}

/** The area a container's children live in: a box's body below its header, or (a removed wrapper) its children's span */
function containerArea(layout: ArchLayout, containerId: string, kids: readonly ArchPlaced[]): RRect | null {
  const box = layout.shapes.find((s) => s.id === containerId && s.shape === "box");
  if (box && box.shape === "box") return { x: box.x, y: box.y + box.head, w: box.w, h: box.h - box.head };
  if (!kids.length) return null;
  const x0 = Math.min(...kids.map((k) => k.x)), y0 = Math.min(...kids.map((k) => k.y));
  const x1 = Math.max(...kids.map((k) => k.x + k.w)), y1 = Math.max(...kids.map((k) => k.y + k.h));
  return { x: x0 - 14, y: y0 - 14, w: x1 - x0 + 28, h: y1 - y0 + 28 };
}

/** The siblings of a container as drawn (stacks as their fold tile), each with its rect */
function siblings(layout: ArchLayout, containerId: string): Array<{ id: string; s: ArchPlaced }> {
  return (layout.containers.get(containerId) ?? []).map((id) => ({ id, s: drawnOf(layout, id) })).filter((x): x is { id: string; s: ArchPlaced } => !!x.s);
}

/**
 * Where a dragged shape lands: the slot in its own container nearest the point (reading order — nearest row, then
 * the columns left of it), with what the overlay draws (area, slots, insertion bar). Outside the container: refused.
 */
export function dropPlan(layout: ArchLayout, shapeId: string, point: readonly [number, number]): DropPlan | { refused: "notMovable" | "follower" } {
  const containerId = layout.containerOf.get(shapeId);
  if (!containerId) return { refused: layout.followers.has(shapeId) ? "follower" : "notMovable" };
  const moving = shapeId.startsWith("fold:") ? shapeId.slice(5) : shapeId;
  const all = siblings(layout, containerId);
  const ids = all.map((x) => x.id);
  const others = all.filter((x) => x.id !== moving);
  const area = containerArea(layout, containerId, all.map((x) => x.s));
  const slots = all.map((x) => rectOf(x.s));
  const uniform = slots.length > 0 && slots.every((r) => r.w === slots[0]!.w && r.h === slots[0]!.h) && ![...layout.followers.values()].some((st) => ids.includes(st));
  const base = { containerId, area: area ?? { x: 0, y: 0, w: 0, h: 0 }, slots };
  if (!area || point[0] < area.x || point[0] > area.x + area.w || point[1] < area.y || point[1] > area.y + area.h) return { ...base, bar: null, target: null, refused: true };
  // Rows of the remaining siblings (boxPack rows share a top), nearest row by vertical centre
  const rows = new Map<number, Array<{ id: string; s: ArchPlaced }>>();
  for (const o of others) (rows.get(o.s.y) ?? rows.set(o.s.y, []).get(o.s.y)!).push(o);
  const ys = [...rows.keys()].sort((a, b) => a - b);
  let index = others.length;
  let bar: RRect | null = null;
  // One child per row (a column — PaaS zones, a lane): the index from the height, a horizontal bar in the gap
  const column = others.length > 0 && ys.length === others.length;
  if (column) {
    const sorted = others.slice().sort((a, b) => a.s.y - b.s.y);
    index = sorted.filter((o) => o.s.y + o.s.h / 2 < point[1]).length;
    const ref = sorted[Math.min(index, sorted.length - 1)]!.s;
    const y = index < sorted.length ? sorted[index]!.s.y - 7 : sorted.at(-1)!.s.y + sorted.at(-1)!.s.h + 7;
    bar = { x: ref.x, y: y - 1.5, w: Math.max(...sorted.map((o) => o.s.w)), h: 3 };
    const ordered = [...sorted.slice(0, index).map((o) => o.id), moving, ...sorted.slice(index).map((o) => o.id)];
    const unchanged = ordered.join("\u0000") === ids.join("\u0000");
    return { ...base, bar, target: null, refused: false, ...(unchanged ? {} : { order: ordered }) };
  }
  if (ys.length) {
    const rowMid = (y: number) => y + Math.max(...rows.get(y)!.map((o) => o.s.h)) / 2;
    const y = ys.reduce((best, cur) => (Math.abs(rowMid(cur) - point[1]) < Math.abs(rowMid(best) - point[1]) ? cur : best), ys[0]!);
    const row = rows.get(y)!.sort((a, b) => a.s.x - b.s.x);
    const before = ys.filter((v) => v < y).reduce((n, v) => n + rows.get(v)!.length, 0);
    const inRow = row.filter((o) => center(rectOf(o.s))[0] < point[0]).length;
    index = before + inRow;
    const h = Math.max(...row.map((o) => o.s.h));
    const x = inRow < row.length ? row[inRow]!.s.x - 7 : row.at(-1)!.s.x + row.at(-1)!.s.w + 7;
    bar = { x: x - 1.5, y, w: 3, h };
  }
  const order = [...others.slice(0, index).map((o) => o.id), moving, ...others.slice(index).map((o) => o.id)];
  const same = order.join("\u0000") === ids.join("\u0000");
  // The slot it takes: with equal slots, the order position of the moved shape is the slot of that position
  const target = uniform ? slots.slice().sort((a, b) => a.y - b.y || a.x - b.x)[order.indexOf(moving)] ?? null : null;
  return { ...base, bar, target, refused: false, ...(same ? {} : { order }) };
}

// ── grid (tile containers: subnets, lanes, PaaS groups, global) ──

const unitOf = (shapeId: string) => (shapeId.startsWith("fold:") ? shapeId.slice(5) : shapeId);
const cellRect = (g: NonNullable<ReturnType<ArchLayout["grids"]["get"]>>, col: number, row: number): RRect =>
  ({ x: g.x0 + col * (g.cellW + g.gap), y: g.y0 + row * (g.cellH + g.gap), w: g.cellW, h: g.cellH });

/** Every unit of a tile container in reading order (holes and stack members left out) */
export function unitSequence(layout: ArchLayout, containerId: string): string[] {
  return (layout.grids.get(containerId)?.slots ?? []).filter((x) => x.unit && !x.follower).map((x) => x.unit!);
}

/**
 * Where a dragged tile lands in its container's grid: the cell nearest the point among every cell — occupied, empty,
 * one extra column on the right (up to ARCH.MAX_COLS) and one extra row below. An empty cell = move there (the gap it
 * leaves stays); an occupied cell = swap; outside = refused. The grid after the drop lists every unit's cell, with the
 * column count, so the picture stays as the user left it.
 */
export function cellPlan(layout: ArchLayout, shapeId: string, point: readonly [number, number]): DropPlan | { refused: "notMovable" | "follower" } | null {
  const containerId = layout.containerOf.get(shapeId);
  if (!containerId) return { refused: layout.followers.has(shapeId) ? "follower" : "notMovable" };
  const g = layout.grids.get(containerId);
  if (!g) return null;
  const unit = unitOf(shapeId);
  const rows = Math.ceil(g.slots.length / g.cols);
  const growCols = g.cols < ARCH.MAX_COLS;
  const cells: DropCell[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < g.cols + (growCols ? 1 : 0); c++) {
      const slot = c < g.cols ? g.slots[r * g.cols + c] : undefined;
      const occupant = slot?.unit ?? null;
      // A stack that is open spans several cells: only its fold cell moves it
      const locked = !!slot?.follower || (occupant !== null && occupant !== unit && layout.followers.size > 0 && [...layout.followers.values()].includes(occupant));
      cells.push({ rect: cellRect(g, c, r), col: c, row: r, occupant, extra: c >= g.cols || r >= rows, locked });
    }
  }
  const x0 = Math.min(...cells.map((c) => c.rect.x)), y0 = Math.min(...cells.map((c) => c.rect.y));
  const x1 = Math.max(...cells.map((c) => c.rect.x + c.rect.w)), y1 = Math.max(...cells.map((c) => c.rect.y + c.rect.h));
  const area: RRect = { x: x0 - 7, y: y0 - 7, w: x1 - x0 + 14, h: y1 - y0 + 14 };
  const base = { containerId, area, slots: [] as RRect[], bar: null, cells };
  if (point[0] < area.x || point[0] > area.x + area.w || point[1] < area.y || point[1] > area.y + area.h) return { ...base, target: null, refused: true };
  const mineAt = g.slots.findIndex((x) => x.unit === unit && !x.follower);
  const mine = cells.find((c) => c.col === mineAt % g.cols && c.row === Math.floor(mineAt / g.cols));
  const open = cells.filter((c) => !c.locked || c === mine);
  const d = (c: DropCell) => Math.hypot(c.rect.x + c.rect.w / 2 - point[0], c.rect.y + c.rect.h / 2 - point[1]);
  const target = open.reduce((b, c) => (d(c) < d(b) ? c : b), open[0]!);
  const guides = { x: target.rect.x + target.rect.w / 2, y: target.rect.y + target.rect.h / 2 };
  if (!mine || target === mine) return { ...base, target: target.rect, refused: false, guides };
  // Every unit keeps its cell; the moved one takes the target, the occupant (if any) takes the moved one's old cell
  const cellsOut = new Map<string, readonly [number, number]>();
  g.slots.forEach((x, i) => { if (x.unit && !x.follower) cellsOut.set(x.unit, [i % g.cols, Math.floor(i / g.cols)]); });
  cellsOut.set(unit, [target.col, target.row]);
  const swapWith = target.occupant && target.occupant !== unit ? target.occupant : null;
  if (swapWith) cellsOut.set(swapWith, [mine.col, mine.row]);
  const cols = Math.max(g.cols, target.col + 1);
  const grow = target.extra
    ? { x: g.x0, y: g.y0, w: cols * g.cellW + (cols - 1) * g.gap, h: (Math.max(rows, target.row + 1)) * (g.cellH + g.gap) - g.gap }
    : null;
  return { ...base, target: target.rect, refused: false, guides, grid: { cols, cells: cellsOut }, swapWith, grow };
}

/** Keyboard: the neighbouring cell (empty ones and the extra column / row too), swapping with a tile there */
export function stepCell(layout: ArchLayout, shapeId: string, dir: "left" | "right" | "up" | "down"): MoveResult | { refused: "edge" } | null {
  const containerId = layout.containerOf.get(shapeId);
  if (!containerId) return { refused: layout.followers.has(shapeId) ? "follower" : "notMovable" };
  const g = layout.grids.get(containerId);
  if (!g) return null;
  const at = g.slots.findIndex((x) => x.unit === unitOf(shapeId) && !x.follower);
  if (at < 0) return { refused: "notMovable" };
  const col = (at % g.cols) + (dir === "left" ? -1 : dir === "right" ? 1 : 0);
  const row = Math.floor(at / g.cols) + (dir === "up" ? -1 : dir === "down" ? 1 : 0);
  if (col < 0 || row < 0) return { refused: "edge" };
  const r = cellRect(g, col, row);
  const plan = cellPlan(layout, shapeId, [r.x + r.w / 2, r.y + r.h / 2]);
  if (!plan || !("containerId" in plan) || plan.refused || !plan.grid) return { refused: "edge" };
  const t = plan.target!;
  if (t.x !== r.x || t.y !== r.y) return { refused: "edge" }; // that cell is not offered (a stack member, past the last column)
  return { containerId, grid: plan.grid, swapWith: plan.swapWith ?? null };
}

/** Column count of a tile container: n columns from its current order (gaps closed), or automatic (null) */
export function setCols(a: Arrangement, layout: ArchLayout, containerId: string, n: number | null): Arrangement {
  const order = new Map(a.order);
  const grid = new Map(a.grid);
  const seq = unitSequence(layout, containerId);
  if (seq.length) order.set(containerId, seq);
  if (n === null) grid.delete(containerId);
  else grid.set(containerId, { cols: Math.max(1, Math.min(ARCH.MAX_COLS, Math.round(n))) });
  return { ...a, order, grid };
}

/** Close the gaps of a tile container (same order and column count) */
export function compactBox(a: Arrangement, layout: ArchLayout, containerId: string): Arrangement {
  const g = layout.grids.get(containerId);
  const order = new Map(a.order);
  const grid = new Map(a.grid);
  const seq = unitSequence(layout, containerId);
  if (seq.length) order.set(containerId, seq);
  if (g?.userCols) grid.set(containerId, { cols: g.cols });
  else grid.delete(containerId);
  return { ...a, order, grid };
}

/** Back to automatic for one container (its order and grid) */
export function resetBox(a: Arrangement, containerId: string): Arrangement {
  const order = new Map(a.order);
  const grid = new Map(a.grid);
  order.delete(containerId);
  grid.delete(containerId);
  return { ...a, order, grid };
}

// ── VNet subnets in columns (vband:<vnet>) ──

const BAND_MAX_COLS = 16;
const vnetOfBand = (containerId: string | undefined) => (containerId?.startsWith("vband:") ? containerId.slice(6) : null);

/** The arrangement for a VNet's subnet columns: column / row cells for every column subnet, the row below as an order */
export function applyBand(a: Arrangement, vnetId: string, columns: string[][], rest: string[]): Arrangement {
  const grid = new Map(a.grid);
  const order = new Map(a.order);
  const cols = columns.filter((c) => c.length);
  const cells = new Map<string, readonly [number, number]>();
  cols.forEach((c, i) => c.forEach((id, r) => cells.set(id, [i, r])));
  grid.set(`vband:${vnetId}`, { cols: Math.max(1, cols.length), cells });
  if (rest.length) order.set(`vrest:${vnetId}`, rest);
  else order.delete(`vrest:${vnetId}`);
  return { ...a, grid, order };
}

/** Back to the traffic-entry columns for one VNet */
export function resetBand(a: Arrangement, vnetId: string): Arrangement {
  const grid = new Map(a.grid);
  const order = new Map(a.order);
  grid.delete(`vband:${vnetId}`);
  order.delete(`vrest:${vnetId}`);
  return { ...a, grid, order };
}

/**
 * Where a dragged subnet lands in its VNet: below the columns → the row below (by x); else the nearest column by x —
 * one of the columns or a new one on the right — at the height of the point (between subnets, a horizontal bar).
 * Any column, any position: the columns are the user's from then on (applyBand).
 */
export function bandPlan(layout: ArchLayout, shapeId: string, point: readonly [number, number]): DropPlan | null {
  const vid = vnetOfBand(layout.containerOf.get(shapeId));
  const band = vid ? layout.bands.get(vid) : undefined;
  if (!vid || !band || !band.cols.length) return null;
  const columns = band.cols.map((c) => c.ids.filter((id) => id !== shapeId));
  const rest = (band.rest?.ids ?? []).filter((id) => id !== shapeId);
  const at = (id: string) => layout.shapes.find((s) => s.id === id)!;
  const top = Math.min(...band.cols.map((c) => c.y));
  const colsBottom = Math.max(...band.cols.map((c) => c.y + c.h));
  const last = band.cols[band.cols.length - 1]!;
  const newCol: RRect | null = band.cols.length < BAND_MAX_COLS ? { x: last.x + last.w + ARCH.BOX_GAP, y: top, w: ARCH.LEAF_W + 2 * ARCH.PAD, h: colsBottom - top } : null;
  const restRect: RRect = band.rest
    ? { x: band.rest.x, y: band.rest.y, w: Math.max(band.rest.w, last.x + last.w - band.cols[0]!.x), h: band.rest.h }
    : { x: band.cols[0]!.x, y: colsBottom + ARCH.BOX_GAP, w: last.x + last.w - band.cols[0]!.x, h: 44 };
  const zonesBase: Array<{ rect: RRect; kind: "col" | "newCol" | "rest" }> = [
    ...band.cols.map((c) => ({ rect: { x: c.x, y: c.y, w: c.w, h: c.h }, kind: "col" as const })),
    ...(newCol ? [{ rect: newCol, kind: "newCol" as const }] : []),
    { rect: restRect, kind: "rest" as const },
  ];
  const x0 = Math.min(...zonesBase.map((z) => z.rect.x)) - 10, y0 = Math.min(...zonesBase.map((z) => z.rect.y)) - 10;
  const x1 = Math.max(...zonesBase.map((z) => z.rect.x + z.rect.w)) + 10, y1 = Math.max(...zonesBase.map((z) => z.rect.y + z.rect.h)) + 10;
  const area: RRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const base = { containerId: `vband:${vid}`, area, slots: [] as RRect[], target: null };
  if (point[0] < area.x || point[0] > area.x + area.w || point[1] < area.y || point[1] > area.y + area.h) {
    return { ...base, bar: null, refused: true, zones: zonesBase.map((z) => ({ ...z, active: false })) };
  }
  let bar: RRect;
  let active: number;
  const restLine = band.rest ? (colsBottom + band.rest.y) / 2 : colsBottom + ARCH.BOX_GAP / 2;
  if (point[1] >= restLine) {
    // the row below: by x
    const i = rest.filter((id) => { const s = at(id); return s.x + s.w / 2 < point[0]; }).length;
    rest.splice(i, 0, shapeId);
    const ref = rest[i + 1] ? at(rest[i + 1]!) : rest[i - 1] ? at(rest[i - 1]!) : null;
    const x = rest[i + 1] && ref ? ref.x - ARCH.BOX_GAP / 2 : ref ? ref.x + ref.w + ARCH.BOX_GAP / 2 : restRect.x + 4;
    bar = { x: x - 1.5, y: restRect.y, w: 3, h: ref?.h ?? restRect.h };
    active = zonesBase.length - 1;
  } else {
    // nearest column by x (a new one on the right too)
    const cands = zonesBase.map((z, k) => ({ z, k })).filter((x) => x.z.kind !== "rest");
    const dist = (r: RRect) => (point[0] < r.x ? r.x - point[0] : point[0] > r.x + r.w ? point[0] - r.x - r.w : 0);
    const best = cands.reduce((b, c) => (dist(c.z.rect) < dist(b.z.rect) ? c : b), cands[0]!);
    active = best.k;
    if (best.z.kind === "newCol") {
      columns.push([shapeId]);
      bar = { x: best.z.rect.x, y: best.z.rect.y - 1.5, w: best.z.rect.w, h: 3 };
    } else {
      const col = columns[best.k]!;
      const i = col.filter((id) => { const s = at(id); return s.y + s.h / 2 < point[1]; }).length;
      col.splice(i, 0, shapeId);
      const below = col[i + 1] ? at(col[i + 1]!) : null, above = col[i - 1] ? at(col[i - 1]!) : null;
      const y = below ? below.y - ARCH.BOX_GAP / 2 : above ? above.y + above.h + ARCH.BOX_GAP / 2 : best.z.rect.y;
      bar = { x: best.z.rect.x, y: y - 1.5, w: best.z.rect.w, h: 3 };
    }
  }
  const cleaned = columns.filter((c) => c.length);
  const same = JSON.stringify(cleaned) === JSON.stringify(band.cols.map((c) => c.ids)) && JSON.stringify(rest) === JSON.stringify(band.rest?.ids ?? []);
  return {
    ...base, bar, refused: false,
    zones: zonesBase.map((z, k) => ({ ...z, active: k === active })),
    ...(same ? {} : { band: { columns: cleaned, rest } }),
  };
}

/** Keyboard for a VNet's subnets: ↑/↓ in the column (↓ at the bottom → the row below), ←/→ to the next column (→ past the last = a new column); in the row below ←/→ reorder, ↑ → the last column */
export function stepBand(layout: ArchLayout, shapeId: string, dir: "left" | "right" | "up" | "down"): MoveResult | { refused: "edge" } | null {
  const vid = vnetOfBand(layout.containerOf.get(shapeId));
  const band = vid ? layout.bands.get(vid) : undefined;
  if (!vid || !band || !band.cols.length) return null;
  const columns = band.cols.map((c) => [...c.ids]);
  const rest = [...(band.rest?.ids ?? [])];
  const ci = columns.findIndex((c) => c.includes(shapeId));
  if (ci >= 0) {
    const col = columns[ci]!;
    const r = col.indexOf(shapeId);
    col.splice(r, 1);
    if (dir === "up") { if (r === 0) return { refused: "edge" }; col.splice(r - 1, 0, shapeId); }
    else if (dir === "down") { if (r === col.length) rest.push(shapeId); else col.splice(r + 1, 0, shapeId); }
    else {
      const ni = ci + (dir === "left" ? -1 : 1);
      if (ni < 0) return { refused: "edge" };
      if (ni >= columns.length) { if (columns.length >= BAND_MAX_COLS || (col.length === 0 && ni === columns.length)) return { refused: "edge" }; columns.push([shapeId]); }
      else columns[ni]!.splice(Math.min(r, columns[ni]!.length), 0, shapeId);
    }
  } else {
    const i = rest.indexOf(shapeId);
    if (i < 0) return { refused: "notMovable" };
    if (dir === "down") return { refused: "edge" };
    rest.splice(i, 1);
    if (dir === "up") columns[columns.length - 1]!.push(shapeId);
    else {
      const j = i + (dir === "left" ? -1 : 1);
      if (j < 0 || j > rest.length) return { refused: "edge" };
      rest.splice(j, 0, shapeId);
    }
  }
  return { containerId: `vband:${vid}`, band: { columns: columns.filter((c) => c.length), rest } };
}

/** The drop itself: the new order of the container, or why there is none */
export function moveInOrder(layout: ArchLayout, shapeId: string, drop: readonly [number, number]): MoveResult {
  const bp = bandPlan(layout, shapeId, drop);
  if (bp) {
    if (bp.refused) return { refused: "outsideParent" };
    return bp.band ? { containerId: bp.containerId, band: bp.band } : { refused: "noChange" };
  }
  const cell = cellPlan(layout, shapeId, drop);
  if (cell) {
    if (!("containerId" in cell)) return { refused: cell.refused };
    if (cell.refused) return { refused: "outsideParent" };
    return cell.grid ? { containerId: cell.containerId, grid: cell.grid, swapWith: cell.swapWith ?? null } : { refused: "noChange" };
  }
  const plan = dropPlan(layout, shapeId, drop);
  if (!("containerId" in plan)) return { refused: plan.refused };
  if (plan.refused) return { refused: "outsideParent" };
  return plan.order ? { containerId: plan.containerId, order: plan.order } : { refused: "noChange" };
}

/** Keyboard: one slot back / forward in reading order (←/→), or to the nearest slot of the row above / below (↑/↓) */
export function stepInOrder(layout: ArchLayout, shapeId: string, dir: "left" | "right" | "up" | "down"): MoveResult | { refused: "edge" } {
  const containerId = layout.containerOf.get(shapeId);
  if (!containerId) return { refused: layout.followers.has(shapeId) ? "follower" : "notMovable" };
  const moving = shapeId.startsWith("fold:") ? shapeId.slice(5) : shapeId;
  const all = siblings(layout, containerId);
  const i = all.findIndex((x) => x.id === moving);
  if (i < 0) return { refused: "notMovable" };
  let j = i;
  if (dir === "left") j = i - 1;
  else if (dir === "right") j = i + 1;
  else {
    const me = all[i]!.s;
    const ys = [...new Set(all.map((x) => x.s.y))].sort((a, b) => a - b);
    const row = ys[ys.indexOf(me.y) + (dir === "up" ? -1 : 1)];
    if (row === undefined) return { refused: "edge" };
    const cx = me.x + me.w / 2;
    const near = all.filter((x) => x.s.y === row).sort((a, b) => Math.abs(a.s.x + a.s.w / 2 - cx) - Math.abs(b.s.x + b.s.w / 2 - cx))[0]!;
    j = all.indexOf(near);
  }
  if (j < 0 || j >= all.length || j === i) return { refused: "edge" };
  const ids = all.map((x) => x.id);
  ids.splice(i, 1);
  ids.splice(j, 0, moving);
  return { containerId, order: ids };
}

export type Relation = { ok: true; kinds: ArchDrawEdge["kind"][] } | { ok: false; reason: "self" | "notDrawable" | "none" };

/**
 * Is there a configured relationship between two drawn shapes? Any model edge (any layer, switched off too) whose
 * two ends are drawn as these shapes, either direction. Fold tiles, ghosts and frames are not ends.
 */
export function relationBetween(model: ArchModel, layout: ArchLayout, a: string, b: string): Relation {
  if (a === b) return { ok: false, reason: "self" };
  const end = (id: string) => layout.shapes.find((s) => s.id === id);
  const sa = end(a), sb = end(b);
  const drawable = (s: ArchPlaced | undefined) => !!s && s.shape !== "fold" && s.shape !== "ghost" && (s.shape !== "box" || s.type === "subnet" || s.type === "vnet");
  if (!drawable(sa) || !drawable(sb)) return { ok: false, reason: "notDrawable" };
  const kinds = new Set<ArchDrawEdge["kind"]>();
  for (const e of model.edges) {
    const s = layout.shownAt.get(e.source), t = layout.shownAt.get(e.target);
    if ((s === a && t === b) || (s === b && t === a)) kinds.add(e.kind);
  }
  return kinds.size ? { ok: true, kinds: ARCH_EDGE_KINDS.filter((k) => kinds.has(k)) } : { ok: false, reason: "none" };
}

/** Every drawn shape → the shapes it has a configured relationship with, and the kinds (one pass over the model) */
export function relationIndex(model: ArchModel, layout: ArchLayout): Map<string, Map<string, ArchDrawEdge["kind"][]>> {
  const out = new Map<string, Map<string, Set<ArchDrawEdge["kind"]>>>();
  const add = (a: string, b: string, k: ArchDrawEdge["kind"]) => {
    const m = out.get(a) ?? out.set(a, new Map()).get(a)!;
    (m.get(b) ?? m.set(b, new Set()).get(b)!).add(k);
  };
  const drawable = new Set(layout.shapes.filter((s) => s.shape !== "fold" && s.shape !== "ghost" && (s.shape !== "box" || s.type === "subnet" || s.type === "vnet")).map((s) => s.id));
  for (const e of model.edges) {
    const a = layout.shownAt.get(e.source), b = layout.shownAt.get(e.target);
    if (!a || !b || a === b || !drawable.has(a) || !drawable.has(b)) continue;
    add(a, b, e.kind);
    add(b, a, e.kind);
  }
  return new Map([...out].map(([a, m]) => [a, new Map([...m].map(([b, ks]) => [b, ARCH_EDGE_KINDS.filter((k) => ks.has(k))]))]));
}

const SIDE_POINT = (r: RRect, side: Side): [number, number] =>
  side === "l" ? [r.x, r.y + r.h / 2] : side === "r" ? [r.x + r.w, r.y + r.h / 2] : side === "t" ? [r.x + r.w / 2, r.y] : [r.x + r.w / 2, r.y + r.h];
const OUT: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
const round = (p: [number, number]): [number, number] => [Math.round(p[0]), Math.round(p[1])];

/** The facing sides of two rects: left/right when they are apart horizontally, else top/bottom */
function facing(S: RRect, T: RRect): [Side, Side] {
  const [sx, sy] = center(S), [tx, ty] = center(T);
  const apartX = S.x + S.w <= T.x || T.x + T.w <= S.x;
  const apartY = S.y + S.h <= T.y || T.y + T.h <= S.y;
  if (apartX && (!apartY || Math.abs(tx - sx) >= Math.abs(ty - sy))) return tx >= sx ? ["r", "l"] : ["l", "r"];
  return ty >= sy ? ["b", "t"] : ["t", "b"];
}

/** The user's line between two shapes: straight (side to side), elbow (one middle run at `bend`), curve (bezier) */
export function manualPath(S: RRect, T: RRect, style: LineStyle, bend = 0.5, bulge = 0): { points: Array<[number, number]>; sourceSide: Side; targetSide: Side; curve?: boolean } {
  const [ss, ts] = facing(S, T);
  const a = SIDE_POINT(S, ss), b = SIDE_POINT(T, ts);
  const f = Math.min(0.9, Math.max(0.1, bend));
  if (style === "straight") return { points: [round(a), round(b)], sourceSide: ss, targetSide: ts };
  if (style === "elbow") {
    const horizontal = ss === "l" || ss === "r";
    const mid = horizontal ? a[0] + (b[0] - a[0]) * f : a[1] + (b[1] - a[1]) * f;
    const pts: Array<[number, number]> = horizontal ? [a, [mid, a[1]], [mid, b[1]], b] : [a, [a[0], mid], [b[0], mid], b];
    return { points: pts.map(round), sourceSide: ss, targetSide: ts };
  }
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d = Math.max(40, chord * 0.4);
  // Bulge: both control points move along the chord's normal; the curve's middle moves by 0.75 of that
  const nx = chord ? -(b[1] - a[1]) / chord : 0, ny = chord ? (b[0] - a[0]) / chord : 0;
  const off = Math.max(-1, Math.min(1, bulge)) * chord / 0.75;
  const c1: [number, number] = [a[0] + OUT[ss][0] * d + nx * off, a[1] + OUT[ss][1] * d + ny * off];
  const c2: [number, number] = [b[0] + OUT[ts][0] * d + nx * off, b[1] + OUT[ts][1] * d + ny * off];
  return { points: [a, c1, c2, b].map(round), sourceSide: ss, targetSide: ts, curve: true };
}

/**
 * The user's lines over a routed layout (no re-routing): each replaces the drawn line(s) of its pair, keeps the
 * relationship's kind (the first by ARCH_EDGE_KINDS when the pair has several) and its model direction, and is
 * always drawn. A line whose pair has no drawn relationship right now (layer off, an end rolled up) is skipped — kept
 * in the arrangement for when it is drawn again.
 */
export function applyManualLines(layout: ArchLayout, lines: readonly ManualLine[]): ArchLayout {
  if (!lines.length) return layout;
  let edges = [...layout.edges];
  for (const l of lines) {
    const pair = edges.filter((e) => (e.source === l.source && e.target === l.target) || (e.source === l.target && e.target === l.source));
    if (!pair.length) continue;
    const first = [...pair].sort((x, y) => ARCH_EDGE_KINDS.indexOf(x.kind) - ARCH_EDGE_KINDS.indexOf(y.kind))[0]!;
    const S = layout.shapes.find((s) => s.id === first.source), T = layout.shapes.find((s) => s.id === first.target);
    if (!S || !T) continue;
    const path = manualPath(rectOf(S), rectOf(T), l.style, l.bend, l.bulge);
    edges = edges.filter((e) => !pair.includes(e));
    edges.push({
      id: `manual:${first.source}->${first.target}`, kind: first.kind, source: first.source, target: first.target,
      count: pair.reduce((n, e) => n + e.count, 0), display: "always",
      points: path.points, sourceSide: path.sourceSide, targetSide: path.targetSide, manual: l.style, replaces: pair.map((e) => e.id).sort(),
    });
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...layout, edges };
}

/**
 * Handle of a selected manual line and how a drag maps to its parameter: elbow — a square on the middle run, moved
 * along the run's axis (bend = share of the span); curve — a round handle at the curve's middle, moved along the
 * chord's normal (bulge = share of the chord). Straight lines have none.
 */
export function lineHandle(e: Pick<ArchDrawEdge, "points" | "manual" | "sourceSide">): { at: [number, number]; kind: "bend" | "bulge" } | null {
  const p = e.points;
  if (e.manual === "elbow" && p.length === 4) return { at: [(p[1]![0] + p[2]![0]) / 2, (p[1]![1] + p[2]![1]) / 2], kind: "bend" };
  if (e.manual === "curve" && p.length === 4) return { at: [(p[0]![0] + 3 * p[1]![0] + 3 * p[2]![0] + p[3]![0]) / 8, (p[0]![1] + 3 * p[1]![1] + 3 * p[2]![1] + p[3]![1]) / 8], kind: "bulge" };
  return null;
}

/** The parameter a handle dragged to `pt` sets (elbow: bend 0.1..0.9 · curve: bulge −1..1) — pure, for the canvas and tests */
export function handleValue(e: Pick<ArchDrawEdge, "points" | "manual" | "sourceSide">, pt: readonly [number, number]): number | null {
  const p = e.points;
  if (p.length !== 4) return null;
  const a = p[0]!, b = p[3]!;
  if (e.manual === "elbow") {
    const horizontal = e.sourceSide === "l" || e.sourceSide === "r";
    const span = horizontal ? b[0] - a[0] : b[1] - a[1];
    if (!span) return 0.5;
    return Math.min(0.9, Math.max(0.1, ((horizontal ? pt[0] : pt[1]) - (horizontal ? a[0] : a[1])) / span));
  }
  if (e.manual === "curve") {
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!chord) return 0;
    const nx = -(b[1] - a[1]) / chord, ny = (b[0] - a[0]) / chord;
    // Facing sides are always opposite, so the plain curve's middle is the chord's middle; the bulge is the handle's
    // offset from it along the normal, over the chord
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return Math.min(1, Math.max(-1, ((pt[0] - mid[0]) * nx + (pt[1] - mid[1]) * ny) / chord));
  }
  return null;
}

/** Same pair (either direction) */
export const samePair = (l: ManualLine, a: string, b: string) => (l.source === a && l.target === b) || (l.source === b && l.target === a);

// ── persistence (the viewer's browser; the page wraps storage access in try/catch) ──

/** Grid columns: tile grids use up to ARCH.MAX_COLS (the layout ignores more); a VNet's subnet columns up to 16 */
const MAX_CONTAINERS = 500, MAX_IDS = 400, MAX_LINES = 500, MAX_ROWS = 99, MAX_GRID_COLS = 16;
const STYLES = new Set<LineStyle>(["straight", "curve", "elbow"]);

/** v1 = order + lines (written while no grid is set, so an older build still reads it); v2 adds grids */
export function serializeArrangement(a: Arrangement): string {
  const order = [...a.order].filter(([, ids]) => ids.length);
  const grid = [...a.grid]
    .map(([c, g]) => [c, { ...(g.cols !== undefined ? { cols: g.cols } : {}), ...(g.cells?.size ? { cells: [...g.cells].map(([id, [col, row]]) => [id, col, row]) } : {}) }] as const)
    .filter(([, g]) => Object.keys(g).length);
  return JSON.stringify(grid.length ? { v: 2, order, grid, lines: a.lines } : { v: 1, order, lines: a.lines });
}

const intIn = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;

/** Never throws: junk, another version or oversized input → what is valid of it (or nothing) */
export function parseArrangement(raw: string | null | undefined): Arrangement {
  if (!raw) return EMPTY_ARRANGEMENT;
  try {
    const j = JSON.parse(raw) as { v?: number; order?: unknown; grid?: unknown; lines?: unknown };
    if (j.v !== 1 && j.v !== 2) return EMPTY_ARRANGEMENT;
    const order = new Map<string, string[]>();
    if (Array.isArray(j.order)) {
      for (const e of j.order.slice(0, MAX_CONTAINERS)) {
        if (Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1])) order.set(e[0], (e[1] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, MAX_IDS));
      }
    }
    const lines: ManualLine[] = [];
    if (Array.isArray(j.lines)) {
      for (const l of j.lines.slice(0, MAX_LINES) as Array<Partial<ManualLine>>) {
        if (typeof l?.source === "string" && typeof l.target === "string" && STYLES.has(l.style as LineStyle)) {
          lines.push({
            source: l.source, target: l.target, style: l.style as LineStyle,
            ...(typeof l.bend === "number" && Number.isFinite(l.bend) ? { bend: Math.min(0.9, Math.max(0.1, l.bend)) } : {}),
            ...(typeof l.bulge === "number" && Number.isFinite(l.bulge) ? { bulge: Math.min(1, Math.max(-1, l.bulge)) } : {}),
          });
        }
      }
    }
    const grid = new Map<string, ArchContainerGrid>();
    if (j.v === 2 && Array.isArray(j.grid)) {
      for (const e of j.grid.slice(0, MAX_CONTAINERS)) {
        if (!Array.isArray(e) || typeof e[0] !== "string" || !e[1] || typeof e[1] !== "object") continue;
        const g = e[1] as { cols?: unknown; cells?: unknown };
        const cols = intIn(g.cols, 1, MAX_GRID_COLS) ? g.cols : undefined;
        const cells = new Map<string, readonly [number, number]>();
        if (Array.isArray(g.cells)) {
          for (const c of g.cells.slice(0, MAX_IDS)) {
            if (Array.isArray(c) && typeof c[0] === "string" && intIn(c[1], 0, MAX_GRID_COLS - 1) && intIn(c[2], 0, MAX_ROWS)) cells.set(c[0], [c[1], c[2]]);
          }
        }
        if (cols !== undefined || cells.size) grid.set(e[0], { ...(cols !== undefined ? { cols } : {}), ...(cells.size ? { cells } : {}) });
      }
    }
    return { order, grid, lines };
  } catch {
    return EMPTY_ARRANGEMENT;
  }
}

/** How much of the arrangement applies to this layout (the badge), and what no longer does (the notice) */
export function arrangementStatus(a: Arrangement, model: ArchModel, layout: ArchLayout): { reordered: number; lines: number; stale: number } {
  const exists = (id: string) => model.resources.has(id) || model.vnets.has(id) || model.subnets.has(id) || id.startsWith("stack:") || layout.shapes.some((s) => s.id === id);
  const known = (c: string) => exists(c) || layout.containers.has(c) || /^(vnets:|vband:|vcol:|vrest:|lane:|paas:|global$)/.test(c);
  let stale = 0;
  for (const [c, ids] of a.order) { if (!known(c)) stale++; else stale += ids.some((id) => !exists(id)) ? 1 : 0; }
  for (const [c, g] of a.grid) { if (!known(c)) stale++; else stale += [...(g.cells?.keys() ?? [])].some((id) => !exists(id)) ? 1 : 0; }
  for (const l of a.lines) if (!exists(l.source) || !exists(l.target)) stale++;
  const boxes = new Set([...[...a.order].filter(([, ids]) => ids.length).map(([c]) => c), ...a.grid.keys()]);
  return { reordered: boxes.size, lines: a.lines.length, stale };
}
