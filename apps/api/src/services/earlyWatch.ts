// 보안 › 긴급 취약점 › 선제 감시 (early watch — 2026-11-17). "Learn about an urgent vulnerability before the internal
// notice does": the internal notice of CVE-2026-114938 (Java, 2026-11-17) carried the exact affected versions of Oracle's
// Critical Security Patch Update pre-release announcement published 2026-11-12 18:40 UTC — five days earlier — while
// the CVE ID itself was only RESERVED on CVE.org and Oracle's RSS had not been updated since 2026-10-30. So the
// earliest official signals are pages whose address and day are known in advance:
//
//   Oracle   CPU (quarterly: Jan · Apr · Jul · Oct) and CSPU (Feb · Mar · May · Jun · Aug · Sep · Nov · Dec) — released on
//            the third Tuesday at 13:00 America/Los_Angeles (06:00 KST the next day), pre-release announcement on the
//            Thursday before at security-alerts/{cpu|cspu}<mon><yyyy>.html (404 until then). The Java SE part says
//            how many patches, whether they are remote without authentication, the highest CVSS and the newest
//            affected version per line — enough to find our exposure before the details.
//   Oracle   Security Alerts (out-of-band, alert-cve-…html) — new links on security-alerts/
//   OpenJDK  Vulnerability Group advisories (CVE · CVSS · affected lines) — the same day for OpenJDK builds (Temurin …)
//   KISA     보호나라 보안공지 RSS — the Korean notice the internal mail waits for
//   CVE.org  the team's watched IDs: RESERVED → PUBLISHED (the record: CNA title, score)
//
// Polled in the background (AUD_ADVISORY_WATCH_INTERVAL_SEC, default 15 min; every 2 min around a pre-release day and
// a release time). A new thing = an event with the time this dashboard first saw it, sent to the alert center
// (category security) and on to its outbound channels. Pure parsers are exported for tests (real page samples).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EarlyWatchEvent, EarlyWatchResponse, EarlyWatchSourceId, JavaSummary, OpenJdkAdvisory, OracleCycle, WatchedCve } from "@aud/types";
import type { Env } from "../env.js";
import { debug } from "../infra/logger.js";
import { safeMessage } from "../infra/requestParams.js";
import type { ParsedAlert } from "./alertPayloads.js";
import { extractCves, fetchOfficial, isCveId } from "./advisoryFeeds.js";
import { parseCveRecord } from "./vulnDb.js";

export const ORACLE_BASE = "https://www.oracle.com/security-alerts/";
export const OPENJDK_INDEX = "https://openjdk.org/groups/vulnerability/advisories/";
export const KISA_RSS = "https://www.boho.or.kr/kr/rss.do?bbsId=B0000133";
export const CVE_ID_API = "https://cveawg.mitre.org/api/cve-id/";
export const CVE_RECORD_API = "https://cveawg.mitre.org/api/cve/";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CPU_MONTHS = new Set([0, 3, 6, 9]);
export const MAX_WATCH = 50;
const MAX_EVENTS = 100;
/** Words in a KISA notice title that make it ours (case-insensitive) */
export const KISA_WORDS = ["java", "자바", "oracle", "오라클", "openjdk", "jdk"];

// ── Schedule (pure) ──

/** Minutes east of UTC for America/Los_Angeles at that instant (−480 PST, −420 PDT) */
export function laOffsetMinutes(at: Date): number {
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(tz);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -480;
}

/** Day of the month of the third Tuesday */
export function thirdTuesday(year: number, month0: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay(); // 0 = Sunday
  return 1 + ((2 - first + 7) % 7) + 14;
}

/** One Oracle cycle: kind, the release instant (13:00 Los Angeles), the pre-release Thursday, the page address */
export function oracleCycle(year: number, month0: number): Pick<OracleCycle, "kind" | "month" | "releaseAt" | "preReleaseDate" | "url"> {
  const day = thirdTuesday(year, month0);
  const noonish = Date.UTC(year, month0, day, 20, 0);
  const release = Date.UTC(year, month0, day, 13, 0) - laOffsetMinutes(new Date(noonish)) * 60_000;
  const kind = CPU_MONTHS.has(month0) ? "cpu" : "cspu";
  const pre = new Date(Date.UTC(year, month0, day - 5));
  return {
    kind, month: `${year}-${String(month0 + 1).padStart(2, "0")}`, releaseAt: new Date(release).toISOString(),
    preReleaseDate: pre.toISOString().slice(0, 10), url: `${ORACLE_BASE}${kind}${MONTHS[month0]}${year}.html`,
  };
}

/** The cycle that matters now (its release less than a week ago, or still ahead) and the one after it */
export function oracleCycles(now: Date): [ReturnType<typeof oracleCycle>, ReturnType<typeof oracleCycle>] {
  const list = [-1, 0, 1, 2].map((d) => { const m = now.getUTCMonth() + d; return oracleCycle(now.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12); });
  const i = list.findIndex((c) => Date.parse(c.releaseAt) + 7 * 86_400_000 > now.getTime());
  return [list[i]!, list[i + 1]!];
}

/** Poll faster on a pre-release Thursday (Los Angeles day) and from 15 min before a release to 3 h after */
export function inFastWindow(now: Date, cycles: Array<Pick<OracleCycle, "releaseAt" | "preReleaseDate">>): boolean {
  const t = now.getTime();
  return cycles.some((c) => {
    const rel = Date.parse(c.releaseAt);
    if (t >= rel - 15 * 60_000 && t <= rel + 3 * 3_600_000) return true;
    const preStart = Date.parse(`${c.preReleaseDate}T00:00:00Z`) - laOffsetMinutes(new Date(`${c.preReleaseDate}T20:00:00Z`)) * 60_000;
    return t >= preStart && t <= preStart + 24 * 3_600_000;
  });
}

// ── Oracle pages (pure) ──

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|tr|h\d|td|th)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&#8226;/g, "•").replace(/[ \t]+/g, " ");

/** The Java SE section of a pre-release announcement or an advisory (both: `id="AppendixJAVA"` … next appendix) */
export function parseOracleJava(html: string): JavaSummary | null {
  const start = html.search(/id="AppendixJAVA"/i);
  if (start < 0) return null;
  const rest = html.slice(start + 10);
  const end = rest.search(/<h4[^>]*id="Appendix/i);
  const sec = end >= 0 ? rest.slice(0, end) : rest;
  const t = text(sec);
  const patches = /contains (\d+) new security patch(?:es)? for Oracle Java SE/i.exec(t);
  let remote: JavaSummary["remoteUnauth"] = null;
  if (/All of these vulnerabilities may be remotely exploitable without authentication|This vulnerability is remotely exploitable without authentication/i.test(t)) remote = "all";
  else { const r = /(\d+) of these vulnerabilities may be remotely exploitable without authentication/i.exec(t); if (r) remote = Number(r[1]); else if (/not remotely exploitable without authentication/i.test(t)) remote = 0; }
  let maxScore: number | null = null, scoreVersion: string | null = null;
  const hi = /highest CVSS v(\d+\.\d+) Base Score of vulnerabilities affecting Oracle Java SE is (\d+(?:\.\d+)?)/i.exec(t);
  if (hi) { scoreVersion = hi[1]!; maxScore = Number(hi[2]); }
  // Final advisory: the risk matrix rows — CVE · product · component · protocol · remote · base score …
  const cves = [...new Set(extractCves(t))];
  if (maxScore === null && cves.length) {
    const ver = /CVSS VERSION ([\d.]+) RISK/i.exec(t);
    for (const row of sec.split(/<tr[\s>]/i).slice(1)) {
      // the CVE sits in a <th> (sticky column), the rest in <td>: CVE · product · component · protocol · remote · base score
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => text(m[1]!).trim());
      if (!cells[0] || !/^CVE-\d{4}-\d+/.test(cells[0])) continue;
      const score = /^(Yes|No)$/i.test(cells[4] ?? "") ? Number(cells[5]) : NaN;
      if (!Number.isFinite(score) || score <= 0 || score > 10) continue;
      if (maxScore === null || score > maxScore) maxScore = score;
    }
    if (maxScore !== null) scoreVersion = ver?.[1] ?? null;
  }
  // Versions: "Oracle Java SE, versions 8u511, 11.0.33, …" (pre-release) or "Oracle Java SE: 8u511, 11.0.33 …" (matrix)
  const versions = new Set<string>();
  for (const m of t.matchAll(/Oracle Java SE(?:,\s*versions?|:)\s*([^\n;]+)/gi)) {
    for (const v of m[1]!.split(/,\s*/)) { const x = v.trim(); if (/^(?:8u\d+(?:-perf)?|\d{2}\.\d+\.\d+)$/.test(x)) versions.add(x); }
  }
  return {
    patches: patches ? Number(patches[1]) : null, remoteUnauth: remote, maxScore, scoreVersion,
    versions: [...versions].filter((v) => !v.endsWith("-perf")), cves,
  };
}

/** Page facts: a pre-release announcement or the advisory, Oracle's own update time, the Java SE part */
export function parseOraclePage(html: string): { preRelease: boolean; updatedAt: string | null; java: JavaSummary | null } {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const h = /<h2[^>]*>([^<]*)/i.exec(html)?.[1] ?? "";
  const updated = /pageData\.pageInfo\.updatedDate\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
  return { preRelease: /Pre-Release Announcement/i.test(`${title} ${h}`), updatedAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toISOString() : null, java: parseOracleJava(html) };
}

/** Security Alert pages linked from security-alerts/ (lower-case ids, newest first as listed) */
export function parseOracleAlerts(html: string): string[] {
  return [...new Set([...html.matchAll(/href="(?:https:\/\/www\.oracle\.com)?\/security-alerts\/alert-(cve-\d{4}-\d+)\.html"/gi)].map((m) => m[1]!.toLowerCase()))];
}

// ── OpenJDK (pure) ──

/** Advisory dates on the index ("2026/10/24") → "2026-10-24", newest first */
export function parseOpenJdkIndex(html: string): string[] {
  // links are relative on the index (href="2026-10-24")
  return [...new Set([...html.matchAll(/(?:advisories\/|href=")(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]!))].sort().reverse();
}

export function parseOpenJdkAdvisory(html: string, date: string): OpenJdkAdvisory {
  const flat = html.replace(/\s+/g, " ");
  const aff = /The affected versions are (.*?),? and earlier/i.exec(text(flat).replace(/\s+/g, " "));
  const affected = aff ? aff[1]!.split(/,\s*/).map((s) => s.trim()).filter((s) => /^(?:8u\d+|\d+(?:\.\d+)+)$/.test(s)) : [];
  const cves: OpenJdkAdvisory["cves"] = [];
  const table = /<table[^>]*risk-matrix[\s\S]*?<\/table>/i.exec(flat)?.[0] ?? "";
  const lines = [...(/<th[^>]*>CVE ID<\/th>([\s\S]*?)<\/tr>/i.exec(table)?.[1] ?? "").matchAll(/<th[^>]*>(\d+)<\/th>/g)].map((m) => Number(m[1]));
  for (const row of table.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!);
    const id = /CVE-\d{4}-\d+/.exec(cells[0] ?? "")?.[0];
    if (!id) continue;
    const score = Number(/^\s*([\d.]+)/.exec(text(cells[2] ?? ""))?.[1]);
    const marks = cells.slice(3);
    cves.push({ id, score: Number.isFinite(score) && score > 0 ? score : null, lines: lines.filter((_, i) => /&#8226;|•/.test(marks[i] ?? "")) });
  }
  return { date, url: `${OPENJDK_INDEX}${date}`, affected, cves };
}

// ── KISA (pure) ──

export function parseKisaRss(xml: string): Array<{ title: string; url: string; date: string | null }> {
  const cdata = (s: string | undefined) => (s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1]!;
    const title = cdata(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1]);
    const link = cdata(/<link>([\s\S]*?)<\/link>/.exec(it)?.[1]);
    const date = cdata(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)?.[1]);
    return { title, url: /^https:\/\/(www\.)?(boho|krcert)\.or\.kr\//.test(link) ? link : "https://www.boho.or.kr/kr/bbs/list.do?menuNo=205020&bbsId=B0000133", date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null };
  }).filter((x) => x.title);
}

/** The watched products / CVE IDs a KISA title names */
export function kisaMatches(title: string, watched: string[]): string[] {
  const t = title.toLowerCase();
  return [...KISA_WORDS.filter((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t)), ...watched.filter((c) => title.toUpperCase().includes(c))];
}

// ── Java versions (pure) ──

/** "21.0.12+7-LTS" · "jdk-21.0.12+7" · "1.8.0_412" · "8u412" · "21.0.13.0.2" → numbers [line, …] */
export function javaParts(v: string): number[] | null {
  const s = v.trim().toLowerCase().replace(/^jdk-?/, "").replace(/[+-].*$/, "");
  let m = /^1\.8\.0_(\d+)/.exec(s) ?? /^8u(\d+)/.exec(s);
  if (m) return [8, Number(m[1])];
  m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
  if (!m || Number(m[1]) < 9) return null;
  const parts = m.slice(1).filter((x) => x !== undefined).map(Number);
  return parts.length === 1 ? [parts[0]!, 0, 0] : parts;
}
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

/** Against a vendor's "newest affected per line" list: affected (≤ it) · newer (a later build) · lineNotListed (no fix on that line — end of life or not covered) · unknown (unreadable version) */
export function javaVerdict(version: string, affected: string[]): "affected" | "newer" | "lineNotListed" | "unknown" {
  const v = javaParts(version);
  if (!v) return "unknown";
  const same = affected.map(javaParts).filter((x): x is number[] => !!x && x[0] === v[0]);
  if (!same.length) return "lineNotListed";
  return same.some((x) => cmp(v, x) <= 0) ? "affected" : "newer";
}

// ── State (watch list, first-seen times, events) ──

type State = {
  v: 1; rev: number;
  watch: Array<{ id: string; note?: string; addedBy?: string; addedAt: string }>;
  cves: Record<string, Omit<WatchedCve, "id" | "note" | "addedBy" | "addedAt">>;
  /** event key → first seen */
  seen: Record<string, string>;
  events: EarlyWatchEvent[];
  oracle: Record<string, OracleCycle>;
  alerts: Record<string, string>;
  openjdk: OpenJdkAdvisory | null;
  kisa: EarlyWatchResponse["kisa"];
  kisaChecked: number;
};
const empty = (): State => ({ v: 1, rev: 0, watch: [], cves: {}, seen: {}, events: [], oracle: {}, alerts: {}, openjdk: null, kisa: [], kisaChecked: 0 });
let memory: State | null = null;
let loadedFromDisk = false;

export const watchDir = (env: Pick<Env, "AUD_ARRANGEMENT_DIR">) => (env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "advisories") : undefined);

async function load(dir: string | undefined): Promise<State> {
  if (memory) return memory;
  if (dir) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, "early-watch.json"), "utf8")) as State;
      if (raw?.v === 1) { loadedFromDisk = true; return (memory = { ...empty(), ...raw }); }
    } catch { /* first run */ }
  }
  return (memory = empty());
}
async function save(dir: string | undefined, s: State): Promise<void> {
  memory = s;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "early-watch.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o640 });
  await fs.rename(tmp, file);
}
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };
export function clearEarlyWatchMemory() { memory = null; loadedFromDisk = false; status.lastCheckAt = null; status.nextCheckAt = null; for (const k of Object.keys(status.sources)) delete status.sources[k as EarlyWatchSourceId]; }

// ── Notification ──

const sevOf = (score: number | null, base: "sev1" | "sev2" | "sev3" = "sev2"): ParsedAlert["severity"] => (score === null ? base : score >= 9 ? "sev1" : score >= 7 ? "sev2" : "sev3");

export function eventAlert(e: EarlyWatchEvent, java: JavaSummary | null): ParsedAlert {
  const parts = java ? [
    java.patches !== null ? `Java SE 패치 ${java.patches}건` : null,
    java.remoteUnauth === "all" ? "모두 인증 없이 원격 악용 가능" : typeof java.remoteUnauth === "number" ? `원격·무인증 ${java.remoteUnauth}건` : null,
    java.maxScore !== null ? `최고 CVSS v${java.scoreVersion ?? "?"} ${java.maxScore}` : null,
    java.versions.length ? `대상 ${java.versions.join(", ")} 이하` : null,
  ].filter(Boolean) : [];
  const severity = e.kind === "preRelease" || e.kind === "released" ? sevOf(java?.maxScore ?? null, "sev2")
    : e.kind === "cvePublished" || e.kind === "openjdkAdvisory" ? sevOf(e.maxScore) : e.kind === "securityAlert" ? "sev2" : "sev3";
  return {
    id: `adv:${createHash("sha256").update(e.key).digest("hex").slice(0, 24)}`, source: "advisory", status: "firing", severity,
    category: "security", categoryBasis: "default", rule: "긴급 취약점 선제 감시", title: e.title,
    summary: [parts.join(" · "), e.cves.length ? `CVE ${e.cves.slice(0, 5).join(", ")}${e.cves.length > 5 ? ` 외 ${e.cves.length - 5}` : ""}` : ""].filter(Boolean).join(" — ") || undefined,
    target: {}, labels: { category: "security", watch: e.source, kind: e.kind },
    links: [{ kind: "source", label: "공식 공지", url: e.url }, { kind: "dashboard", label: "긴급 취약점", url: "/security/advisories" }],
    startsAt: e.firstSeenAt,
  };
}

// ── One check ──

export type WatchDeps = {
  fetch: (url: string) => Promise<{ status: number; body: string }>;
  deliver: (alerts: ParsedAlert[]) => Promise<void>;
  now?: () => Date;
};

const status: { lastCheckAt: string | null; nextCheckAt: string | null; sources: Partial<Record<EarlyWatchSourceId, { state: "ok" | "failed"; checkedAt: string; detail?: string }>> } = { lastCheckAt: null, nextCheckAt: null, sources: {} };

/** fetchOfficial with the status code kept (404 = "not yet", not a failure) */
export async function officialFetch(url: string): Promise<{ status: number; body: string }> {
  try {
    return { status: 200, body: await fetchOfficial(url, { timeoutMs: 20_000, maxBytes: 4_000_000 }) };
  } catch (e: unknown) {
    const m = /HTTP (\d{3})/.exec(e instanceof Error ? e.message : "");
    if (m) return { status: Number(m[1]), body: "" };
    throw e;
  }
}

export async function checkOnce(env: Env, deps: WatchDeps): Promise<{ events: EarlyWatchEvent[] }> {
  const dir = watchDir(env);
  return serial(async () => {
    const s = structuredClone(await load(dir));
    const now = (deps.now ?? (() => new Date()))();
    const at = now.toISOString();
    // The first check with nothing remembered: record what is already out quietly (a restart must not re-announce)
    const quiet = !loadedFromDisk && !s.events.length && !Object.keys(s.seen).length;
    const found: Array<{ e: EarlyWatchEvent; java: JavaSummary | null }> = [];
    const event = (e: Omit<EarlyWatchEvent, "firstSeenAt" | "notified">, java: JavaSummary | null = null) => {
      if (s.seen[e.key]) return;
      s.seen[e.key] = at;
      const ev: EarlyWatchEvent = { ...e, firstSeenAt: at, notified: !quiet };
      s.events = [ev, ...s.events].slice(0, MAX_EVENTS);
      found.push({ e: ev, java });
    };
    const ok = (id: EarlyWatchSourceId, detail?: string) => { status.sources[id] = { state: "ok", checkedAt: at, ...(detail ? { detail } : {}) }; };
    const fail = (id: EarlyWatchSourceId, e: unknown) => { status.sources[id] = { state: "failed", checkedAt: at, detail: safeMessage(e) }; };

    // 1. Oracle: this cycle and the next (pre-release → advisory)
    try {
      for (const c of oracleCycles(now)) {
        const r = await deps.fetch(c.url);
        const prev = s.oracle[c.month];
        if (r.status === 404) { s.oracle[c.month] = { ...c, state: "notYet", updatedAt: null, firstSeenAt: null, java: null, checkedAt: at }; continue; }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const p = parseOraclePage(r.body);
        const state = p.preRelease ? "preRelease" : "released";
        const firstSeenAt = prev?.state === state ? prev.firstSeenAt : at;
        s.oracle[c.month] = { ...c, state, updatedAt: p.updatedAt, firstSeenAt, java: p.java, checkedAt: at };
        if (p.java) {
          const label = `Oracle ${c.kind === "cpu" ? "Critical Patch Update" : "Critical Security Patch Update"} ${c.month}`;
          event({ key: `oracle:${c.month}:${state}`, source: "oracle", kind: state, url: c.url, cves: p.java.cves, maxScore: p.java.maxScore,
            title: state === "preRelease" ? `[사전 공지] ${label} — Java SE ${p.java.patches ?? "?"}건, 공개 ${c.releaseAt.slice(0, 16).replace("T", " ")} UTC` : `[공개] ${label} — Java SE ${p.java.patches ?? "?"}건` }, p.java);
        }
      }
      ok("oracle");
    } catch (e) { fail("oracle", e); }

    // 2. Oracle Security Alerts (out of band)
    try {
      const r = await deps.fetch(ORACLE_BASE);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const ids = parseOracleAlerts(r.body);
      for (const id of ids) {
        if (!s.alerts[id]) s.alerts[id] = at;
        event({ key: `oracle-alert:${id}`, source: "oracleAlerts", kind: "securityAlert", url: `${ORACLE_BASE}alert-${id}.html`, cves: [id.toUpperCase()], maxScore: null, title: `[Oracle Security Alert] ${id.toUpperCase()}` });
      }
      ok("oracleAlerts", `${ids.length}`);
    } catch (e) { fail("oracleAlerts", e); }

    // 3. OpenJDK: the newest advisory
    try {
      const r = await deps.fetch(OPENJDK_INDEX);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const latest = parseOpenJdkIndex(r.body)[0];
      if (latest) {
        const a = s.openjdk?.date === latest ? s.openjdk : await (async () => {
          const p = await deps.fetch(`${OPENJDK_INDEX}${latest}`);
          if (p.status !== 200) throw new Error(`HTTP ${p.status}`);
          return parseOpenJdkAdvisory(p.body, latest);
        })();
        s.openjdk = a;
        const max = a.cves.reduce<number | null>((m, c) => (c.score !== null && (m === null || c.score > m) ? c.score : m), null);
        event({ key: `openjdk:${latest}`, source: "openjdk", kind: "openjdkAdvisory", url: a.url, cves: a.cves.map((c) => c.id), maxScore: max,
          title: `[OpenJDK] 취약점 공지 ${latest} — CVE ${a.cves.length}건${a.affected.length ? `, ${a.affected.join(", ")} 이하` : ""}` });
      }
      ok("openjdk");
    } catch (e) { fail("openjdk", e); }

    // 4. KISA 보호나라 보안공지
    const watched = s.watch.map((w) => w.id);
    try {
      const r = await deps.fetch(KISA_RSS);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const items = parseKisaRss(r.body);
      s.kisaChecked = items.length;
      s.kisa = items.map((i) => ({ ...i, matched: kisaMatches(i.title, watched) })).filter((i) => i.matched.length);
      for (const i of s.kisa) event({ key: `kisa:${createHash("sha256").update(`${i.title}|${i.url}`).digest("hex").slice(0, 16)}`, source: "kisa", kind: "kisaNotice", url: i.url, cves: extractCves(i.title), maxScore: null, title: `[KISA 보호나라] ${i.title}` });
      ok("kisa", `${items.length}`);
    } catch (e) { fail("kisa", e); }

    // 5. CVE.org: the team's watched IDs
    try {
      for (const w of s.watch) {
        const r = await deps.fetch(`${CVE_ID_API}${w.id}`);
        if (r.status === 404) { s.cves[w.id] = { ...(s.cves[w.id] ?? blankCve()), state: "unknown", checkedAt: at }; continue; }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const st = String((JSON.parse(r.body) as { state?: string }).state ?? "").toUpperCase();
        const state: WatchedCve["state"] = st === "RESERVED" || st === "PUBLISHED" || st === "REJECTED" ? st : "unknown";
        const prev = s.cves[w.id] ?? blankCve();
        const next = { ...prev, state, checkedAt: at };
        if (state === "PUBLISHED" && (!prev.title || prev.state !== "PUBLISHED")) {
          const rec = await deps.fetch(`${CVE_RECORD_API}${w.id}`);
          const info = rec.status === 200 ? parseCveRecord(JSON.parse(rec.body)) : null;
          if (info) Object.assign(next, { title: info.title, cna: info.cna, cvss: info.cvss, published: info.published });
          next.publishedSeenAt = prev.publishedSeenAt ?? at;
          event({ key: `cve:${w.id}:published`, source: "cveorg", kind: "cvePublished", url: `https://www.cve.org/CVERecord?id=${w.id}`, cves: [w.id], maxScore: next.cvss?.score ?? null,
            title: `[CVE 공개] ${w.id}${next.title ? ` — ${next.title}` : ""}${next.cvss ? ` (CVSS ${next.cvss.version} ${next.cvss.score})` : ""}` });
        }
        if (state === "REJECTED") event({ key: `cve:${w.id}:rejected`, source: "cveorg", kind: "cveRejected", url: `https://www.cve.org/CVERecord?id=${w.id}`, cves: [w.id], maxScore: null, title: `[CVE 거부] ${w.id}` });
        s.cves[w.id] = next;
      }
      ok("cveorg", `${s.watch.length}`);
    } catch (e) { fail("cveorg", e); }

    status.lastCheckAt = at;
    await save(dir, s);
    if (!quiet && found.length) {
      try { await deps.deliver(found.map((f) => eventAlert(f.e, f.java))); } catch (e) { debug(`[early-watch] deliver: ${safeMessage(e)}`); }
    }
    return { events: found.map((f) => f.e) };
  });
}
const blankCve = (): Omit<WatchedCve, "id" | "note" | "addedBy" | "addedAt"> => ({ state: "unknown", checkedAt: null, publishedSeenAt: null, title: null, cna: null, cvss: null, published: null });

// ── Watch list (team) ──

export async function setWatch(env: Env, list: Array<{ id: string; note?: string }>, baseRev: number, by: string): Promise<{ ok: true; rev: number } | { ok: false; error: "conflict" | "invalid" }> {
  const ids = list.map((x) => ({ id: x.id.trim().toUpperCase(), note: x.note?.trim().slice(0, 120) || undefined }));
  if (ids.length > MAX_WATCH || ids.some((x) => !isCveId(x.id))) return { ok: false, error: "invalid" };
  const dir = watchDir(env);
  return serial(async () => {
    const s = structuredClone(await load(dir));
    if (s.rev !== baseRev) return { ok: false as const, error: "conflict" as const };
    const at = new Date().toISOString();
    const old = new Map(s.watch.map((w) => [w.id, w]));
    s.watch = [...new Map(ids.map((x) => [x.id, { id: x.id, ...(x.note ? { note: x.note } : {}), addedBy: old.get(x.id)?.addedBy ?? by, addedAt: old.get(x.id)?.addedAt ?? at }])).values()];
    for (const k of Object.keys(s.cves)) if (!s.watch.some((w) => w.id === k)) delete s.cves[k];
    s.rev++;
    await save(dir, s);
    return { ok: true as const, rev: s.rev };
  });
}

// ── Response ──

export function watchConfig(env: Env) {
  const intervalSec = env.AUD_ADVISORY_FEEDS ? env.AUD_ADVISORY_WATCH_INTERVAL_SEC : 0;
  return { enabled: intervalSec > 0, intervalSec, fastIntervalSec: Math.min(intervalSec || 120, 120) };
}

export async function earlyWatchResponse(env: Env, canWrite: boolean): Promise<EarlyWatchResponse> {
  const s = await load(watchDir(env));
  const cfg = watchConfig(env);
  const [cur, next] = oracleCycles(new Date());
  const cyc = (c: ReturnType<typeof oracleCycle>): OracleCycle => s.oracle[c.month] ?? { ...c, state: "unchecked", updatedAt: null, firstSeenAt: null, java: null, checkedAt: null };
  const src = (id: EarlyWatchSourceId, url: string): EarlyWatchResponse["sources"][number] => {
    const x = status.sources[id];
    return { id, url, state: !cfg.enabled ? "disabled" : x?.state ?? "unchecked", checkedAt: x?.checkedAt ?? null, ...(x?.detail ? { detail: x.detail } : {}) };
  };
  return {
    ...cfg, lastCheckAt: status.lastCheckAt, nextCheckAt: cfg.enabled ? status.nextCheckAt : null, durable: !!watchDir(env), canWrite, rev: s.rev,
    sources: [src("oracle", cur.url), src("oracleAlerts", ORACLE_BASE), src("openjdk", OPENJDK_INDEX), src("kisa", KISA_RSS), src("cveorg", CVE_ID_API)],
    oracle: { current: cyc(cur), next: cyc(next), alerts: Object.entries(s.alerts).map(([id, firstSeenAt]) => ({ id: id.toUpperCase(), url: `${ORACLE_BASE}alert-${id}.html`, firstSeenAt })).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10) },
    openjdk: s.openjdk, kisa: s.kisa, kisaChecked: s.kisaChecked,
    watch: s.watch.map((w) => ({ ...w, ...(s.cves[w.id] ?? blankCve()) })),
    events: s.events.slice(0, 30),
  };
}

// ── Background poller ──

let timer: NodeJS.Timeout | null = null;
let running = false;
export function startEarlyWatch(env: Env, deliver: WatchDeps["deliver"]): void {
  const cfg = watchConfig(env);
  if (!cfg.enabled || timer) return;
  const tick = async () => {
    if (!running) {
      running = true;
      try { const r = await checkOnce(env, { fetch: officialFetch, deliver }); if (r.events.length) debug(`[early-watch] ${r.events.length} new`); }
      catch (e) { debug(`[early-watch] ${safeMessage(e)}`); }
      finally { running = false; }
    }
    const now = new Date();
    const ms = (inFastWindow(now, oracleCycles(now)) ? cfg.fastIntervalSec : cfg.intervalSec) * 1000;
    status.nextCheckAt = new Date(now.getTime() + ms).toISOString();
    timer = setTimeout(() => void tick(), ms);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), 15_000);
  timer.unref();
  status.nextCheckAt = new Date(Date.now() + 15_000).toISOString();
}
/** Run a check now (operator) — the background schedule continues */
export async function checkNow(env: Env, deliver: WatchDeps["deliver"]): Promise<void> {
  if (running) return;
  running = true;
  try { await checkOnce(env, { fetch: officialFetch, deliver }); } finally { running = false; }
}
