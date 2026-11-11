"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useApiToken } from "./useApiToken";

/** `dataKey` = the request key (without the reload count) the data answers */
type QueryState<T> = { key: string | null; data?: T; dataKey?: string | null; error?: string };

export type ApiQueryResult<T> = {
  /**
   * The latest successful result FOR THIS KEY — kept while the same key reloads (refresh · polling) or its reload
   * fails; undefined while another key loads or after it fails (the previous selection's data is never shown under
   * the new one — 2026-11-11: a failed load left the old subscription's / cluster's numbers on screen).
   */
  data: T | undefined;
  /** Error for the current key, if its request failed. */
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/**
 * Fetch API data for `key` with the user's bearer token.
 * - `key` identifies the request (include every input `load` depends on); `null` skips fetching.
 * - Responses for a stale key are ignored and `data` is only ever the current key's, so switching never shows
 *   mismatched data.
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
          if (!cancelled) setState({ key: effectiveKey, data, dataKey: key });
        },
        (e: unknown) => {
          if (!cancelled) setState((prev) => ({ key: effectiveKey, data: prev.data, dataKey: prev.dataKey, error: e instanceof Error ? e.message : String(e) }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [effectiveKey, key, getApiToken, tokenOptional]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const isCurrent = state.key === effectiveKey;

  return {
    data: key !== null && state.dataKey === key ? state.data : undefined,
    error: isCurrent ? (state.error ?? null) : null,
    loading: effectiveKey !== null && !isCurrent,
    reload,
  };
}
