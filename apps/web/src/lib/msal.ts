import type { Configuration, PopupRequest } from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID ?? "";
const clientId = process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID ?? "";
const redirectUri = process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI ?? "http://localhost:3000";

/** Sign-in is possible only when the SPA app registration is configured. */
export const msalConfigured = clientId.length > 0;

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: tenantId ? `https://login.microsoftonline.com/${tenantId}` : "https://login.microsoftonline.com/common",
    redirectUri,
    postLogoutRedirectUri: redirectUri,
  },
  cache: {
    cacheLocation: "sessionStorage",
  },
};

export const loginRequest: PopupRequest = {
  scopes: [
    "openid",
    "profile",
    "email",
    ...(process.env.NEXT_PUBLIC_AZURE_AD_API_SCOPE ? [process.env.NEXT_PUBLIC_AZURE_AD_API_SCOPE] : []),
  ],
};

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
