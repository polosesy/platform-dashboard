// AKS 모니터링 › 워크로드 히트맵 view model (pure): problems first, the live diagram's card grammar (status strip +
// glyph: ● ok green, ▲ warn, ■ danger, ○ nothing to run, ◎ measured without a baseline), namespaces packed as a mosaic
// with no holes. The API (services/workloadHeatmap.ts) decides every level from the customer's Grafana thresholds;
// this module only orders, groups, sizes and words them — never turns "not measured" into 0 or OK.

import type { HeatLevel, HeatMetric, HeatWorkload, WorkloadHeatmapResponse } from "@aud/types";

export type HeatView = "worst" | HeatMetric;
type T = (k: string, v?: Record<string, string | number>) => string;

export const HEAT_METRICS: HeatMetric[] = ["ready", "memory", "cpu", "restarts", "oldGen", "http5xx", "logErrors", "poolUsage", "poolPending"];
export const SIGNAL_GROUPS: { id: "k8s" | "app" | "logs"; metrics: HeatMetric[] }[] = [
  { id: "k8s", metrics: ["ready", "memory", "cpu", "restarts"] },
  { id: "app", metrics: ["oldGen", "http5xx", "poolUsage", "poolPending"] },
  { id: "logs", metrics: ["logErrors"] },
];
/** Same glyphs as the live diagram's cards (lib/liveStatus.ts) — the glyph carries the state, colour only repeats it */
export const GLYPH: Record<HeatLevel, string> = { danger: "■", warn: "▲", ok: "●", noBaseline: "◎", stopped: "○", noTraffic: "·", notInstrumented: "–", notMeasured: "?" };
/** Display order, lower = worse first */
export const LEVEL_RANK: Record<HeatLevel, number> = { danger: 0, warn: 1, ok: 2, noBaseline: 3, stopped: 4, noTraffic: 5, notInstrumented: 6, notMeasured: 7 };

export const isProblem = (lv: HeatLevel): lv is "danger" | "warn" => lv === "danger" || lv === "warn";
export const levelIn = (w: HeatWorkload, view: HeatView): HeatLevel => (view === "worst" ? w.worst : w.cells[view].level);
export const heatKey = (w: HeatWorkload) => `${w.namespace}/${w.workload}`;
/** A DaemonSet no node matches (Windows-only on a Linux cluster …) — hidden by default, nothing there to look at */
export const isIdle = (w: HeatWorkload) => w.cells.ready.code === "noNodes";

/** Kubernetes quantity notation (Mi / Gi, millicores) — the units kubectl and the manifests use */
export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)}Gi`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)}Mi`;
  return `${Math.max(0, Math.round(b / 1024))}Ki`;
}
export function formatCores(c: number): string {
  return c >= 10 ? `${Math.round(c)}` : c >= 1 ? c.toFixed(2).replace(/0$/, "") : `${Math.max(c > 0 ? 1 : 0, Math.round(c * 1000))}m`;
}
const formatAbs = (metric: HeatMetric, v: number) => (metric === "memory" ? formatBytes(v) : formatCores(v));

/** The workload's warn/danger signals — danger first, then the signal order */
export function problemSignals(w: HeatWorkload): HeatMetric[] {
  return HEAT_METRICS.filter((m) => isProblem(w.cells[m].level)).sort((a, b) => LEVEL_RANK[w.cells[a].level] - LEVEL_RANK[w.cells[b].level]);
}

/** Which signal a tile shows: the chosen one, or (overall) its worst problem, else readiness */
export function tileMetric(w: HeatWorkload, view: HeatView): HeatMetric {
  return view !== "worst" ? view : problemSignals(w)[0] ?? "ready";
}

/** A cell's value as tiles and the panel show it (null → the level word, never 0) */
export function formatCell(metric: HeatMetric, w: HeatWorkload, t: T): string {
  const c = w.cells[metric];
  if (c.code === "noNodes" || c.code === "noPods") return t(`ob.hm.code.${c.code}`);
  if (metric === "ready") return w.replicas.desired === null ? t(`ob.hm.level.${c.level}`) : `${w.replicas.ready ?? 0}/${w.replicas.desired}`;
  if (c.value === null && c.abs != null && (metric === "memory" || metric === "cpu")) return formatAbs(metric, c.abs);
  if (c.value === null) return t(`ob.hm.level.${c.level}`);
  switch (metric) {
    case "memory": case "cpu": case "oldGen": case "poolUsage": return `${Math.round(c.value * 100)}%`;
    case "http5xx": return `${(c.value * 100).toFixed(2)}%`;
    default: return Math.round(c.value).toLocaleString();
  }
}

/** The tile's second line: "재시작 4" (+ how many other problem signals), readiness "1/1" when nothing is wrong */
export function tileText(w: HeatWorkload, view: HeatView, t: T): { glyph: string; text: string; more: number } {
  const m = tileMetric(w, view);
  const lv = w.cells[m].level;
  const value = formatCell(m, w, t);
  const text = m === "ready" && view === "worst" ? value : `${t(`ob.hm.short.${m}`)} ${value}`;
  const more = view === "worst" ? Math.max(0, problemSignals(w).length - 1) : 0;
  return { glyph: GLYPH[lv], text, more };
}

/**
 * "argocd-repo-server" in namespace "argocd" → "repo-server" (the card header already says argocd); likewise the
 * card's shared prefix ("app-gateway", "app-console" → "gateway", "console" under "app-…")
 */
export function shortName(workload: string, namespace: string, prefix?: string | null): string {
  for (const p of [`${namespace}-`, prefix]) {
    if (p && workload.startsWith(p) && workload.length > p.length) return workload.slice(p.length);
  }
  return workload;
}

/** The longest "word-" prefix every name in a card shares (2+ names, leaves 3+ characters each) — else null */
export function sharedPrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  let p = names.reduce((a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); });
  p = p.slice(0, p.lastIndexOf("-") + 1);
  return p.length >= 3 && names.every((n) => n.length - p.length >= 3) ? p : null;
}

export type NsGroup = { namespace: string; workloads: HeatWorkload[]; counts: Record<HeatLevel, number>; worst: HeatLevel; prefix: string | null };
const ZERO = (): Record<HeatLevel, number> => ({ danger: 0, warn: 0, ok: 0, noBaseline: 0, stopped: 0, noTraffic: 0, notInstrumented: 0, notMeasured: 0 });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Namespace cards: worst card first (danger count, warn count, size, name); tiles worst first, then by name */
export function groupByNamespace(ws: HeatWorkload[], view: HeatView, opts: { namespace?: string; problemsOnly?: boolean; hideIdle?: boolean } = {}): NsGroup[] {
  const m = new Map<string, HeatWorkload[]>();
  for (const w of ws) {
    if (opts.namespace && w.namespace !== opts.namespace) continue;
    if (opts.hideIdle && isIdle(w)) continue;
    if (opts.problemsOnly && !isProblem(levelIn(w, view))) continue;
    m.set(w.namespace, [...(m.get(w.namespace) ?? []), w]);
  }
  const groups = [...m].map(([namespace, list]): NsGroup => {
    const counts = ZERO();
    for (const w of list) counts[levelIn(w, view)]++;
    const workloads = [...list].sort((a, b) => LEVEL_RANK[levelIn(a, view)] - LEVEL_RANK[levelIn(b, view)] || cmp(a.workload, b.workload));
    const rest = workloads.map((w) => shortName(w.workload, namespace));
    return { namespace, workloads, counts, worst: levelIn(workloads[0]!, view), prefix: rest.some((n, i) => n !== workloads[i]!.workload) ? null : sharedPrefix(rest) };
  });
  return groups.sort((a, b) =>
    LEVEL_RANK[a.worst] - LEVEL_RANK[b.worst] || b.counts.danger - a.counts.danger || b.counts.warn - a.counts.warn ||
    b.workloads.length - a.workloads.length || cmp(a.namespace, b.namespace));
}

export type AttentionRow = { w: HeatWorkload; level: "danger" | "warn"; signals: HeatMetric[] };

/** "주의 필요" list: danger first, then more problem signals, then (one signal) the higher value, then ns/name */
export function attentionRows(ws: HeatWorkload[], view: HeatView): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const w of ws) {
    const lv = levelIn(w, view);
    if (!isProblem(lv)) continue;
    rows.push({ w, level: lv, signals: view === "worst" ? problemSignals(w) : [view] });
  }
  return rows.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.signals.length - a.signals.length ||
    (view !== "worst" ? (b.w.cells[view].value ?? 0) - (a.w.cells[view].value ?? 0) : 0) ||
    cmp(heatKey(a.w), heatKey(b.w)));
}

export type SignalChip = { metric: HeatMetric; count: number; tone: "danger" | "warn" };

/** The signal strip: active (count > 0, tone = danger when any workload is at danger on it), clear (measured 0), not measured */
export function signalSummary(flags: WorkloadHeatmapResponse["flags"], ws: HeatWorkload[]): { active: SignalChip[]; clear: HeatMetric[]; notMeasured: HeatMetric[] } {
  const active: SignalChip[] = [], clear: HeatMetric[] = [], notMeasured: HeatMetric[] = [];
  for (const f of flags) {
    if (f.count === null) notMeasured.push(f.metric);
    else if (f.count === 0) clear.push(f.metric);
    else active.push({ metric: f.metric, count: f.count, tone: ws.some((w) => w.cells[f.metric].level === "danger") ? "danger" : "warn" });
  }
  active.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1) || b.count - a.count);
  return { active, clear, notMeasured };
}

/** Legend entries: danger/warn/ok always, the other levels only when some tile shows them */
export function legendLevels(groups: NsGroup[]): HeatLevel[] {
  const seen = new Set<HeatLevel>(["danger", "warn", "ok"]);
  for (const g of groups) for (const lv of Object.keys(g.counts) as HeatLevel[]) if (g.counts[lv] > 0) seen.add(lv);
  return (Object.keys(LEVEL_RANK) as HeatLevel[]).filter((lv) => seen.has(lv));
}

/** A threshold as text (ready has its own sentence → null) */
export function formatThreshold(metric: HeatMetric, v: number): string | null {
  if (metric === "ready") return null;
  if (metric === "http5xx") return `${(v * 100).toFixed(1)}%`;
  if (["memory", "cpu", "oldGen", "poolUsage"].includes(metric)) return `${Math.round(v * 100)}%`;
  return String(v);
}

// ── Mosaic: namespace cards packed on the tile grid with no holes ──
// The outer grid's columns are tile tracks and its rows a small unit; each card spans the columns of its own tile
// grid and the rows of its height, and `grid-auto-flow: dense` drops small cards into the gaps beside tall ones
// (a one-workload namespace is one tile wide, not a half-empty card). Numbers match styles.module.css .hm*.
export const MOSAIC = { track: 132, gap: 10, unit: 4, head: 30, pad: 8, tileH: 44, tileGap: 4, border: 1 } as const;

/** How many tile tracks fit the width */
export function mosaicColumns(width: number): number {
  return Math.max(1, Math.floor((width + MOSAIC.gap) / (MOSAIC.track + MOSAIC.gap)));
}

/**
 * A card for n tiles: about twice as wide as tall (√(2.2n) columns), the neighbour with fewest empty slots,
 * never wider than the grid or than n. `span` = grid rows of MOSAIC.unit including the gap below the card.
 */
export function cardShape(n: number, avail: number): { cols: number; rows: number; span: number } {
  const count = Math.max(1, n);
  const max = Math.max(1, Math.min(avail, count));
  const target = Math.sqrt(count * 2.2);
  let best = { cols: 1, waste: Infinity, dist: Infinity };
  for (let c = Math.max(1, Math.floor(target) - 1); c <= Math.ceil(target) + 1; c++) {
    const cols = Math.min(c, max);
    const waste = cols * Math.ceil(count / cols) - count;
    const dist = Math.abs(cols - target);
    if (waste < best.waste || (waste === best.waste && dist < best.dist)) best = { cols, waste, dist };
  }
  const rows = Math.ceil(count / best.cols);
  const h = MOSAIC.border * 2 + MOSAIC.head + MOSAIC.pad * 2 + rows * MOSAIC.tileH + (rows - 1) * MOSAIC.tileGap;
  return { cols: best.cols, rows, span: Math.ceil((h + MOSAIC.gap) / MOSAIC.unit) };
}
