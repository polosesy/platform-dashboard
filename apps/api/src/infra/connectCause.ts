// Why an in-cluster connection (Loki · Hubble UI) was not made — pure, from the error's code only (never its text).
// Measured from the dashboard pod on stg (2026-11-18, Node 24 fetch / undici, Cilium kube-proxy replacement):
//   name that does not resolve                       → ENOTFOUND (70–89 ms)
//   Service with no ready endpoint (Loki restarting) → ECONNREFUSED (5 ms — Cilium answers at once)
//   port the Service does not expose · a port a policy drops · an unroutable IP → UND_ERR_CONNECT_TIMEOUT (~10 s)
// The last three cannot be told apart from the dashboard, so "timeout" says both (policy or no such port/route).
// Before this every one of them read "blocked — check the network policy" (11-18: a Loki restart was taken for a policy).
import type { ConnectCause } from "@aud/types";

const DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA"]);
const REFUSED = new Set(["ECONNREFUSED"]);
const TIMEOUT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const NO_ROUTE = new Set(["EHOSTUNREACH", "ENETUNREACH"]);

/** The socket error codes on the error and its causes (fetch wraps them: TypeError "fetch failed" → cause.code) */
function codesOf(e: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    const c = cur as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof c.code === "string") out.push(c.code);
    // AggregateError (happy eyeballs: one error per address) — every address failed the same way or not
    if (Array.isArray(c.errors)) for (const x of c.errors) if (x && typeof (x as { code?: unknown }).code === "string") out.push((x as { code: string }).code);
    cur = c.cause;
  }
  return out;
}

/** Pure: the error → why no connection was made, or null when its codes say none of these (a read that broke later) */
export function connectCauseOf(e: unknown): ConnectCause | null {
  const codes = codesOf(e);
  if (codes.some((c) => DNS.has(c))) return "dns";
  if (codes.some((c) => REFUSED.has(c))) return "refused";
  if (codes.some((c) => NO_ROUTE.has(c))) return "noRoute";
  if (codes.some((c) => TIMEOUT.has(c))) return "timeout";
  return null;
}
