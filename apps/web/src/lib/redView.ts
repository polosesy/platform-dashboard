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

/** A count from increase() — extrapolated to the window's edges, so not whole (753.55): shown rounded; above 0 but under ½ = "< 1" */
export function countText(n: number, locale: string): string {
  return n > 0 && n < 0.5 ? "< 1" : Math.round(n).toLocaleString(locale);
}

/**
 * An endpoint as people read it: Spring route templates carry the path variable's regular expression
 * (`/applications/{applicationid:[0-9a-f]{8}-…{12}}`) — keep the variable's name only (`/applications/{applicationid}`).
 * The full name stays in the tooltip.
 */
export function endpointLabel(name: string): string {
  let out = "", i = 0;
  while (i < name.length) {
    const m = name[i] === "{" ? /^\{([A-Za-z_][\w.-]*):/.exec(name.slice(i)) : null;
    if (!m) { out += name[i++]; continue; }
    let depth = 0, j = i;
    for (; j < name.length; j++) {
      if (name[j] === "{") depth++;
      else if (name[j] === "}" && --depth === 0) break;
    }
    if (j >= name.length) { out += name.slice(i); break; } // unbalanced: leave as it is
    out += `{${m[1]}}`;
    i = j + 1;
  }
  return out;
}

/** Services with user requests in the window, and those whose server spans were only /actuator (no request to judge) */
export function splitByTraffic(services: RedService[]): { active: RedService[]; idle: RedService[] } {
  return { active: services.filter((s) => s.requests > 0), idle: services.filter((s) => !(s.requests > 0)) };
}

/** Totals for the summary line (only services with requests outside /actuator count toward the error share) */
export function redTotals(services: RedService[]): { services: number; active: number; requests: number; errors: number; actuatorRate: number; withErrors: number } {
  return {
    services: services.length,
    active: services.filter((s) => s.requests > 0).length,
    requests: services.reduce((a, s) => a + s.requests, 0),
    errors: services.reduce((a, s) => a + s.errors, 0),
    actuatorRate: services.reduce((a, s) => a + s.actuatorRate, 0),
    withErrors: services.filter((s) => s.errors > 0).length,
  };
}
