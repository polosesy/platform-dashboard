"use client";

// Display preferences — theme (밝게 · 어둡게 · 시스템) and density (편안함 · 조밀). Per browser (localStorage), applied as
// data attributes on <html> that switch the token sets in app/globals.css. Light + comfortable is the default; dark is
// opt-in while some canvases keep their own light paper (design-system.md).

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
export type Density = "comfortable" | "compact";
import { PREFS_KEYS as KEYS } from "./displayPrefsBoot";
const EVENT = "aud:display-prefs";

const read = (): { theme: Theme; density: Density } => {
  try {
    const t = localStorage.getItem(KEYS.theme);
    const n = localStorage.getItem(KEYS.density);
    return { theme: t === "dark" || t === "system" ? t : "light", density: n === "compact" ? "compact" : "comfortable" };
  } catch {
    return { theme: "light", density: "comfortable" };
  }
};

function apply(p: { theme: Theme; density: Density }) {
  const d = document.documentElement;
  if (p.theme === "light") delete d.dataset.theme;
  else d.dataset.theme = p.theme;
  if (p.density === "compact") d.dataset.density = "compact";
  else delete d.dataset.density;
}

let snapshot = "light|comfortable";
const subscribe = (onChange: () => void) => {
  const on = () => onChange();
  window.addEventListener(EVENT, on);
  window.addEventListener("storage", on);
  return () => { window.removeEventListener(EVENT, on); window.removeEventListener("storage", on); };
};
const getSnapshot = () => {
  const p = read();
  const next = `${p.theme}|${p.density}`;
  if (next !== snapshot) snapshot = next;
  return snapshot;
};

export function useDisplayPrefs() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => "light|comfortable");
  const [theme, density] = snap.split("|") as [Theme, Density];
  const save = useCallback((p: { theme: Theme; density: Density }) => {
    try {
      localStorage.setItem(KEYS.theme, p.theme);
      localStorage.setItem(KEYS.density, p.density);
    } catch { /* storage blocked — applies for this page only */ }
    apply(p);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return {
    theme,
    density,
    setTheme: (t: Theme) => save({ theme: t, density }),
    setDensity: (n: Density) => save({ theme, density: n }),
  };
}
