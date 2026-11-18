// 네트워크 › 네트워크 경로 — pure view model of device-measured paths (API services/netPath.ts). The judgement follows how
// mtr / pathping results are read by network engineers:
//   · loss that carries on to the destination is loss on the path (from the first hop it appears at);
//   · loss at a middle hop that does NOT carry on (later hops and the destination answer fully) is that router limiting
//     the ICMP answers to itself — not loss on the path (said as such, no warning colour);
//   · a hop that never answers ("*") is the same: routers that do not answer probes, the path goes on past them;
//   · latency added at a hop = its average minus the previous answering hop's (negative = ICMP answer slower than the
//     forwarding — shown as "—"). Nothing else is judged: no target latency, no colour without a fact behind it.
import type { NetPathHop, NetPathRun } from "@aud/types";

export type HopVerdict = "ok" | "silent" | "icmpLimited" | "pathLoss" | "destLoss" | "unreached";
export type HopView = NetPathHop & {
  verdict: HopVerdict;
  /** ms added since the previous answering hop (null = first, no answer, or not positive) */
  addedMs: number | null;
  /** the segment the hop sits in: the device's own network (leading private hops) · the way (ISP, transit) · destination */
  segment: "local" | "transit" | "destination";
};
export type PathView = {
  hops: HopView[];
  end: { reached: boolean; rttAvg: number | null; lossPct: number | null; hops: number };
  silent: number;
  /** the first hop where loss on the path starts (null = none) */
  lossFrom: number | null;
};

/** Pure: one run → its hops with verdicts and segments; `hideSilent` drops the "*" hops (they stay counted) */
export function pathView(run: Pick<NetPathRun, "hops" | "reached" | "targetIp">, hideSilent = false): PathView {
  const hops = [...run.hops].sort((a, b) => a.ttl - b.ttl);
  const answered = hops.filter((h) => h.ip);
  const last = answered[answered.length - 1] ?? null;
  const dest = run.reached && last ? last : null;
  const destLoss = dest ? dest.lossPct : null;
  // loss on the path: the first answering hop from which every later answering hop (to the destination) loses too
  let lossFrom: number | null = null;
  if (dest && dest.lossPct > 0) {
    for (let i = answered.length - 1; i >= 0; i--) { if (answered[i]!.lossPct > 0) lossFrom = answered[i]!.ttl; else break; }
  }
  let localEnds = true;
  let prevAvg: number | null = null;
  const out: HopView[] = hops.map((h) => {
    const isDest = !!dest && h.ttl === dest.ttl;
    let verdict: HopVerdict;
    if (!h.ip) verdict = "silent";
    else if (isDest) verdict = h.lossPct > 0 ? "destLoss" : "ok";
    else if (h.lossPct > 0) verdict = lossFrom !== null && h.ttl >= lossFrom ? "pathLoss" : "icmpLimited";
    else verdict = "ok";
    if (h.ip && h.scope !== "private") localEnds = false;
    const segment: HopView["segment"] = isDest ? "destination" : localEnds && h.scope === "private" ? "local" : "transit";
    const added = h.rttAvg !== null && prevAvg !== null ? Math.round((h.rttAvg - prevAvg) * 10) / 10 : null;
    if (h.rttAvg !== null) prevAvg = h.rttAvg;
    return { ...h, verdict, addedMs: added !== null && added > 0 ? added : null, segment };
  });
  if (!run.reached && out.length) out[out.length - 1] = { ...out[out.length - 1]!, verdict: out[out.length - 1]!.ip ? out[out.length - 1]!.verdict : "unreached" };
  return {
    hops: hideSilent ? out.filter((h) => h.verdict !== "silent") : out,
    end: { reached: !!dest, rttAvg: dest?.rttAvg ?? null, lossPct: destLoss, hops: hops.length },
    silent: out.filter((h) => h.verdict === "silent").length,
    lossFrom,
  };
}

/** A device's series of one target (newest first) — the history list and the target table */
export type PathSeries = { key: string; target: string; device: string; runs: NetPathRun[] };

/** Pure: runs grouped by target × device, newest series first */
export function pathSeries(runs: NetPathRun[]): PathSeries[] {
  const by = new Map<string, PathSeries>();
  for (const r of [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    const key = `${r.target}|${r.device}`;
    const s = by.get(key) ?? by.set(key, { key, target: r.target, device: r.device, runs: [] }).get(key)!;
    s.runs.push(r);
  }
  return [...by.values()].sort((a, b) => (a.runs[0]!.startedAt < b.runs[0]!.startedAt ? 1 : -1));
}

/** Pure: did the path (answering addresses in order) change between two runs of a series — ECMP / DNS / routing */
export function samePath(a: NetPathRun, b: NetPathRun): boolean {
  const ips = (r: NetPathRun) => r.hops.filter((h) => h.ip).map((h) => h.ip).join(">");
  return ips(a) === ips(b);
}

// ── what to measure (2026-11-18 2nd pass — "which value goes in -Target?") ──

/** Hosts people measure most — the sign-in and the apps their users say are slow. The dashboard's own host is added on
 *  the page (it is the SaaS too). */
export const TARGET_PRESETS = [
  { id: "m365Login", host: "login.microsoftonline.com" },
  { id: "outlook", host: "outlook.office365.com" },
  { id: "teams", host: "teams.microsoft.com" },
  { id: "azurePortal", host: "portal.azure.com" },
  { id: "github", host: "github.com" },
] as const;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Pure: what a person typed or pasted → the host to measure. People paste the address bar: the scheme, a user, the
 * port, the path, the query and the fragment are dropped (`changed` says so); upper case is folded. A host name needs
 * a dot (a bare word is a local name the device's DNS may not resolve the same); IPv4 is taken as it is; IPv6 is not
 * supported by the probe.
 */
export function targetOf(input: string): { host: string | null; changed: boolean; reason?: "empty" | "invalid" | "ipv6" } {
  const raw = input.trim();
  if (!raw) return { host: null, changed: false, reason: "empty" };
  let s = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^/@]*@/, "");
  s = s.split(/[/?#]/)[0] ?? "";
  if (s.startsWith("[") || (s.match(/:/g)?.length ?? 0) > 1) return { host: null, changed: false, reason: "ipv6" };
  s = s.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  const ok = IPV4.test(s) || (s.length <= 253 && s.includes(".") && s.split(".").every((l) => HOST_LABEL.test(l)));
  return ok ? { host: s, changed: s !== raw } : { host: null, changed: false, reason: "invalid" };
}

/** The commands with the chosen host (the probe script is saved to Downloads by the page's button) */
export const probeCommand = (host: string) => `powershell -ExecutionPolicy Bypass -File "$HOME\\Downloads\\netpath-probe.ps1" -Target ${host} | Set-Clipboard`;
export const mtrCommand = (host: string) => `mtr --json -n -c 10 ${host} | pbcopy   # Linux: | xclip -selection clipboard`;

// ── the path, read top-down like mtr ──

/** One row of the route: a hop, or a run of silent hops folded into one row (they say nothing but "the path goes on") */
export type RouteRow = { kind: "hop"; hop: HopView } | { kind: "silent"; from: number; to: number; count: number; segment: HopView["segment"] };

/** Pure: the route rows — consecutive silent hops folded into one */
export function routeRows(v: PathView): RouteRow[] {
  const out: RouteRow[] = [];
  for (const h of v.hops) {
    const last = out[out.length - 1];
    if (h.verdict === "silent") {
      if (last?.kind === "silent" && last.to === h.ttl - 1) { last.to = h.ttl; last.count++; continue; }
      out.push({ kind: "silent", from: h.ttl, to: h.ttl, count: 1, segment: h.segment });
      continue;
    }
    out.push({ kind: "hop", hop: h });
  }
  return out;
}

/** Pure: the hop where the most latency is added (the largest positive step) — null when none adds any */
export function biggestJump(v: PathView): { ttl: number; ms: number } | null {
  let best: { ttl: number; ms: number } | null = null;
  for (const h of v.hops) if (h.addedMs !== null && (!best || h.addedMs > best.ms)) best = { ttl: h.ttl, ms: h.addedMs };
  return best;
}

/** One point of the latency profile: an answering hop's average with its min–max over the probes */
export type ProfilePoint = { ttl: number; avg: number; min: number; max: number; verdict: HopVerdict };

/** Pure: the latency profile (answering hops in TTL order) and the scale's top (the largest max, ≥ 1 ms) */
export function latencyProfile(v: PathView): { points: ProfilePoint[]; top: number; ttls: number } {
  const points = v.hops.filter((h) => h.rttAvg !== null).map((h) => ({ ttl: h.ttl, avg: h.rttAvg!, min: h.rttMin ?? h.rttAvg!, max: h.rttMax ?? h.rttAvg!, verdict: h.verdict }));
  return { points, top: Math.max(1, ...points.map((p) => p.max)), ttls: v.end.hops };
}

/** Pure: a "nice" axis top and ticks for ms (1-2-5 steps, 3–5 ticks) */
export function msTicks(top: number): number[] {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => top / s <= 4) ?? 10_000;
  const n = Math.ceil(top / step);
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}
