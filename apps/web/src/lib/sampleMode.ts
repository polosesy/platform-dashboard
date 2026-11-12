// Sample mode: the screen on show was (partly) drawn from sample data. Decided where every response passes
// (lib/api.ts fetchJson) — not by each page remembering to say so — so no screen can show sample numbers unmarked.
// The app shell reads it: a ribbon that stays on screen and a watermark across the whole content area (it survives a
// crop or a screenshot of a single card). Cleared when the path changes; the next sample response sets it again.

type Listener = () => void;
let on = false;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

/** Pure: does a response body carry sample data (the markers the API uses — it stamps `source:"mock"` on all of them)? */
export function isSampleResponse(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.sample === true || b.source === "mock" || b.dataSource === "mock" || b._source === "mock";
}

/** Called for every API response */
export function noteResponse(body: unknown): void {
  if (!on && isSampleResponse(body)) { on = true; emit(); }
}
/** A new screen starts clean */
export function clearSampleMode(): void {
  if (on) { on = false; emit(); }
}
export const sampleModeStore = {
  subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => on,
  getServer: () => false,
};
