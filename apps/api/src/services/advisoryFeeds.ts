// Official vulnerability feeds for 보안 › 긴급 취약점 — fixed URLs only (no user-supplied URL is ever fetched):
// CISA KEV (exploited in the wild), NVD (CVSS), nodejs.org (security release RSS, advisory pages, dist index with the
// `security` flag per release), php.net (news Atom with security advisories, release index with the "security" tag).
// Parsers are pure (tested with real samples); fetching is cached 6 h per feed, single-flight, size- and time-capped.
// NVD allows 5 requests / 30 s without a key (50 with AUD_NVD_API_KEY): CVEs over the budget are filled in the
// background and show up on the next load.

import type { AdvisoryCve, AdvisorySource, AdvisorySourceId } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager } from "../infra/cacheManager.js";
import { safeMessage } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";

export const FEED_URLS = {
  kev: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  nvd: "https://services.nvd.nist.gov/rest/json/cves/2.0",
  nodeRss: "https://nodejs.org/en/feed/vulnerability.xml",
  nodeIndex: "https://nodejs.org/dist/index.json",
  phpAtom: "https://www.php.net/feed.atom",
  phpReleases: "https://www.php.net/releases/index.php?json&version=8&max=200",
} as const;
const ALLOWED_HOSTS = new Set(["www.cisa.gov", "services.nvd.nist.gov", "nodejs.org", "www.php.net", "cveawg.mitre.org", "api.osv.dev"]);

const CVE_RE = /CVE-\d{4}-\d{4,7}/g;
export const isCveId = (s: string) => /^CVE-\d{4}-\d{4,7}$/.test(s);

// ── Pure parsers ──

export type KevEntry = {
  cve: string; vendor: string; product: string; name: string; description: string;
  dateAdded: string; dueDate: string; requiredAction: string; ransomware: boolean;
};
export function parseKev(json: unknown): KevEntry[] {
  const v = (json as { vulnerabilities?: Array<Record<string, string>> })?.vulnerabilities ?? [];
  return v.filter((x) => isCveId(x.cveID ?? "")).map((x) => ({
    cve: x.cveID!, vendor: x.vendorProject ?? "", product: x.product ?? "", name: x.vulnerabilityName ?? "", description: x.shortDescription ?? "",
    dateAdded: x.dateAdded ?? "", dueDate: x.dueDate ?? "", requiredAction: x.requiredAction ?? "", ransomware: /^known$/i.test(x.knownRansomwareCampaignUse ?? ""),
  }));
}

/** Unique CVE IDs in a text, in order of appearance */
export function extractCves(text: string): string[] {
  return [...new Set(text.match(CVE_RE) ?? [])];
}

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(unCdata(m[1]!)) : "";
};

export type FeedPost = { title: string; url: string; date: string; cves: string[] };

/** nodejs.org vulnerability RSS → posts (CVE IDs come from each advisory page) */
export function parseNodeRss(xml: string): FeedPost[] {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map((m) => {
    const b = m[1]!;
    const d = new Date(tag(b, "pubDate"));
    return { title: tag(b, "title"), url: tag(b, "link"), date: Number.isNaN(d.getTime()) ? "" : d.toISOString(), cves: [] };
  }).filter((p) => p.url.startsWith("https://nodejs.org/"));
}

/** php.net news Atom → security posts (entries that name CVEs or say "Security advisory") */
export function parsePhpAtom(xml: string): FeedPost[] {
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].flatMap((m) => {
    const b = m[1]!;
    const title = tag(b, "title");
    const content = tag(b, "content");
    const cves = extractCves(`${title} ${content}`);
    if (!cves.length && !/security/i.test(title)) return [];
    // The archive link (<id>, or rel="via") is permanent; the front-page anchor moves
    const href = tag(b, "id") || /<link[^>]*rel="via"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+)"[^>]*rel="via"/.exec(b)?.slice(1).find(Boolean) || "";
    const d = new Date(tag(b, "updated") || tag(b, "published"));
    return [{ title, url: decode(href), date: Number.isNaN(d.getTime()) ? "" : d.toISOString(), cves }];
  }).filter((p) => p.url.startsWith("https://www.php.net/"));
}

export type Release = { line: string; version: string; date: string; security: boolean };

/** nodejs.org/dist/index.json → releases (line = major) */
export function parseNodeIndex(json: unknown): Release[] {
  return ((json as Array<{ version?: string; date?: string; security?: boolean }>) ?? []).flatMap((r) => {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(r.version ?? "");
    return m ? [{ line: m[1]!, version: `${m[1]}.${m[2]}.${m[3]}`, date: r.date ?? "", security: r.security === true }] : [];
  });
}

/** php.net releases JSON (version=8) → releases (line = major.minor) */
export function parsePhpReleases(json: unknown): Release[] {
  return Object.entries((json as Record<string, { date?: string; tags?: string[] }>) ?? {}).flatMap(([version, r]) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    // "21 Oct 2026" is a calendar date — read it as UTC so the server time zone never shifts it
    const d = new Date(`${r?.date ?? ""} UTC`);
    return m && !Number.isNaN(d.getTime())
      ? [{ line: `${m[1]}.${m[2]}`, version, date: d.toISOString().slice(0, 10), security: (r.tags ?? []).includes("security") }]
      : [];
  });
}

/** NVD CVE API 2.0 → CVSS (v4.0 first, then v3.1/3.0), English description, published date */
export function parseNvd(json: unknown): Omit<AdvisoryCve, "id" | "kev"> | null {
  const cve = (json as { vulnerabilities?: Array<{ cve?: Record<string, unknown> }> })?.vulnerabilities?.[0]?.cve;
  if (!cve) return null;
  const metrics = (cve.metrics ?? {}) as Record<string, Array<{ type?: string; cvssData?: { baseScore?: number; baseSeverity?: string; version?: string } ; baseSeverity?: string }>>;
  let cvss: AdvisoryCve["cvss"] = null;
  for (const key of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30"]) {
    const list = metrics[key] ?? [];
    const m = list.find((x) => x.type === "Primary") ?? list[0];
    if (m?.cvssData?.baseScore !== undefined) {
      cvss = { score: m.cvssData.baseScore, version: m.cvssData.version ?? key.slice(-2), severity: m.cvssData.baseSeverity ?? m.baseSeverity ?? "" };
      break;
    }
  }
  const desc = ((cve.descriptions ?? []) as Array<{ lang?: string; value?: string }>).find((d) => d.lang === "en")?.value ?? null;
  return { cvss, description: desc, published: typeof cve.published === "string" ? cve.published : null };
}

// ── Fetching (fixed URLs, allow-listed hosts, capped) ──

/** GET (or a JSON POST — OSV querybatch only) to a fixed, allow-listed https host */
export async function fetchOfficial(url: string, opts: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string>; json?: unknown } = {}): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`not an allowed feed host: ${u.hostname}`);
  const post = opts.json !== undefined;
  const res = await fetch(u, {
    method: post ? "POST" : "GET",
    headers: { Accept: "*/*", "User-Agent": "aud-dashboard advisory check", ...(post ? { "Content-Type": "application/json" } : {}), ...opts.headers },
    ...(post ? { body: JSON.stringify(opts.json) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000), redirect: "follow",
  });
  const final = new URL(res.url || url);
  if (final.protocol !== "https:" || !ALLOWED_HOSTS.has(final.hostname)) throw new Error(`redirected off the allow-list: ${final.hostname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > (opts.maxBytes ?? 8_000_000)) throw new Error("feed too large");
  return text;
}

const feedCache = new CacheManager<unknown>(50, 6 * 3_600_000);
const inflight = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = feedCache.get(key);
  if (hit !== undefined && hit !== null) return Promise.resolve(hit as T);
  const run = inflight.get(key);
  if (run) return run as Promise<T>;
  const job = load().then((v) => { feedCache.set(key, v); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export type FeedBundle = {
  sources: AdvisorySource[];
  kev: KevEntry[] | null;
  nodePosts: FeedPost[];
  nodeReleases: Release[];
  phpPosts: FeedPost[];
  phpReleases: Release[];
};

const NODE_POSTS = 3;

export async function loadFeeds(env: Env): Promise<FeedBundle> {
  const now = new Date().toISOString();
  if (!env.AUD_ADVISORY_FEEDS) {
    const off = (id: AdvisorySourceId): AdvisorySource => ({ id, state: "disabled", checkedAt: null });
    return { sources: [off("kev"), off("nvd"), off("nodejs"), off("php")], kev: null, nodePosts: [], nodeReleases: [], phpPosts: [], phpReleases: [] };
  }
  const settle = async <T>(id: AdvisorySourceId, url: string, fn: () => Promise<T>): Promise<{ v: T | null; s: AdvisorySource }> => {
    try {
      return { v: await fn(), s: { id, state: "ok", checkedAt: now, url } };
    } catch (e) {
      debug(`[advisories] ${id} failed: ${safeMessage(e)}`);
      return { v: null, s: { id, state: "failed", checkedAt: now, url, detail: safeMessage(e).slice(0, 120) } };
    }
  };
  const [kev, node, php] = await Promise.all([
    settle("kev", FEED_URLS.kev, () => cached("kev", async () => parseKev(JSON.parse(await fetchOfficial(FEED_URLS.kev))))),
    settle("nodejs", FEED_URLS.nodeRss, () => cached("node", async () => {
      const [rss, index] = await Promise.all([fetchOfficial(FEED_URLS.nodeRss), fetchOfficial(FEED_URLS.nodeIndex)]);
      const posts = parseNodeRss(rss).slice(0, NODE_POSTS);
      // The RSS has no body — the CVE list is on each advisory page
      for (const p of posts) p.cves = extractCves(await fetchOfficial(p.url, { maxBytes: 3_000_000 }).catch(() => ""));
      return { posts, releases: parseNodeIndex(JSON.parse(index)) };
    })),
    settle("php", FEED_URLS.phpAtom, () => cached("php", async () => {
      const [atom, rel] = await Promise.all([fetchOfficial(FEED_URLS.phpAtom), fetchOfficial(FEED_URLS.phpReleases)]);
      return { posts: parsePhpAtom(atom), releases: parsePhpReleases(JSON.parse(rel)) };
    })),
  ]);
  return {
    sources: [kev.s, node.s, php.s],
    kev: kev.v,
    nodePosts: node.v?.posts ?? [], nodeReleases: node.v?.releases ?? [],
    phpPosts: php.v?.posts ?? [], phpReleases: php.v?.releases ?? [],
  };
}

// ── NVD (rate-limited; the rest fills in the background) ──

const nvdCache = new CacheManager<Omit<AdvisoryCve, "id" | "kev"> | "missing">(2000, 24 * 3_600_000);
const nvdCalls: number[] = [];
const nvdQueue = new Set<string>();
let nvdDraining = false;

function nvdBudget(env: Env): number {
  const limit = env.AUD_NVD_API_KEY ? 50 : 5;
  const cutoff = Date.now() - 30_000;
  while (nvdCalls.length && nvdCalls[0]! < cutoff) nvdCalls.shift();
  return limit - nvdCalls.length;
}

async function nvdOne(env: Env, id: string): Promise<void> {
  nvdCalls.push(Date.now());
  try {
    const text = await fetchOfficial(`${FEED_URLS.nvd}?cveId=${encodeURIComponent(id)}`, { timeoutMs: 15_000, headers: env.AUD_NVD_API_KEY ? { apiKey: env.AUD_NVD_API_KEY } : {} });
    nvdCache.set(id, parseNvd(JSON.parse(text)) ?? "missing");
  } catch (e) {
    debug(`[advisories] nvd ${id}: ${safeMessage(e)}`);
  }
}

function drainNvd(env: Env) {
  if (nvdDraining) return;
  nvdDraining = true;
  void (async () => {
    try {
      while (nvdQueue.size) {
        // unref: a background fill must not keep the process alive at shutdown
        if (nvdBudget(env) <= 0) { await new Promise((r) => setTimeout(r, 6_500).unref()); continue; }
        const id = nvdQueue.values().next().value as string;
        nvdQueue.delete(id);
        if (nvdCache.get(id) === undefined) await nvdOne(env, id);
      }
    } finally { nvdDraining = false; }
  })();
}

/** NVD details for the CVEs — what fits the rate budget now, the rest queued (pending = not read yet) */
export async function nvdDetails(env: Env, ids: string[]): Promise<{ details: Map<string, Omit<AdvisoryCve, "id" | "kev"> | null>; pending: number; source: AdvisorySource }> {
  const now = new Date().toISOString();
  if (!env.AUD_ADVISORY_FEEDS) return { details: new Map(), pending: 0, source: { id: "nvd", state: "disabled", checkedAt: null } };
  const todo = ids.filter((id) => nvdCache.get(id) === undefined);
  const nowBatch = todo.slice(0, Math.max(0, nvdBudget(env)));
  await Promise.all(nowBatch.map((id) => nvdOne(env, id)));
  for (const id of todo) if (nvdCache.get(id) === undefined) nvdQueue.add(id);
  if (nvdQueue.size) drainNvd(env);
  const details = new Map(ids.map((id) => {
    const v = nvdCache.get(id);
    return [id, v === undefined || v === "missing" ? null : v] as const;
  }));
  const pending = ids.filter((id) => nvdCache.get(id) === undefined).length;
  const failed = nowBatch.length > 0 && nowBatch.every((id) => nvdCache.get(id) === undefined);
  return {
    details, pending,
    source: { id: "nvd", state: failed ? "failed" : "ok", checkedAt: now, url: "https://nvd.nist.gov/", ...(pending ? { detail: `pending ${pending}` } : {}) },
  };
}
