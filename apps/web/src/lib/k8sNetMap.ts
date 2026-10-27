// AKS 모니터링 › 네트워크 (Hubble) › 서비스 맵 — pure model + layout, in the live diagram's grammar for Kubernetes.
//
// Why not the old force layout: every poll re-ran a d3-force simulation, and a Hubble sample (exec buffer, Hubble UI
// relay sample) holds a slightly different set of workloads each time — the whole picture jumped every 15–30 s.
// Here the picture is a function of the structure only (deterministic, no physics), and observations accumulate:
//   1. remember()  — every sample is merged into a session memory; what this sample did not see stays, faded
//                    ("not seen in the last sample"), until a TTL — a quiet edge does not blink out and back.
//   2. buildNetMap() — namespaces are boxes (the VNet/subnet boxes of the live diagram), workloads cards inside;
//                    left → right = the way requests go: the Internet (world as a source) on the left, then
//                    namespaces/columns by the longest request path (Tarjan SCC → cycles share a step), the
//                    Internet as a destination and the cluster's own parts (API server, nodes, health) on the right.
// Shared destinations (cluster DNS, the API server, nodes, Cilium health) are "hub" links: almost every workload
// talks to them, so drawing them all hides everything else — like the live diagram's focus-only lines they are drawn
// only for the hovered / selected card, and each card carries their count instead (chips 'DNS', 'API').
// The card status uses the live diagram's glyphs: ■ drops seen · ▲ HTTP 5xx / DNS errors · ● traffic seen, no error ·
// ○ not in the last sample. Nothing is invented: a workload with no flows in the samples is not drawn at all.

import type { HubbleServiceEdge, HubbleServiceMapResponse, HubbleServiceNode } from "@aud/types";
import { measure, place, type PackBox, type PackNode } from "./boxPack";

export const NET = { CARD_W: 208, CARD_H: 66, GAP: 14, COL_GAP: 40, HEAD: 30, PAD: 12, COL_MAX: 6, ROW_MAX_W: 2800, LANE_GAP: 64 } as const;

export type NetStatus = "danger" | "warn" | "ok" | "stale";
export const NET_GLYPH: Record<NetStatus, string> = { danger: "■", warn: "▲", ok: "●", stale: "○" };

// ── 1. session memory ──

export type NetMemory = {
  nodes: Map<string, { node: HubbleServiceNode; lastSeen: number }>;
  edges: Map<string, { edge: HubbleServiceEdge; lastSeen: number }>;
  /** Time of the newest sample merged */
  at: number;
};

export const emptyMemory = (): NetMemory => ({ nodes: new Map(), edges: new Map(), at: 0 });

/** Pure: merge one sample (newest data wins), forget what was not seen for `ttlMs` */
export function remember(mem: NetMemory, map: Pick<HubbleServiceMapResponse, "nodes" | "edges">, now: number, ttlMs: number): NetMemory {
  const nodes = new Map(mem.nodes);
  const edges = new Map(mem.edges);
  for (const n of map.nodes) nodes.set(n.id, { node: n, lastSeen: now });
  for (const e of map.edges) edges.set(e.id, { edge: e, lastSeen: now });
  for (const [k, v] of nodes) if (now - v.lastSeen > ttlMs) nodes.delete(k);
  for (const [k, v] of edges) if (now - v.lastSeen > ttlMs || !nodes.has(v.edge.sourceId) || !nodes.has(v.edge.destinationId)) edges.delete(k);
  return { nodes, edges, at: now };
}

// ── 2. model ──

export type NetCardKind = "workload" | "internetIn" | "internetOut" | "platform";
export type NetCard = {
  id: string;
  /** The service map node behind it (world is split into an in and an out card) */
  nodeId: string;
  kind: NetCardKind;
  namespace: string;
  name: string;
  serviceType: HubbleServiceNode["serviceType"];
  pods: number;
  flows: number;
  drops: number;
  httpRequests: number;
  httpErrors: number;
  latencyMs: number | null;
  dnsQueries: number;
  dnsErrors: number;
  k8sServices: number;
  /** Hub links this card sends (DNS · API server · nodes) — drawn on focus only */
  hubs: { dns: number; api: number; node: number };
  status: NetStatus;
  stale: boolean;
  /** Request-path step (0 = where requests enter) */
  rank: number;
};

export type NetLink = {
  id: string;
  source: string;
  target: string;
  port: number;
  protocol: string;
  flows: number;
  drops: number;
  httpErrorRate: number;
  verdict: HubbleServiceEdge["verdict"];
  tone: "forward" | "drop" | "l7err";
  /** Stroke width 1–4 by flow count (log) */
  width: number;
  stale: boolean;
  /** To a shared destination (cluster DNS, API server, nodes) — focus only */
  hub: "dns" | "api" | "node" | null;
  l7?: HubbleServiceEdge["l7Summary"];
};

export type NetBox = { id: string; kind: "namespace" | "laneIn" | "laneOut"; title: string; x: number; y: number; w: number; h: number; counts: Record<NetStatus, number>; system: boolean };
export type NetPlacedCard = NetCard & { x: number; y: number; w: number; h: number; parent: string };

export type NetMap = {
  boxes: NetBox[];
  cards: NetPlacedCard[];
  links: NetLink[];
  width: number;
  height: number;
  /** Changes only when cards or links appear / disappear — the layout key (metrics updates keep positions) */
  structure: string;
  totals: { workloads: number; namespaces: number; links: number; dropLinks: number; stale: number };
};

const PLATFORM = new Set(["host", "remote-node", "kube-apiserver", "health", "init", "unmanaged"]);
const DNS_NAMES = new Set(["coredns", "kube-dns", "coredns-autoscaler"]);

/** Pure: is this destination a shared hub every workload talks to? (cluster DNS · API server · nodes / health) */
export function hubOf(n: Pick<HubbleServiceNode, "serviceType" | "namespace" | "workloadName"> | undefined): NetLink["hub"] {
  if (!n) return null;
  if (n.serviceType === "dns" || (n.namespace === "kube-system" && DNS_NAMES.has(n.workloadName))) return "dns";
  if (n.serviceType === "kube-apiserver") return "api";
  if (n.serviceType === "host" || n.serviceType === "remote-node" || n.serviceType === "health") return "node";
  return null;
}
const isSystemNs = (ns: string) => ns.startsWith("kube-") || ns.endsWith("-system");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function statusOf(n: HubbleServiceNode, stale: boolean): NetStatus {
  if (stale) return "stale";
  if (n.metrics.droppedFlows > 0) return "danger";
  if (n.metrics.httpErrorCount > 0 || n.metrics.dnsErrorCount > 0) return "warn";
  return "ok";
}

/** Pure: longest request path step per node — Tarjan SCC so a cycle shares one step (never an endless climb) */
export function requestSteps(ids: string[], links: Array<{ source: string; target: string }>): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const l of links) if (l.source !== l.target && out.has(l.source) && out.has(l.target)) out.get(l.source)!.push(l.target);
  for (const v of out.values()) v.sort(cmp);
  // Tarjan (iterative)
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [];
  const comp = new Map<string, number>();
  let comps = 0;
  for (const root of [...ids].sort(cmp)) {
    if (idx.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    idx.set(root, index); low.set(root, index); index++; stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      const next = out.get(top.v)![top.i++];
      if (next !== undefined) {
        if (!idx.has(next)) {
          idx.set(next, index); low.set(next, index); index++; stack.push(next); onStack.add(next);
          work.push({ v: next, i: 0 });
        } else if (onStack.has(next)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(next)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1]!.v; low.set(p, Math.min(low.get(p)!, low.get(top.v)!)); }
      if (low.get(top.v) === idx.get(top.v)) {
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.set(w, comps); } while (w !== top.v);
        comps++;
      }
    }
  }
  // Tarjan numbers components in reverse topological order → walk from the highest number down
  const cOut = new Map<number, Set<number>>();
  for (const [s, ts] of out) for (const t of ts) { const a = comp.get(s)!, b = comp.get(t)!; if (a !== b) (cOut.get(a) ?? cOut.set(a, new Set()).get(a)!).add(b); }
  const step = new Map<number, number>();
  for (let c = comps - 1; c >= 0; c--) step.set(c, step.get(c) ?? 0);
  for (let c = comps - 1; c >= 0; c--) for (const d of cOut.get(c) ?? []) step.set(d, Math.max(step.get(d) ?? 0, step.get(c)! + 1));
  return new Map(ids.map((id) => [id, step.get(comp.get(id)!) ?? 0]));
}

type Shape = { kind: "box"; id: string } | { kind: "card"; id: string } | { kind: "frame" };

/**
 * Pure: the drawable map. `filter` keeps cards whose name/namespace matches (and the links between kept cards);
 * `verdict` keeps links of that verdict and the cards they touch.
 */
export function buildNetMap(mem: NetMemory, opts: { search?: string; verdict?: string; namespace?: string } = {}): NetMap {
  const latest = mem.at;
  const nodesAll = [...mem.nodes.values()];
  const linksAll = [...mem.edges.values()];
  // world → split into the Internet in (as a source) and out (as a destination)
  const cardIdOf = (nodeId: string, side: "src" | "dst") => {
    const n = mem.nodes.get(nodeId)?.node;
    return n?.serviceType === "world" ? `${nodeId}#${side === "src" ? "in" : "out"}` : nodeId;
  };
  let links: NetLink[] = linksAll.map(({ edge: e, lastSeen }) => {
    const tone: NetLink["tone"] = e.verdict === "DROPPED" || e.metrics.droppedCount > 0 ? "drop" : e.metrics.httpErrorRate > 0 ? "l7err" : "forward";
    return {
      id: e.id, source: cardIdOf(e.sourceId, "src"), target: cardIdOf(e.destinationId, "dst"), port: e.port, protocol: e.protocol,
      flows: e.metrics.flowCount, drops: e.metrics.droppedCount, httpErrorRate: e.metrics.httpErrorRate, verdict: e.verdict, tone,
      width: Math.round((1 + Math.min(3, Math.log10(Math.max(1, e.metrics.flowCount)))) * 10) / 10,
      stale: lastSeen < latest, hub: hubOf(mem.nodes.get(e.destinationId)?.node), ...(e.l7Summary ? { l7: e.l7Summary } : {}),
    };
  });
  if (opts.verdict) links = links.filter((l) => l.verdict === opts.verdict);

  const cards = new Map<string, NetCard>();
  for (const { node: n, lastSeen } of nodesAll) {
    const stale = lastSeen < latest;
    const base = {
      nodeId: n.id, namespace: n.namespace, name: n.workloadName || n.serviceType, serviceType: n.serviceType, pods: n.podCount,
      flows: n.metrics.totalFlows, drops: n.metrics.droppedFlows, httpRequests: n.metrics.httpRequestsTotal, httpErrors: n.metrics.httpErrorCount,
      latencyMs: n.metrics.avgLatencyMs, dnsQueries: n.metrics.dnsQueryCount, dnsErrors: n.metrics.dnsErrorCount, k8sServices: n.k8sServices?.length ?? 0,
      hubs: { dns: 0, api: 0, node: 0 }, status: statusOf(n, stale), stale, rank: 0,
    };
    if (n.serviceType === "world") {
      if (links.some((l) => l.source === `${n.id}#in`)) cards.set(`${n.id}#in`, { ...base, id: `${n.id}#in`, kind: "internetIn" });
      if (links.some((l) => l.target === `${n.id}#out`)) cards.set(`${n.id}#out`, { ...base, id: `${n.id}#out`, kind: "internetOut" });
    } else cards.set(n.id, { ...base, id: n.id, kind: PLATFORM.has(n.serviceType) || !n.namespace ? "platform" : "workload" });
  }

  // Filters: verdict keeps touched cards; search / namespace keep matching cards (+ the Internet / platform they talk to)
  const touched = new Set(links.flatMap((l) => [l.source, l.target]));
  if (opts.verdict) for (const id of [...cards.keys()]) if (!touched.has(id)) cards.delete(id);
  const q = opts.search?.trim().toLowerCase();
  if (q || opts.namespace) {
    const keep = new Set([...cards.values()].filter((c) => c.kind === "workload"
      && (!opts.namespace || c.namespace === opts.namespace)
      && (!q || c.name.toLowerCase().includes(q) || c.namespace.toLowerCase().includes(q))).map((c) => c.id));
    for (const l of links) {
      if (keep.has(l.source) && cards.get(l.target)?.kind !== "workload") keep.add(l.target);
      if (keep.has(l.target) && cards.get(l.source)?.kind !== "workload") keep.add(l.source);
    }
    for (const id of [...cards.keys()]) if (!keep.has(id)) cards.delete(id);
  }
  links = links.filter((l) => cards.has(l.source) && cards.has(l.target)).sort((a, b) => cmp(a.id, b.id));
  // A card with no link left (filtered) is still drawn only if it is a workload that was seen
  for (const [id, c] of cards) if (c.kind !== "workload" && !links.some((l) => l.source === id || l.target === id)) cards.delete(id);

  for (const l of links) if (l.hub) { const c = cards.get(l.source); if (c) c.hubs[l.hub]++; }

  // Steps: requests only between cards in the request path (the cluster's own parts sit on the right, unranked)
  const pathIds = [...cards.values()].filter((c) => c.kind !== "platform").map((c) => c.id);
  // A dropped link is still an attempted request — it orders the path like any other
  const steps = requestSteps(pathIds, links.filter((l) => !l.hub));
  for (const c of cards.values()) c.rank = steps.get(c.id) ?? 0;

  // ── layout (boxPack): [Internet in] [namespaces …] [Internet out · cluster parts] ──
  const leaf = (c: NetCard): PackNode<Shape> => ({ t: "leaf", shape: { kind: "card", id: c.id }, w: NET.CARD_W, h: NET.CARD_H });
  const column = (cs: NetCard[], key: string): PackBox<Shape> => ({ t: "box", shape: { kind: "box", id: key }, dir: "col", children: cs.map(leaf), head: 0, pad: 0, gap: NET.GAP, framed: false, maxW: 0 });
  const byName = (a: NetCard, b: NetCard) => cmp(a.name, b.name) || cmp(a.id, b.id);

  const nsGroups = new Map<string, NetCard[]>();
  for (const c of cards.values()) if (c.kind === "workload") (nsGroups.get(c.namespace) ?? nsGroups.set(c.namespace, []).get(c.namespace)!).push(c);
  const nsOrder = [...nsGroups.entries()].map(([ns, cs]) => ({ ns, cs, min: Math.min(...cs.map((c) => c.rank)) }))
    .sort((a, b) => Number(isSystemNs(a.ns)) - Number(isSystemNs(b.ns)) || a.min - b.min || cmp(a.ns, b.ns));

  const nsBoxes: PackBox<Shape>[] = nsOrder.map(({ ns, cs, min }) => {
    const cols = new Map<number, NetCard[]>();
    for (const c of cs) (cols.get(c.rank - min) ?? cols.set(c.rank - min, []).get(c.rank - min)!).push(c);
    const kids: PackNode<Shape>[] = [];
    for (const [step, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort(byName);
      for (let i = 0; i < list.length; i += NET.COL_MAX) kids.push(column(list.slice(i, i + NET.COL_MAX), `col:${ns}:${step}:${i}`));
    }
    return { t: "box", shape: { kind: "box", id: `ns:${ns}` }, dir: "row", children: kids, head: NET.HEAD, pad: NET.PAD, gap: NET.COL_GAP, framed: true, maxW: 100_000, minW: NET.CARD_W + NET.PAD * 2 };
  });
  const lane = (id: string, cs: NetCard[]): PackBox<Shape> | null => (cs.length
    ? { t: "box", shape: { kind: "box", id }, dir: "col", children: cs.sort(byName).map(leaf), head: NET.HEAD, pad: NET.PAD, gap: NET.GAP, framed: true, maxW: 0 }
    : null);
  const inLane = lane("lane:in", [...cards.values()].filter((c) => c.kind === "internetIn"));
  const outLane = lane("lane:out", [...cards.values()].filter((c) => c.kind === "internetOut" || c.kind === "platform"));
  const middle: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: nsBoxes, head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: NET.ROW_MAX_W };
  const root: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: [inLane, middle, outLane].filter((x): x is PackBox<Shape> => !!x), head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: 100_000 };
  const placed = place(measure(root));

  const boxes: NetBox[] = [];
  const out: NetPlacedCard[] = [];
  const parentBox = new Map<string, string>();
  for (const p of placed) {
    if (p.shape.kind === "box" && (p.shape.id.startsWith("ns:") || p.shape.id.startsWith("lane:"))) {
      const id = p.shape.id;
      const ns = id.startsWith("ns:") ? id.slice(3) : "";
      boxes.push({ id, kind: id === "lane:in" ? "laneIn" : id === "lane:out" ? "laneOut" : "namespace", title: ns, x: p.x, y: p.y, w: p.w, h: p.h, counts: { danger: 0, warn: 0, ok: 0, stale: 0 }, system: !!ns && isSystemNs(ns) });
    }
  }
  const boxAt = (x: number, y: number) => boxes.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  for (const p of placed) {
    if (p.shape.kind !== "card") continue;
    const c = cards.get(p.shape.id)!;
    const b = boxAt(p.x, p.y);
    if (b) { b.counts[c.status]++; parentBox.set(c.id, b.id); }
    out.push({ ...c, x: p.x, y: p.y, w: p.w, h: p.h, parent: b?.id ?? "" });
  }
  const width = Math.max(0, ...placed.map((p) => p.x + p.w));
  const height = Math.max(0, ...placed.map((p) => p.y + p.h));
  const structure = [...out.map((c) => c.id).sort(), "|", ...links.map((l) => l.id)].join(",");
  return {
    boxes, cards: out, links, width, height, structure,
    totals: {
      workloads: out.filter((c) => c.kind === "workload").length, namespaces: nsGroups.size, links: links.length,
      dropLinks: links.filter((l) => l.tone === "drop").length, stale: out.filter((c) => c.stale).length,
    },
  };
}

/** Pure: the links touching a card, split by direction (the detail panel) */
export function linksOf(map: NetMap, cardId: string): { inbound: NetLink[]; outbound: NetLink[] } {
  const by = (a: NetLink, b: NetLink) => Number(b.tone === "drop") - Number(a.tone === "drop") || b.flows - a.flows || cmp(a.id, b.id);
  return {
    inbound: map.links.filter((l) => l.target === cardId).sort(by),
    outbound: map.links.filter((l) => l.source === cardId).sort(by),
  };
}

/** Pure: the short name inside its namespace box — the namespace prefix ("app-" in namespace "app") is dropped */
export function shortWorkload(name: string, ns: string): string {
  return ns && name.startsWith(`${ns}-`) && name.length > ns.length + 1 ? name.slice(ns.length + 1) : name;
}
