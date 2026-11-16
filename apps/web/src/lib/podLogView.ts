// AKS 모니터링 › 로그 — the pod log list's view helpers (pure): the level filter, what a line's detail shows
// (Grafana's log details: indexed labels · structured metadata · the line's own fields), and the context list.

import type { PodLogEntry } from "@aud/types";

export type LogLevel = "error" | "warn" | "info" | "unknown";
export const LEVEL_GLYPH: Record<LogLevel, string> = { error: "■", warn: "▲", info: "●", unknown: "○" };

const LEVEL_WORD = /(^|[\s[|])(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
/**
 * The line's level: the API's (Loki's detected level or the level word in the line); a line from kubelet or
 * Container Insights carries none, so the level word the line itself states is read — else unknown (never guessed)
 */
export function levelOf(l: PodLogEntry): LogLevel {
  if (l.level) return l.level;
  const w = LEVEL_WORD.exec(l.logMessage.slice(0, 400))?.[2];
  return !w ? "unknown" : w === "ERROR" || w === "FATAL" ? "error" : w.startsWith("WARN") ? "warn" : "info";
}

export type LevelFilter = "all" | "error" | "warn";
/** Pure: errors only · warnings and worse · everything */
export function passesLevel(l: PodLogEntry, f: LevelFilter): boolean {
  const lv = levelOf(l);
  return f === "all" || lv === "error" || (f === "warn" && lv === "warn");
}

/** Pure: lines per level (the filter's counts) */
export function levelCounts(lines: PodLogEntry[]): Record<LogLevel, number> {
  const n: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, unknown: 0 };
  for (const l of lines) n[levelOf(l)]++;
  return n;
}

/**
 * Pure: the level filter's numbers. The API filters on the server with the log insights' rules and counts the scope's
 * ERROR / WARN lines over the whole window (Loki) — those are the numbers; without counts (kubelet, Container
 * Insights, over 6 h) there are none (null), never the lines that happen to be loaded (2026-11-16: "ERROR 0" next to
 * "ERROR 4" — one counted 300 lines of one pod, the other an hour of every pod).
 */
export function levelNumbers(counts: { error: number | null; warn: number | null } | null | undefined): { error: number | null; warnPlus: number | null } {
  if (!counts) return { error: null, warnPlus: null };
  return { error: counts.error, warnPlus: counts.error === null || counts.warn === null ? null : counts.error + counts.warn };
}

export type Coverage = { kind: "complete" } | { kind: "partial"; from: string; minutes: number } | { kind: "unknown" };
/**
 * Pure: how much of the window the lines cover — all of it, or the newest lines back to `from` (minutes of the
 * window, rounded up, never more than the window)
 */
export function coverageOf(cov: { complete: boolean; from: string | null } | undefined, windowMinutes: number, endIso: string): Coverage {
  if (!cov) return { kind: "unknown" };
  if (cov.complete) return { kind: "complete" };
  const from = cov.from ? Date.parse(cov.from) : NaN, end = Date.parse(endIso);
  if (!Number.isFinite(from) || !Number.isFinite(end)) return { kind: "unknown" };
  return { kind: "partial", from: cov.from!, minutes: Math.min(windowMinutes, Math.max(1, Math.ceil((end - from) / 60_000))) };
}

/** Pure: the pod's tail for a row when lines of several pods are listed (`…-drjd7` → `drjd7`) */
export const podTail = (pod: string): string => pod.split("-").pop() ?? pod;

/** A row's identity: the exact timestamp when Loki gave one (two lines can share a millisecond), else its position */
export const lineKey = (l: PodLogEntry, i: number): string => (l.tsNs ? `${l.tsNs}:${i}` : `i${i}`);

/** Pure: label pairs sorted by name, for the detail tables; empty = the group is not shown */
export function labelRows(labels: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(labels ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Pure: the first line of a message (the row's summary) — the rest shows when the row is opened */
export function firstLine(text: string, max = 400): string {
  const one = text.split("\n", 1)[0] ?? "";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Pure: whether the surrounding lines can be asked for — a Loki line (it has its exact timestamp) */
export const hasContext = (l: PodLogEntry): boolean => !!l.tsNs && /^\d{16,20}$/.test(l.tsNs);

/** Pure: the line as text to copy — time, level, message; then its labels and metadata as `name="value"` */
export function lineText(l: PodLogEntry): string {
  const pairs = (m: Record<string, string> | undefined) => labelRows(m).map(([k, v]) => `${k}="${v}"`).join(" ");
  return [`${l.timestamp} ${l.logMessage}`, pairs(l.labels), pairs(l.metadata)].filter(Boolean).join("\n");
}
