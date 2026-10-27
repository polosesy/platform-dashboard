import { useEffect } from "react";

/** The page is in a background tab / minimised window (polling there only spends Azure calls nobody reads) */
export const pageHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Call `tick` every `ms` while the page is visible: ticks are skipped in a background tab and one runs as soon as it
 * is shown again; a tick never overlaps a slow previous one. `tick` resolving `false` stops for good. Returns the stop
 * function. (Every poll used to keep running in hidden tabs — the live diagram's eight Azure collectors every 30 s,
 * Hubble's exec fan-out to every node.)
 */
export function startPolling(tick: () => Promise<boolean | void> | boolean | void, ms: number): () => void {
  let stopped = false;
  let inFlight = false;
  const run = async () => {
    if (stopped || inFlight || pageHidden()) return;
    inFlight = true;
    try {
      if ((await tick()) === false) stop();
    } finally {
      inFlight = false;
    }
  };
  const onVisible = () => { if (!pageHidden()) void run(); };
  const iv = setInterval(() => void run(), ms);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  function stop() {
    stopped = true;
    clearInterval(iv);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  }
  void run();
  return stop;
}

/**
 * Run `load` now and every `ms` (visible tab only — see startPolling); stop once it resolves `false` — a state that
 * polling cannot change (Hubble exec off for the deployment, no role, bad cluster: `isPermanentApiError`). A new
 * `load` (cluster, token, filter or language changed) starts over.
 */
export function usePolling(load: () => Promise<boolean | void>, ms: number, live = true): void {
  // live = false: load once (and again whenever `load` changes — a new filter or a "new sample" nonce), no interval
  useEffect(() => (live ? startPolling(load, ms) : (void load(), undefined)), [load, ms, live]);
}
