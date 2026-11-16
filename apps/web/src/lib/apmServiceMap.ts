// AKS 모니터링 › 서비스 (APM) › 서비스 맵 — pure model + layout in the Pod traffic service map's grammar (lib/k8sNetMap,
// lib/vnetFlowMap): namespaces are boxes, services cards (status strip + glyph, two cells), left → right = the way
// requests go (requestSteps — Tarjan, a cycle shares a step), callers outside the traced services ("user") in a lane on
// the left. Lines: grey = requests, orange dashed = some failed, dotted = messaging (asynchronous), width = rate (log).
//
// Nothing is invented: a line is the trace pipeline's service-graph count over the window (API services/serviceGraph.ts);
// failures are facts (▲), never a judgement — there is no target here (the 서비스 SLO view judges).

import type { ServiceGraphEdge, ServiceGraphResponse } from "@aud/types";
import { measure, place, type PackBox, type PackNode } from "./boxPack";
import { NET, NET_GLYPH, requestSteps, type NetStatus } from "./k8sNetMap";

export { NET_GLYPH };

export type ApmCard = {
  id: string;
  kind: "service" | "entry";
  name: string;
  /** the box: the namespace, "" when the pipeline gave none */
  namespace: string;
  workload: ServiceGraphResponse["nodes"][number]["workload"];
  /** requests in / failed in (the window), requests out */
  inRequests: number;
  inFailed: number;
  inRate: number;
  outRequests: number;
  status: NetStatus;
  rank: number;
};
export type ApmLink = {
  id: string;
  source: string;
  target: string;
  edge: ServiceGraphEdge;
  tone: "forward" | "fail" | "async";
  /** Stroke width 1–4 by requests per second (log) */
  width: number;
};
export type ApmBox = { id: string; kind: "namespace" | "laneIn"; title: string; x: number; y: number; w: number; h: number; counts: Record<NetStatus, number> };
export type ApmPlacedCard = ApmCard & { x: number; y: number; w: number; h: number; parent: string };
export type ApmMap = {
  boxes: ApmBox[];
  cards: ApmPlacedCard[];
  links: ApmLink[];
  width: number;
  height: number;
  structure: string;
  totals: { services: number; links: number; failingLinks: number; requests: number; failed: number };
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Line width by rate: 1 at ≤ 0.1/s … 4 at ≥ 100/s */
export const widthOf = (rate: number) => Math.round((1 + Math.min(3, Math.max(0, Math.log10(Math.max(0.1, rate)) + 1))) * 10) / 10;
export const toneOfEdge = (e: Pick<ServiceGraphEdge, "failed" | "kind">): ApmLink["tone"] => (e.failed > 0 ? "fail" : e.kind === "messaging" ? "async" : "forward");

/**
 * Pure: the drawable map. `failing` keeps lines with failures (and the cards they touch); `search` keeps services whose
 * name / namespace matches, plus the services they call or are called by.
 */
export function buildApmMap(data: Pick<ServiceGraphResponse, "nodes" | "edges" | "windowMinutes">, opts: { failing?: boolean; search?: string } = {}): ApmMap {
  const secs = data.windowMinutes * 60;
  const cards = new Map<string, ApmCard>();
  for (const n of data.nodes) {
    cards.set(n.service, {
      id: n.service, kind: n.entry ? "entry" : "service", name: n.service, namespace: n.namespace ?? n.workload?.namespace ?? "",
      workload: n.workload, inRequests: n.inbound.requests, inFailed: n.inbound.failed, inRate: n.inbound.requests / secs,
      outRequests: n.outbound.requests, status: n.inbound.failed > 0 ? "warn" : "ok", rank: 0,
    });
  }
  let links: ApmLink[] = data.edges
    .filter((e) => cards.has(e.client) && cards.has(e.server))
    .filter((e) => !opts.failing || e.failed > 0)
    .map((e) => ({ id: `${e.client}>${e.server}`, source: e.client, target: e.server, edge: e, tone: toneOfEdge(e), width: widthOf(e.rate) }));

  const q = opts.search?.trim().toLowerCase();
  const hits = new Set(q ? [...cards.values()].filter((c) => c.name.toLowerCase().includes(q) || c.namespace.toLowerCase().includes(q)).map((c) => c.id) : []);
  if (q) links = links.filter((l) => hits.has(l.source) || hits.has(l.target));
  if (q || opts.failing) {
    // what is left: the ends of the lines left, and (search only) the matching services themselves
    const visible = new Set(links.flatMap((l) => [l.source, l.target]));
    if (!opts.failing) for (const id of hits) visible.add(id);
    for (const id of [...cards.keys()]) if (!visible.has(id)) cards.delete(id);
  }
  // A self call (a service consuming its own queue) is a line too, but not a step
  const steps = requestSteps([...cards.keys()], links.filter((l) => l.source !== l.target));
  for (const c of cards.values()) c.rank = steps.get(c.id) ?? 0;
  links.sort((a, b) => cmp(a.id, b.id));

  // ── layout (boxPack): [callers outside the traces] [namespaces …] ──
  type Shape = { kind: "box"; id: string } | { kind: "card"; id: string } | { kind: "frame" };
  const leaf = (c: ApmCard): PackNode<Shape> => ({ t: "leaf", shape: { kind: "card", id: c.id }, w: NET.CARD_W, h: NET.CARD_H });
  const column = (cs: ApmCard[], key: string): PackBox<Shape> => ({ t: "box", shape: { kind: "box", id: key }, dir: "col", children: cs.map(leaf), head: 0, pad: 0, gap: NET.GAP, framed: false, maxW: 0 });
  const byName = (a: ApmCard, b: ApmCard) => cmp(a.name, b.name);
  const groups = new Map<string, ApmCard[]>();
  for (const c of cards.values()) if (c.kind === "service") (groups.get(c.namespace) ?? groups.set(c.namespace, []).get(c.namespace)!).push(c);
  const order = [...groups.entries()].map(([ns, cs]) => ({ ns, cs, min: Math.min(...cs.map((c) => c.rank)) }))
    // the unnamed namespace last
    .sort((a, b) => Number(a.ns === "") - Number(b.ns === "") || a.min - b.min || cmp(a.ns, b.ns));
  const nsBoxes: PackBox<Shape>[] = order.map(({ ns, cs, min }) => {
    const cols = new Map<number, ApmCard[]>();
    for (const c of cs) (cols.get(c.rank - min) ?? cols.set(c.rank - min, []).get(c.rank - min)!).push(c);
    const kids: PackNode<Shape>[] = [];
    for (const [step, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort(byName);
      for (let i = 0; i < list.length; i += NET.COL_MAX) kids.push(column(list.slice(i, i + NET.COL_MAX), `col:${ns}:${step}:${i}`));
    }
    return { t: "box", shape: { kind: "box", id: `ns:${ns}` }, dir: "row", children: kids, head: NET.HEAD, pad: NET.PAD, gap: NET.COL_GAP, framed: true, maxW: 100_000, minW: NET.CARD_W + NET.PAD * 2 };
  });
  const entries = [...cards.values()].filter((c) => c.kind === "entry").sort(byName);
  const inLane: PackBox<Shape> | null = entries.length
    ? { t: "box", shape: { kind: "box", id: "lane:in" }, dir: "col", children: entries.map(leaf), head: NET.HEAD, pad: NET.PAD, gap: NET.GAP, framed: true, maxW: 0 }
    : null;
  const middle: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: nsBoxes, head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: NET.ROW_MAX_W };
  const root: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: [inLane, middle].filter((x): x is PackBox<Shape> => !!x), head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: 100_000 };
  const placed = place(measure(root));

  const boxes: ApmBox[] = [];
  for (const p of placed) {
    if (p.shape.kind !== "box") continue;
    const id = p.shape.id;
    if (!id.startsWith("ns:") && id !== "lane:in") continue;
    boxes.push({ id, kind: id === "lane:in" ? "laneIn" : "namespace", title: id === "lane:in" ? "" : id.slice(3), x: p.x, y: p.y, w: p.w, h: p.h, counts: { danger: 0, warn: 0, ok: 0, stale: 0 } });
  }
  const boxAt = (x: number, y: number) => boxes.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  const out: ApmPlacedCard[] = [];
  for (const p of placed) {
    if (p.shape.kind !== "card") continue;
    const c = cards.get(p.shape.id)!;
    const b = boxAt(p.x, p.y);
    if (b) b.counts[c.status]++;
    out.push({ ...c, x: p.x, y: p.y, w: p.w, h: p.h, parent: b?.id ?? "" });
  }
  return {
    boxes, cards: out, links,
    width: Math.max(0, ...placed.map((p) => p.x + p.w)), height: Math.max(0, ...placed.map((p) => p.y + p.h)),
    structure: [...out.map((c) => c.id).sort(), "|", ...links.map((l) => l.id)].join(","),
    totals: {
      services: out.filter((c) => c.kind === "service").length, links: links.length, failingLinks: links.filter((l) => l.edge.failed > 0).length,
      requests: links.reduce((n, l) => n + l.edge.requests, 0), failed: links.reduce((n, l) => n + l.edge.failed, 0),
    },
  };
}

/** Pure: the lines touching a card, split by direction — most failures, then most requests first */
export function apmLinksOf(map: ApmMap, cardId: string): { inbound: ApmLink[]; outbound: ApmLink[] } {
  const by = (a: ApmLink, b: ApmLink) => b.edge.failed - a.edge.failed || b.edge.requests - a.edge.requests || cmp(a.id, b.id);
  return { inbound: map.links.filter((l) => l.target === cardId).sort(by), outbound: map.links.filter((l) => l.source === cardId).sort(by) };
}
