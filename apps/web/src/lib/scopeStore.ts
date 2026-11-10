"use client";

// The scope a person is looking at — subscription and AKS cluster — shared by every screen and the scope bar at the top
// of the page (components/ScopeBar.tsx): pick a cluster on AKS 모니터링 and AKS 클러스터 opens on the same one.
// Per tab (sessionStorage), so two tabs can look at two clusters. Also: one in-flight request per list, shared by the
// scope bar and the page (the lists are the same).

import { useCallback, useSyncExternalStore } from "react";

export type ScopeKind = "subscription" | "cluster";
const KEYS: Record<ScopeKind, string> = { subscription: "aud.scope.subscription", cluster: "aud.scope.cluster" };
const memory: Record<ScopeKind, string> = { subscription: "", cluster: "" };
const listeners = new Set<() => void>();

function read(kind: ScopeKind): string {
  try {
    return window.sessionStorage.getItem(KEYS[kind]) ?? memory[kind];
  } catch {
    return memory[kind];
  }
}

/** [chosen id ("" = none yet), set] for one scope — every caller sees the same value */
export function useScopeChoice(kind: ScopeKind): [string, (id: string) => void] {
  const value = useSyncExternalStore(
    (onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    () => read(kind),
    () => "",
  );
  const set = useCallback((id: string) => {
    memory[kind] = id;
    try { window.sessionStorage.setItem(KEYS[kind], id); } catch { /* storage blocked — memory only */ }
    listeners.forEach((l) => l());
  }, [kind]);
  return [value, set];
}

const inflight = new Map<string, { at: number; promise: Promise<unknown> }>();
/** One request per key for 30 s (the scope bar and the page ask for the same list at the same time) */
export function sharedLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.promise as Promise<T>;
  const promise = load().catch((e: unknown) => { inflight.delete(key); throw e; });
  inflight.set(key, { at: Date.now(), promise });
  return promise;
}
