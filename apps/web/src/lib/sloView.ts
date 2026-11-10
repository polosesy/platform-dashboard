// AKS 모니터링 › SLO — pure view helpers (API services/workloadSlo.ts). The platform's state grammar: ● ok · ▲ warn ·
// ■ danger · ○ not judged (low traffic / no data) · ? the query did not answer. A target the team did not set is
// always marked "default"; "achievable" is a reference for setting one, never a verdict.

import type { SloAlert, SloService, SloSli, SloState } from "@aud/types";

export type SloLevel = "ok" | "warn" | "danger" | "neutral" | "unknown";
export const SLO_LEVEL: Record<SloState, SloLevel> = {
  fastBurn: "danger", exhausted: "danger", slowBurn: "warn", atRisk: "warn", ok: "ok", lowTraffic: "neutral", noData: "neutral", queryFailed: "unknown",
};
export const SLO_GLYPH: Record<SloLevel, string> = { ok: "●", warn: "▲", danger: "■", neutral: "○", unknown: "?" };

const RANK: Record<SloLevel, number> = { danger: 4, warn: 3, unknown: 2, ok: 1, neutral: 0 };
/**
 * Pure: an SLI's level — against a default target (not the team's promise) it never goes red: a missed default is
 * "watch" (2026-11-05 stg: 7 of 16 services missed the default 99 % ≤ 1 s, all on workflow actions that call out)
 */
export function sliLevel(s: SloSli): SloLevel {
  const level = SLO_LEVEL[s.state];
  return level === "danger" && s.targetSource === "default" ? "warn" : level;
}
/** Pure: a service's level = its worse SLI's */
export function serviceLevel(s: SloService): SloLevel {
  return s.slis.reduce<SloLevel>((w, x) => (RANK[sliLevel(x)] > RANK[w] ? sliLevel(x) : w), "neutral");
}

/** Pure: how many services sit at each level (the summary line) */
export function sloCounts(services: SloService[]): Record<SloLevel, number> {
  const out: Record<SloLevel, number> = { ok: 0, warn: 0, danger: 0, neutral: 0, unknown: 0 };
  for (const s of services) out[serviceLevel(s)]++;
  return out;
}

/** Pure: a ratio as a percent with the digits that tell it apart from a three-nines target (99.956 %, 98.21 %, 87.5 %) */
export function pctText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  const digits = v >= 0.999 ? 3 : v >= 0.99 ? 2 : 1;
  return `${p.toFixed(digits)}%`;
}
/** Pure: a target as written (0.999 → "99.9%", 0.9995 → "99.95%") */
export function targetText(t: number): string {
  return `${Number((t * 100).toFixed(4))}%`;
}

/**
 * Pure: the budget in requests — allowed bad ones over the window, used, left (negative = over). The number a reader
 * can hold: "allowed 266 failures, 116 used"
 */
export function budgetOf(s: SloSli): { allowed: number; used: number; left: number; usedPct: number } | null {
  if (s.events === null || s.bad === null || s.budgetUsed === null) return null;
  const allowed = (1 - s.target) * s.events;
  return { allowed: Math.round(allowed), used: s.bad, left: Math.round(allowed - s.bad), usedPct: Math.round(s.budgetUsed * 100) };
}

/** Pure: the bar's fill (0 – 100) and whether it ran over */
export function budgetBar(s: SloSli): { fill: number; over: boolean } | null {
  if (s.budgetUsed === null) return null;
  return { fill: Math.max(0, Math.min(100, s.budgetUsed * 100)), over: s.budgetUsed >= 1 };
}

/** Pure: a burn rate as "×14.4" (two digits under 10, none from 100) */
export function burnText(rate: number | null): string {
  if (rate === null) return "—";
  return `×${rate >= 100 ? Math.round(rate) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2)}`;
}

/** Pure: an alert's level — firing page = danger, firing ticket = warn, not firing = ok, not judged = unknown */
export function alertLevel(a: SloAlert): SloLevel {
  if (a.firing === null) return "unknown";
  if (!a.firing) return "ok";
  return a.id === "ticket3d" ? "warn" : "danger";
}

/** Pure: services shown first — problems, then the rest by name (the API already sorts; kept for filters) */
export function filterServices(services: SloService[], show: "problems" | "all", ns: string): SloService[] {
  return services.filter((s) => (ns === "" || s.namespace === ns) && (show === "all" || ["danger", "warn"].includes(serviceLevel(s))));
}

/** Pure: the SLI's label parameters — latency names the boundary actually counted */
export function sliLabelParams(s: SloSli): Record<string, string | number> {
  if (s.kind !== "latency") return {};
  const ms = s.effectiveMs ?? s.thresholdMs ?? 0;
  return { ms: ms >= 1000 ? `${Number((ms / 1000).toFixed(3))}s` : `${Math.round(ms)}ms` };
}

/** Pure: a Grafana Explore link for one PromQL (the platform links Grafana, never reads it) */
export function exploreUrl(endpoint: string, uid: string, expr: string, days: number): string {
  const panes = { aud: { datasource: uid, queries: [{ refId: "A", datasource: { uid }, expr, instant: true }], range: { from: `now-${days}d`, to: "now" } } };
  return `${endpoint}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

/** Pure: a duration in ms as written in the guide (1000 → "1s", 300 → "300ms") */
export function msText(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(3))}s` : `${Math.round(ms)}ms`;
}

/**
 * Pure: a first draft of the connection file's `aks.observability.slo` block for the guide — the file's top level
 * keeps the current window and targets; a service gets its own entry only where the window met a different standard
 * tier than that (its `achievable`), so the draft starts from what the service actually did. A draft, never applied:
 * the team checks it before an admin writes it (services/workloadSlo.ts targetsFor reads the same shape).
 */
export function sloConfigDraft(d: {
  windowDays: number;
  defaults: { availability: number; latency: { thresholdMs: number; target: number } };
  services: SloService[];
}): string {
  const services: Record<string, { availability?: number; latency?: { thresholdMs: number; target: number } }> = {};
  for (const s of [...d.services].sort((a, b) => `${a.namespace}/${a.application}`.localeCompare(`${b.namespace}/${b.application}`))) {
    if (!s.application) continue; // the key is "<namespace>/<application>" — series without the tag cannot be named
    const entry: { availability?: number; latency?: { thresholdMs: number; target: number } } = {};
    for (const x of s.slis) {
      if (x.achievable === null) continue;
      if (x.kind === "availability" && x.achievable !== d.defaults.availability) entry.availability = x.achievable;
      if (x.kind === "latency" && x.achievable !== d.defaults.latency.target) {
        entry.latency = { thresholdMs: x.thresholdMs ?? d.defaults.latency.thresholdMs, target: x.achievable };
      }
    }
    if (Object.keys(entry).length) services[`${s.namespace}/${s.application}`] = entry;
  }
  const slo = {
    windowDays: d.windowDays,
    availability: d.defaults.availability,
    latency: d.defaults.latency,
    ...(Object.keys(services).length ? { services } : {}),
  };
  return `"aks": ${JSON.stringify({ observability: { slo } }, null, 2)}`;
}
