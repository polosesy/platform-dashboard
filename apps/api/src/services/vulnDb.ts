// Official vulnerability records for 보안 › 긴급 취약점:
//   CVE.org (CVE Services, cveawg.mitre.org) — the CVE Program's own record of each CVE: the CNA's title and score,
//     and CISA's ADP container (SSVC "Exploitation": none · poc · active; CVSS when the CNA gave none)
//   OSV.dev — ecosystem-aware version ranges, aggregating the GitHub Advisory Database (a CVE CNA), the Go
//     vulnerability database and the Debian security tracker: "does package X at version Y have advisories?"
// Parsers are pure. Lookups are cached 24 h and time-boxed per request; what doesn't fit is filled in the background
// (unref'd timers) and shows up on the next load — the response says how many are still pending.

import type { FindingSeverity } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager } from "../infra/cacheManager.js";
import { safeMessage } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";
import { fetchOfficial, isCveId } from "./advisoryFeeds.js";
import type { Coord, SbomEntry } from "./sbom.js";

// ── Versions ──

const semverParts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export function compareSemverish(a: string, b: string): number {
  const pa = semverParts(a), pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") { if (x !== y) return x - y; continue; }
    // a pre-release tag sorts before the release (1.0.0-rc1 < 1.0.0)
    if (typeof x === "string" && typeof y === "number") return -1;
    if (typeof x === "number" && typeof y === "string") return 1;
    if (x !== y) return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Debian version comparison (epoch:upstream-revision, "~" sorts before anything) — Debian Policy §5.6.12 */
export function compareDebian(a: string, b: string): number {
  const split = (v: string) => {
    const e = /^(\d+):/.exec(v);
    const rest = e ? v.slice(e[0].length) : v;
    const dash = rest.lastIndexOf("-");
    return { epoch: e ? Number(e[1]) : 0, up: dash >= 0 ? rest.slice(0, dash) : rest, rev: dash >= 0 ? rest.slice(dash + 1) : "0" };
  };
  const order = (c: string) => (c === "~" ? -1 : c === "" ? 0 : /[a-z]/i.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
  const part = (x: string, y: string): number => {
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      let nx = "", ny = "";
      while (i < x.length && !/\d/.test(x[i]!)) nx += x[i++];
      while (j < y.length && !/\d/.test(y[j]!)) ny += y[j++];
      for (let k = 0; k < Math.max(nx.length, ny.length); k++) {
        const d = order(nx[k] ?? "") - order(ny[k] ?? "");
        if (d) return d;
      }
      let dx = "", dy = "";
      while (i < x.length && /\d/.test(x[i]!)) dx += x[i++];
      while (j < y.length && /\d/.test(y[j]!)) dy += y[j++];
      const d = Number(dx || 0) - Number(dy || 0);
      if (d) return d;
    }
    return 0;
  };
  const A = split(a), B = split(b);
  return A.epoch - B.epoch || part(A.up, B.up) || part(A.rev, B.rev);
}

export const compareIn = (ecosystem: string, a: string, b: string) => (ecosystem.startsWith("Debian") ? compareDebian(a, b) : compareSemverish(a, b));

// ── CVE.org ──

export type CveOrgInfo = {
  title: string | null; cna: string | null; published: string | null; description: string | null;
  cvss: { score: number; version: string; severity: string } | null;
  exploitation: "none" | "poc" | "active" | null;
};

type Metric = Record<string, { baseScore?: number; baseSeverity?: string; version?: string } | undefined> & { other?: { type?: string; content?: { options?: Array<Record<string, string>> } } };
const bestCvss = (metrics: Metric[] | undefined) => {
  for (const key of ["cvssV4_0", "cvssV3_1", "cvssV3_0"]) {
    const m = (metrics ?? []).map((x) => x[key]).find((x) => typeof x?.baseScore === "number");
    if (m) return { score: m.baseScore!, version: m.version ?? key.replace("cvssV", "").replace("_", "."), severity: m.baseSeverity ?? "" };
  }
  return null;
};

/** A CVE 5 record (CVE Services) → title, CNA, score (CNA first, then CISA ADP), SSVC exploitation */
export function parseCveRecord(json: unknown): CveOrgInfo | null {
  const r = json as { cveMetadata?: { assignerShortName?: string; datePublished?: string; state?: string }; containers?: { cna?: { title?: string; descriptions?: Array<{ lang?: string; value?: string }>; metrics?: Metric[] }; adp?: Array<{ providerMetadata?: { shortName?: string }; metrics?: Metric[] }> } };
  if (!r?.cveMetadata || r.cveMetadata.state === "REJECTED") return null;
  const cna = r.containers?.cna;
  const adp = r.containers?.adp ?? [];
  let exploitation: CveOrgInfo["exploitation"] = null;
  for (const a of adp) for (const m of a.metrics ?? []) {
    if (m.other?.type !== "ssvc") continue;
    const e = (m.other.content?.options ?? []).find((o) => "Exploitation" in o)?.Exploitation?.toLowerCase();
    if (e === "none" || e === "poc" || e === "active") exploitation = e;
  }
  return {
    title: cna?.title ?? null, cna: r.cveMetadata.assignerShortName ?? null, published: r.cveMetadata.datePublished ?? null,
    description: cna?.descriptions?.find((d) => d.lang?.startsWith("en"))?.value ?? null,
    cvss: bestCvss(cna?.metrics) ?? adp.map((a) => bestCvss(a.metrics)).find(Boolean) ?? null,
    exploitation,
  };
}

const CVE_ORG = "https://cveawg.mitre.org/api/cve/";
const cveCache = new CacheManager<CveOrgInfo | "missing">(5000, 24 * 3_600_000);

// ── Budgeted lookups (time-boxed now, the rest in the background) ──

const queued = new Map<string, Set<string>>();
const draining = new Set<string>();

async function budgeted(lane: string, ids: string[], has: (id: string) => boolean, load: (id: string) => Promise<void>, opts: { concurrency: number; deadlineMs: number }): Promise<number> {
  const todo = ids.filter((id) => !has(id));
  const deadline = Date.now() + opts.deadlineMs;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, todo.length) }, async () => {
    while (next < todo.length && Date.now() < deadline) await load(todo[next++]!);
  }));
  const rest = todo.slice(next).filter((id) => !has(id));
  if (rest.length) {
    const q = queued.get(lane) ?? new Set();
    rest.forEach((id) => q.add(id));
    queued.set(lane, q);
    if (!draining.has(lane)) {
      draining.add(lane);
      void (async () => {
        try {
          while (q.size) {
            const id = q.values().next().value as string;
            q.delete(id);
            if (!has(id)) await load(id);
            await new Promise((r) => setTimeout(r, 150).unref());
          }
        } finally { draining.delete(lane); }
      })();
    }
  }
  return ids.filter((id) => !has(id)).length;
}

/** CVE.org records for these CVE IDs — pending = not fetched yet (next load) */
export async function cveOrgRecords(env: Env, ids: string[], deadlineMs = 8_000): Promise<{ records: Map<string, CveOrgInfo>; pending: number; failed: boolean }> {
  const list = [...new Set(ids.filter(isCveId))];
  if (!env.AUD_ADVISORY_FEEDS) return { records: new Map(), pending: 0, failed: false };
  let errors = 0, oks = 0;
  const pending = await budgeted("cveorg", list, (id) => cveCache.get(id) !== undefined, async (id) => {
    try {
      cveCache.set(id, parseCveRecord(JSON.parse(await fetchOfficial(`${CVE_ORG}${id}`, { timeoutMs: 10_000, maxBytes: 2_000_000 }))) ?? "missing");
      oks++;
    } catch (e) {
      errors++;
      // 404 = not a published record: remember it; other failures are retried next time
      if (/HTTP 404/.test(safeMessage(e))) cveCache.set(id, "missing");
      debug(`[advisories] cve.org ${id}: ${safeMessage(e)}`);
    }
  }, { concurrency: 6, deadlineMs });
  const records = new Map<string, CveOrgInfo>();
  for (const id of list) { const v = cveCache.get(id); if (v && v !== "missing") records.set(id, v); }
  return { records, pending, failed: errors > 0 && oks === 0 && records.size === 0 };
}

// ── OSV ──

export type OsvVuln = {
  id: string; aliases: string[]; summary: string | null; severity: FindingSeverity;
  cvssVector: string | null; published: string | null; withdrawn: boolean;
  affected: Array<{ ecosystem: string; name: string; fixed: string[] }>;
};

const SEV: Record<string, FindingSeverity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };

export function parseOsvVuln(json: unknown): OsvVuln | null {
  const v = json as { id?: string; aliases?: string[]; summary?: string; details?: string; published?: string; withdrawn?: string; severity?: Array<{ type?: string; score?: string }>; database_specific?: { severity?: string }; affected?: Array<{ package?: { ecosystem?: string; name?: string }; ranges?: Array<{ events?: Array<Record<string, string>> }> }> };
  if (!v?.id) return null;
  return {
    id: v.id, aliases: v.aliases ?? [], summary: v.summary ?? v.details?.split("\n")[0]?.slice(0, 200) ?? null,
    severity: SEV[(v.database_specific?.severity ?? "").toUpperCase()] ?? "unknown",
    cvssVector: v.severity?.find((s) => /^CVSS/.test(s.type ?? ""))?.score ?? null,
    published: v.published ?? null, withdrawn: !!v.withdrawn,
    affected: (v.affected ?? []).map((a) => ({
      ecosystem: a.package?.ecosystem ?? "", name: a.package?.name ?? "",
      fixed: (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((x): x is string => !!x)),
    })),
  };
}

/** The smallest fixed version above ours for this package (null = no fix published) */
export function fixedFor(v: OsvVuln, c: Coord): string | null {
  const fixes = v.affected
    .filter((a) => a.name === c.name && (a.ecosystem === c.ecosystem || a.ecosystem.split(":")[0] === c.ecosystem.split(":")[0]))
    .flatMap((a) => a.fixed)
    .filter((f) => compareIn(c.ecosystem, f, c.version) > 0)
    .sort((a, b) => compareIn(c.ecosystem, a, b));
  return fixes[0] ?? null;
}

const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";
const idsCache = new CacheManager<string[]>(20_000, 6 * 3_600_000);
const vulnCache = new CacheManager<OsvVuln | "missing">(20_000, 24 * 3_600_000);
const coordKey = (c: Coord) => `${c.ecosystem}|${c.name}|${c.version}`;

/** Which advisories apply to each entry (OSV querybatch, 500 per call), then their details (time-boxed) */
export async function osvScan(env: Env, entries: SbomEntry[], deadlineMs = 15_000): Promise<{ matches: Array<{ entry: SbomEntry; vuln: OsvVuln }>; pending: number; failed: boolean; queried: number }> {
  if (!env.AUD_ADVISORY_FEEDS || !entries.length) return { matches: [], pending: 0, failed: false, queried: 0 };
  const todo = entries.filter((e) => idsCache.get(coordKey(e)) === undefined);
  let failed = false;
  for (let i = 0; i < todo.length; i += 500) {
    const chunk = todo.slice(i, i + 500);
    try {
      const res = JSON.parse(await fetchOfficial(OSV_BATCH, { json: { queries: chunk.map((c) => ({ package: { name: c.name, ecosystem: c.ecosystem }, version: c.version })) }, timeoutMs: 30_000, maxBytes: 20_000_000 })) as { results?: Array<{ vulns?: Array<{ id: string }> }> };
      chunk.forEach((c, k) => idsCache.set(coordKey(c), (res.results?.[k]?.vulns ?? []).map((v) => v.id)));
    } catch (e) {
      failed = true;
      debug(`[advisories] osv querybatch: ${safeMessage(e)}`);
    }
  }
  const pairs = entries.flatMap((e) => (idsCache.get(coordKey(e)) ?? []).map((id) => ({ entry: e, id })));
  // Language packages and Kubernetes first (they carry severities), OS packages after
  const ids = [...new Set([...pairs.filter((p) => p.entry.kind !== "os"), ...pairs.filter((p) => p.entry.kind === "os")].map((p) => p.id))];
  const pending = await budgeted("osv", ids, (id) => vulnCache.get(id) !== undefined, async (id) => {
    try { vulnCache.set(id, parseOsvVuln(JSON.parse(await fetchOfficial(`${OSV_VULN}${encodeURIComponent(id)}`, { timeoutMs: 10_000, maxBytes: 3_000_000 }))) ?? "missing"); }
    catch (e) { debug(`[advisories] osv ${id}: ${safeMessage(e)}`); }
  }, { concurrency: 10, deadlineMs });
  const matches: Array<{ entry: SbomEntry; vuln: OsvVuln }> = [];
  for (const e of entries) {
    const vulns = (idsCache.get(coordKey(e)) ?? []).map((id) => vulnCache.get(id)).filter((v): v is OsvVuln => !!v && v !== "missing" && !v.withdrawn);
    // One finding per vulnerability: a GO-… entry that aliases a GHSA-… already listed is the same advisory
    const ids = new Set(vulns.map((v) => v.id));
    for (const v of vulns) {
      if (v.id.startsWith("GO-") && v.aliases.some((a) => ids.has(a))) continue;
      matches.push({ entry: e, vuln: v });
    }
  }
  return { matches, pending, failed: failed && !matches.length, queried: entries.length };
}
