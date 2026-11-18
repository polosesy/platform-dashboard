// AKS 모니터링 › 서비스 (APM) › 서비스 맵 — pure model + layout in the Pod traffic service map's grammar (lib/k8sNetMap,
// lib/vnetFlowMap): namespaces are boxes, services cards (status strip + glyph, two cells), left → right = the way
// requests go (requestSteps — Tarjan, a cycle shares a step), callers outside the traced services ("user") in a lane on
// the left. Lines: grey = requests, orange dashed = some failed, dotted = messaging (asynchronous), width = rate (log).
//
// Nothing is invented: a line is the trace pipeline's service-graph count over the window (API services/serviceGraph.ts);
// failures are facts (▲), never a judgement — there is no target here (the 서비스 SLO view judges).
//
// Services found on the network only (lib/apmDiscovery.ts, 2026-11-18 2nd pass — 54 full cards and their dotted lines
// buried the traced services): the traced services stay the map; what has no traces is drawn one step quieter —
//   · in a traced namespace: small cards (name + flows · drops) in a dashed "not instrumented" box after its services;
//   · a namespace with no traced service at all (kube-system, monitoring, GitOps …): ONE card per namespace in the
//     lane "namespaces without traces" — pressing it opens the namespace (its workloads as small cards);
//   · a connection to a closed namespace goes to that namespace's card (flows summed — nothing dropped but the
//     connections inside a closed namespace, counted in `hiddenInside`).

import type { ServiceGraphEdge, ServiceGraphResponse } from "@aud/types";
import type { NetDiscovery } from "./apmDiscovery";
import { measure, place, type PackBox, type PackNode } from "./boxPack";
import { NET, NET_GLYPH, requestSteps, type NetStatus } from "./k8sNetMap";

export { NET_GLYPH };

export type ApmCard = {
  id: string;
  /** discovered = seen on the network (Hubble), sends no traces (lib/apmDiscovery.ts) · nsGroup = a closed namespace
   *  that holds discovered workloads only */
  kind: "service" | "entry" | "discovered" | "nsGroup";
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
  /** discovered cards: what Cilium saw in the sample (a namespace card: summed over its workloads) */
  net?: { flows: number; dropped: number; pods: number };
  /** a namespace card: how many discovered workloads it holds */
  members?: number;
};
export type ApmLink = {
  id: string;
  source: string;
  target: string;
  edge: ServiceGraphEdge;
  /** net = a connection seen on the network only (no trace edge) */
  tone: "forward" | "fail" | "async" | "net";
  /** Stroke width 1–4 by requests per second (log) */
  width: number;
  /** net links: flows Cilium saw (never requests); `merged` = connections summed into this one (a closed namespace) */
  net?: { flows: number; dropped: number; port: number; protocol: string; merged: number };
};
/** namespace · laneIn (callers outside the traces) · disc (the "not instrumented" part of a traced namespace) · untraced
 *  (the lane of closed namespaces) · nsOpen (a namespace without traces, opened) */
export type ApmBox = { id: string; kind: "namespace" | "laneIn" | "disc" | "untraced" | "nsOpen"; title: string; x: number; y: number; w: number; h: number; counts: Record<NetStatus, number>; members: number };
export type ApmPlacedCard = ApmCard & { x: number; y: number; w: number; h: number; parent: string };
export type ApmMap = {
  boxes: ApmBox[];
  cards: ApmPlacedCard[];
  links: ApmLink[];
  width: number;
  height: number;
  structure: string;
  totals: { services: number; links: number; failingLinks: number; requests: number; failed: number; discovered: number; netLinks: number; closedNamespaces: number; hiddenInside: number };
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** APM cards are one row taller than the Pod traffic map's: the signal row (lib/apmSignals.ts) */
export const APM_CARD_H = NET.CARD_H + 20;
/** A workload seen on the network only: name + one line (flows · drops) — one step quieter than a traced service */
export const DISC_CARD_H = 46;
const DISC_HEAD = 24;
/** Line width by rate: 1 at ≤ 0.1/s … 4 at ≥ 100/s */
export const widthOf = (rate: number) => Math.round((1 + Math.min(3, Math.max(0, Math.log10(Math.max(0.1, rate)) + 1))) * 10) / 10;
export const toneOfEdge = (e: Pick<ServiceGraphEdge, "failed" | "kind">): ApmLink["tone"] => (e.failed > 0 ? "fail" : e.kind === "messaging" ? "async" : "forward");

/**
 * Pure: the drawable map. `failing` keeps lines with failures (and the cards they touch); `search` keeps services whose
 * name / namespace matches, plus the services they call or are called by.
 */
export function buildApmMap(
  data: Pick<ServiceGraphResponse, "nodes" | "edges" | "windowMinutes">,
  opts: { failing?: boolean; search?: string; open?: ReadonlySet<string> } = {},
  net: NetDiscovery | null = null,
): ApmMap {
  const secs = data.windowMinutes * 60;
  const cards = new Map<string, ApmCard>();
  for (const n of data.nodes) {
    cards.set(n.service, {
      id: n.service, kind: n.entry ? "entry" : "service", name: n.service, namespace: n.namespace ?? n.workload?.namespace ?? "",
      workload: n.workload, inRequests: n.inbound.requests, inFailed: n.inbound.failed, inRate: n.inbound.requests / secs,
      outRequests: n.outbound.requests, status: n.inbound.failed > 0 ? "warn" : "ok", rank: 0,
    });
  }
  // namespaces with a traced service: their discovered workloads stay inside them; the others close into one card
  const tracedNs = new Set([...cards.values()].filter((c) => c.kind === "service").map((c) => c.namespace));
  const groupOf = new Map<string, string>();
  for (const c of net?.cards ?? []) {
    const closed = !tracedNs.has(c.namespace) && !opts.open?.has(c.namespace);
    if (closed) {
      const gid = `nsg:${c.namespace}`;
      groupOf.set(c.id, gid);
      const g = cards.get(gid) ?? cards.set(gid, {
        id: gid, kind: "nsGroup", name: c.namespace, namespace: c.namespace, workload: null, inRequests: 0, inFailed: 0, inRate: 0,
        outRequests: 0, status: "stale", rank: 0, net: { flows: 0, dropped: 0, pods: 0 }, members: 0,
      }).get(gid)!;
      g.net!.flows += c.flows; g.net!.dropped += c.dropped; g.net!.pods += c.pods; g.members! += 1;
      continue;
    }
    cards.set(c.id, {
      id: c.id, kind: "discovered", name: c.workload, namespace: c.namespace, workload: null, inRequests: 0, inFailed: 0, inRate: 0,
      outRequests: 0, status: "stale", rank: 0, net: { flows: c.flows, dropped: c.dropped, pods: c.pods },
    });
  }
  const NONE: Omit<ServiceGraphEdge, "client" | "server"> = { kind: "other", requests: 0, rate: 0, failed: 0, errorRate: null, p95: null, p99: null, lowTraffic: false };
  // network-only connections: an end in a closed namespace → its card; the same pair again = summed (the busiest port kept)
  const end = (id: string) => groupOf.get(id) ?? id;
  const mergedNet = new Map<string, ApmLink>();
  let hiddenInside = 0;
  for (const l of opts.failing ? [] : net?.links ?? []) {
    const s = end(l.source), t = end(l.target);
    if (!cards.has(s) || !cards.has(t)) continue;
    if (s === t) { hiddenInside++; continue; }
    const id = `${s}>${t}`;
    const cur = mergedNet.get(id);
    if (!cur) { mergedNet.set(id, { id, source: s, target: t, edge: { ...NONE, client: s, server: t }, tone: "net", width: 1, net: { flows: l.flows, dropped: l.dropped, port: l.port, protocol: l.protocol, merged: 1 } }); continue; }
    const n = cur.net!;
    if (l.flows > n.flows / n.merged) { n.port = l.port; n.protocol = l.protocol; }
    n.flows += l.flows; n.dropped += l.dropped; n.merged += 1;
  }
  const netLinks = [...mergedNet.values()];
  let links: ApmLink[] = data.edges
    .filter((e) => cards.has(e.client) && cards.has(e.server))
    .filter((e) => !opts.failing || e.failed > 0)
    .map((e): ApmLink => ({ id: `${e.client}>${e.server}`, source: e.client, target: e.server, edge: e, tone: toneOfEdge(e), width: widthOf(e.rate) }))
    .concat(netLinks.filter((l) => !data.edges.some((e) => `${e.client}>${e.server}` === l.id)));

  const q = opts.search?.trim().toLowerCase();
  const hits = new Set(q ? [...cards.values()].filter((c) => c.name.toLowerCase().includes(q) || c.namespace.toLowerCase().includes(q)).map((c) => c.id) : []);
  if (q) links = links.filter((l) => hits.has(l.source) || hits.has(l.target));
  if (q || opts.failing) {
    // what is left: the ends of the lines left, and (search only) the matching services themselves
    const visible = new Set(links.flatMap((l) => [l.source, l.target]));
    if (!opts.failing) for (const id of hits) visible.add(id);
    for (const id of [...cards.keys()]) if (!visible.has(id)) cards.delete(id);
  }
  // A self call (a service consuming its own queue) is a line too, but not a step. Steps come from the traces only — a
  // network-only connection does not move a traced service (the map keeps its shape when discovery is switched on)
  const traceLinks = links.filter((l) => l.tone !== "net" && l.source !== l.target);
  const steps = requestSteps([...cards.values()].filter((c) => c.kind === "service" || c.kind === "entry").map((c) => c.id), traceLinks);
  for (const c of cards.values()) c.rank = steps.get(c.id) ?? 0;
  links.sort((a, b) => cmp(a.id, b.id));

  // ── layout (boxPack): [callers outside the traces] [traced namespaces …] [opened namespaces …] [closed namespaces] ──
  type Shape = { kind: "box"; id: string } | { kind: "card"; id: string } | { kind: "frame" };
  const quiet = (c: ApmCard) => c.kind === "discovered" || c.kind === "nsGroup";
  const leaf = (c: ApmCard): PackNode<Shape> => ({ t: "leaf", shape: { kind: "card", id: c.id }, w: NET.CARD_W, h: quiet(c) ? DISC_CARD_H : APM_CARD_H });
  const column = (cs: ApmCard[], key: string, gap: number = NET.GAP): PackBox<Shape> => ({ t: "box", shape: { kind: "box", id: key }, dir: "col", children: cs.map(leaf), head: 0, pad: 0, gap, framed: false, maxW: 0 });
  /** small cards in columns of up to COL_MAX × 2 (they are half as tall) */
  const quietColumns = (cs: ApmCard[], key: string) => {
    const kids: PackNode<Shape>[] = [];
    for (let i = 0; i < cs.length; i += NET.COL_MAX * 2) kids.push(column(cs.slice(i, i + NET.COL_MAX * 2), `${key}:${i}`, 8));
    return kids;
  };
  const byName = (a: ApmCard, b: ApmCard) => cmp(a.name, b.name);
  const groups = new Map<string, ApmCard[]>();
  for (const c of cards.values()) if (c.kind === "service" || c.kind === "discovered") (groups.get(c.namespace) ?? groups.set(c.namespace, []).get(c.namespace)!).push(c);
  const order = [...groups.entries()].map(([ns, cs]) => ({ ns, cs, traced: cs.some((c) => c.kind === "service"), min: Math.min(...cs.filter((c) => c.kind === "service").map((c) => c.rank)) }))
    // traced namespaces by their first step, then opened namespaces by name; the unnamed namespace last
    .sort((a, b) => Number(b.traced) - Number(a.traced) || Number(a.ns === "") - Number(b.ns === "") || (a.traced ? a.min - b.min : 0) || cmp(a.ns, b.ns));
  const nsBoxes: PackBox<Shape>[] = order.map(({ ns, cs, traced, min }) => {
    const kids: PackNode<Shape>[] = [];
    if (traced) {
      const cols = new Map<number, ApmCard[]>();
      for (const c of cs) if (c.kind === "service") (cols.get(c.rank - min) ?? cols.set(c.rank - min, []).get(c.rank - min)!).push(c);
      for (const [step, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
        list.sort(byName);
        for (let i = 0; i < list.length; i += NET.COL_MAX) kids.push(column(list.slice(i, i + NET.COL_MAX), `col:${ns}:${step}:${i}`));
      }
      const disc = cs.filter((c) => c.kind === "discovered").sort(byName);
      if (disc.length) kids.push({ t: "box", shape: { kind: "box", id: `disc:${ns}` }, dir: "row", children: quietColumns(disc, `dcol:${ns}`), head: DISC_HEAD, pad: 8, gap: 12, framed: true, maxW: 100_000 });
    } else {
      kids.push(...quietColumns(cs.sort(byName), `ocol:${ns}`));
    }
    return { t: "box", shape: { kind: "box", id: `${traced ? "ns" : "nso"}:${ns}` }, dir: "row", children: kids, head: NET.HEAD, pad: NET.PAD, gap: NET.COL_GAP, framed: true, maxW: 100_000, minW: NET.CARD_W + NET.PAD * 2 };
  });
  const closed = [...cards.values()].filter((c) => c.kind === "nsGroup").sort(byName);
  const closedLane: PackBox<Shape> | null = closed.length
    ? { t: "box", shape: { kind: "box", id: "lane:untraced" }, dir: "row", children: quietColumns(closed, "ucol"), head: NET.HEAD, pad: NET.PAD, gap: 12, framed: true, maxW: 100_000 }
    : null;
  const entries = [...cards.values()].filter((c) => c.kind === "entry").sort(byName);
  const inLane: PackBox<Shape> | null = entries.length
    ? { t: "box", shape: { kind: "box", id: "lane:in" }, dir: "col", children: entries.map(leaf), head: NET.HEAD, pad: NET.PAD, gap: NET.GAP, framed: true, maxW: 0 }
    : null;
  const middle: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: [...nsBoxes, ...(closedLane ? [closedLane] : [])], head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: NET.ROW_MAX_W };
  const root: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: [inLane, middle].filter((x): x is PackBox<Shape> => !!x), head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: 100_000 };
  const placed = place(measure(root));

  const boxes: ApmBox[] = [];
  const KIND: Record<string, ApmBox["kind"]> = { ns: "namespace", nso: "nsOpen", disc: "disc" };
  for (const p of placed) {
    if (p.shape.kind !== "box") continue;
    const id = p.shape.id;
    const pre = id.slice(0, id.indexOf(":"));
    const kind: ApmBox["kind"] | undefined = id === "lane:in" ? "laneIn" : id === "lane:untraced" ? "untraced" : KIND[pre];
    if (!kind) continue;
    boxes.push({ id, kind, title: kind === "laneIn" || kind === "untraced" ? "" : id.slice(pre.length + 1), x: p.x, y: p.y, w: p.w, h: p.h, counts: { danger: 0, warn: 0, ok: 0, stale: 0 }, members: 0 });
  }
  // the innermost box holding a point (a "disc" box sits inside its namespace box)
  const boxAt = (x: number, y: number) => boxes.filter((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  const out: ApmPlacedCard[] = [];
  for (const p of placed) {
    if (p.shape.kind !== "card") continue;
    const c = cards.get(p.shape.id)!;
    const b = boxAt(p.x, p.y);
    if (b) { b.counts[c.status]++; b.members++; }
    // the namespace box counts its "not instrumented" part too
    if (b?.kind === "disc") { const nsBox = boxes.find((x) => x.id === `ns:${b.title}`); if (nsBox) nsBox.members++; }
    out.push({ ...c, x: p.x, y: p.y, w: p.w, h: p.h, parent: b?.id ?? "" });
  }
  return {
    boxes, cards: out, links,
    width: Math.max(0, ...placed.map((p) => p.x + p.w)), height: Math.max(0, ...placed.map((p) => p.y + p.h)),
    structure: [...out.map((c) => c.id).sort(), "|", ...links.map((l) => l.id)].join(","),
    totals: {
      services: out.filter((c) => c.kind === "service").length, links: links.filter((l) => l.tone !== "net").length, failingLinks: links.filter((l) => l.edge.failed > 0).length,
      discovered: out.reduce((n, c) => n + (c.kind === "discovered" ? 1 : c.kind === "nsGroup" ? c.members ?? 0 : 0), 0), netLinks: links.filter((l) => l.tone === "net").length,
      closedNamespaces: out.filter((c) => c.kind === "nsGroup").length, hiddenInside,
      requests: links.reduce((n, l) => n + l.edge.requests, 0), failed: links.reduce((n, l) => n + l.edge.failed, 0),
    },
  };
}

/** Pure: the lines touching a card, split by direction — most failures, then most requests first */
export function apmLinksOf(map: ApmMap, cardId: string): { inbound: ApmLink[]; outbound: ApmLink[] } {
  const by = (a: ApmLink, b: ApmLink) => b.edge.failed - a.edge.failed || b.edge.requests - a.edge.requests || cmp(a.id, b.id);
  return { inbound: map.links.filter((l) => l.target === cardId).sort(by), outbound: map.links.filter((l) => l.source === cardId).sort(by) };
}
