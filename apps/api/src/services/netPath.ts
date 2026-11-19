// 네트워크 › 네트워크 경로 — a device's path to a SaaS endpoint, hop by hop. The DEVICE measures and uploads; this module
// parses the upload (pure) and keeps the runs. Three formats:
//   aud-netpath/2 — scripts/netpath-probe.ps1 (2026-11-19, Datadog Network Path's shape: traceroute_queries · e2e
//                   probes): every traceroute probe by probe (TTL → who answered, its time) — so which hop followed which
//                   is known (the multipath graph) — end-to-end probe times in order (TCP connect by default: SaaS hosts
//                   often never answer ICMP), the link type / speed, and only with -Lookup the device's PTR / Team Cymru
//                   AS answers. Loss, latency and jitter are computed here.
//   aud-netpath/1 — the earlier probe (Windows, .NET Ping with a TTL per probe): per TTL the addresses that answered
//                   (count), probes sent / answered and every round-trip time (raw) — which hop followed which is not kept
//   mtr           — `mtr --json -c N <target>` (macOS / Linux): per hub host, Loss%, Snt, Best / Avg / Wrst (already
//                   summarised by mtr — the raw times are not in its JSON)
// Loss and latency are computed here from the raw values, so the numbers are testable. Nothing is invented: a hop that
// did not answer is "*" with 100 % loss; no address is looked up (no ASN / geo service — the addresses stay in-house).
// Kept in <AUD_ARRANGEMENT_DIR>/netpath/runs.json (temp file → rename), else memory; newest MAX_RUNS.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NetPathE2e, NetPathHop, NetPathHopInfo, NetPathProbe, NetPathRun, NetPathScope } from "@aud/types";

export const MAX_RUNS = 500;
/** one upload may hold many runs (one JSON line each — the probe's -Repeat); under the API's 1 MB JSON body */
export const MAX_UPLOAD_BYTES = 900 * 1024;
export const MAX_RUNS_PER_UPLOAD = 200;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const LABEL = /^[\w .@()-]{1,64}$/u;

/** Pure: where an IPv4 address sits */
export function scopeOf(ip: string | null): NetPathScope | null {
  if (!ip || !IPV4.test(ip)) return null;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
}

const r1 = (n: number) => Math.round(n * 10) / 10;

const AudHop = z.object({
  ttl: z.number().int().min(1).max(64),
  // ConvertTo-Json writes an empty hashtable as {} and a one-entry one as {"ip": n}
  addresses: z.record(z.string(), z.number().int().min(0).max(1000)).optional().default({}),
  sent: z.number().int().min(1).max(1000),
  received: z.number().int().min(0).max(1000),
  // one value: ConvertTo-Json writes a single-element array as a bare number
  rtt: z.union([z.array(z.number().min(0).max(60_000)).max(1000), z.number().min(0).max(60_000)]).optional(),
});
const AudRun = z.object({
  format: z.literal("aud-netpath/1"),
  target: z.string().regex(HOST),
  targetIp: z.string().regex(IPV4).nullish(),
  device: z.string().max(64).optional(),
  startedAt: z.string().max(40),
  probes: z.number().int().min(1).max(1000),
  reached: z.boolean(),
  hops: z.union([z.array(AudHop).max(64), AudHop]),
});
const MtrHub = z.object({ count: z.number().int().min(1).max(64), host: z.string().max(253), "Loss%": z.number().min(0).max(100), Snt: z.number().int().min(0).max(100_000), Best: z.number().optional(), Avg: z.number().optional(), Wrst: z.number().optional() }).passthrough();
const MtrRun = z.object({ report: z.object({ mtr: z.object({ dst: z.string().max(253), tests: z.union([z.number(), z.string()]).optional() }).passthrough(), hubs: z.array(MtrHub).max(64) }) });

const ms = z.number().min(0).max(60_000);
const Probe2 = z.object({ ttl: z.number().int().min(1).max(64), ip: z.string().regex(IPV4).nullable().optional(), ms: ms.nullable().optional(), st: z.enum(["x", "d", "-"]) });
/** ConvertTo-Json writes a one-element list as the bare element */
const oneOrMany = <T extends z.ZodTypeAny>(t: T) => z.union([z.array(t), t]).transform((v): Array<z.infer<T>> => (Array.isArray(v) ? v : [v]));
const AudRun2 = z.object({
  format: z.literal("aud-netpath/2"),
  target: z.string().regex(HOST),
  targetIp: z.string().regex(IPV4).nullish(),
  device: z.string().max(64).optional(),
  startedAt: z.string().max(40),
  passes: oneOrMany(z.object({ hops: oneOrMany(Probe2).optional() })),
  e2e: z.object({
    protocol: z.enum(["tcp", "icmp"]),
    port: z.number().int().min(1).max(65535).nullish(),
    // -1 = lost
    rtt: oneOrMany(z.number().min(-1).max(60_000)),
  }).nullish(),
  link: z.object({ type: z.string().regex(/^\w{1,40}$/), mbps: z.number().min(0).max(1_000_000).nullish() }).nullish(),
  lookup: z.record(z.string().regex(IPV4), z.object({ ptr: z.string().max(253).optional(), origin: z.string().max(300).optional(), as: z.string().max(300).optional() })).optional(),
});

export type ParsedPath = Omit<NetPathRun, "id" | "uploadedAt" | "by">;

/** Pure: end-to-end probe times (in order, null = lost) → loss, latency and jitter (mean |Δ| of consecutive answers) */
export function e2eOf(protocol: NetPathE2e["protocol"], port: number | null, rtt: Array<number | null>): NetPathE2e {
  const got = rtt.filter((x): x is number => x !== null);
  const diffs: number[] = [];
  for (let i = 1; i < rtt.length; i++) {
    const a = rtt[i - 1], b = rtt[i];
    if (a !== null && a !== undefined && b !== null && b !== undefined) diffs.push(Math.abs(b - a));
  }
  return {
    protocol, port, rtt, sent: rtt.length, received: got.length,
    lossPct: rtt.length ? r1(((rtt.length - got.length) / rtt.length) * 100) : 100,
    rttMin: got.length ? r1(Math.min(...got)) : null,
    rttAvg: got.length ? r1(got.reduce((a, b) => a + b, 0) / got.length) : null,
    rttMax: got.length ? r1(Math.max(...got)) : null,
    jitter: diffs.length >= 2 ? r1(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
  };
}

/** Pure: the device's lookups — PTR, Team Cymru TXT (origin "7922 | 73.0.0.0/8 | US | arin | 2006-07-13", AS "7922 | US | arin | 2006-07-13 | COMCAST-7922 - Comcast …, US") */
export function hopInfoOf(e: { ptr?: string; origin?: string; as?: string }): NetPathHopInfo {
  const out: NetPathHopInfo = {};
  if (e.ptr && /^[A-Za-z0-9.-]{1,253}$/.test(e.ptr)) out.name = e.ptr.replace(/\.$/, "").toLowerCase();
  const o = e.origin?.split("|").map((x) => x.trim());
  // a prefix announced by several ASes ("7922 3356 | …"): the first is kept
  const asn = o?.[0] ? Number(o[0].split(/\s+/)[0]) : NaN;
  if (Number.isInteger(asn) && asn > 0 && asn < 4_294_967_296) out.asn = asn;
  if (o?.[1] && /^[\d.]+\/\d{1,2}$/.test(o[1])) out.prefix = o[1];
  if (o?.[2] && /^[A-Z]{2}$/.test(o[2])) out.country = o[2];
  const a = e.as?.split("|").map((x) => x.trim());
  if (out.asn !== undefined && a && Number(a[0]) === out.asn && a[4]) out.asName = a[4].replace(/[^\p{L}\p{N} .,&()'/-]/gu, "").slice(0, 120);
  return out;
}

/** Pure: an aud-netpath/2 document → a run — passes as measured, per-TTL hops over the passes, e2e computed */
function parseV2(d: z.infer<typeof AudRun2>): ParsedPath {
  const passes: NetPathProbe[][] = d.passes.slice(0, 16).map((p) => (p.hops ?? [])
    .map((h) => {
      const answered = h.st !== "-" && !!h.ip;
      return { ttl: h.ttl, ip: answered ? h.ip! : null, rtt: answered && h.ms !== null && h.ms !== undefined ? r1(h.ms) : null, dest: answered && h.st === "d" };
    })
    .sort((a, b) => a.ttl - b.ttl));
  if (!passes.length) throw new Error("netpath_unknown_format");
  // per TTL: the probes of the passes that got this far
  const maxTtl = Math.max(0, ...passes.flatMap((p) => p.map((h) => h.ttl)));
  const hops: NetPathHop[] = [];
  for (let ttl = 1; ttl <= maxTtl; ttl++) {
    const at = passes.map((p) => p.find((h) => h.ttl === ttl)).filter((h): h is NetPathProbe => !!h);
    if (!at.length) continue;
    const addresses: Record<string, number> = {};
    for (const h of at) if (h.ip) addresses[h.ip] = (addresses[h.ip] ?? 0) + 1;
    const rtt = at.filter((h) => h.rtt !== null).map((h) => h.rtt!);
    hops.push(hopOf({ ttl, addresses, sent: at.length, received: at.filter((h) => h.ip).length, rtt }));
  }
  const device = (d.device ?? "").trim();
  const hopInfo: Record<string, NetPathHopInfo> = {};
  for (const [ip, e] of Object.entries(d.lookup ?? {})) {
    const i = hopInfoOf(e);
    if (Object.keys(i).length) hopInfo[ip] = i;
  }
  const e2e = d.e2e ? e2eOf(d.e2e.protocol, d.e2e.protocol === "tcp" ? d.e2e.port ?? null : null, d.e2e.rtt.slice(0, 1000).map((x) => (x < 0 ? null : r1(x)))) : null;
  return {
    source: "aud-netpath/2", target: d.target, targetIp: d.targetIp ?? null, device: LABEL.test(device) ? device : "device",
    startedAt: Number.isFinite(Date.parse(d.startedAt)) ? new Date(d.startedAt).toISOString() : new Date().toISOString(),
    probes: passes.length, reached: passes.some((p) => p.some((h) => h.dest)), hops, passes,
    ...(e2e ? { e2e } : {}),
    ...(d.link ? { link: { type: d.link.type, mbps: d.link.mbps ?? null } } : {}),
    ...(Object.keys(hopInfo).length ? { hopInfo } : {}),
  };
}

/** Pure: an aud-netpath/1 hop → stats (loss over probes, latency over the answered probes) */
export function hopOf(h: z.infer<typeof AudHop>): NetPathHop {
  const addrs = Object.entries(h.addresses).filter(([ip, n]) => IPV4.test(ip) && n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const rtt = h.rtt === undefined ? [] : Array.isArray(h.rtt) ? h.rtt : [h.rtt];
  const received = Math.min(h.received, h.sent);
  const ip = received > 0 ? addrs[0]?.[0] ?? null : null;
  return {
    ttl: h.ttl, ip, others: addrs.slice(1).map(([a]) => a), sent: h.sent, received,
    lossPct: r1(((h.sent - received) / h.sent) * 100),
    rttMin: rtt.length ? r1(Math.min(...rtt)) : null,
    rttAvg: rtt.length ? r1(rtt.reduce((s, x) => s + x, 0) / rtt.length) : null,
    rttMax: rtt.length ? r1(Math.max(...rtt)) : null,
    scope: scopeOf(ip),
  };
}

/** Pure: an upload's text → a run (throws a short reason on anything else) */
export function parseNetPath(text: string): ParsedPath {
  if (text.length > MAX_UPLOAD_BYTES) throw new Error("netpath_too_large");
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^﻿/, "").trim()); } catch { throw new Error("netpath_not_json"); }
  return parseDoc(doc);
}

/** Pure: one parsed JSON document → a run */
function parseDoc(doc: unknown): ParsedPath {
  const v2 = AudRun2.safeParse(doc);
  if (v2.success) return parseV2(v2.data);
  const aud = AudRun.safeParse(doc);
  if (aud.success) {
    const d = aud.data;
    const hops = (Array.isArray(d.hops) ? d.hops : [d.hops]).map(hopOf).sort((a, b) => a.ttl - b.ttl);
    const device = (d.device ?? "").trim();
    return {
      source: "aud-netpath/1", target: d.target, targetIp: d.targetIp ?? null, device: LABEL.test(device) ? device : "device",
      startedAt: Number.isFinite(Date.parse(d.startedAt)) ? new Date(d.startedAt).toISOString() : new Date().toISOString(),
      probes: d.probes, reached: d.reached, hops,
    };
  }
  const mtr = MtrRun.safeParse(doc);
  if (mtr.success) {
    const m = mtr.data.report;
    const hops: NetPathHop[] = m.hubs.map((h) => {
      const ip = IPV4.test(h.host) ? h.host : null; // "???" = no answer; names (mtr without -n) are not addresses
      const sent = Math.max(1, h.Snt);
      const received = ip ? Math.round(sent * (1 - h["Loss%"] / 100)) : 0;
      const ok = ip && received > 0;
      return {
        ttl: h.count, ip: ok ? ip : null, others: [], sent, received: ok ? received : 0, lossPct: ok ? r1(h["Loss%"]) : 100,
        rttMin: ok && h.Best !== undefined ? r1(h.Best) : null, rttAvg: ok && h.Avg !== undefined ? r1(h.Avg) : null, rttMax: ok && h.Wrst !== undefined ? r1(h.Wrst) : null,
        scope: ok ? scopeOf(ip) : null,
      };
    }).sort((a, b) => a.ttl - b.ttl);
    const dst = m.mtr.dst;
    const last = [...hops].reverse().find((h) => h.ip);
    return {
      source: "mtr", target: HOST.test(dst) ? dst : "target", targetIp: IPV4.test(dst) ? dst : null, device: "device",
      startedAt: new Date().toISOString(), probes: hops[0]?.sent ?? 0, reached: !!last && IPV4.test(dst) && last.ip === dst, hops,
    };
  }
  throw new Error("netpath_unknown_format");
}

/**
 * Pure: an upload → its runs. One document (a pretty-printed mtr too), a JSON array of runs, or one run per line (the
 * probe's -Repeat / -OutFile). Any line that is not a run fails the whole upload (nothing half-kept).
 */
export function parseNetPathMany(text: string): ParsedPath[] {
  if (text.length > MAX_UPLOAD_BYTES) throw new Error("netpath_too_large");
  const body = text.replace(/^﻿/, "").trim();
  let whole: unknown;
  let parsed = true;
  try { whole = JSON.parse(body); } catch { parsed = false; }
  if (parsed) {
    const docs = Array.isArray(whole) ? whole : [whole];
    if (!docs.length) throw new Error("netpath_unknown_format");
    if (docs.length > MAX_RUNS_PER_UPLOAD) throw new Error("netpath_too_large");
    return docs.map(parseDoc);
  }
  const lines = body.split(/\r?\n/).map((l) => l.replace(/^﻿/, "").trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("netpath_not_json");
  if (lines.length > MAX_RUNS_PER_UPLOAD) throw new Error("netpath_too_large");
  return lines.map((l) => {
    let doc: unknown;
    try { doc = JSON.parse(l); } catch { throw new Error("netpath_not_json"); }
    return parseDoc(doc);
  });
}

// ── store ──
type Doc = { v: 1; runs: NetPathRun[] };
let memory: Doc = { v: 1, runs: [] };
let lock: Promise<unknown> = Promise.resolve();

export const netPathDir = (env: { AUD_ARRANGEMENT_DIR?: string }) => (env.AUD_ARRANGEMENT_DIR ? path.join(env.AUD_ARRANGEMENT_DIR, "netpath") : undefined);
const fileOf = (dir: string) => path.join(dir, "runs.json");

export async function readRuns(dir: string | undefined): Promise<NetPathRun[]> {
  if (!dir) return memory.runs;
  try { return (JSON.parse(await fs.readFile(fileOf(dir), "utf8")) as Doc).runs ?? []; } catch { return []; }
}

async function write(dir: string | undefined, runs: NetPathRun[]): Promise<void> {
  if (!dir) { memory = { v: 1, runs }; return; }
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, runs } satisfies Doc), { mode: 0o640 });
  await fs.rename(tmp, fileOf(dir));
}

/** Parse and keep one upload — one run or many (newest measured first, MAX_RUNS kept) */
export async function addRuns(dir: string | undefined, text: string, opts: { by?: string; device?: string; now?: Date } = {}): Promise<NetPathRun[]> {
  const parsed = parseNetPathMany(text);
  const device = opts.device?.trim();
  const uploadedAt = (opts.now ?? new Date()).toISOString();
  const runs: NetPathRun[] = parsed.map((p) => ({
    ...p, ...(device && LABEL.test(device) ? { device } : {}),
    id: randomUUID(), uploadedAt, ...(opts.by ? { by: opts.by.slice(0, 120) } : {}),
  }));
  const next = lock.catch(() => undefined).then(async () => {
    const all = [...runs, ...(await readRuns(dir))].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    await write(dir, all.slice(0, MAX_RUNS));
  });
  lock = next;
  await next;
  return runs;
}

/** One run (the single-run call) */
export async function addRun(dir: string | undefined, text: string, opts: { by?: string; device?: string; now?: Date } = {}): Promise<NetPathRun> {
  return (await addRuns(dir, text, opts))[0]!;
}

export async function deleteRun(dir: string | undefined, id: string): Promise<boolean> {
  let found = false;
  const next = lock.catch(() => undefined).then(async () => {
    const runs = await readRuns(dir);
    const kept = runs.filter((r) => r.id !== id);
    found = kept.length !== runs.length;
    if (found) await write(dir, kept);
  });
  lock = next;
  await next;
  return found;
}

/** Test hook */
export function clearNetPathMemory(): void { memory = { v: 1, runs: [] }; }
