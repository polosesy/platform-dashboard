import type { Env } from "../env.js";
import { CacheManager } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { debug } from "../infra/logger.js";

// ──────────────────────────────────────────────────────────────
// Azure service tags → "which Microsoft service owns this public IP"
//
// Source: the official Service Tag Discovery API (ARM, Reader on any subscription)
//   GET /subscriptions/{sub}/providers/Microsoft.Network/locations/{location}/serviceTags
// It returns the same prefixes as the weekly "ServiceTags_Public" download. A world IP that the cluster
// reached is named only when it falls in a published prefix — never by reverse DNS or guess.
// Tag = a Microsoft service's shared front end (Entra ID, ARM, Azure Monitor …), not a resource of this tenant.
// `AzureCloud` alone = "an Azure address, service not published" (it covers every public Azure range).
// ──────────────────────────────────────────────────────────────

export type ServiceTagValue = { name: string; properties?: { systemService?: string; region?: string; addressPrefixes?: string[] } };
type Entry = { net: number; len: number; tag: string; base: string; region: string };
export type ServiceTagIndex = { entries: Entry[]; changeNumber: string | null };
export type ServiceTagMatch = { tag: string; service: string; region: string; prefix: string };

// Public data (identical for every tenant in the cloud) — cached per location, not per user
const tagCache = new CacheManager<ServiceTagIndex>(8, 24 * 3_600_000);
const inflight = new Map<string, Promise<ServiceTagIndex>>();

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}

/** Pure: RFC 1918 · 100.64/10 (CGNAT) — never the Internet */
export function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inNet = (base: string, len: number) => (n >>> (32 - len)) === (ipv4ToInt(base)! >>> (32 - len));
  return inNet("10.0.0.0", 8) || inNet("172.16.0.0", 12) || inNet("192.168.0.0", 16) || inNet("100.64.0.0", 10);
}

/** Pure: index the IPv4 prefixes of every tag, most specific first */
export function buildServiceTagIndex(values: ServiceTagValue[], changeNumber: string | null = null): ServiceTagIndex {
  const entries: Entry[] = [];
  for (const v of values) {
    const base = v.name.split(".")[0]!;
    for (const p of v.properties?.addressPrefixes ?? []) {
      const [addr, l] = p.split("/");
      const net = ipv4ToInt(addr ?? "");
      const len = Number(l);
      if (net === null || !Number.isInteger(len) || len < 0 || len > 32) continue; // IPv6 is skipped
      entries.push({ net: len === 0 ? 0 : (net >>> (32 - len)) >>> 0, len, tag: v.name, base, region: v.properties?.region ?? "" });
    }
  }
  entries.sort((a, b) => b.len - a.len || a.tag.localeCompare(b.tag));
  return { entries, changeNumber };
}

/**
 * Pure: the service that owns `ip`. A named service beats `AzureCloud` even when AzureCloud's prefix is narrower
 * (AzureCloud covers every Azure range, so it says nothing about which service); among named services the most
 * specific prefix wins, then a regional tag over the global one.
 */
export function lookupServiceTag(index: ServiceTagIndex, ip: string): ServiceTagMatch | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  let named: Entry | undefined;
  let cloud: Entry | undefined;
  for (const e of index.entries) {
    if ((e.len === 0 ? 0 : n >>> (32 - e.len)) !== e.net) continue;
    if (e.base === "AzureCloud") { cloud ??= e; continue; }
    if (!named || e.len > named.len || (e.len === named.len && !named.region && e.region)) named = e;
  }
  const hit = named ?? cloud;
  if (!hit) return null;
  const prefix = `${hit.len === 0 ? "0.0.0.0" : intToIpv4((hit.net << (32 - hit.len)) >>> 0)}/${hit.len}`;
  return { tag: hit.tag, service: hit.base, region: hit.region, prefix };
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Service tags for the cluster's region (cached 24 h — the API changes weekly). */
export async function getServiceTagIndex(env: Env, bearerToken: string | undefined, subscriptionId: string, location: string): Promise<ServiceTagIndex> {
  const key = location.toLowerCase().replace(/\s/g, "");
  const cached = tagCache.get(key);
  if (cached) return cached;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const arm = await getArmFetcherAuto(env, bearerToken);
    const res = await arm.fetchJson<{ changeNumber?: string; values?: ServiceTagValue[] }>(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network/locations/${encodeURIComponent(key)}/serviceTags?api-version=2024-05-01`,
      { timeoutMs: 20_000 },
    );
    const index = buildServiceTagIndex(res.values ?? [], res.changeNumber ?? null);
    debug(`[service-tags] ${key}: ${res.values?.length ?? 0} tags, ${index.entries.length} IPv4 prefixes (change ${index.changeNumber})`);
    tagCache.set(key, index);
    return index;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
