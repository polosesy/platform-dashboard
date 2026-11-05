// AKS 모니터링 time picker (Grafana's): one range + one auto-refresh interval for the page, read by every panel of the
// 클러스터 · 워크로드 and 노드 tabs. Pure — the bar is components/ui TimeRangeBar, the state lib/useTimeRange.
// A range is a span ending now (relative — what a quick range means) or ending at a fixed minute (after ‹‹ / ››:
// absolute). Panels can't all answer any span: each maps the range to what its API reads and says when it differs
// (Grafana's panel time override) — never a silent other range.

export const RANGE_PRESETS = ["5m", "15m", "30m", "1h", "3h", "6h", "12h", "24h", "2d", "7d", "14d", "30d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const PRESET_MINUTES: Record<RangePreset, number> = {
  "5m": 5, "15m": 15, "30m": 30, "1h": 60, "3h": 180, "6h": 360, "12h": 720, "24h": 1440, "2d": 2880, "7d": 10080, "14d": 20160, "30d": 43200,
};
export const DEFAULT_PRESET: RangePreset = "1h";

/** Off, or at least the heatmap's server cache (30 s) — a faster tick would only read the same answer again */
export const REFRESH_INTERVALS = ["off", "30s", "1m", "5m", "15m"] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];
export const INTERVAL_MS: Record<RefreshInterval, number> = { off: 0, "30s": 30_000, "1m": 60_000, "5m": 300_000, "15m": 900_000 };

const MIN = 60_000;
/** How far back ‹‹ goes: the Activity Log keeps 90 days, a 30-day range from 30 days ago stays inside it */
export const MAX_BACK_MS = 30 * 1440 * MIN;
/** An end this close to now is now (relative again — auto refresh resumes) */
const NOW_SLACK_MS = MIN;

export type TimeRange = { preset: RangePreset; /** epoch ms on a minute; null = now */ to: number | null };

export const spanMs = (r: TimeRange) => PRESET_MINUTES[r.preset] * MIN;
export const endMs = (r: TimeRange, now: number) => r.to ?? now;
/** A past range: its data no longer changes, so auto refresh waits */
export const isAbsolute = (r: TimeRange) => r.to !== null;

/** An end as a range end: on a minute, now when within a minute of it, never more than MAX_BACK_MS ago */
export function normalizeEnd(to: number | null, now: number): number | null {
  if (to === null || !Number.isFinite(to)) return null;
  if (to >= now - NOW_SLACK_MS) return null;
  return Math.floor(Math.max(to, now - MAX_BACK_MS) / MIN) * MIN;
}

/**
 * From the URL (?range=1h&to=<epoch ms>); anything unknown is the default. Without `now` the end is only checked and
 * put on its minute — a page open for hours must not turn a fresh shift into "now" against the time it opened (the
 * shift handlers normalize against the clock; the API treats an end at now as now)
 */
export function parseRange(range: string | null, to: string | null, now?: number): TimeRange {
  const preset = (RANGE_PRESETS as readonly string[]).includes(range ?? "") ? (range as RangePreset) : DEFAULT_PRESET;
  const end = to && /^\d{10,14}$/.test(to) ? Number(to) : null;
  return { preset, to: now === undefined ? (end === null ? null : Math.floor(end / MIN) * MIN) : normalizeEnd(end, now) };
}

/** ‹‹ / ››: half the span, Grafana's step; forward stops at now */
export function shiftRange(r: TimeRange, dir: -1 | 1, now: number): TimeRange {
  return { preset: r.preset, to: normalizeEnd(endMs(r, now) + dir * (spanMs(r) / 2), now) };
}
export const canShiftBack = (r: TimeRange, now: number) => endMs(r, now) - spanMs(r) / 2 >= now - MAX_BACK_MS - NOW_SLACK_MS;

/** ⊖: the next preset, around the same middle (an end past now is now) */
export function zoomOut(r: TimeRange, now: number): TimeRange {
  const i = RANGE_PRESETS.indexOf(r.preset);
  if (i === RANGE_PRESETS.length - 1) return r;
  const preset = RANGE_PRESETS[i + 1]!;
  const grow = PRESET_MINUTES[preset] * MIN - spanMs(r);
  return { preset, to: r.to === null ? null : normalizeEnd(r.to + grow / 2, now) };
}
export const canZoomOut = (r: TimeRange) => r.preset !== RANGE_PRESETS[RANGE_PRESETS.length - 1];

/** The `at` an API takes (epoch seconds), none for now */
export const atParam = (r: TimeRange): string | undefined => (r.to === null ? undefined : String(Math.floor(r.to / 1000)));

/** What a panel reads for the range: its own minutes / days, and whether that differs from the range (and how) */
export type PanelSpan = { value: number; differs: "max" | "min" | null };

/** Heatmap windows the API answers (minutes) — every preset up to a day; longer = the last 24 h of the range */
export const HEAT_WINDOWS = [5, 15, 30, 60, 180, 360, 720, 1440] as const;
export function heatWindowFor(r: TimeRange): PanelSpan {
  const m = PRESET_MINUTES[r.preset];
  const fit = HEAT_WINDOWS.find((w) => w >= m);
  return fit === undefined ? { value: HEAT_WINDOWS[HEAT_WINDOWS.length - 1]!, differs: "max" } : { value: fit, differs: fit === m ? null : "max" };
}

/** Node maintenance reads whole days, 1–30: shorter ranges show the last day (episodes take hours) */
export function maintDaysFor(r: TimeRange): PanelSpan {
  const m = PRESET_MINUTES[r.preset];
  const days = Math.min(30, Math.max(1, Math.ceil(m / 1440)));
  return { value: days, differs: m < 1440 ? "min" : null };
}

export const parseInterval = (v: string | null): RefreshInterval => ((REFRESH_INTERVALS as readonly string[]).includes(v ?? "") ? (v as RefreshInterval) : "off");
