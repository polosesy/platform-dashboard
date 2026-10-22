// Alert history and rule evaluation, as the live card and panel show them. Pure; tested from
// apps/api/test/liveAlerts.test.ts.
import type { AlertRuleInfo, LiveAlertHistory } from "@aud/types";

/** ISO-8601 duration (PT1M, PT5M, PT1H, P1D) → minutes; null when not one */
export function isoMinutes(d: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d ?? "");
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Card chip for a rule that fired recently and is resolved now (an active one makes the card itself red) */
export function recentAlertChip(history: LiveAlertHistory[] | undefined, nodeId: string): { count: number; sev: number; hours: number } | null {
  const mine = (history ?? []).filter((h) => h.nodeId === nodeId && !h.active);
  if (!mine.length) return null;
  return { count: mine.reduce((n, h) => n + h.count, 0), sev: Math.min(...mine.map((h) => h.sev)), hours: mine[0]!.windowHours };
}

/** "집계 Average · 5분 창 · 1분마다 평가 · BackendSettingsPool = pool" parts (i18n keys + vars) */
export function evaluationParts(e: AlertRuleInfo["evaluation"]): Array<{ key: string; vars?: Record<string, string | number> }> {
  if (!e) return [];
  const out: Array<{ key: string; vars?: Record<string, string | number> }> = [];
  if (e.aggregation) out.push({ key: "ld.rule.agg", vars: { agg: e.aggregation } });
  const w = isoMinutes(e.windowSize), f = isoMinutes(e.frequency);
  if (w != null) out.push({ key: "ld.rule.window", vars: { n: w } });
  if (f != null) out.push({ key: "ld.rule.every", vars: { n: f } });
  for (const d of e.dimensions ?? []) out.push({ key: "ld.rule.dim", vars: { dim: d } });
  if (e.autoMitigate) out.push({ key: "ld.rule.autoMitigate" });
  return out;
}

/** Minutes an instance stayed fired (null while still fired) */
export function firedMinutes(i: { firedAt: string; resolvedAt?: string }): number | null {
  if (!i.resolvedAt) return null;
  return Math.max(0, Math.round((Date.parse(i.resolvedAt) - Date.parse(i.firedAt)) / 60000));
}
