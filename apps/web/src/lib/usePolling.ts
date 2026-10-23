import { useEffect } from "react";

/**
 * Run `load` now and every `ms`; stop once it resolves `false` — a state that polling cannot change (Hubble exec
 * off for the deployment, no role, bad cluster: `isPermanentApiError`). A new `load` (cluster, token, filter or
 * language changed) starts over.
 */
export function usePolling(load: () => Promise<boolean | void>, ms: number): void {
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if ((await load()) === false) {
        stopped = true;
        clearInterval(iv);
      }
    };
    const iv = setInterval(tick, ms);
    void tick();
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [load, ms]);
}
