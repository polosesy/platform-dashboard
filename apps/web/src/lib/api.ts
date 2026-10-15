import { T, type Locale } from "./i18nMessages";
export function apiBaseUrl() {
  // In the browser, use same-origin relative path (Next.js rewrites /api/* → API server).
  // On the server (SSR), call the API directly.
  if (typeof window !== "undefined") return "";
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
}

/**
 * Human-readable API target for display. Deterministic on server and client
 * (unlike apiBaseUrl(), which is "" in the browser) so it cannot cause a hydration mismatch.
 */
export function apiTargetLabel(): string {
  return `/api → ${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}`;
}

/**
 * Build an API URL with query params (empty / undefined values are skipped).
 * Use this instead of `new URL(...)`: in the browser the base is "" and
 * `new URL("/api/...")` throws "Invalid URL".
 */
export function apiUrl(path: string, params?: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const query = qs.toString();
  return `${apiBaseUrl()}${path}${query ? `?${query}` : ""}`;
}

/**
 * A refused API call with the API's error code (signin_required, invalid_token, token_expired,
 * consent_required, interaction_required, access_blocked, tenant_not_allowed, no_platform_role, role_required,
 * connection_forbidden, connection_* (the platform's Azure connection), aad_cluster_unsupported …).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly claims?: string,
  ) {
    super(message);
  }
}

/** What the page should ask the user to do for an API error (null = nothing about sign-in) */
export type AuthState = "signin" | "reauth" | "consent" | "blocked" | "denied" | "norole" | "connection" | "aksCredential";

export function authStateOf(e: unknown): AuthState | null {
  if (!(e instanceof ApiError)) return null;
  return authStateOfCode(e.code);
}

/** The same mapping for a code carried in a response note (sample data / partial data) */
export function authStateOfCode(code: string | null | undefined): AuthState | null {
  switch (code) {
    case "signin_required": return "signin";
    case "token_expired": case "invalid_token": case "interaction_required": return "reauth";
    case "consent_required": return "consent";
    case "access_blocked": return "blocked";
    case "tenant_not_allowed": case "insufficient_scope": case "role_required": case "connection_forbidden": return "denied";
    case "no_platform_role": return "norole";
    case "connection_not_consented": case "connection_credential_invalid": case "connection_unconfigured":
    case "connection_tenant_mismatch": case "connection_failed": case "connection_timeout": return "connection";
    // The Azure connection may read the cluster but not fetch its credentials (listClusterUserCredential/action)
    case "aks_credential_forbidden": return "aksCredential";
    default: return null;
  }
}

function authText(state: NonNullable<ReturnType<typeof authStateOf>>): string {
  let locale: Locale = "ko";
  try { locale = localStorage.getItem("aud-locale") === "en" ? "en" : "ko"; } catch { /* default */ }
  return T[`auth.state.${state}`]?.[locale] ?? state;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: { error?: string; claims?: string } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* not JSON */ }
    const raw = `HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`;
    const probe = new ApiError(res.status, body.error, raw, body.claims);
    // Sign-in problems read as a sentence wherever a page prints the error (in the app's language)
    const auth = authStateOf(probe);
    throw auth ? new ApiError(res.status, body.error, authText(auth), body.claims) : probe;
  }
  return (await res.json()) as T;
}

export async function fetchJsonWithBearer<T>(
  url: string,
  bearerToken: string | null | undefined,
  init?: RequestInit
): Promise<T> {
  return fetchJson<T>(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {})
    }
  });
}
