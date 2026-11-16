// Sign-in page flow (pure — tested in apps/api/test/loginFlow.test.ts). The app signs in by redirect (the page goes to
// Microsoft and comes back) instead of a popup: no blocked popups, no 60 s relay timeouts, and the user returns to the
// screen they were on. The design draft ① (docs/architecture/design-system.md).

/** sessionStorage keys — this tab only, gone when it closes */
export const LOGIN_KEYS = {
  /** Set right before loginRedirect: the next load carries Entra's response in the URL, and it is THIS window's, not a popup's */
  redirecting: "aud.login.redirecting",
  /** A sign-in that failed on the way back (Entra error, consent) — shown once on /login */
  error: "aud.login.error",
} as const;

export type LoginReason = "expired" | "consent" | "norole" | "error" | "redirectUri";
const REASONS: readonly LoginReason[] = ["expired", "consent", "norole", "error", "redirectUri"];

/**
 * Pure: where to go after signing in — only a path on this site (an open redirect would hand the user to another host
 * right after sign-in). "/login" itself, protocol-relative ("//x"), backslashes and anything not starting with "/" fall
 * back to the overview.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  let v = raw.trim();
  try { v = decodeURIComponent(v); } catch { return "/"; }
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\u0000-\u001f]/.test(v)) return "/";
  if (v === "/login" || v.startsWith("/login?") || v.startsWith("/login/")) return "/";
  return v;
}

/** Pure: the reason shown on /login (unknown values are ignored, never echoed) */
export function loginReason(raw: string | null | undefined): LoginReason | null {
  return raw && (REASONS as readonly string[]).includes(raw) ? (raw as LoginReason) : null;
}

/** Pure: the /login URL for a reason and the page to come back to */
export function loginUrl(next: string, reason?: LoginReason | null): string {
  const q = new URLSearchParams();
  const n = safeNext(next);
  if (n !== "/") q.set("next", n);
  if (reason) q.set("reason", reason);
  const s = q.toString();
  return s ? `/login?${s}` : "/login";
}

/**
 * What a silent token request for the API said on /login: "ok" = the session really works; "expired" = MSAL wants the
 * user again (InteractionRequired — sign-in frequency, revoked or expired refresh token); "failed" = anything else.
 */
export type SessionCheck = "checking" | "ok" | "expired" | "failed";

/** What /login shows */
export type LoginView = "notConfigured" | "checking" | "signedIn" | "expired" | "noRole" | "signIn";

/**
 * Pure: the /login state. A remembered account is NOT a session — MSAL keeps the account after its refresh token has
 * expired (Conditional Access sign-in frequency, AADSTS70043), and "you are signed in · continue" then bounced between
 * the screen (token refused → /login?reason=expired) and here forever (2026-11-16). Only a token that came back counts.
 */
export function loginView(i: { configured: boolean; hasAccount: boolean; session: SessionCheck; noRole: boolean }): LoginView {
  if (!i.configured) return "notConfigured";
  if (!i.hasAccount) return "signIn";
  if (i.session === "checking") return "checking";
  if (i.session === "expired") return "expired";
  if (i.session === "failed") return "signIn";
  return i.noRole ? "noRole" : "signedIn";
}

/** Pure: an MSAL failure → the reason the page explains (consent and a wrong redirect address have their own words) */
export function reasonOfError(e: unknown): LoginReason {
  const code = (e as { errorCode?: string })?.errorCode ?? "";
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (code === "consent_required" || /AADSTS65001|consent/i.test(text)) return "consent";
  if (/AADSTS50011/.test(text)) return "redirectUri";
  if (code === "interaction_required" || code === "login_required" || /AADSTS50058|AADSTS700082|AADSTS70043/.test(text)) return "expired";
  return "error";
}
