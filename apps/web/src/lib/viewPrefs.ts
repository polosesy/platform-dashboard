"use client";

// 설정 › 보기 설정 (2026-11-19) — the per-browser view preferences that are not theme / density (lib/displayPrefs) or
// language (lib/i18n): how the menu behaves, and which subscriptions the scope bar offers (Azure Portal's "고급 필터":
// every screen inherits it — the scope bar, the pages' subscription and cluster lists). Per browser (localStorage) —
// a person's own view, never shared and never sent to the API. Pure helpers below are tested (viewPrefs.test.ts).

import { useCallback, useSyncExternalStore } from "react";

/** auto = docked on a wide screen (≥ 1100 px), a drawer below · drawer = always a drawer (more room for the page) */
export type MenuMode = "auto" | "drawer";
export type ViewPrefs = {
  menu: MenuMode;
  /** the subscription filter is on (off = every subscription, whatever is hidden) */
  filterOn: boolean;
  /** subscriptions hidden from the scope bar — a new subscription shows until someone hides it */
  hidden: string[];
  /** the subscription a new tab opens on ("" = the first one) */
  start: string;
};
export const DEFAULT_VIEW_PREFS: ViewPrefs = { menu: "auto", filterOn: true, hidden: [], start: "" };
const KEY = "aud.prefs.view";
const EVENT = "aud:view-prefs";
const GUIDISH = /^[0-9a-f-]{8,64}$/i;

/** Pure: a stored value → prefs (anything unknown or malformed = the default) */
export function parseViewPrefs(raw: string | null): ViewPrefs {
  try {
    const v = raw ? JSON.parse(raw) as Partial<ViewPrefs> : {};
    return {
      menu: v.menu === "drawer" ? "drawer" : "auto",
      filterOn: v.filterOn !== false,
      hidden: Array.isArray(v.hidden) ? [...new Set(v.hidden.filter((x): x is string => typeof x === "string" && GUIDISH.test(x)).map((x) => x.toLowerCase()))].slice(0, 500) : [],
      start: typeof v.start === "string" && GUIDISH.test(v.start) ? v.start.toLowerCase() : "",
    };
  } catch {
    return { ...DEFAULT_VIEW_PREFS };
  }
}

/**
 * Pure: the subscriptions the scope bar offers — the hidden ones left out while the filter is on; a filter that would
 * leave nothing is not applied (`ignored`) so a person can never lock themselves out of every screen
 */
export function visibleSubscriptions<T extends { subscriptionId: string }>(all: T[], p: Pick<ViewPrefs, "filterOn" | "hidden">): { list: T[]; hiddenCount: number; ignored: boolean } {
  if (!p.filterOn || !p.hidden.length) return { list: all, hiddenCount: 0, ignored: false };
  const hide = new Set(p.hidden);
  const list = all.filter((s) => !hide.has(s.subscriptionId.toLowerCase()));
  return list.length ? { list, hiddenCount: all.length - list.length, ignored: false } : { list: all, hiddenCount: 0, ignored: all.length > 0 };
}

/** Pure: a cluster's subscription from its ARM ID ("" when not an ARM ID) */
export const subscriptionOfId = (armId: string) => /^\/subscriptions\/([^/]+)\//i.exec(armId)?.[1]?.toLowerCase() ?? "";

/**
 * Pure: the clusters outside the hidden subscriptions (a cluster whose ID names no subscription stays); a filter that
 * would leave none is not applied — like the subscriptions
 */
export function visibleClusters<T extends { id: string }>(all: T[], p: Pick<ViewPrefs, "filterOn" | "hidden">): T[] {
  if (!p.filterOn || !p.hidden.length) return all;
  const hide = new Set(p.hidden);
  const kept = all.filter((c) => { const s = subscriptionOfId(c.id); return !s || !hide.has(s); });
  return kept.length ? kept : all;
}

/** Pure: the subscription a tab opens on — the chosen one, else the start one when visible, else the first */
export function initialSubscription(list: Array<{ subscriptionId: string }>, chosen: string, start: string): string {
  const has = (id: string) => !!id && list.some((s) => s.subscriptionId.toLowerCase() === id.toLowerCase());
  if (has(chosen)) return list.find((s) => s.subscriptionId.toLowerCase() === chosen.toLowerCase())!.subscriptionId;
  if (has(start)) return list.find((s) => s.subscriptionId.toLowerCase() === start.toLowerCase())!.subscriptionId;
  return list[0]?.subscriptionId ?? "";
}

let cache: { raw: string | null; prefs: ViewPrefs } = { raw: null, prefs: DEFAULT_VIEW_PREFS };
const readRaw = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const getSnapshot = (): ViewPrefs => {
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, prefs: parseViewPrefs(raw) };
  return cache.prefs;
};
const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener("storage", onChange); };
};

export function useViewPrefs(): [ViewPrefs, (patch: Partial<ViewPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_VIEW_PREFS);
  const save = useCallback((patch: Partial<ViewPrefs>) => {
    const next = parseViewPrefs(JSON.stringify({ ...getSnapshot(), ...patch }));
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { cache = { raw: JSON.stringify(next), prefs: next }; }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [prefs, save];
}
