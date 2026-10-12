let debugEnabled = false;

/** Enable verbose diagnostics (AUD_DEBUG=true). Called once at startup. */
export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Diagnostic log — silent unless AUD_DEBUG is enabled. */
export function debug(...args: unknown[]): void {
  if (debugEnabled) console.log(...args);
}
