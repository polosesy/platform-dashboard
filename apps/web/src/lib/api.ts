export function apiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
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
