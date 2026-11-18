// 네트워크 › 네트워크 경로 — a device's path to a SaaS endpoint, hop by hop. The DEVICE measures and uploads; this module
// parses the upload (pure) and keeps the runs. Two formats:
//   aud-netpath/1 — scripts/netpath-probe.ps1 (Windows, .NET Ping with a TTL per probe — no admin, no locale text): per
//                   TTL the addresses that answered (count), probes sent / answered and every round-trip time (raw)
//   mtr           — `mtr --json -c N <target>` (macOS / Linux): per hub host, Loss%, Snt, Best / Avg / Wrst (already
//                   summarised by mtr — the raw times are not in its JSON)
// Loss and latency are computed here from the raw values, so the numbers are testable. Nothing is invented: a hop that
// did not answer is "*" with 100 % loss; no address is looked up (no ASN / geo service — the addresses stay in-house).
// Kept in <AUD_ARRANGEMENT_DIR>/netpath/runs.json (temp file → rename), else memory; newest MAX_RUNS.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NetPathHop, NetPathRun, NetPathScope } from "@aud/types";

export const MAX_RUNS = 500;
export const MAX_UPLOAD_BYTES = 256 * 1024;
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

export type ParsedPath = Omit<NetPathRun, "id" | "uploadedAt" | "by">;

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

/** Parse and keep one upload (newest first, MAX_RUNS kept) */
export async function addRun(dir: string | undefined, text: string, opts: { by?: string; device?: string; now?: Date } = {}): Promise<NetPathRun> {
  const parsed = parseNetPath(text);
  const device = opts.device?.trim();
  const run: NetPathRun = {
    ...parsed, ...(device && LABEL.test(device) ? { device } : {}),
    id: randomUUID(), uploadedAt: (opts.now ?? new Date()).toISOString(), ...(opts.by ? { by: opts.by.slice(0, 120) } : {}),
  };
  const next = lock.catch(() => undefined).then(async () => { await write(dir, [run, ...(await readRuns(dir))].slice(0, MAX_RUNS)); });
  lock = next;
  await next;
  return run;
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
