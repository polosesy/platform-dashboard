"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useApiToken } from "./useApiToken";

type QueryState<T> = { key: string | null; data?: T; error?: string };

export type ApiQueryResult<T> = {
  /** Latest successful result — kept while a new key is loading (stale-while-revalidate). */
  data: T | undefined;
  /** Error for the current key, if its request failed. */
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/**
 * Fetch API data for `key` with the user's bearer token.
 * - `key` identifies the request (include every input `load` depends on); `null` skips fetching.
 * - Responses for a stale key are ignored, so fast switching never shows mismatched data.
 * - Loading is derived from the key rather than set inside the effect.
 * - `tokenOptional`: on token acquisition failure, still call the API without a token
 *   (for endpoints that serve demo/mock data to anonymous callers).
 */
export function useApiQuery<T>(
  key: string | null,
  load: (token: string | null) => Promise<T>,
  opts?: { tokenOptional?: boolean },
): ApiQueryResult<T> {
  const getApiToken = useApiToken();
  const [state, setState] = useState<QueryState<T>>({ key: null });
  const [reloadCount, setReloadCount] = useState(0);

  const effectiveKey = key === null ? null : `${key}#${reloadCount}`;
  const runLoad = useEffectEvent((token: string | null) => load(token));
  const tokenOptional = opts?.tokenOptional ?? false;

  useEffect(() => {
    if (effectiveKey === null) return;
    let cancelled = false;
    getApiToken()
      .catch((e: unknown) => {
        if (tokenOptional) return null;
        throw e;
      })
      .then((token) => runLoad(token))
      .then(
        (data) => {
          if (!cancelled) setState({ key: effectiveKey, data });
        },
        (e: unknown) => {
          if (!cancelled) setState((prev) => ({ key: effectiveKey, data: prev.data, error: e instanceof Error ? e.message : String(e) }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [effectiveKey, getApiToken, tokenOptional]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const isCurrent = state.key === effectiveKey;

  return {
    data: state.data,
    error: isCurrent ? (state.error ?? null) : null,
    loading: effectiveKey !== null && !isCurrent,
    reload,
  };
}
