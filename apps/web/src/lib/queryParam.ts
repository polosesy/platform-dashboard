// Pure helpers for one allow-listed URL query parameter (tested in apps/api/test/queryParam.test.ts).

/** The parameter's value if it is allowed, otherwise `fallback`. */
export function parseParam<T extends string>(search: string, name: string, allowed: readonly T[], fallback: T): T {
  const raw = new URLSearchParams(search).get(name);
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** `search` with `name` set to `value` — removed when it equals `fallback`; other parameters are kept. */
export function withParam(search: string, name: string, value: string, fallback: string): string {
  const p = new URLSearchParams(search);
  if (value === fallback) p.delete(name);
  else p.set(name, value);
  const q = p.toString();
  return q ? `?${q}` : "";
}
