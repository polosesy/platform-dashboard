// Manual arrangement on the live diagram — pure (no React, no DOM; tested in apps/api/test/liveArrange.test.ts).
//
// Same idea as the infrastructure diagram (lib/archArrange): ORDER and GRID CELLS, never coordinates, and a shape
// never leaves its real container. What the user may change here:
//   · cards inside their subnet — grid cells, under the side rules that keep lines out of cards (liveLayout cardClass):
//     a card linked to the right has no card right of it on its row, one linked from the left (inbound / an earlier
//     step) none left of it, one linked both ways is alone on its row. A move that adds a breach is refused; breaches
//     the automatic layout already has (chained rows) never block other moves
//   · subnets inside their step column (the step = configured distance from the inbound side — never another step)
//   · VNets among each other, and cards of the PaaS / outside / ghost lanes
// Inbound, on-premises, outbound and unused lanes stay as the layout places them (their positions are facts).
// Keys are lower-case ARM IDs (spec ids are re-numbered when a diagram is regenerated); `spec:<id>` without one.
import type { DiagramNodeSpec } from "@aud/types";
import type { Arrangement } from "./archArrange";

export type ARect = { x: number; y: number; w: number; h: number };

export const liveKey = (n: Pick<DiagramNodeSpec, "id" | "azureResourceId">): string =>
  n.azureResourceId ? n.azureResourceId.toLowerCase() : `spec:${n.id}`;

/** Items in the user's sequence take the places listed items had, in that order; the rest keep their places */
export function applySequence<T>(items: readonly T[], seq: readonly string[] | undefined, keyOf: (t: T) => string): T[] {
  if (!seq?.length) return [...items];
  const rank = new Map(seq.map((k, i) => [k, i] as const));
  const listed = items.filter((t) => rank.has(keyOf(t))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  let i = 0;
  return items.map((t) => (rank.has(keyOf(t)) ? listed[i++]! : t));
}

export type CellRule = "first" | "last" | "alone" | "any";
/** liveLayout CardClass → where the card may sit on its row: first (nothing left of it), last (nothing right), alone */
export const ruleOfClass = (c: string | undefined): CellRule => (c === "L" ? "first" : c === "R" ? "last" : c === "LR" ? "alone" : "any");

/** Side-rule breaches on the given rows: a "last" card with a card right of it, a "first" one with one left of it,
 *  an "alone" one sharing its row */
export function rowBreaches(cells: ReadonlyMap<string, readonly [number, number]>, rules: ReadonlyMap<string, CellRule>, rows?: ReadonlySet<number>): number {
  const byRow = new Map<number, Array<[string, number]>>();
  for (const [id, [c, r]] of cells) if (!rows || rows.has(r)) (byRow.get(r) ?? byRow.set(r, []).get(r)!).push([id, c]);
  let n = 0;
  for (const list of byRow.values()) {
    for (const [id, c] of list) {
      const rule = rules.get(id) ?? "any";
      if (rule === "alone" && list.length > 1) n++;
      else if (rule === "last" && list.some(([o, oc]) => o !== id && oc > c)) n++;
      else if (rule === "first" && list.some(([o, oc]) => o !== id && oc < c)) n++;
    }
  }
  return n;
}

export type GridUnit = { id: string; key: string; rule: CellRule };

/**
 * Cards into a `cols`-wide grid: stored cells exactly (when inside the grid and free — what the user saw stays), then
 * the cards without one (new since) in their order to the first free cell that adds no side-rule breach. Rows left
 * empty are dropped. Returns rows of card ids (null = empty cell).
 */
export function assignCells(units: readonly GridUnit[], cols: number, cells?: ReadonlyMap<string, readonly [number, number]>): Array<Array<string | null>> {
  const at = new Map<string, string>();
  const placedCells = new Map<string, readonly [number, number]>();
  const rules = new Map(units.map((u) => [u.id, u.rule] as const));
  const rowUnits = new Map<number, GridUnit[]>();
  const free = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && !at.has(`${c},${r}`);
  const put = (u: GridUnit, c: number, r: number) => {
    at.set(`${c},${r}`, u.id);
    placedCells.set(u.id, [c, r]);
    (rowUnits.get(r) ?? rowUnits.set(r, []).get(r)!).push(u);
  };
  const rest: GridUnit[] = [];
  for (const u of units) {
    const cell = cells?.get(u.key);
    if (cell && free(cell[0], cell[1])) put(u, cell[0], cell[1]);
    else rest.push(u);
  }
  for (const u of rest) {
    for (let r = 0; ; r++) {
      let placed = false;
      for (let c = 0; c < cols && !placed; c++) {
        if (!free(c, r)) continue;
        const row = new Set([r]);
        const before = rowBreaches(placedCells, rules, row);
        const trial = new Map(placedCells).set(u.id, [c, r]);
        if (rowBreaches(trial, rules, row) <= before) { put(u, c, r); placed = true; }
      }
      if (placed) break;
    }
  }
  const maxRow = Math.max(-1, ...rowUnits.keys());
  const rows: Array<Array<string | null>> = [];
  for (let r = 0; r <= maxRow; r++) {
    if (!rowUnits.get(r)?.length) continue;
    rows.push(Array.from({ length: cols }, (_, c) => at.get(`${c},${r}`) ?? null));
  }
  return rows;
}

// ── The arrange view (liveLayout builds it from the drawn layout) ──

export type ArrangeContainer =
  | {
      kind: "grid"; id: string; storeKey: string; area: ARect;
      /** Top-left of cell [0,0] and the cell pitch */
      x0: number; y0: number; cellW: number; cellH: number; gap: number;
      cols: number;
      /** Card id → its cell as drawn now */
      cells: ReadonlyMap<string, readonly [number, number]>;
      rules: ReadonlyMap<string, CellRule>;
      keys: ReadonlyMap<string, string>;
    }
  | { kind: "list"; id: string; storeKey: string; area: ARect; members: readonly string[]; keys: ReadonlyMap<string, string> };

export type ArrangeView = {
  /** Movable shape id → its container id */
  containerOf: ReadonlyMap<string, string>;
  containers: ReadonlyMap<string, ArrangeContainer>;
  /** Absolute rectangles (liveLayout abs) */
  abs: ReadonlyMap<string, ARect>;
};

export type LivePlan = {
  containerId: string;
  area: ARect;
  /** Where the shape lands (grid cell) */
  target: ARect | null;
  /** Insertion bar (lists) */
  bar: ARect | null;
  /** Why the drop snaps back — i18n key suffix; null = allowed */
  refused: "side" | "alone" | "noChange" | null;
  next?: { cols: number; cells: Map<string, readonly [number, number]> } | { order: string[] };
};

const cx = (r: ARect) => r.x + r.w / 2;
const cy = (r: ARect) => r.y + r.h / 2;

/** Where the dragged shape (centre at `point`) would go; null = not movable */
export function livePlan(view: ArrangeView, id: string, point: readonly [number, number]): LivePlan | null {
  const cid = view.containerOf.get(id);
  const c = cid ? view.containers.get(cid) : undefined;
  if (!c) return null;
  const [px, py] = point;
  if (c.kind === "grid") {
    const own = c.cells.get(id);
    if (!own) return null;
    const pitchX = c.cellW + c.gap, pitchY = c.cellH + c.gap;
    const maxRow = Math.max(0, ...[...c.cells.values()].map(([, r]) => r));
    const col = Math.min(c.cols - 1, Math.max(0, Math.round((px - c.x0 - c.cellW / 2) / pitchX)));
    const row = Math.min(maxRow + 1, Math.max(0, Math.round((py - c.y0 - c.cellH / 2) / pitchY)));
    const target: ARect = { x: c.x0 + col * pitchX, y: c.y0 + row * pitchY, w: c.cellW, h: c.cellH };
    const base = { containerId: c.id, area: c.area, target, bar: null };
    if (own[0] === col && own[1] === row) return { ...base, refused: "noChange" };
    const occupant = [...c.cells].find(([other, [oc, or]]) => other !== id && oc === col && or === row)?.[0] ?? null;
    const moved = new Map(c.cells);
    moved.set(id, [col, row]);
    if (occupant) moved.set(occupant, own);
    // No new side-rule breach on the rows involved (lines would cross cards); old breaches never block a move
    const rows = new Set([own[1], row]);
    if (rowBreaches(moved, c.rules, rows) > rowBreaches(c.cells, c.rules, rows)) {
      const alone = c.rules.get(id) === "alone" || (occupant && c.rules.get(occupant) === "alone") || [...moved].some(([o, [, r]]) => rows.has(r) && c.rules.get(o) === "alone");
      return { ...base, refused: alone ? "alone" : "side" };
    }
    const cells = new Map<string, readonly [number, number]>();
    for (const [sid, cell] of moved) cells.set(c.keys.get(sid) ?? sid, cell);
    return { ...base, refused: null, next: { cols: c.cols, cells } };
  }
  // Lists: insertion in reading order (rows top → bottom, then left → right)
  const others = c.members.filter((m) => m !== id && view.abs.has(m));
  const before = (m: string) => {
    const r = view.abs.get(m)!;
    return cy(r) < py - r.h / 2 || (Math.abs(cy(r) - py) <= r.h / 2 && cx(r) < px);
  };
  const idx = others.filter(before).length;
  const ref = others[Math.min(idx, others.length - 1)];
  const rr = ref ? view.abs.get(ref)! : view.abs.get(id)!;
  const bar: ARect = idx < others.length
    ? { x: rr.x, y: rr.y - 6, w: rr.w, h: 3 }
    : { x: rr.x, y: rr.y + rr.h + 3, w: rr.w, h: 3 };
  const seq = [...others.slice(0, idx), id, ...others.slice(idx)];
  const same = seq.every((m, i) => m === c.members.filter((x) => view.abs.has(x))[i]);
  if (same) return { containerId: c.id, area: c.area, target: null, bar, refused: "noChange" };
  return { containerId: c.id, area: c.area, target: null, bar, refused: null, next: { order: seq.map((m) => c.keys.get(m) ?? m) } };
}

/** The arrangement after an allowed drop: a grid replaces the container's cells; a list order goes first and keeps the
 *  stored entries of members not in view (another scope) after it */
export function commitPlan(a: Arrangement, c: ArrangeContainer, next: NonNullable<LivePlan["next"]>): Arrangement {
  if ("cells" in next) {
    const grid = new Map(a.grid);
    grid.set(c.storeKey, { cols: next.cols, cells: next.cells });
    return { ...a, grid };
  }
  const prev = a.order.get(c.storeKey) ?? [];
  const order = new Map(a.order);
  order.set(c.storeKey, [...next.order, ...prev.filter((k) => !next.order.includes(k))]);
  return { ...a, order };
}

/** A subnet's column count (1–3); its cards re-flow in reading order (cells that no longer fit move) */
export function setGridCols(a: Arrangement, c: Extract<ArrangeContainer, { kind: "grid" }>, cols: number | null): Arrangement {
  const grid = new Map(a.grid);
  if (cols == null) grid.delete(c.storeKey);
  else {
    const cells = new Map<string, readonly [number, number]>();
    for (const [id, cell] of c.cells) cells.set(c.keys.get(id) ?? id, cell);
    grid.set(c.storeKey, { cols, cells });
  }
  return { ...a, grid };
}

/** Forget what the user did in one container */
export function resetContainer(a: Arrangement, storeKey: string): Arrangement {
  const order = new Map(a.order);
  const grid = new Map(a.grid);
  order.delete(storeKey);
  grid.delete(storeKey);
  return { ...a, order, grid };
}

/** Badge numbers: containers the user arranged, and stored entries that name nothing in this diagram */
export function liveArrangementStatus(a: Arrangement, knownKeys: ReadonlySet<string>): { boxes: number; stale: number } {
  let stale = 0;
  for (const [, ids] of a.order) stale += ids.filter((k) => k.startsWith("/") && !knownKeys.has(k)).length;
  for (const [, g] of a.grid) stale += [...(g.cells?.keys() ?? [])].filter((k) => k.startsWith("/") && !knownKeys.has(k)).length;
  return { boxes: new Set([...[...a.order].filter(([, ids]) => ids.length).map(([k]) => k), ...a.grid.keys()]).size, stale };
}
