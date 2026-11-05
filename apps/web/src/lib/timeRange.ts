// AKS 모니터링 time picker (Grafana's): one range + one auto-refresh interval for the page, read by every tab.
// Pure — the bar is components/ui TimeRangeBar, the state lib/useTimeRange.
// A range is a span (minutes) ending now (relative — what a quick range means) or ending at a fixed minute (after
// ‹‹ / ›› or a typed from–to: absolute). Panels can't all answer any span: each maps the range to what its API reads
// and says when it differs (Grafana's panel time override) — never a silent other range.

export const RANGE_PRESETS = ["5m", "15m", "30m", "1h", "3h", "6h", "12h", "24h", "2d", "7d", "14d", "30d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const PRESET_MINUTES: Record<RangePreset, number> = {
  "5m": 5, "15m": 15, "30m": 30, "1h": 60, "3h": 180, "6h": 360, "12h": 720, "24h": 1440, "2d": 2880, "7d": 10080, "14d": 20160, "30d": 43200,
};
/** A typed range: at least 5 minutes (the shortest quick range), at most 30 days */
export const MIN_SPAN = 5;
export const MAX_SPAN = 43200;

/** Off, or at least the heatmap's server cache (30 s) — a faster tick would only read the same answer again */
export const REFRESH_INTERVALS = ["off", "30s", "1m", "5m", "15m"] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];
export const INTERVAL_MS: Record<RefreshInterval, number> = { off: 0, "30s": 30_000, "1m": 60_000, "5m": 300_000, "15m": 900_000 };

const MIN = 60_000;
/** How far back ‹‹ goes: the Activity Log keeps 90 days, a 30-day range from 30 days ago stays inside it */
export const MAX_BACK_MS = 30 * 1440 * MIN;
/** An end this close to now is now (relative again — auto refresh resumes) */
const NOW_SLACK_MS = MIN;

export type TimeRange = { /** minutes */ span: number; /** epoch ms on a minute; null = now */ to: number | null };
export const DEFAULT_RANGE: TimeRange = { span: 60, to: null };

export const spanMs = (r: TimeRange) => r.span * MIN;
export const endMs = (r: TimeRange, now: number) => r.to ?? now;
/** A past range: its data no longer changes, so auto refresh waits */
export const isAbsolute = (r: TimeRange) => r.to !== null;
/** The quick range this is (ending now, a preset's span) — else it reads as from ~ to */
export const presetOf = (r: TimeRange): RangePreset | null => (r.to === null ? RANGE_PRESETS.find((p) => PRESET_MINUTES[p] === r.span) ?? null : null);

/** A span in the URL: a preset key or <n>m / <n>h / <n>d inside MIN_SPAN–MAX_SPAN; anything else = null */
export function parseSpan(s: string | null): number | null {
  if (s && (RANGE_PRESETS as readonly string[]).includes(s)) return PRESET_MINUTES[s as RangePreset];
  const m = s ? /^(\d{1,5})([mhd])$/.exec(s) : null;
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "d" ? 1440 : m[2] === "h" ? 60 : 1);
  return n >= MIN_SPAN && n <= MAX_SPAN ? n : null;
}
export function formatSpan(minutes: number): string {
  const p = RANGE_PRESETS.find((k) => PRESET_MINUTES[k] === minutes);
  if (p) return p;
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** An end as a range end: on a minute, now when within a minute of it, never more than MAX_BACK_MS ago */
export function normalizeEnd(to: number | null, now: number): number | null {
  if (to === null || !Number.isFinite(to)) return null;
  if (to >= now - NOW_SLACK_MS) return null;
  return Math.floor(Math.max(to, now - MAX_BACK_MS) / MIN) * MIN;
}

/**
 * From the URL (?range=1h&to=<epoch ms>); anything unknown is the default. Without `now` the end is only checked and
 * put on its minute — a page open for hours must not turn a fresh shift into "now" against the time it opened (the
 * handlers normalize against the clock; the API treats an end at now as now)
 */
export function parseRange(range: string | null, to: string | null, now?: number): TimeRange {
  const span = parseSpan(range) ?? DEFAULT_RANGE.span;
  const end = to && /^\d{10,14}$/.test(to) ? Number(to) : null;
  return { span, to: now === undefined ? (end === null ? null : Math.floor(end / MIN) * MIN) : normalizeEnd(end, now) };
}

/** ‹‹ / ››: half the span, Grafana's step; forward stops at now */
export function shiftRange(r: TimeRange, dir: -1 | 1, now: number): TimeRange {
  return { span: r.span, to: normalizeEnd(endMs(r, now) + dir * (spanMs(r) / 2), now) };
}
export const canShiftBack = (r: TimeRange, now: number) => endMs(r, now) - spanMs(r) / 2 >= now - MAX_BACK_MS - NOW_SLACK_MS;

/** ⊖: the next quick range wider than this one, around the same middle (an end past now is now) */
export function zoomOut(r: TimeRange, now: number): TimeRange {
  const next = RANGE_PRESETS.find((p) => PRESET_MINUTES[p] > r.span);
  if (!next) return r;
  const grow = (PRESET_MINUTES[next] - r.span) * MIN;
  return { span: PRESET_MINUTES[next], to: r.to === null ? null : normalizeEnd(r.to + grow / 2, now) };
}
export const canZoomOut = (r: TimeRange) => r.span < MAX_SPAN;

export type CustomRangeError = "invalid" | "order" | "short" | "long" | "future" | "old";
/** A typed from–to (epoch ms): minutes, MIN_SPAN–MAX_SPAN, not in the future, not ending before MAX_BACK_MS ago */
export function customRange(from: number, to: number, now: number): TimeRange | { error: CustomRangeError } {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: "invalid" };
  if (to > now + NOW_SLACK_MS) return { error: "future" };
  if (to < now - MAX_BACK_MS) return { error: "old" };
  if (to <= from) return { error: "order" };
  const span = Math.round((to - from) / MIN);
  if (span < MIN_SPAN) return { error: "short" };
  if (span > MAX_SPAN) return { error: "long" };
  return { span, to: normalizeEnd(to, now) };
}

/** The `at` an API takes (epoch seconds), none for now */
export const atParam = (r: TimeRange): string | undefined => (r.to === null ? undefined : String(Math.floor(r.to / 1000)));

/**
 * What a panel reads for the range: its own minutes / days and whether that differs from the range — "max" = the
 * range is longer than the panel reads (its last part), "min" = shorter (the panel reads more, ending at the same
 * time), "round" = the panel's nearest wider window
 */
export type PanelSpan = { value: number; differs: "max" | "min" | "round" | null };

/** The smallest window that covers the span; past the largest = the largest (the range's last part) */
export function fitWindow(r: TimeRange, windows: readonly number[]): PanelSpan {
  const fit = windows.find((w) => w >= r.span);
  if (fit === undefined) return { value: windows[windows.length - 1]!, differs: "max" };
  return { value: fit, differs: fit === r.span ? null : r.span < windows[0]! ? "min" : "round" };
}

/** Heatmap windows the API answers (minutes) — every quick range up to a day; longer = the last 24 h of the range */
export const HEAT_WINDOWS = [5, 15, 30, 60, 180, 360, 720, 1440] as const;
export const heatWindowFor = (r: TimeRange) => fitWindow(r, HEAT_WINDOWS);

/**
 * A workload's Loki log stream (the side panel): up to 6 h — a stream reads every line of the workload's pods, and the
 * customer's Loki is a single binary whose CPU the alert queries already saturate (2026-11-05)
 */
export const WORKLOAD_LOG_WINDOWS = [5, 15, 30, 60, 180, 360] as const;

/** One pod's logs (the 로그 tab): any minutes up to a day (the API's limit) */
export function podLogMinutesFor(r: TimeRange): PanelSpan {
  return r.span > 1440 ? { value: 1440, differs: "max" } : { value: r.span, differs: null };
}

/** Node maintenance reads whole days, 1–30: shorter ranges show the last day (episodes take hours) */
export function maintDaysFor(r: TimeRange): PanelSpan {
  const days = Math.min(30, Math.max(1, Math.ceil(r.span / 1440)));
  return { value: days, differs: r.span < 1440 ? "min" : days * 1440 === r.span ? null : "round" };
}

export const parseInterval = (v: string | null): RefreshInterval => ((REFRESH_INTERVALS as readonly string[]).includes(v ?? "") ? (v as RefreshInterval) : "off");

/** `datetime-local` value (local time, minutes) ↔ epoch ms */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): number => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? new Date(v).getTime() : NaN);

/**
 * Grafana's time keys: t then ← (back) / → (forward) / z (zoom out), within a second. Pure: the key event in, what
 * to do out; `armed` = when t was pressed. Ignored while typing (an input, select, textarea or editable element).
 */
export type TimeKeyAction = "arm" | "back" | "forward" | "zoomOut" | null;
export function timeKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown }, armed: number | null, now: number): TimeKeyAction {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName ?? ""))) return null;
  if (armed !== null && now - armed <= 1000) {
    if (e.key === "ArrowLeft") return "back";
    if (e.key === "ArrowRight") return "forward";
    if (e.key === "z" || e.key === "Z") return "zoomOut";
  }
  return e.key === "t" || e.key === "T" ? "arm" : null;
}
