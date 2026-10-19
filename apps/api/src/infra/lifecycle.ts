// Process lifecycle for the API in a container (on-prem Docker, AKS pod) and on a dev PC — pure helpers, tested from
// apps/api/test/lifecycle.test.ts. The wiring (signals, listen errors) is in index.ts.

/** A socket dropped by the peer (browser tab closed, proxy timeout): never a reason to stop the server */
const BENIGN_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);
export function isBenignSocketError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && BENIGN_CODES.has(code);
}

/**
 * What an uncaught exception does: development keeps running (an editor reload must not kill the dev server), a
 * container exits on anything but a dropped socket — the orchestrator restarts it in a known state.
 */
export function onUncaught(err: unknown, nodeEnv: string | undefined): "ignore" | "exit" {
  if (isBenignSocketError(err)) return "ignore";
  return nodeEnv === "production" ? "exit" : "ignore";
}

/** The Windows dev helper that kills a zombie holding the port (netstat/taskkill) — never in a container */
export const canKillPortHolder = (platform: string, nodeEnv: string | undefined) => platform === "win32" && nodeEnv !== "production";

/** Health body: process up, no Azure call — readiness must not depend on Azure being reachable */
export const healthBody = (version: string | undefined) => ({ ok: true as const, version: version || "dev" });

/** Graceful stop: stop accepting, give open requests (and SSE) `drainMs`, then close what is left; hard exit after `hardMs` */
export const SHUTDOWN = { drainMs: 5_000, hardMs: 10_000 } as const;
