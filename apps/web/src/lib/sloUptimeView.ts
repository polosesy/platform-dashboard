// SLO › 서비스 상세 — pure helpers for the API's uptime answer (services/sloUptime.ts): the error budget left, the
// segments' counts, the top contributors' share and the SLI axis.
import type { SloContributor, SloUptimeBucket, SloUptimeGrade, SloUptimeResponse } from "@aud/types";

/** Pure: the error budget left (1 − used, never below 0) — null without requests */
export const budgetLeft = (t: SloUptimeResponse["totals"]): number | null => (t.budgetUsed === null ? null : Math.max(0, 1 - t.budgetUsed));

/** Pure: how many buckets of each state */
export function uptimeSegments(buckets: SloUptimeBucket[]): { ok: number; error: number; noData: number } {
  const c = { ok: 0, error: 0, noData: 0 };
  for (const b of buckets) c[b.state]++;
  return c;
}

/** Pure: the share of all failed requests the first `n` contributors spent */
export const topShare = (cs: SloContributor[], n: number) => Math.min(1, Math.round(cs.slice(0, n).reduce((a, c) => a + c.share, 0) * 1000) / 1000);

/**
 * Pure: the SLI axis — from a round floor under both the lowest bucket SLI and the target (so the target line and every
 * dip show), to 100 %; 3–5 ticks
 */
export function sliTicks(buckets: SloUptimeBucket[], target: number): { lo: number; ticks: number[] } {
  const min = Math.min(target, ...buckets.map((b) => b.sli ?? 1));
  const floors = [0.999, 0.995, 0.99, 0.98, 0.95, 0.9, 0.8, 0.5, 0];
  const lo = floors.find((f) => f < min - 1e-9) ?? 0;
  const step = (1 - lo) / 4;
  return { lo, ticks: [0, 1, 2, 3, 4].map((i) => Math.round((lo + i * step) * 100000) / 100000) };
}

/** Pure: a tooltip's left edge — centred on `center`, kept inside [0, barW] (a narrow bar: from 0) */
export const tipLeft = (center: number, tipW: number, barW: number) => Math.round(Math.max(0, Math.min(center - tipW / 2, barW - tipW)));

/** Pure: the decimals a tick label needs to say its value exactly (0.995..1 → 99.625 %, 0.99..1 → 99.25 % — never 100 % twice) */
export function tickDecimals(ticks: number[]): number {
  for (let d = 0; d < 3; d++) if (ticks.every((t) => Math.abs(Number((t * 100).toFixed(d)) - t * 100) < 1e-6)) return d;
  return 3;
}

// ── 글로벌 업타임 막대 (2026-11-19, 2nd — a status page's bars: one bar per bucket, a gap between, graded) ──

/** The API's thresholds (services/sloUptime.ts BURN_GRADES — the SRE Workbook's 14.4 and 6, kept equal by a test) */
export const BURN_GRADES = { partial: 6, major: 14.4 } as const;
/** Worst last: the order a bar's grades are compared in */
export const GRADE_ORDER: SloUptimeGrade[] = ["noData", "ok", "minor", "partial", "major"];

/** Pure: the API's gradeOf — a merged bar is graded again from its summed counts (never an average of grades) */
export function gradeOf(total: number, bad: number, target: number): { grade: SloUptimeGrade; burn: number | null; sli: number | null } {
  if (!(total >= 0.5)) return { grade: "noData", burn: null, sli: null };
  const b = Math.min(bad, total), sli = 1 - b / total;
  const burn = target < 1 ? (b / total) / (1 - target) : null;
  const grade: SloUptimeGrade = b < 0.5 || sli >= target || burn === null ? "ok"
    : burn >= BURN_GRADES.major - 1e-9 ? "major" : burn >= BURN_GRADES.partial - 1e-9 ? "partial" : "minor"; // 6 / 1000 / 0.001 = 5.999…
  return { grade, burn: burn === null ? null : Math.round(burn * 100) / 100, sli: Math.round(sli * 100000) / 100000 };
}

/** Narrowest bar and the gap between bars (px) — under them a phone shows 1–2 px slivers and the gaps vanish */
export const MIN_BAR = 3;
export const BAR_GAP = 2;

/** Pure: how many buckets one bar holds at a width — 1 when every bucket gets MIN_BAR + gap */
export function mergeFactor(n: number, width: number): number {
  if (n <= 0 || width <= 0) return 1;
  const fit = Math.max(1, Math.floor((width + BAR_GAP) / (MIN_BAR + BAR_GAP)));
  return Math.max(1, Math.ceil(n / fit));
}

export type UptimeBar = { t: number; from: number; total: number; bad: number; sli: number | null; grade: SloUptimeGrade; burn: number | null; buckets: number };

/**
 * Pure: the bars — `k` neighbouring buckets per bar, from the end (the newest bar is always whole). Counts are summed;
 * the bar's grade is its worst bucket's (a status page colours a day by its worst incident — regrading the sums hid a
 * 4-hour minor blip inside a 12-hour bar on stg); the burn and SLI are the summed ones. The first bar may hold fewer.
 */
export function mergeBuckets(buckets: SloUptimeBucket[], k: number, minutes: number, target: number): UptimeBar[] {
  const out: UptimeBar[] = [];
  const step = minutes * 60_000;
  for (let end = buckets.length; end > 0; end -= Math.max(1, k)) {
    const part = buckets.slice(Math.max(0, end - Math.max(1, k)), end);
    const total = part.reduce((a, b) => a + b.total, 0), bad = part.reduce((a, b) => a + (b.grade === "noData" ? 0 : b.bad), 0);
    const g = part.length === 1 ? { grade: part[0]!.grade, burn: part[0]!.burn, sli: part[0]!.sli } : gradeOf(total, bad, target);
    const worst = part.reduce<SloUptimeGrade>((w, b) => (GRADE_ORDER.indexOf(b.grade) > GRADE_ORDER.indexOf(w) ? b.grade : w), "noData");
    out.push({ t: part[part.length - 1]!.t, from: part[0]!.t - step, total: Math.round(total * 100) / 100, bad: Math.round(bad * 100) / 100, ...g, grade: worst, buckets: part.length });
  }
  return out.reverse();
}

/** Pure: bars per grade */
export function gradeCounts(bars: Array<{ grade: SloUptimeGrade }>): Record<SloUptimeGrade, number> {
  const c: Record<SloUptimeGrade, number> = { noData: 0, ok: 0, minor: 0, partial: 0, major: 0 };
  for (const b of bars) c[b.grade]++;
  return c;
}

/** Pure: the share of judged bars that are ok (a status page's "n % uptime") — null when none was judged */
export function uptimeShare(bars: Array<{ grade: SloUptimeGrade }>): number | null {
  const judged = bars.filter((b) => b.grade !== "noData");
  return judged.length ? Math.round((judged.filter((b) => b.grade === "ok").length / judged.length) * 10000) / 10000 : null;
}

/** Pure: the newest judged bar's grade (a status page's "Operational" on the right) — noData when nothing was judged */
export function latestGrade(bars: Array<{ grade: SloUptimeGrade }>): SloUptimeGrade {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.grade !== "noData") return bars[i]!.grade;
  return "noData";
}

export type OverallBar = UptimeBar & { worst: Array<{ key: string; grade: SloUptimeGrade }> };

/**
 * Pure: the board's "전체" row — per bar the worst grade of the services (noData only when every service had none);
 * counts summed; `worst` = the services graded below ok in that bar, worst first. Rows must share one time grid (the
 * API reads them with one end and one step) — a row of another length is left out.
 */
export function overallBars(rows: Array<{ key: string; bars: UptimeBar[] }>): OverallBar[] {
  const n = rows[0]?.bars.length ?? 0;
  const same = rows.filter((r) => r.bars.length === n);
  return Array.from({ length: n }, (_, i) => {
    const at = same.map((r) => ({ key: r.key, bar: r.bars[i]! }));
    const grade = at.reduce<SloUptimeGrade>((w, x) => (GRADE_ORDER.indexOf(x.bar.grade) > GRADE_ORDER.indexOf(w) ? x.bar.grade : w), "noData");
    const worst = at.filter((x) => GRADE_ORDER.indexOf(x.bar.grade) > GRADE_ORDER.indexOf("ok"))
      .sort((a, b) => GRADE_ORDER.indexOf(b.bar.grade) - GRADE_ORDER.indexOf(a.bar.grade) || (a.key < b.key ? -1 : 1))
      .map((x) => ({ key: x.key, grade: x.bar.grade }));
    const first = at[0]!.bar;
    return {
      t: first.t, from: first.from, buckets: first.buckets, grade, burn: null, sli: null, worst,
      total: Math.round(at.reduce((a, x) => a + x.bar.total, 0) * 100) / 100, bad: Math.round(at.reduce((a, x) => a + x.bar.bad, 0) * 100) / 100,
    };
  });
}
