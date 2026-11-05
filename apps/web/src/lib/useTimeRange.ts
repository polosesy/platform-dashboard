"use client";

// The page's time range and auto refresh (lib/timeRange.ts) as URL state — ?range=1h&to=<epoch ms>&refresh=30s, so a
// link opens the same view (Grafana's from / to / refresh). `nonce` goes up on 새로 고침 and on every auto tick; panels
// reload when it changes and report while they load (`report`), so the button spins until the last one answers and
// a tick never stacks on a slow one. Auto refresh runs only in a visible tab (startPolling) and waits while the range
// is in the past (its data does not change). Callers sit under a <Suspense> (useSearchParams).

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { withParam } from "./queryParam";
import { startPolling } from "./usePolling";
import { DEFAULT_PRESET, INTERVAL_MS, isAbsolute, parseInterval, parseRange, type RefreshInterval, type TimeRange } from "./timeRange";

export type TimeRangeState = {
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  interval: RefreshInterval;
  setInterval: (v: RefreshInterval) => void;
  /** Auto refresh is set but waiting: the range ends in the past */
  paused: boolean;
  /** Up on every refresh (manual or auto) — 0 until the first */
  nonce: number;
  refresh: () => void;
  busy: boolean;
  /** A panel loading (true) / done (false), by a name of its own */
  report: (id: string, loading: boolean) => void;
  /** When the page opened — "now" for render-time checks (how far back ‹‹ may go); handlers read the clock */
  mountedAt: number;
};

export function useTimeRange(): TimeRangeState {
  const params = useSearchParams();
  const pathname = usePathname();
  const [mountedAt] = useState(() => Date.now());
  const range = parseRange(params.get("range"), params.get("to"));
  const interval = parseInterval(params.get("refresh"));
  const paused = interval !== "off" && isAbsolute(range);

  const write = useCallback((set: Record<string, [string, string]>) => {
    let search = window.location.search;
    for (const [name, [value, fallback]] of Object.entries(set)) search = withParam(search, name, value, fallback);
    window.history.replaceState(null, "", `${pathname}${search}${window.location.hash}`);
  }, [pathname]);
  const setRange = useCallback((r: TimeRange) => write({ range: [r.preset, DEFAULT_PRESET], to: [r.to === null ? "" : String(r.to), ""] }), [write]);
  const setInterval = useCallback((v: RefreshInterval) => write({ refresh: [v, "off"] }), [write]);

  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const busy = Object.values(loading).some(Boolean);
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const report = useCallback((id: string, v: boolean) => setLoading((s) => (!!s[id] === v ? s : { ...s, [id]: v })), []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const ms = paused ? 0 : INTERVAL_MS[interval];
  useEffect(() => {
    if (!ms) return;
    // startPolling ticks at once (and when the tab is shown again): the first one is the current view, not a refresh
    let first = true;
    return startPolling(() => {
      if (first) { first = false; return; }
      if (!busyRef.current) refresh();
    }, ms);
  }, [ms, refresh]);

  return { range, setRange, interval, setInterval, paused, nonce, refresh, busy, report, mountedAt };
}

/** In a panel: reload on each refresh after the first render, and tell the page while loading */
export function useRangeRefresh(id: string, nonce: number, loading: boolean, reload: () => void, report?: (id: string, loading: boolean) => void) {
  const seen = useRef(nonce);
  useEffect(() => {
    if (seen.current === nonce) return;
    seen.current = nonce;
    reload();
  }, [nonce, reload]);
  useEffect(() => { report?.(id, loading); }, [id, loading, report]);
  useEffect(() => () => report?.(id, false), [id, report]);
}
