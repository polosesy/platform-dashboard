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

/** User-facing message for a failed sign-in (MSAL error codes → Korean guidance). */
export function loginErrorMessage(e: unknown): string {
  const code = (e as { errorCode?: string })?.errorCode ?? "";
  const text = e instanceof Error ? e.message : String(e);
  if (code === "user_cancelled") return "로그인 창이 닫혔습니다.";
  if (code === "popup_window_error" || code === "empty_window_error") return "팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.";
  if (code === "timed_out") return "로그인 응답을 받지 못했습니다(시간 초과). 다시 시도하세요.";
  if (code === "interaction_in_progress") return "다른 로그인 창이 이미 열려 있습니다.";
  if (/AADSTS50011/.test(text)) return "리디렉트 URI가 앱 등록에 없습니다(AADSTS50011). Entra 앱 등록의 SPA 리디렉트 URI를 확인하세요.";
  if (/AADSTS65001|consent/i.test(text)) return "API 권한 동의가 필요합니다. 관리자 동의 또는 앱 권한을 확인하세요.";
  return `로그인 실패: ${code || text.slice(0, 120)}`;
}
