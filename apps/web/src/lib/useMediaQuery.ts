"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches now (and on change). The server render and the first client render answer false,
 * so the markup matches; the real answer follows right after mount.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches),
    () => false,
  );
}

/** The width at which the menu docks on the left (the same number as AppShell / Sidebar CSS) */
export const DOCK_QUERY = "(min-width: 1100px)";
