"use client";

import { useEffect, useEffectEvent, useRef } from "react";

/** Runs `fn` when `value` changes after the first render (not on mount) — e.g. clear a choice when the scope changes */
export function useOnChange<T>(value: T, fn: () => void): void {
  const prev = useRef(value);
  const run = useEffectEvent(fn);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    run();
  }, [value]);
}
