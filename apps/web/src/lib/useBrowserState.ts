"use client";

import { useCallback, useSyncExternalStore } from "react";

/** `matchMedia` result; `false` during server render and hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const LOCAL_EVENT = "aud-local-storage";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private mode / blocked storage
  }
}

/**
 * A string preference kept in localStorage (per viewer convenience only).
 * Falls back to `fallback` on the server, on hydration and when storage is blocked.
 */
export function useLocalPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const subscribe = useCallback((cb: () => void) => {
    const on = (e: Event) => {
      if (e instanceof StorageEvent ? e.key === key : (e as CustomEvent<string>).detail === key) cb();
    };
    window.addEventListener("storage", on);
    window.addEventListener(LOCAL_EVENT, on);
    return () => {
      window.removeEventListener("storage", on);
      window.removeEventListener(LOCAL_EVENT, on);
    };
  }, [key]);
  const raw = useSyncExternalStore(subscribe, () => readLocal(key), () => null);
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback((v: T) => {
    try {
      window.localStorage.setItem(key, v);
    } catch {
      /* blocked storage: preference is not kept */
    }
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: key }));
  }, [key]);
  return [value, set];
}
