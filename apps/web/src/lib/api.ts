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
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
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
