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
