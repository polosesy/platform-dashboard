// 사례·런북 › 외부 학습 › 기술 블로그 감시 (docs/architecture/ops-knowledge.md §11): official engineering blogs and status
// histories the team registers (RSS / Atom). The API reads them in the background; a new post is kept with the time it
// was first seen and the incident words it carries (outage · postmortem · root cause · 장애 …) — a fact, not a score.
// An operator decides: record it as a case (a public reference case — the post's own link) or skip it.
//
// The URL is the operator's, so the fetch is guarded: https only, the host must resolve to public addresses only
// (no private · loopback · link-local · CGNAT · metadata), redirects followed by hand (≤ 3, each checked again),
// 2 MB, 15 s, XML only. In Kubernetes the network policy decides the hosts too (networkPolicy.extraFqdns).

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { OpsFeed, OpsFeedItem, OpsFeedsResponse } from "@aud/types";
import type { Env } from "../env.js";
import { debug } from "../infra/logger.js";
import { safeMessage } from "../infra/requestParams.js";
import { redactLogText } from "./logRedaction.js";

export const MAX_FEEDS = 30;
const MAX_ITEMS_PER_FEED = 40;
const MAX_BYTES = 2_000_000;

/** Incident words (title / summary) — English on word boundaries, Korean as written */
export const INCIDENT_WORDS = ["outage", "incident", "postmortem", "post-mortem", "post-incident", "post incident review", "root cause", "rca", "disruption", "degradation", "degraded", "downtime", "retrospective", "lessons learned", "service event", "장애", "사후 분석", "원인 분석", "서비스 중단"];

/** Official feeds checked to answer RSS / Atom (2026-11-17) — offered as one click, never added by themselves */
export const FEED_PRESETS: OpsFeedsResponse["presets"] = [
  { name: "Google Cloud 상태 기록", url: "https://status.cloud.google.com/en/feed.atom", note: "GCP 장애 보고(Atom) — 해결된 사건과 보고서 링크" },
  { name: "Cloudflare 블로그", url: "https://blog.cloudflare.com/rss/", note: "사후 분석이 블로그 글로 나옴" },
  { name: "Kubernetes 블로그", url: "https://kubernetes.io/feed.xml", note: "제거·변경 예고(예: kube-proxy IPVS 제거)" },
  { name: "AWS Architecture 블로그", url: "https://aws.amazon.com/blogs/architecture/feed/", note: "설계·복원력 글 (AWS 사건 요약은 RSS 없음)" },
  { name: "Azure 블로그", url: "https://azure.microsoft.com/en-us/blog/feed/", note: "외부(후원) 링크가 섞일 수 있음 — Azure PIR은 상태 기록 trackingId 링크" },
  { name: "Google Cloud 블로그", url: "https://cloudblog.withgoogle.com/rss/", note: "cloud.google.com/blog/rss는 HTML로 답함 — 이 주소가 RSS" },
  { name: "OpenAI 뉴스", url: "https://openai.com/news/rss.xml", note: "장애 보고는 status.openai.com(RSS 아님)" },
];
// Checked 2026-11-17 and left out: Anthropic (no official RSS / Atom — /engineering has no feed link), Uber engineering
// (every RSS address answers 404 / 406), Azure status feed (active incidents only — normally empty)

// ── Pure ──

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const plain = (html: string) => decode(decode(html)).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (x: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(x)?.[1];
const iso = (s: string | undefined) => { const t = s ? Date.parse(decode(s).trim()) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** RSS 2.0 items or Atom entries → title · link · date · summary (plain text) */
export function parseFeed(xml: string): Array<{ title: string; url: string; publishedAt: string | null; summary: string }> {
  const out: Array<{ title: string; url: string; publishedAt: string | null; summary: string }> = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const it = m[1]!;
    const link = plain(tag(it, "link") ?? "") || /<guid[^>]*isPermaLink="true"[^>]*>([^<]+)</i.exec(it)?.[1] || "";
    out.push({ title: plain(tag(it, "title") ?? ""), url: link.trim(), publishedAt: iso(tag(it, "pubDate") ?? tag(it, "dc:date")), summary: plain(tag(it, "description") ?? tag(it, "content:encoded") ?? "") });
  }
  if (!out.length) {
    for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
      const it = m[1]!;
      const links = [...it.matchAll(/<link\s([^>]*)\/?>/gi)].map((l) => l[1]!);
      const alt = links.find((l) => /rel="alternate"/i.test(l)) ?? links.find((l) => !/rel=/i.test(l)) ?? links[0] ?? "";
      out.push({ title: plain(tag(it, "title") ?? ""), url: decode(/href="([^"]+)"/i.exec(alt)?.[1] ?? ""), publishedAt: iso(tag(it, "published") ?? tag(it, "updated")), summary: plain(tag(it, "summary") ?? tag(it, "content") ?? "") });
    }
  }
  return out.filter((x) => x.title && /^https:\/\//.test(x.url));
}

export function incidentWords(text: string): string[] {
  const t = text.toLowerCase();
  return INCIDENT_WORDS.filter((w) => (/^[a-z -]+$/.test(w) ? new RegExp(`(^|[^a-z])${w.replace(/[-]/g, "[- ]?")}([^a-z]|$)`).test(t) : t.includes(w)));
}

/** Private, loopback, link-local, CGNAT, unique-local, metadata, multicast — never fetched */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return !(x === "::1" || x === "::" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff"));
  }
  return false;
}

/** A feed URL an operator may register: https, a host name (not an address), no credentials, ≤ 500 chars */
export function feedUrlProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "not a URL"; }
  if (u.protocol !== "https:") return "https only";
  if (u.username || u.password) return "no credentials in the URL";
  if (isIP(u.hostname.replace(/^\[|\]$/g, ""))) return "a host name, not an address";
  if (!u.hostname.includes(".") || /\.(local|internal|localhost|cluster\.local)$/i.test(u.hostname)) return "a public host name";
  if (url.length > 500) return "too long";
  return null;
}

// ── Guarded fetch ──

export type FeedFetch = (url: string) => Promise<string>;
export const guardedFetch: FeedFetch = async (start) => {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const problem = feedUrlProblem(url);
    if (problem) throw new Error(problem);
    const host = new URL(url).hostname;
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new Error("the host resolves to a non-public address");
    const res = await fetch(url, { redirect: "manual", headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9", "User-Agent": "aud-dashboard feed reader" }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} without a location`);
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_BYTES) { await reader.cancel(); throw new Error("feed too large"); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 4000))) throw new Error("not an RSS / Atom feed");
    return text;
  }
  throw new Error("too many redirects");
};

// ── State ──

type State = {
  v: 1; rev: number; feeds: OpsFeed[];
  items: Record<string, OpsFeedItem>;
  status: Record<string, { state: "ok" | "failed"; checkedAt: string; detail?: string }>;
  lastCheckAt: string | null;
};
const empty = (): State => ({ v: 1, rev: 0, feeds: [], items: {}, status: {}, lastCheckAt: null });
let memory: State | null = null;
export const feedsDir = (env: Pick<Env, "AUD_ARRANGEMENT_DIR">) => (env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "knowledge") : undefined);
async function load(dir: string | undefined): Promise<State> {
  if (memory) return memory;
  if (dir) { try { const r = JSON.parse(await fs.readFile(path.join(dir, "feeds.json"), "utf8")) as State; if (r?.v === 1) return (memory = { ...empty(), ...r }); } catch { /* first run */ } }
  return (memory = empty());
}
async function save(dir: string | undefined, s: State) {
  memory = s;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, "feeds.json"), tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o640 });
  await fs.rename(tmp, f);
}
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };
export function clearFeedsMemory() { memory = null; }

const idOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Read every feed (or one) and keep new posts — at most 40 per feed, newest first */
export async function checkFeeds(env: Env, fetcher: FeedFetch = guardedFetch, only?: string, now = new Date()): Promise<{ added: number }> {
  return serial(async () => {
    const dir = feedsDir(env);
    const s = structuredClone(await load(dir));
    const at = now.toISOString();
    let added = 0;
    for (const f of s.feeds.filter((x) => !only || x.id === only)) {
      try {
        const posts = parseFeed(await fetcher(f.url)).slice(0, MAX_ITEMS_PER_FEED);
        for (const p of posts) {
          const id = idOf(`${f.id}|${p.url}`);
          if (s.items[id]) continue;
          const summary = redactLogText(p.summary.slice(0, 400)).text;
          s.items[id] = { id, feedId: f.id, title: p.title.slice(0, 300), url: p.url.slice(0, 500), publishedAt: p.publishedAt, firstSeenAt: at, summary, matched: incidentWords(`${p.title} ${p.summary}`) };
          added++;
        }
        // keep the newest per feed
        const mine = Object.values(s.items).filter((i) => i.feedId === f.id).sort((a, b) => ((b.publishedAt ?? b.firstSeenAt) < (a.publishedAt ?? a.firstSeenAt) ? -1 : 1));
        for (const old of mine.slice(MAX_ITEMS_PER_FEED * 2)) if (!old.decision) delete s.items[old.id];
        s.status[f.id] = { state: "ok", checkedAt: at, detail: `${posts.length}` };
      } catch (e) {
        s.status[f.id] = { state: "failed", checkedAt: at, detail: safeMessage(e).slice(0, 200) };
      }
    }
    s.lastCheckAt = at;
    await save(dir, s);
    return { added };
  });
}

export async function setFeeds(env: Env, list: Array<{ name: string; url: string }>, baseRev: number, by: string): Promise<{ ok: true; rev: number; added: string[] } | { ok: false; error: "conflict" | "invalid"; detail?: string }> {
  if (list.length > MAX_FEEDS) return { ok: false, error: "invalid", detail: `at most ${MAX_FEEDS}` };
  for (const f of list) {
    const p = feedUrlProblem(f.url.trim());
    if (p || !f.name.trim() || f.name.length > 60) return { ok: false, error: "invalid", detail: p ?? "a name (≤ 60)" };
  }
  return serial(async () => {
    const dir = feedsDir(env);
    const s = structuredClone(await load(dir));
    if (s.rev !== baseRev) return { ok: false as const, error: "conflict" as const };
    const at = new Date().toISOString();
    const old = new Map(s.feeds.map((f) => [f.url, f]));
    s.feeds = [...new Map(list.map((f) => { const url = f.url.trim(); const prev = old.get(url); return [url, { id: prev?.id ?? idOf(url), name: f.name.trim(), url, addedBy: prev?.addedBy ?? by, addedAt: prev?.addedAt ?? at }]; })).values()];
    const ids = new Set(s.feeds.map((f) => f.id));
    for (const [k, i] of Object.entries(s.items)) if (!ids.has(i.feedId)) delete s.items[k];
    for (const k of Object.keys(s.status)) if (!ids.has(k)) delete s.status[k];
    s.rev++;
    await save(dir, s);
    return { ok: true as const, rev: s.rev, added: s.feeds.filter((f) => !old.has(f.url)).map((f) => f.id) };
  });
}

export async function decideItem(env: Env, itemId: string, decision: "case" | "ignored" | null, by: string, caseId?: string): Promise<boolean> {
  return serial(async () => {
    const dir = feedsDir(env);
    const s = structuredClone(await load(dir));
    const it = s.items[itemId];
    if (!it) return false;
    if (decision) Object.assign(it, { decision, decidedBy: by, ...(caseId ? { caseId } : {}) });
    else { delete it.decision; delete it.caseId; delete it.decidedBy; }
    await save(dir, s);
    return true;
  });
}

export function feedsConfig(env: Env) {
  const intervalSec = env.AUD_OPS_FEEDS_INTERVAL_SEC;
  return { enabled: intervalSec > 0, intervalSec };
}

export async function feedsResponse(env: Env, canWrite: boolean): Promise<OpsFeedsResponse> {
  const s = await load(feedsDir(env));
  return {
    ...feedsConfig(env), lastCheckAt: s.lastCheckAt, durable: !!feedsDir(env), canWrite, rev: s.rev,
    feeds: s.feeds.map((f) => ({ ...f, state: s.status[f.id]?.state ?? "unchecked", checkedAt: s.status[f.id]?.checkedAt ?? null, ...(s.status[f.id]?.detail ? { detail: s.status[f.id]!.detail } : {}), items: Object.values(s.items).filter((i) => i.feedId === f.id).length })),
    // incident posts first, then newest
    items: Object.values(s.items).sort((a, b) => Number(!!b.matched.length) - Number(!!a.matched.length) || ((b.publishedAt ?? b.firstSeenAt) > (a.publishedAt ?? a.firstSeenAt) ? 1 : -1)).slice(0, 300),
    presets: FEED_PRESETS,
  };
}

let timer: NodeJS.Timeout | null = null;
export function startFeedWatch(env: Env): void {
  const cfg = feedsConfig(env);
  if (!cfg.enabled || timer) return;
  const tick = async () => {
    try { const r = await checkFeeds(env); if (r.added) debug(`[feeds] ${r.added} new post(s)`); } catch (e) { debug(`[feeds] ${safeMessage(e)}`); }
    timer = setTimeout(() => void tick(), cfg.intervalSec * 1000);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), 30_000);
  timer.unref();
}
