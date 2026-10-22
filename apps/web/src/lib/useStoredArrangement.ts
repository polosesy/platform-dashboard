"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_ARRANGEMENT, parseArrangement, serializeArrangement, type Arrangement } from "@/lib/archArrange";

const HISTORY = 50;
/** Keyboard steps on the same shape within this window are one undo step */
const MERGE_MS = 700;

/**
 * A manual arrangement (lib/archArrange, lib/liveArrange) kept in this browser under `storageKey` (localStorage, every
 * access in try/catch — a private window just starts empty), with undo / redo for the session. History changes
 * happen in the event handlers, never inside a state updater (React may run an updater twice).
 * Another key (another subscription / diagram) loads its own arrangement and starts a fresh history.
 */
const read = (key: string): Arrangement => {
  try { return parseArrangement(window.localStorage.getItem(key)); } catch { return EMPTY_ARRANGEMENT; }
};

export function useStoredArrangement(storageKey: string) {
  const [arrangement, setArrangement] = useState<Arrangement>(() => read(storageKey));
  const past = useRef<Arrangement[]>([]);
  const future = useRef<Arrangement[]>([]);
  // Key changed: reset during render (React re-renders before committing, so the save effect below never writes the
  // previous key's arrangement under the new key)
  const [loadedKey, setLoadedKey] = useState(storageKey);
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey);
    setArrangement(read(storageKey));
    past.current = [];
    future.current = [];
  }
  const current = useRef(arrangement);
  current.current = arrangement;
  const lastMerge = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    try {
      const empty = !arrangement.order.size && !arrangement.grid.size && !arrangement.lines.length;
      if (empty) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, serializeArrangement(arrangement));
    } catch { /* storage unavailable — the edit lives for this page only */ }
  }, [arrangement, storageKey]);

  /** A new state, undoable; `merge` = a key whose repeats within MERGE_MS join the previous undo step */
  const commit = useCallback((next: Arrangement, merge?: string) => {
    const now = Date.now();
    const joins = !!merge && lastMerge.current?.key === merge && now - lastMerge.current.at < MERGE_MS;
    if (!joins) past.current = [...past.current, current.current].slice(-HISTORY);
    future.current = [];
    lastMerge.current = merge ? { key: merge, at: now } : null;
    current.current = next;
    setArrangement(next);
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.at(-1);
    if (!prev) return;
    past.current = past.current.slice(0, -1);
    future.current = [current.current, ...future.current];
    lastMerge.current = null;
    current.current = prev;
    setArrangement(prev);
    bump((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current[0];
    if (!next) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, current.current].slice(-HISTORY);
    lastMerge.current = null;
    current.current = next;
    setArrangement(next);
    bump((n) => n + 1);
  }, []);

  return { arrangement, commit, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
