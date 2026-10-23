// AKS 모니터링 › 워크로드 히트맵 view model (pure): problems first, colour only for warn/danger, namespaces as cards
// that flow side by side. The API (services/workloadHeatmap.ts) decides every level from the customer's Grafana
// thresholds; this module only orders, groups and words them — never turns "not measured" into 0 or OK.

import type { HeatLevel, HeatMetric, HeatWorkload, WorkloadHeatmapResponse } from "@aud/types";

export type HeatView = "worst" | HeatMetric;
type T = (k: string, v?: Record<string, string | number>) => string;

export const HEAT_METRICS: HeatMetric[] = ["ready", "memory", "cpu", "restarts", "oldGen", "http5xx", "logErrors", "poolUsage", "poolPending"];
export const SIGNAL_GROUPS: { id: "k8s" | "app" | "logs"; metrics: HeatMetric[] }[] = [
  { id: "k8s", metrics: ["ready", "memory", "cpu", "restarts"] },
  { id: "app", metrics: ["oldGen", "http5xx", "poolUsage", "poolPending"] },
  { id: "logs", metrics: ["logErrors"] },
];
export const GLYPH: Record<HeatLevel, string> = { danger: "✕", warn: "!", ok: "", stopped: "0/0", noTraffic: "·", notInstrumented: "–", notMeasured: "?" };
/** Display order, lower = worse first */
export const LEVEL_RANK: Record<HeatLevel, number> = { danger: 0, warn: 1, ok: 2, stopped: 3, noTraffic: 4, notInstrumented: 5, notMeasured: 6 };

export const isProblem = (lv: HeatLevel): lv is "danger" | "warn" => lv === "danger" || lv === "warn";
export const levelIn = (w: HeatWorkload, view: HeatView): HeatLevel => (view === "worst" ? w.worst : w.cells[view].level);
export const heatKey = (w: HeatWorkload) => `${w.namespace}/${w.workload}`;

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
  if (metric === "ready") return w.replicas.desired === null ? t(`ob.hm.level.${c.level}`) : `${w.replicas.ready ?? 0}/${w.replicas.desired}`;
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

/** "argocd-repo-server" in namespace "argocd" → "repo-server" (the card header already says argocd) */
export function shortName(workload: string, namespace: string): string {
  const p = `${namespace}-`;
  return workload.startsWith(p) && workload.length > p.length ? workload.slice(p.length) : workload;
}

export type NsGroup = { namespace: string; workloads: HeatWorkload[]; counts: Record<HeatLevel, number>; worst: HeatLevel };
const ZERO = (): Record<HeatLevel, number> => ({ danger: 0, warn: 0, ok: 0, stopped: 0, noTraffic: 0, notInstrumented: 0, notMeasured: 0 });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Namespace cards: worst card first (danger count, warn count, size, name); tiles worst first, then by name */
export function groupByNamespace(ws: HeatWorkload[], view: HeatView, opts: { namespace?: string; problemsOnly?: boolean } = {}): NsGroup[] {
  const m = new Map<string, HeatWorkload[]>();
  for (const w of ws) {
    if (opts.namespace && w.namespace !== opts.namespace) continue;
    if (opts.problemsOnly && !isProblem(levelIn(w, view))) continue;
    m.set(w.namespace, [...(m.get(w.namespace) ?? []), w]);
  }
  const groups = [...m].map(([namespace, list]): NsGroup => {
    const counts = ZERO();
    for (const w of list) counts[levelIn(w, view)]++;
    const workloads = [...list].sort((a, b) => LEVEL_RANK[levelIn(a, view)] - LEVEL_RANK[levelIn(b, view)] || cmp(a.workload, b.workload));
    return { namespace, workloads, counts, worst: levelIn(workloads[0]!, view) };
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
