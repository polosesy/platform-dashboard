// Cost trend chart — the numbers the bars, the axis and the hover read (pure; apps/api/test/costTrendView.test.ts).
// One series (cost per day or per month) → a bar chart from a zero baseline, a recessive y-axis with "nice" ticks, a few
// date labels (never one per bar) and the average as a dashed reference line. Dates arrive as YYYY-MM-DD (monthly = the
// first of the month) and are read as calendar dates in UTC — never shifted by the viewer's time zone.

export type TrendPoint = { date: string; cost: number };

/** Ticks from 0 to a round top ≥ max: steps of 1 · 2 · 2.5 · 5 × 10ⁿ, about `count` of them (0 is always the first) */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * Which bars carry a date under them: daily = the first, then every 7th, plus the last when it is not crowded (≥ 3 bars
 * from the previous label) · monthly = every month up to 12, else every 2nd. One label per bar is noise.
 */
export function labelIndices(n: number, granularity: "daily" | "monthly"): number[] {
  if (n <= 0) return [];
  const every = granularity === "daily" ? 7 : n > 12 ? 2 : 1;
  const out: number[] = [];
  for (let i = 0; i < n; i += every) out.push(i);
  const last = n - 1;
  if (out[out.length - 1] !== last && last - out[out.length - 1]! >= (granularity === "daily" ? 3 : every)) out.push(last);
  return out;
}

const utc = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`);

/** Short axis label: daily 11/20 · 20 Nov (by locale) — monthly 2026-11 → "11월" / "Nov" (+ the year in January) */
export function dateLabel(date: string, granularity: "daily" | "monthly", locale: string): string {
  const d = utc(date);
  if (Number.isNaN(d.getTime())) return date;
  if (granularity === "daily") return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "UTC" }).format(d);
  const jan = d.getUTCMonth() === 0;
  return new Intl.DateTimeFormat(locale, { month: "short", ...(jan ? { year: "numeric" } : {}), timeZone: "UTC" }).format(d);
}

/** Full label for the tooltip: 2026년 11월 20일 목요일 · 2026년 11월 (a short weekday read as a stray '목' in Korean) */
export function dateLong(date: string, granularity: "daily" | "monthly", locale: string): string {
  const d = utc(date);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(locale, granularity === "daily"
    ? { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" }
    : { year: "numeric", month: "long", timeZone: "UTC" }).format(d);
}

/** Axis money: compact (US$1.2K · ₩120만) — the tooltip shows the full amount */
export function axisMoney(n: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

export type TrendSummary = { ticks: number[]; top: number; average: number | null; maxIndex: number; total: number };

/** Scale and the one reference the chart draws: the average of the shown bars (null when there are none) */
export function trendSummary(points: TrendPoint[]): TrendSummary {
  const costs = points.map((p) => (Number.isFinite(p.cost) ? p.cost : 0));
  const total = costs.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...costs);
  const ticks = niceTicks(max);
  let maxIndex = -1;
  costs.forEach((c, i) => { if (maxIndex < 0 || c > costs[maxIndex]!) maxIndex = i; });
  return { ticks, top: ticks[ticks.length - 1]!, average: costs.length ? total / costs.length : null, maxIndex, total };
}

/** The bar a keyboard step lands on: ←/→ one bar, Home/End the ends; nothing chosen yet → the last bar (today) */
export function stepIndex(current: number | null, key: string, n: number): number | null {
  if (n <= 0) return null;
  const from = current ?? n - 1;
  if (key === "ArrowLeft") return Math.max(0, current === null ? n - 1 : from - 1);
  if (key === "ArrowRight") return Math.min(n - 1, current === null ? n - 1 : from + 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return current;
}
