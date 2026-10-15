"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const read = () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches);

/**
 * The OS "reduce motion" setting, live. CSS cannot stop SMIL animations (`<animateMotion>`), so components that
 * use them read this and render a still frame instead.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
