// SLO › 서비스 상세 — pure helpers for the API's uptime answer (services/sloUptime.ts): the error budget left, the
// segments' counts, the top contributors' share and the SLI axis.
import type { SloContributor, SloUptimeBucket, SloUptimeResponse } from "@aud/types";

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
