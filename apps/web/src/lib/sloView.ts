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

/** The standard targets a team picks from — the same list as the API's SLO_TIERS (test-checked) */
export const SLO_TIERS = [0.9, 0.95, 0.99, 0.995, 0.999, 0.9995, 0.9999] as const;

/**
 * Pure: the draft's target for a met tier — one tier below it, so the budget has room (a target equal to what the
 * window just did spends the whole budget on an ordinary month); the lowest tier stays itself
 */
export function draftTarget(achievable: number): number {
  const i = SLO_TIERS.findIndex((x) => Math.abs(x - achievable) < 1e-9);
  return i <= 0 ? achievable : SLO_TIERS[i - 1]!;
}

/**
 * Pure: a first draft of the connection file's `aks.observability.slo` block for the guide — the file's top level
 * keeps the current window and targets; a service gets its own entry only where its draft target (one tier under what
 * the window met — `draftTarget`) differs from that, so the draft starts from what the service actually did, with
 * room. One service per line so a dozen services stay readable. A draft, never applied: the team checks it before an
 * admin writes it (services/workloadSlo.ts targetsFor reads the same shape). Services that met no tier are left to the
 * top level (and named by the guide's table).
 */
export function sloConfigDraft(d: {
  windowDays: number;
  defaults: { availability: number; latency: { thresholdMs: number; target: number } };
  services: SloService[];
}): string {
  const lines: string[] = [];
  for (const s of [...d.services].sort((a, b) => `${a.namespace}/${a.application}`.localeCompare(`${b.namespace}/${b.application}`))) {
    if (!s.application) continue; // the key is "<namespace>/<application>" — series without the tag cannot be named
    const entry: { availability?: number; latency?: { thresholdMs: number; target: number } } = {};
    for (const x of s.slis) {
      if (x.achievable === null) continue;
      const target = draftTarget(x.achievable);
      if (x.kind === "availability" && target !== d.defaults.availability) entry.availability = target;
      if (x.kind === "latency" && target !== d.defaults.latency.target) {
        entry.latency = { thresholdMs: x.thresholdMs ?? d.defaults.latency.thresholdMs, target };
      }
    }
    if (Object.keys(entry).length) lines.push(`        ${JSON.stringify(`${s.namespace}/${s.application}`)}: ${JSON.stringify(entry).replace(/([{,])"/g, "$1 \"").replace(/":/g, "\": ").replace(/}/g, " }")}`);
  }
  const lat = d.defaults.latency;
  return [
    `"aks": {`,
    `  "observability": {`,
    `    "slo": {`,
    `      "windowDays": ${d.windowDays},`,
    `      "availability": ${d.defaults.availability},`,
    `      "latency": { "thresholdMs": ${lat.thresholdMs}, "target": ${lat.target} }${lines.length ? "," : ""}`,
    ...(lines.length ? [`      "services": {`, lines.join(",\n"), `      }`] : []),
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}

/** The thresholds teams usually pick (ms) — the guide shows which boundary each one is actually counted at */
export const COMMON_THRESHOLDS_MS = [100, 200, 300, 500, 1000, 2000, 3000, 5000] as const;

/**
 * Pure: for each common threshold, the boundary it is counted at (the largest at or under it — the API's
 * effectiveBucket) and whether that is exact; plus the boundaries without duplicates in the guide's text
 * (Micrometer's default histogram has ~90, several of which read alike: 1.048 ms, 1.398 ms → "1ms")
 */
export function bucketHints(bucketsSec: number[]): { picks: Array<{ ms: number; countedMs: number | null; exact: boolean }>; all: string[] } {
  const ms = [...bucketsSec].filter(Number.isFinite).map((b) => b * 1000).sort((a, b) => a - b);
  const picks = COMMON_THRESHOLDS_MS.map((t) => {
    const under = ms.filter((b) => b <= t * (1 + 1e-9));
    const counted = under.length ? under[under.length - 1]! : null;
    return { ms: t, countedMs: counted, exact: counted !== null && Math.abs(counted - t) < 1e-6 };
  });
  return { picks, all: [...new Set(ms.map(msText))] };
}
