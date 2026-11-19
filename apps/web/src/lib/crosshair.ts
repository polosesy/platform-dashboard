// Shared crosshair (2026-11-19) — charts on one time axis (APM › 메트릭, 수집 상태 › 수집기 신호) follow the pointer
// together: the chart under the pointer says the time, every chart of the group draws a line there and reads its own
// values at that time. Pure: the store (no React) and the snapping rule, so the API tests can check them.
//
// Snapping: each chart has its own points (a percentile has none where there were no requests), so a chart takes ITS
// nearest point to the shared time — only within 1.5 × its step; farther = no value ("—"), never a neighbour's value
// from minutes away passed off as "at this time".

export type CrosshairState = { ms: number; source: string } | null;

export type CrosshairStore = {
  get: () => CrosshairState;
  set: (s: CrosshairState) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createCrosshair(): CrosshairStore {
  let state: CrosshairState = null;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (s) => {
      if (s === state || (s && state && s.ms === state.ms && s.source === state.source)) return;
      state = s;
      for (const fn of subs) fn();
    },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** The usual gap between a chart's points (the median — one missing point does not double it); null with < 2 points */
export function stepOf(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => t - times[i]!).filter((g) => g > 0).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;
}

/** This chart's point nearest the shared time — null when none is within 1.5 × its step (sorted times) */
export function snapTime(times: readonly number[], ms: number, step = stepOf(times)): number | null {
  if (!times.length || !Number.isFinite(ms)) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid]! < ms) lo = mid + 1; else hi = mid; }
  const best = lo > 0 && Math.abs(times[lo - 1]! - ms) <= Math.abs(times[lo]! - ms) ? times[lo - 1]! : times[lo]!;
  const reach = step === null ? 0 : step * 1.5;
  return Math.abs(best - ms) <= reach ? best : null;
}

/** The pointer's time on a plot: x in the plot box → ms, clamped to the range */
export function timeAtX(px: number, left: number, width: number, from: number, to: number): number {
  const f = Math.min(1, Math.max(0, (px - left) / Math.max(1, width)));
  return from + f * (to - from);
}
