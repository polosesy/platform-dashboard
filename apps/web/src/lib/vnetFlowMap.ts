// VNet 트래픽 › 트래픽 맵 — pure model + layout in the same grammar as the Pod traffic service map (lib/k8sNetMap.ts):
// VNets are boxes, subnets cards inside (status strip + ● ■ glyph, two cells), left → right = the way traffic goes:
// address classes as a source on the left (Internet · on-premises · Azure services · other private · unclassified),
// VNets by the longest path (requestSteps — Tarjan, a cycle shares a step), the same classes as a destination on the
// right. Lines: grey = allowed only, red dashed = denied flows (NSG / admin rule) or Traffic Analytics' MaliciousFlow,
// width = bytes (log). Traffic inside one subnet is a card value ("서브넷 안"), not a loop line.
//
// Nothing is invented: a line is a Traffic Analytics aggregate over the chosen range; the end of a flow it names no
// subnet for is its FlowType class (NetExternal), never a guessed resource; flows with no subnet on either end are
// counted (unplaced) and not drawn.

import type { NetExternal, NetMapData, NetMapEdge } from "@aud/types";
import { measure, place, type PackBox, type PackNode } from "./boxPack";
import { NET, NET_GLYPH, requestSteps, type NetStatus } from "./k8sNetMap";

export { NET_GLYPH };
export const EXTERNAL_ORDER: readonly NetExternal[] = ["internet", "onprem", "azure", "private", "unknown"];

export type VCardKind = "subnet" | "externalIn" | "externalOut";
export type VCard = {
  id: string;
  kind: VCardKind;
  /** Subnet: "rg/vnet/subnet" · external: the class */
  key: string;
  name: string;
  /** Subnet: "rg/vnet" (the box) · external: "" */
  vnet: string;
  external: NetExternal | null;
  bytesIn: number;
  bytesOut: number;
  /** Bytes between addresses of this one subnet (a self line in the data) */
  bytesWithin: number;
  allowedFlows: number;
  deniedFlows: number;
  maliciousRecords: number;
  status: NetStatus;
  rank: number;
};
export type VLink = {
  id: string;
  source: string;
  target: string;
  edge: NetMapEdge;
  tone: "forward" | "drop";
  /** Stroke width 1–4 by bytes (log of MB) */
  width: number;
};
export type VBox = { id: string; kind: "vnet" | "laneIn" | "laneOut"; title: string; sub: string; x: number; y: number; w: number; h: number; counts: Record<NetStatus, number> };
export type VPlacedCard = VCard & { x: number; y: number; w: number; h: number; parent: string };
export type VMap = {
  boxes: VBox[];
  cards: VPlacedCard[];
  links: VLink[];
  width: number;
  height: number;
  /** Changes only when cards or lines appear / disappear (the fit key) */
  structure: string;
  totals: { subnets: number; vnets: number; links: number; deniedLinks: number; maliciousLinks: number };
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isExternal = (end: string) => end.startsWith("@");
const classOf = (end: string) => end.slice(1) as NetExternal;
export const cardIdOf = (end: string, side: "src" | "dst") => (isExternal(end) ? `${end}#${side === "src" ? "in" : "out"}` : end);
/** "rg/vnet/subnet" → parts; the box key is "rg/vnet" */
export function splitSubnet(key: string): { rg: string; vnet: string; subnet: string } {
  const [rg = "", vnet = "", subnet = ""] = key.split("/");
  return { rg, vnet, subnet };
}

/**
 * Pure: the drawable map. `denied` keeps lines with denied or malicious flows (and the cards they touch); `search`
 * keeps subnets whose name / VNet matches (+ the address classes they talk to).
 */
export function buildVnetMap(data: NetMapData, opts: { denied?: boolean; search?: string } = {}): VMap {
  const cards = new Map<string, VCard>();
  const card = (end: string, side: "src" | "dst"): VCard => {
    const id = cardIdOf(end, side);
    let c = cards.get(id);
    if (!c) {
      const ext = isExternal(end) ? classOf(end) : null;
      const p = splitSubnet(end);
      c = {
        id, kind: ext ? (side === "src" ? "externalIn" : "externalOut") : "subnet", key: ext ?? end, name: ext ?? p.subnet,
        vnet: ext ? "" : `${p.rg}/${p.vnet}`, external: ext, bytesIn: 0, bytesOut: 0, bytesWithin: 0, allowedFlows: 0, deniedFlows: 0,
        maliciousRecords: 0, status: "ok", rank: 0,
      };
      cards.set(id, c);
    }
    return c;
  };

  let links: VLink[] = [];
  for (const e of data.edges) {
    const bad = e.deniedFlows > 0 || e.maliciousRecords > 0;
    if (opts.denied && !bad) continue;
    if (e.src === e.dst) {
      // Inside one subnet: a card value, not a line
      const c = card(e.src, "src");
      c.bytesWithin += e.bytes; c.allowedFlows += e.allowedFlows; c.deniedFlows += e.deniedFlows; c.maliciousRecords += e.maliciousRecords;
      continue;
    }
    const s = card(e.src, "src"), d = card(e.dst, "dst");
    s.bytesOut += e.bytes; d.bytesIn += e.bytes;
    for (const c of [s, d]) { c.allowedFlows += e.allowedFlows; c.deniedFlows += e.deniedFlows; c.maliciousRecords += e.maliciousRecords; }
    links.push({
      id: `${e.src}>${e.dst}`, source: s.id, target: d.id, edge: e, tone: bad ? "drop" : "forward",
      width: Math.round((1 + Math.min(3, Math.log10(Math.max(1, e.bytes / 1e6)))) * 10) / 10,
    });
  }
  for (const c of cards.values()) c.status = c.deniedFlows > 0 || c.maliciousRecords > 0 ? "danger" : "ok";

  const q = opts.search?.trim().toLowerCase();
  if (q) {
    const keep = new Set([...cards.values()].filter((c) => c.kind === "subnet" && (c.name.toLowerCase().includes(q) || c.vnet.toLowerCase().includes(q))).map((c) => c.id));
    for (const l of links) {
      if (keep.has(l.source) && cards.get(l.target)?.kind !== "subnet") keep.add(l.target);
      if (keep.has(l.target) && cards.get(l.source)?.kind !== "subnet") keep.add(l.source);
    }
    for (const id of [...cards.keys()]) if (!keep.has(id)) cards.delete(id);
  }
  links = links.filter((l) => cards.has(l.source) && cards.has(l.target)).sort((a, b) => cmp(a.id, b.id));
  // An address class with no line left is not drawn (a subnet stays: its own traffic is a value)
  for (const [id, c] of cards) if (c.kind !== "subnet" && !links.some((l) => l.source === id || l.target === id)) cards.delete(id);

  // Steps: sources on the left; the classes as destinations sit in the right lane, unranked
  const pathIds = [...cards.values()].filter((c) => c.kind !== "externalOut").map((c) => c.id);
  const steps = requestSteps(pathIds, links);
  for (const c of cards.values()) c.rank = steps.get(c.id) ?? 0;

  // ── layout (boxPack): [classes in] [VNets …] [classes out] ──
  type Shape = { kind: "box"; id: string } | { kind: "card"; id: string } | { kind: "frame" };
  const leaf = (c: VCard): PackNode<Shape> => ({ t: "leaf", shape: { kind: "card", id: c.id }, w: NET.CARD_W, h: NET.CARD_H });
  const column = (cs: VCard[], key: string): PackBox<Shape> => ({ t: "box", shape: { kind: "box", id: key }, dir: "col", children: cs.map(leaf), head: 0, pad: 0, gap: NET.GAP, framed: false, maxW: 0 });
  const byName = (a: VCard, b: VCard) => cmp(a.name, b.name) || cmp(a.id, b.id);
  const byClass = (a: VCard, b: VCard) => EXTERNAL_ORDER.indexOf(a.external!) - EXTERNAL_ORDER.indexOf(b.external!);

  const groups = new Map<string, VCard[]>();
  for (const c of cards.values()) if (c.kind === "subnet") (groups.get(c.vnet) ?? groups.set(c.vnet, []).get(c.vnet)!).push(c);
  const order = [...groups.entries()].map(([vnet, cs]) => ({ vnet, cs, min: Math.min(...cs.map((c) => c.rank)) }))
    .sort((a, b) => a.min - b.min || cmp(a.vnet, b.vnet));
  const vnetBoxes: PackBox<Shape>[] = order.map(({ vnet, cs, min }) => {
    const cols = new Map<number, VCard[]>();
    for (const c of cs) (cols.get(c.rank - min) ?? cols.set(c.rank - min, []).get(c.rank - min)!).push(c);
    const kids: PackNode<Shape>[] = [];
    for (const [step, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort(byName);
      for (let i = 0; i < list.length; i += NET.COL_MAX) kids.push(column(list.slice(i, i + NET.COL_MAX), `col:${vnet}:${step}:${i}`));
    }
    return { t: "box", shape: { kind: "box", id: `vnet:${vnet}` }, dir: "row", children: kids, head: NET.HEAD, pad: NET.PAD, gap: NET.COL_GAP, framed: true, maxW: 100_000, minW: NET.CARD_W + NET.PAD * 2 };
  });
  const lane = (id: string, cs: VCard[]): PackBox<Shape> | null => (cs.length
    ? { t: "box", shape: { kind: "box", id }, dir: "col", children: cs.sort(byClass).map(leaf), head: NET.HEAD, pad: NET.PAD, gap: NET.GAP, framed: true, maxW: 0 }
    : null);
  const inLane = lane("lane:in", [...cards.values()].filter((c) => c.kind === "externalIn"));
  const outLane = lane("lane:out", [...cards.values()].filter((c) => c.kind === "externalOut"));
  const middle: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: vnetBoxes, head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: NET.ROW_MAX_W };
  const root: PackBox<Shape> = { t: "box", shape: { kind: "frame" }, dir: "row", children: [inLane, middle, outLane].filter((x): x is PackBox<Shape> => !!x), head: 0, pad: 0, gap: NET.LANE_GAP, framed: false, maxW: 100_000 };
  const placed = place(measure(root));

  const boxes: VBox[] = [];
  for (const p of placed) {
    if (p.shape.kind !== "box") continue;
    const id = p.shape.id;
    if (!id.startsWith("vnet:") && !id.startsWith("lane:")) continue;
    const key = id.startsWith("vnet:") ? id.slice(5) : "";
    const [rg = "", vnet = ""] = key.split("/");
    boxes.push({ id, kind: id === "lane:in" ? "laneIn" : id === "lane:out" ? "laneOut" : "vnet", title: vnet, sub: rg, x: p.x, y: p.y, w: p.w, h: p.h, counts: { danger: 0, warn: 0, ok: 0, stale: 0 } });
  }
  const boxAt = (x: number, y: number) => boxes.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  const out: VPlacedCard[] = [];
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
      subnets: out.filter((c) => c.kind === "subnet").length, vnets: groups.size, links: links.length,
      deniedLinks: links.filter((l) => l.edge.deniedFlows > 0).length, maliciousLinks: links.filter((l) => l.edge.maliciousRecords > 0).length,
    },
  };
}

/** Pure: the lines touching a card, split by direction (the detail panel) — most bytes first */
export function vLinksOf(map: VMap, cardId: string): { inbound: VLink[]; outbound: VLink[] } {
  const by = (a: VLink, b: VLink) => b.edge.bytes - a.edge.bytes || cmp(a.id, b.id);
  return {
    inbound: map.links.filter((l) => l.target === cardId).sort(by),
    outbound: map.links.filter((l) => l.source === cardId).sort(by),
  };
}

/** Bytes for people: B · KB · MB · GB · TB (1024) */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
