"use client";

import { useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { parseParam, withParam } from "./queryParam";

/**
 * One allow-listed query parameter as state (e.g. ?tab=rbac).
 * Reads through useSearchParams, so a menu click to the same route without the
 * parameter resets it. Writes with history.replaceState, which Next's router
 * observes — no navigation or refetch. Callers must sit under a <Suspense>.
 */
export function useQueryParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const search = params.toString();
  const value = parseParam(search, name, allowed, fallback);
  const set = useCallback(
    (v: T) => {
      const next = `${pathname}${withParam(window.location.search, name, v, fallback)}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    },
    [name, fallback, pathname],
  );
  return [value, set];
}
