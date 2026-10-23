// Risk-factor heatmap view model (pure): which factor columns to show, how risky a workload row is, how to sort, and
// the short text a hit cell carries — so the matrix reads at a glance and the detail drawer lists only what hits.

import type { PolicyInsightsResponse, RiskFactorKey, WorkloadRiskRow } from "@aud/types";

type Factor = PolicyInsightsResponse["factors"][number];
export type HeatSort = "risk" | "name";

const WEIGHT_SCORE: Record<string, number> = { crit: 3, warn: 2, low: 1 };
export const WEIGHT_GLYPH: Record<string, string> = { crit: "▲", warn: "■", low: "●" };

/** Columns some shown row hits (or all, when asked) — a column of nothing but empty boxes is noise */
export function visibleFactors(rows: WorkloadRiskRow[], factors: Factor[], showEmpty: boolean): Factor[] {
  return showEmpty ? factors : factors.filter((f) => rows.some((r) => r.cells[f.key]));
}

/** Σ weight of the hit factors (crit 3 · warn 2 · low 1) + 2 per combo — combos are what make an attack path */
export function rowRisk(row: WorkloadRiskRow, factors: Factor[]): number {
  const hits = factors.reduce((a, f) => a + (row.cells[f.key] ? WEIGHT_SCORE[row.weights[f.key] ?? f.weight] ?? 1 : 0), 0);
  return hits + 2 * row.combos.length;
}

export function sortRows(rows: WorkloadRiskRow[], factors: Factor[], by: HeatSort): WorkloadRiskRow[] {
  return [...rows].sort((a, b) =>
    by === "risk" ? rowRisk(b, factors) - rowRisk(a, factors) || (a.name < b.name ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** A hit cell's text: the value's first meaningful token, at most `max` characters */
export function cellText(value: string, max = 8): string {
  const first = value.split(/[\s·,(:]+/).find((x) => x.length > 0) ?? value;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** The drawer: the factors that hit (in column order), and how many do not */
export function splitFactors(row: WorkloadRiskRow, factors: Factor[]): { hits: Factor[]; nonHits: Factor[] } {
  return { hits: factors.filter((f) => row.cells[f.key]), nonHits: factors.filter((f) => !row.cells[f.key]) };
}

export const hitCount = (row: WorkloadRiskRow, factors: Factor[]) => factors.filter((f) => row.cells[f.key as RiskFactorKey]).length;

/**
 * Factor columns whose hit cells carry text: the value tells rows apart (≥2 different short texts — e.g. 공인/내부,
 * cluster-admin/nodes/proxy) or the hit is critical. A column where every hit says the same ("runAsNonRoot…") shows
 * the glyph only — the header already names it, the drawer has the value.
 */
export function textColumns(rows: WorkloadRiskRow[], factors: Factor[]): Set<string> {
  const out = new Set<string>();
  for (const f of factors) {
    const texts = new Set(rows.filter((r) => r.cells[f.key]).map((r) => cellText(r.cells[f.key]!)));
    if (texts.size >= 2) out.add(f.key);
  }
  return out;
}

export const showsCellText = (row: WorkloadRiskRow, f: Factor, cols: Set<string>) =>
  cols.has(f.key) || (row.weights[f.key] ?? f.weight) === "crit";
