import { decodeJwt } from "jose";
import { createHash } from "node:crypto";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/** In-memory LRU cache with per-entry TTL. Map insertion order tracks recency. */
export class CacheManager<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries: number = 50,
    private readonly defaultTtlMs: number = 60_000,
  ) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Re-setting an existing key must not evict an unrelated entry
    this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}

/** Generate a cache key prefix from a bearer token using SHA-256. */
export function bearerKeyPrefix(bearerToken: string): string {
  return createHash("sha256").update(bearerToken).digest("hex").slice(0, 16);
}

const userKeys = new Map<string, string>();

let scopeResolver: ((bearerToken: string) => string | null) | null = null;

/**
 * Installed at boot by platformAccess: the set of Azure connections a token's role reaches (`c:home,cust-a`) — users
 * who read through the same platform credentials see the same data and may share entries. null = per user.
 */
export function setCacheScopeResolver(fn: ((bearerToken: string) => string | null) | null): void {
  scopeResolver = fn;
}

/**
 * Cache key prefix for a request: `c:{connection keys}` when the caller reads only through platform credentials
 * (shared by everyone with the same access), else `u:{tid}:{oid}` (delegated/OBO data is per user); "sp" anonymous.
 */
export function cachePrefix(bearerToken: string | undefined): string {
  if (!bearerToken) return "sp";
  return scopeResolver?.(bearerToken) ?? principalKey(bearerToken);
}

/** The signed-in person, stable across token renewals (`u:{tid}:{oid}`) — ownership of saved things (diagrams) */
export function principalKey(bearerToken: string): string {
  let key = userKeys.get(bearerToken);
  if (!key) {
    try {
      const c = decodeJwt(bearerToken);
      key = typeof c.tid === "string" && typeof c.oid === "string" ? `u:${c.tid.toLowerCase()}:${c.oid.toLowerCase()}` : bearerKeyPrefix(bearerToken);
    } catch {
      key = bearerKeyPrefix(bearerToken);
    }
    if (userKeys.size >= 500) userKeys.clear();
    userKeys.set(bearerToken, key);
  }
  return key;
}
