// 네트워크 › 네트워크 경로 › Path View · Analysis — pure model of the paths of the runs picked on the health bar
// (Datadog Network Path: hops aggregated over the traceroutes of a time range, traversal counts, hop-to-hop latency,
// grouping by AS, hiding unknown hops, comparing with the previous range). Every number comes from the probes as the
// device measured them (API services/netPath.ts):
//   · a node = an address at a TTL (the same address at another TTL is another node — that is where it answered);
//     the destination is one node; a TTL without an answer is an "unknown hop" node "*";
//   · an edge = consecutive answers of the SAME traceroute (aud-netpath/2 keeps every pass) — its count is how many
//     traceroutes went that way; with unknown hops hidden, an edge bridges them and says how many it skipped;
//   · older runs (aud-netpath/1, mtr) kept per-TTL summaries only: one chain of the busiest address per TTL, its
//     edges marked "pairing not measured" — never drawn as if a traceroute had gone that way;
//   · latency added on an edge = the node's average minus the previous node's (≤ 0 → "<1 ms": ICMP answers are made
//     on the routers' slow path, a later hop may answer faster); loss = the TTL's probes without an answer.
// Colours carry facts only: red = loss that carries on to the destination (pathView's rule), dashed = not a measured
// edge (bridged unknown hops / unpaired summary), the user's own latency threshold (none by default) = orange.
import type { NetPathE2e, NetPathHop, NetPathHopInfo, NetPathRun, NetPathScope } from "@aud/types";
import { pathView, type HopView } from "./netPathView";

export const SOURCE_ID = "src";
export const DEST_ID = "dst";

export type GNode = {
  id: string;
  kind: "source" | "hop" | "unknown" | "dest";
  /** the TTL it answered at (the destination: the most common one) */
  ttl: number;
  ip: string | null;
  /** traceroutes that went through it */
  traversed: number;
  rttAvg: number | null;
  rttMin: number | null;
  rttMax: number | null;
  info: NetPathHopInfo | null;
  scope: NetPathScope | null;
  /** the TTL's probes without an answer, % (0–100) — null for the source */
  ttlLossPct: number | null;
  verdict: HopView["verdict"] | null;
  segment: HopView["segment"] | null;
};
export type GEdge = {
  id: string;
  from: string;
  to: string;
  /** traceroutes that went this way */
  count: number;
  /** unknown hops it bridges (hidden) */
  skipped: number;
  /** false: runs that kept per-TTL summaries only — the pairing was not measured */
  measured: boolean;
  /** to.avg − from.avg (null without both); ≤ 0 is shown as "<1 ms" */
  addedMs: number | null;
  state: "ok" | "loss" | "slow";
};
export type PathGraph = {
  nodes: GNode[];
  edges: GEdge[];
  /** traceroutes over the runs */
  passes: number;
  runs: number;
  /** traceroutes that reached the destination (traversal completion) */
  completed: number;
  /** some run kept summaries only */
  unpaired: boolean;
  /** unknown hops (TTLs without any answer) */
  unknownTtls: number;
  lossFrom: number | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** = API netPath.ts scopeOf — a node's own address (the per-TTL hop's scope is its busiest address's) */
export function scopeOfIp(ip: string | null): NetPathScope | null {
  if (!ip || !IPV4.test(ip)) return null;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 169 && b === 254)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
}
const stats = (xs: number[]) => (xs.length ? { avg: r1(xs.reduce((a, b) => a + b, 0) / xs.length), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) } : { avg: null, min: null, max: null });

type P = { ttl: number; ip: string | null; rtt: number | null; dest: boolean };

/** Pure: a run's traceroutes — the measured passes, or (older formats) one chain built from the per-TTL summary */
export function passesOf(run: NetPathRun): { passes: P[][]; measured: boolean } {
  if (run.passes?.length) return { passes: run.passes, measured: true };
  const last = [...run.hops].reverse().find((h) => h.ip);
  const chain = [...run.hops].sort((a, b) => a.ttl - b.ttl).map((h) => ({ ttl: h.ttl, ip: h.ip, rtt: h.rttAvg, dest: run.reached && !!last && h.ttl === last.ttl }));
  return { passes: [chain], measured: false };
}

/**
 * Pure: the per-TTL hops of several runs (the input of pathView — verdicts, segments, the latency profile): sent /
 * received add up, latency over every answer (aud-netpath/2: the probes; summaries: their min / average / max weighted
 * by answers), the busiest address first.
 */
export function mergedHops(runs: NetPathRun[]): NetPathHop[] {
  const by = new Map<number, { sent: number; received: number; addrs: Map<string, number>; rtt: number[]; sum: number; n: number; min: number | null; max: number | null; scope: NetPathScope | null }>();
  for (const run of runs) {
    for (const h of run.hops) {
      const e = by.get(h.ttl) ?? by.set(h.ttl, { sent: 0, received: 0, addrs: new Map(), rtt: [], sum: 0, n: 0, min: null, max: null, scope: null }).get(h.ttl)!;
      e.sent += h.sent;
      e.received += h.received;
      if (h.ip) { e.addrs.set(h.ip, (e.addrs.get(h.ip) ?? 0) + h.received); e.scope ??= h.scope; }
      for (const o of h.others) e.addrs.set(o, (e.addrs.get(o) ?? 0) + 1);
      if (!run.passes && h.rttAvg !== null) { e.sum += h.rttAvg * h.received; e.n += h.received; }
      if (h.rttMin !== null) e.min = e.min === null ? h.rttMin : Math.min(e.min, h.rttMin);
      if (h.rttMax !== null) e.max = e.max === null ? h.rttMax : Math.max(e.max, h.rttMax);
    }
    for (const p of run.passes ?? []) for (const x of p) if (x.rtt !== null) by.get(x.ttl)?.rtt.push(x.rtt);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ttl, e]) => {
    const addrs = [...e.addrs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const sum = e.sum + e.rtt.reduce((a, b) => a + b, 0), n = e.n + e.rtt.length;
    return {
      ttl, ip: e.received > 0 ? addrs[0]?.[0] ?? null : null, others: e.received > 0 ? addrs.slice(1).map(([a]) => a) : [],
      sent: e.sent, received: e.received, lossPct: e.sent ? r1(((e.sent - e.received) / e.sent) * 100) : 100,
      rttMin: n ? e.min : null, rttAvg: n ? r1(sum / n) : null, rttMax: n ? e.max : null, scope: e.received > 0 ? e.scope : null,
    };
  });
}

/** Pure: the end-to-end probes of several runs pooled (loss and latency over every probe, jitter within each run) */
export function mergedE2e(runs: NetPathRun[]): (NetPathE2e & { runs: number }) | null {
  const with2 = runs.filter((r) => r.e2e);
  if (!with2.length) return null;
  const all = with2.flatMap((r) => r.e2e!.rtt);
  const got = all.filter((x): x is number => x !== null);
  const diffs: number[] = [];
  for (const r of with2) for (let i = 1; i < r.e2e!.rtt.length; i++) { const a = r.e2e!.rtt[i - 1], b = r.e2e!.rtt[i]; if (a != null && b != null) diffs.push(Math.abs(b - a)); }
  const s = stats(got);
  const first = with2[0]!.e2e!;
  return {
    protocol: first.protocol, port: first.port, rtt: all, sent: all.length, received: got.length,
    lossPct: all.length ? r1(((all.length - got.length) / all.length) * 100) : 100,
    rttMin: s.min, rttAvg: s.avg, rttMax: s.max, jitter: diffs.length >= 2 ? r1(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
    runs: with2.length,
  };
}

/** Pure: the hop graph of the runs */
export function buildGraph(runs: NetPathRun[], opts: { hideUnknown: boolean; slowMs?: number | null }): PathGraph {
  const merged = mergedHops(runs);
  const view = pathView({ hops: merged, reached: runs.some((r) => r.reached), targetIp: runs[0]?.targetIp ?? null });
  const verdictOf = new Map(view.hops.map((h) => [h.ttl, h]));
  const lossOf = new Map(merged.map((h) => [h.ttl, h.lossPct]));
  const info: Record<string, NetPathHopInfo> = {};
  for (const r of runs) Object.assign(info, r.hopInfo ?? {});
  const nodes = new Map<string, { n: GNode; rtt: number[]; ttls: Map<number, number> }>();
  const edges = new Map<string, GEdge>();
  const node = (id: string, kind: GNode["kind"], ttl: number, ip: string | null) => {
    let e = nodes.get(id);
    if (!e) {
      const hv = kind === "hop" || kind === "unknown" ? verdictOf.get(ttl) : undefined;
      e = { n: { id, kind, ttl, ip, traversed: 0, rttAvg: null, rttMin: null, rttMax: null, info: ip ? info[ip] ?? null : null, scope: kind === "hop" ? scopeOfIp(ip) : null, ttlLossPct: kind === "source" ? null : lossOf.get(ttl) ?? null, verdict: kind === "unknown" ? "silent" : hv?.verdict ?? null, segment: hv?.segment ?? null }, rtt: [], ttls: new Map() };
      nodes.set(id, e);
    }
    return e;
  };
  node(SOURCE_ID, "source", 0, null);
  let passes = 0, completed = 0, unpaired = false;
  for (const run of runs) {
    const { passes: ps, measured } = passesOf(run);
    if (!measured) unpaired = true;
    for (const p of ps) {
      passes++;
      node(SOURCE_ID, "source", 0, null).n.traversed++;
      let prev = SOURCE_ID, skipped = 0;
      for (const x of p) {
        if (!x.ip && opts.hideUnknown) { skipped++; continue; }
        const id = x.dest ? DEST_ID : x.ip ? `${x.ttl}|${x.ip}` : `*${x.ttl}`;
        const e = node(id, x.dest ? "dest" : x.ip ? "hop" : "unknown", x.ttl, x.dest ? run.targetIp ?? x.ip : x.ip);
        e.n.traversed++;
        e.ttls.set(x.ttl, (e.ttls.get(x.ttl) ?? 0) + 1);
        if (x.rtt !== null) e.rtt.push(x.rtt);
        const k = `${prev}>${id}`;
        const g = edges.get(k) ?? edges.set(k, { id: k, from: prev, to: id, count: 0, skipped: 0, measured, addedMs: null, state: "ok" }).get(k)!;
        g.count++;
        g.skipped = Math.max(g.skipped, skipped);
        g.measured &&= measured;
        prev = id;
        skipped = 0;
        if (x.dest) { completed++; break; }
      }
    }
  }
  const out: GNode[] = [...nodes.values()].map(({ n, rtt, ttls }) => {
    const s = stats(rtt);
    const ttl = n.kind === "dest" ? [...ttls].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? n.ttl : n.ttl;
    const hv = n.kind === "dest" ? verdictOf.get(ttl) : undefined;
    return { ...n, ttl, rttAvg: s.avg, rttMin: s.min, rttMax: s.max, ...(n.kind === "dest" ? { ttlLossPct: lossOf.get(ttl) ?? null, verdict: hv?.verdict ?? "ok", segment: "destination" as const, info: n.ip ? info[n.ip] ?? null : null } : {}) };
  });
  const byId = new Map(out.map((n) => [n.id, n]));
  const lossFrom = view.lossFrom;
  const es = [...edges.values()].map((e) => {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    const from = e.from === SOURCE_ID ? 0 : a.rttAvg;
    const added = from !== null && b.rttAvg !== null ? r1(b.rttAvg - from) : null;
    const loss = lossFrom !== null && (b.kind === "hop" || b.kind === "dest") && b.ttl >= lossFrom && (b.ttlLossPct ?? 0) > 0;
    const slow = !!opts.slowMs && added !== null && added >= opts.slowMs;
    return { ...e, addedMs: added, state: loss ? "loss" as const : slow ? "slow" as const : "ok" as const };
  });
  return { nodes: out, edges: es, passes, runs: runs.length, completed, unpaired, unknownTtls: view.silent, lossFrom };
}

// ── grouping (Datadog: "Group by" · "Collapse all groups") ──

export type GroupBy = "ip" | "asn" | "segment";
export type HopGroup = { id: string; key: string; by: GroupBy; nodeIds: string[]; asn: number | null; asName: string | null; segment: HopView["segment"] | null };

/** Pure: a hop's group key — AS (only when the device looked it up), the segment (own network · the way · destination) */
export function groupKeyOf(n: GNode, by: GroupBy): string | null {
  if (n.kind === "source" || n.kind === "dest") return null;
  if (by === "asn") return n.info?.asn ? `AS${n.info.asn}` : n.kind === "unknown" ? "" : null;
  if (by === "segment") return n.kind === "unknown" ? "" : n.segment;
  return null;
}

/**
 * Pure: groups — runs of consecutive TTLs whose answering hops all share a key (an unknown hop "" joins the run it
 * sits in; a run ends at a different key, a hop without one, or the destination). Groups of one hop are not groups.
 */
export function groupsOf(g: PathGraph, by: GroupBy): HopGroup[] {
  if (by === "ip") return [];
  const ttls = [...new Set(g.nodes.filter((n) => n.kind === "hop" || n.kind === "unknown").map((n) => n.ttl))].sort((a, b) => a - b);
  const out: HopGroup[] = [];
  let cur: { key: string; ids: string[] } | null = null;
  const close = () => {
    if (cur && cur.key && cur.ids.length >= 2) {
      const members = cur.ids.map((id) => g.nodes.find((n) => n.id === id)!);
      const withInfo = members.find((m) => m.info?.asn);
      out.push({ id: `${by}:${cur.key}@${members[0]!.ttl}`, key: cur.key, by, nodeIds: cur.ids, asn: withInfo?.info?.asn ?? null, asName: withInfo?.info?.asName ?? null, segment: by === "segment" ? (cur.key as HopView["segment"]) : null });
    }
    cur = null;
  };
  for (const ttl of ttls) {
    const col = g.nodes.filter((n) => n.ttl === ttl && (n.kind === "hop" || n.kind === "unknown"));
    const keys = new Set(col.map((n) => groupKeyOf(n, by)));
    keys.delete("");
    if (keys.has(null) || keys.size > 1) { close(); continue; }
    const key = keys.size ? [...keys][0]! : "";
    // consecutive columns in use (hidden unknown hops leave no column — the group goes on over them)
    if (cur && (key === "" || cur.key === "" || cur.key === key)) {
      if (cur.key === "") cur.key = key;
      cur.ids.push(...col.map((n) => n.id));
    } else {
      close();
      cur = { key, ids: col.map((n) => n.id) };
    }
  }
  close();
  // an unknown hop at the end of a group belongs to no one in particular — trim trailing unknowns
  return out.map((gr) => {
    const ids = [...gr.nodeIds];
    while (ids.length && g.nodes.find((n) => n.id === ids[ids.length - 1])!.kind === "unknown") ids.pop();
    return { ...gr, nodeIds: ids };
  }).filter((gr) => gr.nodeIds.filter((id) => g.nodes.find((n) => n.id === id)!.kind === "hop").length >= 2);
}

/** A collapsed group drawn as one node */
export type GroupNode = GNode & { group: HopGroup; hops: number; /** its first hops' average — where it is entered */ firstAvg: number | null };

/**
 * Pure: the graph with some groups collapsed — each into one node (traversed = traceroutes entering it, latency = its
 * members' range, average = its last hops' — where the group hands over), its inner edges dropped, the edges in and
 * out moved to it (counts of the same pair add up).
 */
export function collapse(g: PathGraph, groups: HopGroup[], collapsed: Set<string>): { nodes: Array<GNode | GroupNode>; edges: GEdge[] } {
  const owner = new Map<string, HopGroup>();
  for (const gr of groups) if (collapsed.has(gr.id)) for (const id of gr.nodeIds) owner.set(id, gr);
  if (!owner.size) return { nodes: g.nodes, edges: g.edges };
  const nodes: Array<GNode | GroupNode> = g.nodes.filter((n) => !owner.has(n.id));
  const gid = (gr: HopGroup) => `grp:${gr.id}`;
  for (const gr of groups) {
    if (!collapsed.has(gr.id)) continue;
    const members = gr.nodeIds.map((id) => g.nodes.find((n) => n.id === id)!);
    const lastTtl = Math.max(...members.filter((m) => m.kind === "hop").map((m) => m.ttl));
    const last = members.filter((m) => m.ttl === lastTtl && m.rttAvg !== null);
    const firstTtl = Math.min(...members.filter((m) => m.kind === "hop").map((m) => m.ttl));
    const first = members.filter((m) => m.ttl === firstTtl && m.rttAvg !== null);
    const wavg = (xs: GNode[]) => (xs.length ? r1(xs.reduce((a, m) => a + m.rttAvg! * m.traversed, 0) / xs.reduce((a, m) => a + m.traversed, 0)) : null);
    // traceroutes entering it — from outside this group (another collapsed group counts as outside)
    const into = g.edges.filter((e) => owner.get(e.from) !== gr && owner.get(e.to) === gr).reduce((n, e) => n + e.count, 0);
    const avgs = members.filter((m) => m.rttMin !== null);
    nodes.push({
      id: gid(gr), kind: "hop", ttl: members[0]!.ttl, ip: null, traversed: into,
      rttAvg: wavg(last),
      rttMin: avgs.length ? Math.min(...avgs.map((m) => m.rttMin!)) : null, rttMax: avgs.length ? Math.max(...avgs.map((m) => m.rttMax!)) : null,
      info: members.find((m) => m.info?.asn)?.info ?? null, scope: null, ttlLossPct: null,
      verdict: members.some((m) => m.verdict === "pathLoss") ? "pathLoss" : "ok", segment: gr.segment,
      group: gr, hops: members.filter((m) => m.kind === "hop").length, firstAvg: wavg(first),
    });
  }
  const map = (id: string) => (owner.has(id) ? gid(owner.get(id)!) : id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = new Map<string, GEdge>();
  for (const e of g.edges) {
    const from = map(e.from), to = map(e.to);
    if (from === to) continue;
    const k = `${from}>${to}`;
    const x = edges.get(k);
    if (x) {
      x.count += e.count; x.skipped = Math.max(x.skipped, e.skipped); x.measured &&= e.measured;
      if (e.state === "loss") x.state = "loss"; else if (e.state === "slow" && x.state === "ok") x.state = "slow";
      continue;
    }
    const a = byId.get(from), b = byId.get(to);
    const base = from === SOURCE_ID ? 0 : a?.rttAvg ?? null;
    // into a group: up to its first hops (the rest is inside it)
    const into = b && "group" in b ? b.firstAvg : b?.rttAvg ?? null;
    const added = base !== null && into !== null ? r1(into - base) : e.addedMs;
    edges.set(k, { ...e, id: k, from, to, addedMs: from !== e.from || to !== e.to ? added : e.addedMs });
  }
  return { nodes, edges: [...edges.values()] };
}

// ── layout: TTL columns left → right, the busiest hop of a column in the middle ──

export const PATH_NODE_W = 168;
export const PATH_NODE_H = 64;
/** The destination card has a status band on top of the two rows every card has (64 px cut its last row in half) */
export const PATH_DEST_H = PATH_NODE_H + 22;
export const PATH_COL_GAP = 72;
export const PATH_ROW_GAP = 18;

/** Pure: node positions — one column per TTL in use (source first, destination last), rows centred on 0 */
export function layoutPath(nodes: Array<GNode | GroupNode>): Map<string, { x: number; y: number; col: number }> {
  const colKey = (n: GNode) => (n.kind === "source" ? -1 : n.kind === "dest" ? Number.MAX_SAFE_INTEGER : n.ttl);
  const keys = [...new Set(nodes.map(colKey))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number; col: number }>();
  keys.forEach((k, col) => {
    const inCol = nodes.filter((n) => colKey(n) === k).sort((a, b) => b.traversed - a.traversed || ((a.ip ?? a.id) < (b.ip ?? b.id) ? -1 : 1));
    // busiest in the middle, then alternating below / above
    const order: typeof inCol = [];
    inCol.forEach((n, i) => (i % 2 ? order.push(n) : order.unshift(n)));
    const mid = (order.length - 1) / 2;
    order.forEach((n, row) => pos.set(n.id, { x: col * (PATH_NODE_W + PATH_COL_GAP), y: (row - mid) * (PATH_NODE_H + PATH_ROW_GAP), col }));
  });
  return pos;
}

/** Pure: search — the nodes whose address, name, AS number or AS name holds the text (null = no search) */
export function matchHops(nodes: Array<GNode | GroupNode>, q: string): Set<string> | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  const hit = (n: GNode) => [n.ip, n.info?.name, n.info?.asn ? `as${n.info.asn}` : null, n.info?.asName].some((x) => x && x.toLowerCase().includes(s));
  return new Set(nodes.filter((n) => hit(n) || ("group" in n && n.group.key.toLowerCase().includes(s))).map((n) => n.id));
}

// ── the health bar and the time series (one point per run) ──

export type RunPoint = {
  id: string;
  at: number;
  /** end-to-end (e2e probes; else the ICMP destination hop) */
  latency: number | null;
  lossPct: number | null;
  jitter: number | null;
  hops: number;
  /** reachable = some end-to-end probe answered (else a traceroute reached the destination) */
  reachable: boolean;
  basis: "e2e" | "icmp";
};

/** Pure: a series' runs, oldest first, as health-bar points */
export function runPoints(runs: NetPathRun[]): RunPoint[] {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).map((r) => {
    if (r.e2e) return { id: r.id, at: Date.parse(r.startedAt), latency: r.e2e.rttAvg, lossPct: r.e2e.lossPct, jitter: r.e2e.jitter, hops: hopCount(r), reachable: r.e2e.received > 0, basis: "e2e" as const };
    const v = pathView(r);
    return { id: r.id, at: Date.parse(r.startedAt), latency: v.end.rttAvg, lossPct: v.end.lossPct, jitter: null, hops: v.end.hops, reachable: v.end.reached, basis: "icmp" as const };
  });
}

/** Pure: a run's hop count — the TTL the destination answered at (the most common over its traceroutes), else its last TTL */
export function hopCount(r: NetPathRun): number {
  const d = (r.passes ?? []).map((p) => p.find((x) => x.dest)?.ttl).filter((x): x is number => x !== undefined);
  if (d.length) {
    const c = new Map<number, number>();
    for (const t of d) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  }
  return r.hops.length;
}

export type PointLevel = "ok" | "warn" | "danger";
/** Pure: a point's state on the health bar — not reachable / loss / fine (facts, no latency threshold) */
export const pointLevel = (p: RunPoint): PointLevel => (!p.reachable ? "danger" : (p.lossPct ?? 0) > 0 ? "warn" : "ok");

/** Pure: the runs of the previous range of the same length (one run picked → the run before it) */
export function previousRange(points: RunPoint[], from: number, to: number): string[] {
  const i0 = points.findIndex((p) => p.at >= from);
  if (i0 <= 0) return [];
  if (from === to) return [points[i0 - 1]!.id];
  const span = to - from;
  return points.filter((p) => p.at < from && p.at >= from - span).map((p) => p.id);
}

/** Pure: distinct routes (answering addresses in order, per traceroute) — a path change shows as more than one */
export function routesOf(runs: NetPathRun[]): number {
  const keys = new Set<string>();
  for (const r of runs) for (const p of passesOf(r).passes) keys.add(p.filter((x) => x.ip).map((x) => x.ip).join(">"));
  return keys.size;
}

// ── comparison (Datadog "Compare": common and unique hops, hop RTT A vs B) ──

export type CompareRow = { ttl: number; ip: string | null; a: GNode | null; b: GNode | null; only: "a" | "b" | null; deltaMs: number | null };

/** Pure: the hops of two graphs side by side by TTL and address (a = the picked range, b = the one before) */
export function compareHops(a: PathGraph, b: PathGraph): CompareRow[] {
  const key = (n: GNode) => (n.kind === "dest" ? DEST_ID : n.kind === "unknown" ? `*${n.ttl}` : `${n.ttl}|${n.ip}`);
  const am = new Map(a.nodes.filter((n) => n.kind !== "source").map((n) => [key(n), n]));
  const bm = new Map(b.nodes.filter((n) => n.kind !== "source").map((n) => [key(n), n]));
  const keys = [...new Set([...am.keys(), ...bm.keys()])];
  return keys.map((k) => {
    const x = am.get(k) ?? null, y = bm.get(k) ?? null;
    const n = (x ?? y)!;
    return { ttl: n.kind === "dest" ? Number.MAX_SAFE_INTEGER : n.ttl, ip: n.ip, a: x, b: y, only: x && !y ? "a" as const : !x && y ? "b" as const : null, deltaMs: x?.rttAvg != null && y?.rttAvg != null ? r1(x.rttAvg - y.rttAvg) : null };
  }).sort((p, q) => p.ttl - q.ttl || ((p.ip ?? "") < (q.ip ?? "") ? -1 : 1)).map((r) => (r.ttl === Number.MAX_SAFE_INTEGER ? { ...r, ttl: (r.a ?? r.b)!.ttl } : r));
}

/** Pure: an edge's label — "<1 ms" for ≤ 0 (not negative latency), "12 ms", or null without both ends measured */
export function edgeLabel(e: Pick<GEdge, "addedMs">): string | null {
  if (e.addedMs === null) return null;
  if (e.addedMs < 1) return "<1 ms";
  return `${e.addedMs < 10 ? e.addedMs.toFixed(1) : Math.round(e.addedMs)} ms`;
}

/** .NET NetworkInterfaceType of the link → a word the page translates */
export function linkKind(type: string | undefined): "wifi" | "ethernet" | "cellular" | "vpn" | "other" | null {
  if (!type) return null;
  if (/wireless|wifi|80211/i.test(type)) return "wifi";
  if (/ethernet|gigabit|fast/i.test(type)) return "ethernet";
  if (/wwan|wman|mobile/i.test(type)) return "cellular";
  if (/ppp|tunnel/i.test(type)) return "vpn";
  return "other";
}
