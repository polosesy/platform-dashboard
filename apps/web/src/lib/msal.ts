import type { Configuration, PopupRequest } from "@azure/msal-browser";
import type { WebRuntimeConfig } from "./runtimeConfig";

/** The redirect when none is configured: the origin the user opened (on-prem host, cluster host, localhost) */
const ownOrigin = () => (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");

/** MSAL settings from the page's runtime config (lib/runtimeConfig.ts) */
export function msalConfigFor(cfg: WebRuntimeConfig): Configuration {
  const redirectUri = cfg.redirectUri ?? ownOrigin();
  return {
    auth: {
      clientId: cfg.clientId,
      authority: cfg.tenantId ? `https://login.microsoftonline.com/${cfg.tenantId}` : "https://login.microsoftonline.com/common",
      redirectUri,
      postLogoutRedirectUri: redirectUri,
    },
    cache: {
      cacheLocation: "sessionStorage",
    },
  };
}

export const loginRequestFor = (cfg: WebRuntimeConfig): PopupRequest => ({
  scopes: ["openid", "profile", "email", ...(cfg.apiScope ? [cfg.apiScope] : [])],
});

/**
 * True when this window is the MSAL popup that Entra redirected back to (auth response in the URL).
 * MSAL v5 delivers popup responses only through the redirect bridge (BroadcastChannel), so such a
 * window must hand the response to the opener instead of starting the app.
 */
export function isAuthPopupResponse(loc: Pick<Location, "hash" | "search">): boolean {
  for (const raw of [loc.hash.replace(/^#/, ""), loc.search.replace(/^\?/, "")]) {
    if (!raw) continue;
    const p = new URLSearchParams(raw);
    if (p.has("state") && (p.has("code") || p.has("error"))) return true;
  }
  return false;
}

/** User-facing message for a failed sign-in (MSAL error codes → guidance in the current language). */
export function loginErrorMessage(e: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const code = (e as { errorCode?: string })?.errorCode ?? "";
  const text = e instanceof Error ? e.message : String(e);
  if (code === "user_cancelled") return t("auth.err.cancelled");
  if (code === "popup_window_error" || code === "empty_window_error") return t("auth.err.popupBlocked");
  if (code === "timed_out") return t("auth.err.timeout");
  if (code === "interaction_in_progress") return t("auth.err.inProgress");
  if (/AADSTS50011/.test(text)) return t("auth.err.redirectUri");
  if (/AADSTS65001|consent/i.test(text)) return t("auth.err.consent");
  return t("auth.err.other", { detail: code || text.slice(0, 120) });
}
