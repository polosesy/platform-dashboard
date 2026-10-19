// Sign-in settings read when the page is served, not when the image is built — one image runs on an on-prem Docker
// host and in an AKS pod, each with its own app registration / host name. Pure; tested from
// apps/api/test/webRuntimeConfig.test.ts. The root layout reads it on the server and hands it to the client
// providers (lib/webConfig.tsx); NEXT_PUBLIC_AZURE_AD_* (inlined at build) stay as the local-development fallback.

export type WebRuntimeConfig = {
  tenantId: string;
  clientId: string;
  /** Absent → the page's own origin (the host the user opened) */
  redirectUri?: string;
  /** The API scope to request (api://<aud-api>/Azure.Read.All) — empty = sign-in without API tokens */
  apiScope: string;
};

type Source = Record<string, string | undefined>;

const pick = (env: Source, runtime: string, build: string): string => (env[runtime] ?? "").trim() || (env[build] ?? "").trim();

/** Runtime AUD_WEB_* first, the build-time NEXT_PUBLIC_AZURE_AD_* second; only https (or http://localhost) redirects */
export function webRuntimeConfig(env: Source): WebRuntimeConfig {
  const redirect = pick(env, "AUD_WEB_REDIRECT_URI", "NEXT_PUBLIC_AZURE_AD_REDIRECT_URI");
  return {
    tenantId: pick(env, "AUD_WEB_TENANT_ID", "NEXT_PUBLIC_AZURE_AD_TENANT_ID"),
    clientId: pick(env, "AUD_WEB_CLIENT_ID", "NEXT_PUBLIC_AZURE_AD_CLIENT_ID"),
    ...(redirect && validRedirect(redirect) ? { redirectUri: redirect } : {}),
    apiScope: pick(env, "AUD_WEB_API_SCOPE", "NEXT_PUBLIC_AZURE_AD_API_SCOPE"),
  };
}

/** Entra accepts SPA redirect URIs over https, or http only for localhost */
export function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** Sign-in is possible only when the SPA app registration is configured */
export const signInConfigured = (cfg: WebRuntimeConfig) => cfg.clientId.length > 0;
