// AKS 모니터링 › SLO › RED (트레이스) — how the numbers are written (API services/workloadRed.ts). Pure; tested from
// apps/api/test/workloadRed.test.ts. No colour for a value without a threshold: RED has none (the SLO view judges).
import type { RedQuantile, RedService } from "@aud/types";

/** The windows the API answers (minutes) — the page's range is fitted to one of them */
export const RED_WINDOWS = [5, 15, 60, 360, 1440] as const;

/** A duration boundary in seconds → "100ms" / "1s" / "2.5s" */
export function secText(s: number): string {
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${Number(s.toFixed(2))}s`;
}

/** The bucket holding a quantile: "≤ 300ms"; above the last boundary: "> 30s"; no requests: "—" */
export function quantileText(q: RedQuantile | null, buckets: number[]): string {
  if (!q) return "—";
  if (q.le === null) return buckets.length ? `> ${secText(buckets[buckets.length - 1]!)}` : "—";
  return `≤ ${secText(q.le)}`;
}

/** A rate: per second when ≥ 1/s, else per minute (0.07/s reads better as 4.4/min) — the unit key + the number */
export function rateText(perSecond: number): { key: "ob.red.perSec" | "ob.red.perMin"; n: string } {
  if (perSecond >= 1) return { key: "ob.red.perSec", n: perSecond >= 100 ? String(Math.round(perSecond)) : perSecond.toFixed(1) };
  const m = perSecond * 60;
  return { key: "ob.red.perMin", n: m >= 10 ? String(Math.round(m)) : m.toFixed(m === 0 ? 0 : 1) };
}

/** An error ratio: "0%" only when there were requests and none failed; "—" without requests */
export function errorRateText(r: number | null): string {
  if (r === null) return "—";
  if (r === 0) return "0%";
  const p = r * 100;
  return p < 0.01 ? "< 0.01%" : `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

/** Totals for the summary line (only services with requests outside /actuator count toward the error share) */
export function redTotals(services: RedService[]): { services: number; requests: number; errors: number; actuatorRate: number; withErrors: number } {
  return {
    services: services.length,
    requests: services.reduce((a, s) => a + s.requests, 0),
    errors: services.reduce((a, s) => a + s.errors, 0),
    actuatorRate: services.reduce((a, s) => a + s.actuatorRate, 0),
    withErrors: services.filter((s) => s.errors > 0).length,
  };
}
