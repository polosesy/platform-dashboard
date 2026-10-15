// Live diagram layout — pure (no React), unit-tested from apps/api/test/liveLayout.test.ts.
//
//   [ inbound lane ]        [ VNet                                              ]      [ egress rail      ]
//   (Internet) → [pub LB] → [ entry band:  layer 0 │ layer 1 │ …   (connected) ]  →   [ PaaS by category ]
//                           [ other bands: one per connected group of subnets  ]      [ outside / other  ]
//                           [ ┌ no connections: isolated subnets, grid ┐       ]      [ unused · detached ]
//                           [ folded empty subnets                             ]
//
// Subnets are placed by how they are connected, not by kind: the subnets linked by configured lines form a
// "band" (one connected component, never wrapped), its layers are breadth-first distances from the inbound
// side (or towards the outbound side), and lines between neighbouring layers bend in a fixed 48 px corridor.
// Cards keep one fixed size (220 × 100). Positions are relative to the parent, as React Flow expects;
// `abs` and `placeMeta` carry the absolute geometry the router (lib/liveRoute.ts) needs.
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
import { measure, place, type PackNode, type Placed } from "./boxPack";
import { archCategoryOf, labelWidth, PAAS_ORDER, type PaasCategory } from "./archModel";
import { isInferredEdge } from "./liveScope";

export const LIVE = {
  CARD_W: 220,
  /** Every card is 220 × 100 (sub-resources and NSG are chips inside the card) */
  CARD_H: 100,
  NSG_W: 140,
  NSG_H: 24,
  INTERNET_W: 110,
  /** Same height as a card: the terminal's centre (where its line leaves) lines up with the card it feeds */
  INTERNET_H: 100,
  SUMMARY_W: 260,
  SUMMARY_H: 40,
  GAP: 20,
  PAD: 16,
  VNET_HEAD: 46,
  /** Second header row of a VNet with peerings (one row of chips, never wrapped — lib/livePeering) */
  PEER_ROW: 24,
  /** Two-line subnet header (name / CIDR · outbound · NICs): 8 + 20 + 4 + 20, then 8 px clear of the cards */
  SUBNET_HEAD: 60,
  LANE_HEAD: 34,
  SUBNET_COLS: 3,
  ASPECT: 1.6,
  /** A VNet with at least this many subnets without cards folds them into one row */
  FOLD_EMPTY_AT: 2,
  /** Gap between layers of a band — the vertical part of a line between layers runs in its middle */
  CORRIDOR: 48,
  /** Gap between the Internet terminal column and the public LB column of the inbound lane */
  INGRESS_INNER_GAP: 40,
  /** Layers beyond this many are folded into the last one */
  MAX_LAYERS: 4,
  /** Gap between the inbound lane / VNet column / right column */
  COLUMN_GAP: 120,
  /** VNet widths above this are penalised when picking the wrap width (screen fit) */
  VNET_SOFT_MAX_W: 1200,
} as const;

export type LaneKind = "ingress" | "onprem" | "egress" | "paas" | "outside" | "ghost" | "unused";

export type LayoutBox = { id: string; x: number; y: number; w: number; h: number; parent: string | null };
export type Rect = { x: number; y: number; w: number; h: number };

/** How a card connects outside its subnet: from the left, to the right, both, none */
export type CardClass = "L" | "R" | "LR" | "N";

export type PlaceMeta = {
  /** Subnet id → its band (connected group) and layer (column inside the band); isolated subnets have none */
  subnet: Map<string, { band: number; layer: number; vnetId: string }>;
  /** `${band}:${layer}` → x (absolute) of the corridor between layer and layer + 1 */
  corridorX: Map<string, number>;
  /** Middle of the gap between the inbound lane and the VNet column (absolute x) */
  ingressGapX: number;
  /** Middle of the gap between the Internet terminal and the public LB column inside the inbound lane */
  laneInnerGapX?: number;
  cardClass: Map<string, CardClass>;
  /** Subnet id → its right-linked cards (step 3), reordered to their targets' height after the lanes are placed */
  rSlots: Map<string, string[]>;
  /** Lane membership of nodes outside the VNets */
  laneOf: Map<string, LaneKind>;
  /** Every drawn subnet box (banded or not) */
  subnetIds: Set<string>;
  /** Internet terminals of the inbound lane */
  terminals: Set<string>;
};

export type LiveLayout = {
  /** Spec nodes: position relative to `parent` (or absolute when parent is null) and size */
  items: Map<string, LayoutBox>;
  /** Synthetic lane boxes (React Flow group-like nodes) — `label` is an i18n key */
  lanes: Array<LayoutBox & { lane: LaneKind; label: string; category?: PaasCategory }>;
  /**
   * Titled frame inside a VNet around the subnets (and VNet-level cards) with no configured link, below the
   * connected flow — drawn as decoration only (children keep the VNet as parent). Relative to `parent` (the VNet).
   */
  sections: Array<LayoutBox & { vnetId: string; label: string; count: number }>;
  /** One row per VNet for its subnets without cards; `expanded`: they are shown and the row folds them again */
  summaries: Array<LayoutBox & { vnetId: string; subnetIds: string[]; names: string[]; expanded: boolean }>;
  /** Spec nodes not drawn: NICs folded into a subnet count, folded empty subnets, NSGs embedded as badges */
  hidden: Set<string>;
  /** Subnet id → NICs without a VM (shown as a count on the subnet header) */
  nicCount: Map<string, number>;
  /** Absolute rectangle of every drawn node, lane, subnet, VNet and folded row */
  abs: Map<string, Rect>;
  placeMeta: PlaceMeta;
  bounds: { x: number; y: number; width: number; height: number };
};

export type LiveLayoutOptions = {
  /** VNets whose empty subnets are shown one by one instead of the folded row */
  expandedEmpty?: ReadonlySet<string>;
};

type ShapeKind = "node" | "vnet" | "subnet" | "lane" | "summary" | "wrap" | "spacer" | "section";
type Shape = {
  id: string;
  kind: ShapeKind;
  lane?: LaneKind;
  label?: string;
  category?: PaasCategory;
  vnetId?: string;
  subnetIds?: string[];
  names?: string[];
  expanded?: boolean;
  count?: number;
};

const isGroup = (n: DiagramNodeSpec) => n.nodeType === "group";
const kindOf = (n: DiagramNodeSpec) => n.resourceKind ?? n.icon;
/** Code-point order — the same everywhere, unlike localeCompare */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Card size as LiveNode draws it */
export function cardSize(n: DiagramNodeSpec): { w: number; h: number } {
  const k = kindOf(n);
  if (k === "internet") return { w: LIVE.INTERNET_W, h: LIVE.INTERNET_H };
  if (k === "nsg") return { w: LIVE.NSG_W, h: LIVE.NSG_H };
  return { w: LIVE.CARD_W, h: LIVE.CARD_H };
}

/** A load balancer whose every frontend is a public IP — an Internet entry point, not a subnet resource */
export function isPublicOnlyLb(n: DiagramNodeSpec): boolean {
  return kindOf(n) === "lb" && (n.subResources?.length ?? 0) > 0 && n.subResources!.every((s) => s.kind === "publicIP");
}

const ENTRY_LANE_KINDS = new Set(["frontDoor", "trafficManager"]);

/** Reading order inside a subnet: entry points first, then compute, data, the rest */
const CARD_ORDER = ["appGateway", "firewall", "lb", "aks", "vmss", "vm", "containerApp", "functionApp", "appService", "privateEndpoint", "nsg"];
const cardRank = (n: DiagramNodeSpec) => {
  if (kindOf(n) === "internet") return CARD_ORDER.length; // the Internet terminal ends its lane
  const i = CARD_ORDER.indexOf(kindOf(n));
  return i < 0 ? CARD_ORDER.length - 1 : i;
};
const byCard = (a: DiagramNodeSpec, b: DiagramNodeSpec) => cardRank(a) - cardRank(b) || cmp(a.label, b.label) || cmp(a.id, b.id);

/** Subnet tie-break order: entry (0) → compute (1) → data / Private Endpoints (2) → management (3) → empty (4) */
export function subnetTier(subnet: DiagramNodeSpec, cards: DiagramNodeSpec[]): number {
  const name = subnet.label;
  if (cards.length === 0) return 4;
  if (/^(GatewaySubnet|AzureFirewallSubnet|AzureFirewallManagementSubnet|RouteServerSubnet)$/i.test(name)) return 0;
  if (/bastion|mgmt|manage|jump|jbx/i.test(name)) return 3;
  const kinds = new Set(cards.map(kindOf));
  if (kinds.has("appGateway") || kinds.has("firewall")) return 0;
  if (["vm", "vmss", "aks", "appService", "functionApp", "containerApp"].some((k) => kinds.has(k))) return 1;
  if (kinds.has("lb")) return 0;
  return 2;
}

/** Lines that say how traffic or dependencies flow between places (associations and guesses do not) */
/** The VNet lists at least one peering (its header gets the peering row) */
export const hasPeerings = (v: DiagramNodeSpec) => {
  const raw = v.metadata?.peerings;
  return !!raw && raw !== "[]";
};

export function isLayoutEdge(e: DiagramEdgeSpec): boolean {
  if (isInferredEdge(e)) return false;
  // Internet → VM through its own public IP: drawn only — otherwise every subnet with such a VM becomes an entry
  // (layer 0) and the bands reorder
  if (e.exposure) return false;
  return e.edgeKind !== "natgw-association" && e.edgeKind !== "outbound-internet" && e.edgeKind !== "peering";
}

function box(shape: Shape, children: PackNode<Shape>[], o: { head: number; pad?: number; gap?: number; maxW: number; minW?: number; framed?: boolean; dir?: "row" | "col" }): PackNode<Shape> {
  return {
    t: "box", shape, dir: o.dir ?? "row", children,
    head: o.head, pad: o.pad ?? LIVE.PAD, gap: o.gap ?? LIVE.GAP,
    framed: o.framed ?? true, maxW: o.maxW, minW: o.minW,
  };
}
const wrap = (id: string, dir: "row" | "col", children: PackNode<Shape>[], gap: number, minW?: number): PackNode<Shape> =>
  // A min width needs a framed box (boxPack applies minW to framed boxes only) — pad 0 / head 0 keeps it invisible
  box({ id, kind: "wrap" }, children, { head: 0, pad: 0, gap, framed: minW != null, dir, maxW: Infinity, minW });
const leaf = (id: string, w: number, h: number, kind: ShapeKind = "node"): PackNode<Shape> => ({ t: "leaf", shape: { id, kind }, w, h });
const spacer = (key: string): PackNode<Shape> => leaf(`spacer:${key}`, LIVE.CARD_W, 0, "spacer");

export function liveLayout(spec: DiagramSpec, opts: LiveLayoutOptions = {}): LiveLayout {
  const nodes = [...spec.nodes].sort((a, b) => cmp(a.id, b.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hidden = new Set<string>();
  const nicCount = new Map<string, number>();
  const childrenOf = new Map<string, DiagramNodeSpec[]>();
  const topLevel: DiagramNodeSpec[] = [];
  const laneOf = new Map<string, LaneKind>();
  const laneMembers: Record<LaneKind, DiagramNodeSpec[]> = { ingress: [], onprem: [], egress: [], paas: [], outside: [], ghost: [], unused: [] };
  /** Unused public IP, NSG attached to nothing — kept apart from what carries traffic */
  const isUnused = (n: DiagramNodeSpec) => n.metadata?.unused === "true" || n.metadata?.detached === "true";
  const toLane = (n: DiagramNodeSpec, lane: LaneKind) => { laneMembers[lane].push(n); laneOf.set(n.id, lane); };

  // ── Step 0: who goes where ──
  for (const n of nodes) {
    // NSGs attached to a subnet / NIC / VM are drawn as badges by their owner
    if (n.metadata?.nsgAttachedTo) { hidden.add(n.id); continue; }
    // Public entry points have no subnet: inbound lane, whatever the generator nested them in
    if (!isGroup(n) && (isPublicOnlyLb(n) || ENTRY_LANE_KINDS.has(kindOf(n)))) { toLane(n, "ingress"); continue; }
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    // Unused / detached resources — wherever the generator nested them (a detached NSG sits in a subnet only by
    // resource-group guess): one lane at the bottom of the right column, so they are all in one place
    if (!isGroup(n) && isUnused(n)) { toLane(n, "unused"); continue; }
    if (!parent) { topLevel.push(n); continue; }
    // A NIC without a VM says little on its own — the subnet header counts it
    if (kindOf(n) === "nic" && isGroup(parent)) {
      nicCount.set(parent.id, (nicCount.get(parent.id) ?? 0) + 1);
      hidden.add(n.id);
      continue;
    }
    (childrenOf.get(parent.id) ?? childrenOf.set(parent.id, []).get(parent.id)!).push(n);
  }

  // Top-level containers: VNets (or resource-group boxes when the subscription has no VNet)
  const vnets = topLevel.filter(isGroup);
  for (const n of topLevel) {
    if (isGroup(n)) continue;
    const k = kindOf(n);
    if (k === "internet") toLane(n, n.metadata?.direction === "ingress" ? "ingress" : "egress");
    // On-premises sites (S2S, catalog EDGE-09): a lane under the inbound one, on the left
    else if (k === "onPremSite") toLane(n, "onprem");
    else if (n.metadata?.ghostOf) toLane(n, "ghost");
    else if (k === "natGateway") toLane(n, "egress");
    else {
      const cat = archCategoryOf(k);
      // Known PaaS categories get their lane; network / compute / unclassified (public IPs, API endpoints) are "outside"
      toLane(n, cat === "network" || cat === "compute" || cat === "other" ? "outside" : "paas");
    }
  }
  // NAT Gateways nested under a VNet sit on the egress rail (not part of the VNet address space)
  for (const v of vnets) for (const c of childrenOf.get(v.id) ?? []) if (kindOf(c) === "natGateway") toLane(c, "egress");

  // Card → its subnet (for the subnet graph and card classes)
  const subnetOfCard = new Map<string, string>();
  for (const v of vnets) for (const s of childrenOf.get(v.id) ?? []) {
    if (!isGroup(s)) continue;
    for (const c of childrenOf.get(s.id) ?? []) subnetOfCard.set(c.id, s.id);
  }
  /** Vertex of the subnet graph a node belongs to: a subnet id, "IN", "OUT", or null (ignored) */
  const vertexOf = (id: string): string | null => {
    if (hidden.has(id)) return null;
    const lane = laneOf.get(id);
    if (lane === "ingress") return "IN";
    if (lane === "paas" || lane === "outside" || lane === "ghost") return "OUT";
    // On-premises sites are not part of the subnet graph (they would reorder the bands)
    if (lane === "egress" || lane === "unused" || lane === "onprem") return null;
    const sub = subnetOfCard.get(id);
    if (sub) return sub;
    const n = byId.get(id);
    return n && isGroup(n) && n.parentId ? id : null;
  };
  const layoutEdges = [...spec.edges].filter(isLayoutEdge).sort((a, b) => cmp(a.id, b.id));

  const meta: PlaceMeta = { subnet: new Map(), corridorX: new Map(), ingressGapX: 0, cardClass: new Map(), laneOf, subnetIds: new Set(), terminals: new Set(), rSlots: new Map() };
  const bandLayerIds = new Map<number, string[]>(); // band → layer column wrap ids in order
  let bandSeq = 0;

  // ── VNets ──
  const summaries: LiveLayout["summaries"] = [];
  const vnetNode = (v: DiagramNodeSpec): PackNode<Shape> => {
    const subs = (childrenOf.get(v.id) ?? []).filter(isGroup).sort((a, b) => cmp(a.id, b.id));
    const cardsOf = new Map(subs.map((s) => [s.id, (childrenOf.get(s.id) ?? []).slice().sort(byCard)]));
    const tierOf = new Map(subs.map((s) => [s.id, subnetTier(s, cardsOf.get(s.id)!)]));
    const subTie = (a: string, b: string) => tierOf.get(a)! - tierOf.get(b)! || cmp(byId.get(a)!.label, byId.get(b)!.label) || cmp(a, b);
    const filled = subs.filter((s) => cardsOf.get(s.id)!.length > 0).map((s) => s.id);
    const filledSet = new Set(filled);

    // ── Step 1: subnet graph (undirected, weighted) + IN / OUT adjacency + directed source counts ──
    const adj = new Map<string, Map<string, number>>(filled.map((id) => [id, new Map()]));
    const nearIn = new Set<string>();
    const nearOut = new Set<string>();
    const sourceCount = new Map<string, number>();
    const intra = new Map<string, Array<{ s: string; t: string }>>();
    const crossByCard = new Map<string, Array<{ other: string }>>();
    for (const e of layoutEdges) {
      const a = vertexOf(e.source), b = vertexOf(e.target);
      if (!a || !b) continue;
      const aSub = filledSet.has(a), bSub = filledSet.has(b);
      if (!aSub && !bSub) continue;
      if (a === b) {
        if (subnetOfCard.has(e.source) && subnetOfCard.has(e.target)) (intra.get(a) ?? intra.set(a, []).get(a)!).push({ s: e.source, t: e.target });
        continue;
      }
      if (aSub) (crossByCard.get(e.source) ?? crossByCard.set(e.source, []).get(e.source)!).push({ other: b });
      if (bSub) (crossByCard.get(e.target) ?? crossByCard.set(e.target, []).get(e.target)!).push({ other: a });
      if (aSub && bSub) {
        adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + 1);
        adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + 1);
        sourceCount.set(a, (sourceCount.get(a) ?? 0) + 1);
      } else {
        const sub = aSub ? a : b;
        const other = aSub ? b : a;
        if (other === "IN") nearIn.add(sub);
        else if (other === "OUT") nearOut.add(sub);
      }
    }

    // ── Step 2: components and layers ──
    const compOf = new Map<string, number>();
    const comps: string[][] = [];
    for (const id of [...filled].sort(subTie)) {
      if (compOf.has(id)) continue;
      const members: string[] = [];
      const queue = [id];
      compOf.set(id, comps.length);
      while (queue.length) {
        const cur = queue.shift()!;
        members.push(cur);
        for (const nb of [...adj.get(cur)!.keys()].sort(cmp)) if (!compOf.has(nb)) { compOf.set(nb, comps.length); queue.push(nb); }
      }
      comps.push(members);
    }
    const bfs = (sources: string[], members: Set<string>): Map<string, number> => {
      const dist = new Map<string, number>();
      const queue = [...sources].sort(subTie);
      for (const s of queue) dist.set(s, 0);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nb of [...adj.get(cur)!.keys()].sort(subTie)) {
          if (!members.has(nb) || dist.has(nb)) continue;
          dist.set(nb, dist.get(cur)! + 1);
          queue.push(nb);
        }
      }
      return dist;
    };
    type Band = { members: string[]; layerOf: Map<string, number>; entry: boolean };
    const bands: Band[] = [];
    const isolated: string[] = [];
    for (const members of comps) {
      const set = new Set(members);
      const entrySrc = members.filter((m) => nearIn.has(m));
      const exitSrc = members.filter((m) => nearOut.has(m));
      if (members.length === 1 && !entrySrc.length && !exitSrc.length) { isolated.push(members[0]!); continue; }
      let layerOf: Map<string, number>;
      if (entrySrc.length) {
        layerOf = bfs(entrySrc, set);
      } else if (exitSrc.length) {
        const d = bfs(exitSrc, set);
        const lc = Math.max(...d.values()) + 1;
        layerOf = new Map([...d].map(([k, v]) => [k, lc - 1 - v]));
      } else {
        const root = [...members].sort((a, b) => (sourceCount.get(b) ?? 0) - (sourceCount.get(a) ?? 0) || subTie(a, b))[0]!;
        layerOf = bfs([root], set);
      }
      for (const [k, v] of layerOf) if (v >= LIVE.MAX_LAYERS) layerOf.set(k, LIVE.MAX_LAYERS - 1);
      bands.push({ members, layerOf, entry: entrySrc.length > 0 });
    }

    // ── Step 3: order inside each layer (one down and one up barycenter sweep, deterministic) ──
    const layersOf = (b: Band): string[][] => {
      const max = Math.max(0, ...b.layerOf.values());
      const layers: string[][] = Array.from({ length: max + 1 }, () => []);
      for (const [id, l] of b.layerOf) layers[l]!.push(id);
      layers[0]!.sort(subTie);
      const rank = new Map<string, number>();
      layers[0]!.forEach((id, i) => rank.set(id, i));
      const sweep = (l: number, ref: number) => {
        const key = (id: string) => {
          const nbs = [...adj.get(id)!.keys()].filter((nb) => b.layerOf.get(nb) === ref);
          return nbs.length ? nbs.reduce((s, nb) => s + rank.get(nb)!, 0) / nbs.length : Infinity;
        };
        layers[l]!.sort((a, c) => key(a) - key(c) || subTie(a, c));
        layers[l]!.forEach((id, i) => rank.set(id, i));
      };
      for (let l = 1; l <= max; l++) sweep(l, l - 1);
      for (let l = max - 1; l >= 0; l--) sweep(l, l + 1);
      return layers;
    };

    // ── Step 5: cards inside a subnet — lines leave on the side they go ──
    const subnetBox = (s: DiagramNodeSpec, band?: number): PackNode<Shape> => {
      const cards = cardsOf.get(s.id)!;
      const cols = Math.min(LIVE.SUBNET_COLS, Math.max(1, Math.ceil(Math.sqrt(cards.length))));
      const myLayer = band != null ? meta.subnet.get(s.id)?.layer ?? 0 : 0;
      const classOf = (c: DiagramNodeSpec): CardClass => {
        let l = false, r = false;
        for (const { other } of crossByCard.get(c.id) ?? []) {
          if (other === "IN") l = true;
          else if (other === "OUT") r = true;
          else {
            const ol = meta.subnet.get(other)?.layer;
            if (ol != null && ol < myLayer) l = true;
            else r = true;
          }
        }
        return l && r ? "LR" : l ? "L" : r ? "R" : "N";
      };
      for (const c of cards) meta.cardClass.set(c.id, classOf(c));
      const rows: PackNode<Shape>[][] = [];
      const used = new Set<string>();
      const sizeLeaf = (c: DiagramNodeSpec) => { const z = cardSize(c); return leaf(c.id, z.w, z.h); };
      // 1. cards linked both ways: one per row
      for (const c of cards) if (meta.cardClass.get(c.id) === "LR") { rows.push([sizeLeaf(c)]); used.add(c.id); }
      // 2. a line inside the subnet: the source, then its targets on the same row
      if (cols > 1) {
        const lines = intra.get(s.id) ?? [];
        for (const src of cards) {
          if (used.has(src.id)) continue;
          const targets = cards.filter((t) => !used.has(t.id) && t.id !== src.id && lines.some((x) => x.s === src.id && x.t === t.id));
          if (!targets.length) continue;
          used.add(src.id);
          for (const t of targets) used.add(t.id);
          // A target that is also reached from the left (inbound / lower layer) goes first, so the line from
          // the left reaches it without crossing the source card
          const leftFirst = targets.filter((t) => meta.cardClass.get(t.id) === "L");
          const others = targets.filter((t) => meta.cardClass.get(t.id) !== "L");
          for (let i = 0; i < others.length || i === 0; i += cols - 1) {
            const chunk = others.slice(i, i + cols - 1).map(sizeLeaf);
            const head = i === 0 ? [...leftFirst.map(sizeLeaf), sizeLeaf(src)] : [spacer(`${s.id}:${src.id}:${i}`)];
            rows.push([...head, ...chunk]);
            if (!others.length) break;
          }
        }
      }
      // 3. the rest: left-linked cards in column 0, right-linked in the last column, others in between
      const rest = cards.filter((c) => !used.has(c.id));
      if (cols === 1) {
        for (const c of rest) rows.push([sizeLeaf(c)]);
      } else {
        const L = rest.filter((c) => meta.cardClass.get(c.id) === "L");
        const R = rest.filter((c) => meta.cardClass.get(c.id) === "R");
        const N = rest.filter((c) => meta.cardClass.get(c.id) === "N" || meta.cardClass.get(c.id) === "LR");
        const r = Math.max(L.length, R.length, Math.ceil(rest.length / cols));
        const grid: Array<Array<DiagramNodeSpec | null>> = [];
        for (let i = 0; i < r; i++) {
          const slots: Array<DiagramNodeSpec | null> = Array.from({ length: cols }, () => null);
          if (L[i]) slots[0] = L[i]!;
          if (R[i]) slots[cols - 1] = R[i]!;
          for (let c = 0; c < cols; c++) if (!slots[c] && N.length) slots[c] = N.shift()!;
          if (slots.some(Boolean)) grid.push(slots);
        }
        // A column no row uses is dropped: seven right-linked Private Endpoints are one column, not
        // [empty, empty, PE] rows that left two thirds of the subnet blank. Right-linked cards stay last.
        const keep = Array.from({ length: cols }, (_, c) => grid.some((row) => row[c]));
        grid.forEach((slots, i) => {
          const kept = slots.filter((_, c) => keep[c]);
          let last = -1;
          kept.forEach((x, c) => { if (x) last = c; });
          rows.push(kept.slice(0, last + 1).map((x, c) => (x ? sizeLeaf(x) : spacer(`${s.id}:${i}:${c}`))));
        });
        if (R.length > 1) meta.rSlots.set(s.id, R.map((c) => c.id));
      }
      const rowBoxes = rows.map((row, i) => wrap(`row:${s.id}:${i}`, "row", row, LIVE.GAP));
      return box({ id: s.id, kind: "subnet" }, rowBoxes, { head: LIVE.SUBNET_HEAD, dir: "col", maxW: Infinity, minW: LIVE.CARD_W + 2 * LIVE.PAD });
    };

    // ── Step 4: bands (never wrapped) stacked in one connected block; isolated subnets after ──
    const bandOrder = bands.map((b) => ({ b, minTier: Math.min(...b.members.map((m) => tierOf.get(m)!)), minName: [...b.members].map((m) => byId.get(m)!.label).sort(cmp)[0]! }))
      .sort((x, y) => Number(y.b.entry) - Number(x.b.entry) || y.b.members.length - x.b.members.length || x.minTier - y.minTier || cmp(x.minName, y.minName));
    const bandNodes: PackNode<Shape>[] = [];
    for (const { b } of bandOrder) {
      const id = bandSeq++;
      const layers = layersOf(b);
      layers.forEach((ids, l) => ids.forEach((sid) => meta.subnet.set(sid, { band: id, layer: l, vnetId: v.id })));
      const cols = layers.map((ids, l) => {
        const boxes = ids.map((sid) => subnetBox(byId.get(sid)!, id));
        const colW = Math.max(...boxes.map((x) => measure(x).w));
        return wrap(`band:${id}:layer:${l}`, "col", boxes, LIVE.GAP, colW);
      });
      bandLayerIds.set(id, layers.map((_, l) => `band:${id}:layer:${l}`));
      bandNodes.push(wrap(`band:${id}`, "row", cols, LIVE.CORRIDOR));
    }
    const block = bandNodes.length ? wrap(`block:${v.id}`, "col", bandNodes, LIVE.GAP) : null;
    const blockW = block ? measure(block).w : 0;

    const empties = subs.filter((s) => cardsOf.get(s.id)!.length === 0).sort((a, b) => subTie(a.id, b.id));
    // No configured link: one regular grid in a fixed order (tier: entry → compute → data / PE → management,
    // then name), below the connected flow — never squeezed into the gaps beside it
    const isolatedNodes = [...isolated].sort(subTie).map((sid) => subnetBox(byId.get(sid)!));
    const direct = (childrenOf.get(v.id) ?? []).filter((c) => !isGroup(c) && !laneOf.has(c.id)).sort(byCard).map((c) => { const z = cardSize(c); return leaf(c.id, z.w, z.h); });
    const loose: PackNode<Shape>[] = [...isolatedNodes, ...direct];
    const expanded = !!opts.expandedEmpty?.has(v.id);
    const fold = empties.length >= LIVE.FOLD_EMPTY_AT;
    // One or two empty subnets just follow the others; more get their own section at the bottom of the VNet
    if (!fold) loose.push(...empties.map((s) => subnetBox(s)));
    else if (!expanded) for (const e of empties) hidden.add(e.id);
    const main: PackNode<Shape>[] = [...(block ? [block] : []), ...loose];
    const rowWrap = (id: string, children: PackNode<Shape>[], maxW: number): PackNode<Shape> =>
      box({ id, kind: "wrap" }, children, { head: 0, pad: 0, gap: LIVE.GAP, framed: false, dir: "row", maxW });
    /** The VNet for one wrap width: the connected flow, the unconnected grid, then (bottom-left) the empty-subnet row */
    const vnetFor = (maxW: number): PackNode<Shape> => {
      const content: PackNode<Shape>[] = [];
      if (block) content.push(block);
      if (loose.length) {
        // With a connected flow above, the unconnected ones get a titled frame at least as wide as the flow; the
        // wrap width (picked below for the VNet's shape) decides how many go on one row
        const sectionW = Math.max(maxW, blockW, ...loose.map((k) => measure(k).w + 2 * LIVE.PAD));
        content.push(block
          ? box({ id: `isolated:${v.id}`, kind: "section", label: "ld.section.isolated", vnetId: v.id, count: loose.length }, loose, {
              head: LIVE.LANE_HEAD, pad: LIVE.PAD, gap: LIVE.GAP, dir: "row", maxW: sectionW - 2 * LIVE.PAD, minW: blockW,
            })
          : rowWrap(`main:${v.id}`, loose, maxW));
      }
      if (fold) {
        const summary: PackNode<Shape> = { t: "leaf", shape: { id: `empty-subnets:${v.id}`, kind: "summary", vnetId: v.id, subnetIds: empties.map((e) => e.id), names: empties.map((e) => e.label), expanded }, w: LIVE.SUMMARY_W, h: LIVE.SUMMARY_H };
        const section: PackNode<Shape>[] = [summary];
        // Opened: same-size boxes in a grid as wide as the subnets above (never wider)
        if (expanded) section.push(rowWrap(`empties:${v.id}`, empties.map((s) => subnetBox(s)), Math.max(maxW, LIVE.CARD_W + 2 * LIVE.PAD)));
        content.push(box({ id: `emptySection:${v.id}`, kind: "wrap" }, section, { head: 0, pad: 0, gap: LIVE.GAP / 2, framed: false, dir: "col", maxW: Infinity }));
      }
      // A VNet with peerings has a second header row for them (fixed height: chips never wrap)
      return box({ id: v.id, kind: "vnet" }, content, { head: LIVE.VNET_HEAD + (hasPeerings(v) ? LIVE.PEER_ROW : 0), dir: "col", maxW: Infinity, minW });
    };

    const minW = labelWidth(v.label, v.metadata?.addressSpace, 260, 360);
    // Pick the wrap width whose box is closest to the target aspect ratio (ties → smaller area); never narrower
    // than the connected block, which must not wrap
    const widths = main.map((k) => measure(k).w);
    const maxKid = Math.max(LIVE.CARD_W, ...widths);
    const candidates = new Set<number>();
    for (let i = 1; i <= main.length; i++) {
      const sorted = [...widths].sort((x, y) => y - x).slice(0, i);
      candidates.add(sorted.reduce((sum, w) => sum + w, 0) + (i - 1) * LIVE.GAP);
      candidates.add(i * maxKid + (i - 1) * LIVE.GAP);
    }
    candidates.add(Math.max(blockW, LIVE.CARD_W + 2 * LIVE.PAD));
    // Widths that put the first k unconnected boxes on one row of the framed grid (frame padding included)
    if (block) {
      const lw = loose.map((k) => measure(k).w);
      for (let k = 1, row = 0; k <= lw.length; k++) {
        row += (k > 1 ? LIVE.GAP : 0) + lw[k - 1]!;
        candidates.add(Math.max(blockW, row + 2 * LIVE.PAD));
      }
    }
    let best: PackNode<Shape> | null = null;
    let bestScore = Infinity;
    // Never wider than ~1200 px unless the connected flow itself is (screen fit once the side lanes are added)
    const cap = Math.max(blockW, LIVE.VNET_SOFT_MAX_W);
    for (const maxW of [...candidates].filter((w) => w >= blockW && w <= cap).sort((x, y) => x - y)) {
      const b = vnetFor(maxW);
      const m = measure(b);
      // Wider than ~1200 px pushes the fit-to-screen zoom under 0.45 once the side lanes are added
      const score = Math.abs(Math.log((m.w / m.h) / LIVE.ASPECT)) + Math.max(0, m.w - LIVE.VNET_SOFT_MAX_W) / 1000 + (m.w * m.h) / 1e9;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best ?? vnetFor(Math.max(blockW, LIVE.CARD_W));
  };
  // Several VNets in view: the one with the most peerings among them first, its peers next (by name), then the
  // rest in their order — a hub reads before its spokes. Without peering lines nothing moves.
  const inView = new Set(vnets.map((v) => v.id));
  const peerLines = spec.edges.filter((e) => e.edgeKind === "peering" && inView.has(e.source) && inView.has(e.target));
  if (vnets.length > 1 && peerLines.length) {
    const degree = (id: string) => peerLines.filter((e) => e.source === id || e.target === id).length;
    const hub = [...vnets].sort((a, b) => degree(b.id) - degree(a.id) || cmp(a.label, b.label) || cmp(a.id, b.id))[0]!;
    const peersOfHub = new Set(peerLines.flatMap((e) => (e.source === hub.id ? [e.target] : e.target === hub.id ? [e.source] : [])));
    const spokes = vnets.filter((v) => peersOfHub.has(v.id)).sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id));
    const rest = vnets.filter((v) => v.id !== hub.id && !peersOfHub.has(v.id));
    vnets.splice(0, vnets.length, hub, ...spokes, ...rest);
  }
  const vnetBoxes = vnets.map(vnetNode);

  // ── Lanes ──
  const lane = (kind: LaneKind, label: string, members: DiagramNodeSpec[], cols = 1, category?: PaasCategory): PackNode<Shape> | null => {
    if (!members.length) return null;
    const cards = members.slice().sort(byCard);
    return box({ id: `lane:${kind}${category ? ":" + category : ""}`, kind: "lane", lane: kind, label, category }, cards.map((n) => { const s = cardSize(n); return leaf(n.id, s.w, s.h); }), {
      head: LIVE.LANE_HEAD, maxW: cols * LIVE.CARD_W + (cols - 1) * LIVE.GAP, minW: LIVE.CARD_W + 2 * LIVE.PAD,
    });
  };
  // Inbound: [Internet terminal(s)] | [public load balancers / Front Door]
  const inet = laneMembers.ingress.filter((n) => kindOf(n) === "internet").sort(byCard);
  const entries = laneMembers.ingress.filter((n) => kindOf(n) !== "internet").sort(byCard);
  const ingress = laneMembers.ingress.length
    ? box({ id: "lane:ingress", kind: "lane", lane: "ingress", label: "ld.lane.ingress" }, [
        ...(inet.length ? [wrap("ingress:inet", "col", inet.map((n) => leaf(n.id, cardSize(n).w, cardSize(n).h)), LIVE.GAP)] : []),
        ...(entries.length ? [wrap("ingress:lb", "col", entries.map((n) => leaf(n.id, cardSize(n).w, cardSize(n).h)), LIVE.GAP)] : []),
      ], { head: LIVE.LANE_HEAD, maxW: Infinity, gap: LIVE.INGRESS_INNER_GAP, minW: LIVE.CARD_W + 2 * LIVE.PAD })
    : null;
  const paasGroups = PAAS_ORDER
    .map((cat) => {
      const members = laneMembers.paas.filter((n) => archCategoryOf(kindOf(n)) === cat);
      // One column up to six: lines into a second column crossed the cards of the first
      return lane("paas", `ld.lane.paas.${cat}`, members, members.length > 6 ? 2 : 1, cat);
    })
    .filter((x): x is PackNode<Shape> => !!x);
  const right = [
    // Outbound reads left to right: NAT Gateways, then the Internet terminal (lines stay short and straight)
    lane("egress", "ld.lane.egress", laneMembers.egress, Math.min(3, laneMembers.egress.length)),
    ...paasGroups,
    lane("outside", "ld.lane.outside", laneMembers.outside, 2),
    lane("ghost", "ld.lane.ghost", laneMembers.ghost, 1),
    // Last: nothing flows through these (unused public IPs, NSGs attached to nothing), kind → name
    lane("unused", "ld.lane.unused", laneMembers.unused, 2),
  ].filter((x): x is PackNode<Shape> => !!x);

  // On-premises sites under the inbound lane (left: they reach the VNet through its gateway)
  const onprem = lane("onprem", "ld.lane.onprem", laneMembers.onprem, 1);
  const columns: PackNode<Shape>[] = [];
  if (ingress || onprem) columns.push(wrap("col:ingress", "col", [ingress, onprem].filter((x): x is PackNode<Shape> => !!x), 24));
  if (vnetBoxes.length) columns.push(wrap("col:vnets", "col", vnetBoxes, 48));
  if (right.length) columns.push(wrap("col:right", "col", right, 24));
  const placed = place(measure(wrap("root", "row", columns, LIVE.COLUMN_GAP)));

  // ── Step 6: vertical alignment of what sits outside the VNets ──
  const at = new Map(placed.map((p) => [p.shape.id, p]));
  const within = (p: Placed<Shape>, ancestor: string) => {
    for (let cur = p.parent ? at.get(p.parent.id) : undefined; cur; cur = cur.parent ? at.get(cur.parent.id) : undefined) if (cur.shape.id === ancestor) return true;
    return false;
  };
  const cy = (p: Placed<Shape>) => p.y + p.h / 2;
  const inLane = (id: string) => laneOf.has(id);
  const neighbours = (id: string, accept: (other: string) => boolean): string[] => {
    const out: string[] = [];
    for (const e of layoutEdges) {
      const other = e.source === id ? e.target : e.target === id ? e.source : null;
      if (other && at.has(other) && accept(other)) out.push(other);
    }
    return out;
  };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  /** Stack items top-down at their targets without overlap; items without a target follow in their order */
  const stack = (items: Array<{ p: Placed<Shape>; target: number | null; move: (dy: number) => void }>, gap: number, top: number) => {
    const withT = items.filter((i) => i.target != null).sort((a, b) => a.target! - b.target! || cmp(a.p.shape.id, b.p.shape.id));
    const without = items.filter((i) => i.target == null);
    let floor = top;
    for (const it of [...withT, ...without]) {
      // No target and nothing above yet: stay where the packer put it
      const y = Math.max(it.target ?? (Number.isFinite(floor) ? floor : it.p.y), floor);
      it.move(y - it.p.y);
      floor = it.p.y + it.p.h + gap;
    }
  };
  const shiftTree = (rootId: string, dy: number) => {
    for (const p of placed) if (p.shape.id === rootId || within(p, rootId)) p.y += dy;
  };
  const vnetCol = at.get("col:vnets");
  const laneIngress = at.get("lane:ingress");
  if (laneIngress && vnetCol) {
    const lbs = placed.filter((p) => within(p, "ingress:lb") && p.shape.kind === "node");
    const terms = placed.filter((p) => within(p, "ingress:inet") && p.shape.kind === "node");
    // In-VNet targets of the Internet (e.g. a public App Gateway): keep LB cards off their horizontal line
    const vnetTargets = terms.flatMap((t) => neighbours(t.shape.id, (o) => !inLane(o))).map((id) => at.get(id)!);
    stack(lbs.map((p) => {
      const nb = neighbours(p.shape.id, (o) => !inLane(o));
      let target: number | null = nb.length ? mean(nb.map((id) => cy(at.get(id)!))) - p.h / 2 : null;
      if (target != null) for (const t of vnetTargets) if (target < cy(t) + 12 && target + p.h > cy(t) - 12) target = cy(t) + 12;
      return { p, target, move: (dy: number) => { p.y += dy; } };
    }), LIVE.GAP, vnetCol.y);
    const lo = vnetCol.y, hi = vnetCol.y + vnetCol.h;
    stack(terms.map((p) => {
      const nb = neighbours(p.shape.id, () => true);
      const raw = nb.length ? mean(nb.map((id) => cy(at.get(id)!))) - p.h / 2 : (lo + hi) / 2 - p.h / 2;
      return { p, target: Math.min(Math.max(raw, lo), Math.max(lo, hi - p.h)), move: (dy: number) => { p.y += dy; } };
    }), LIVE.GAP, -Infinity);
    // The lane box wraps its members again
    const members = [...lbs, ...terms];
    const top = Math.min(...members.map((m) => m.y)) - LIVE.LANE_HEAD;
    const bottom = Math.max(...members.map((m) => m.y + m.h)) + LIVE.PAD;
    laneIngress.y = top;
    laneIngress.h = bottom - top;
  }
  // On-premises lane: the inbound lane just moved and may have grown over it — keep it below (24px), at the height
  // of the VPN gateways it connects to when that is lower
  const laneOnprem = at.get("lane:onprem");
  if (laneOnprem) {
    const members = placed.filter((m) => m.shape.kind === "node" && within(m, laneOnprem.shape.id));
    const ids = new Set(members.map((m) => m.shape.id));
    const nb = [...new Set(members.flatMap((m) => neighbours(m.shape.id, (o) => !ids.has(o) && !inLane(o))))].sort(cmp);
    const floor = laneIngress ? laneIngress.y + laneIngress.h + 24 : -Infinity;
    const target = nb.length ? mean(nb.map((id) => cy(at.get(id)!))) - laneOnprem.h / 2 : null;
    stack([{ p: laneOnprem, target, move: (dy: number) => shiftTree(laneOnprem.shape.id, dy) }], 24, floor);
  }
  const rightCol = at.get("col:right");
  if (rightCol) {
    const laneBoxes = placed.filter((p) => p.shape.kind === "lane" && p.shape.lane !== "ingress" && p.shape.lane !== "onprem");
    stack(laneBoxes.map((p) => {
      const members = placed.filter((m) => m.shape.kind === "node" && within(m, p.shape.id));
      const ids = new Set(members.map((m) => m.shape.id));
      let nb: string[] = [];
      for (const m of members) {
        nb.push(...neighbours(m.shape.id, (o) => !ids.has(o) && !inLane(o)));
        // The egress rail sits at the subnets it serves (subnet → NAT associations)
        if (p.shape.lane === "egress") {
          for (const e of spec.edges) if (e.edgeKind === "natgw-association" && e.target === m.shape.id && at.has(e.source)) nb.push(e.source);
        }
      }
      nb = [...new Set(nb)].sort(cmp);
      const target = nb.length ? mean(nb.map((id) => cy(at.get(id)!))) - p.h / 2 : null;
      return { p, target, move: (dy: number) => shiftTree(p.shape.id, dy) };
    }), 24, -Infinity);
  }
  orderToTargets();

  /**
   * Right-linked cards of a subnet (Private Endpoints → PaaS lane) take their slots in the vertical order of what
   * they link to outside the subnet, so their lines do not cross. Only the slots move (same size), lanes stay;
   * ties by id — deterministic.
   */
  function orderToTargets() {
    for (const [subnetId, ids] of [...meta.rSlots].sort(([a], [b]) => cmp(a, b))) {
      const cards = ids.map((id) => at.get(id)).filter((p): p is Placed<Shape> => !!p);
      if (cards.length < 2 || cards.some((c) => c.w !== cards[0]!.w || c.h !== cards[0]!.h)) continue;
      const own = new Set(ids);
      const key = (p: Placed<Shape>) => {
        const nb = neighbours(p.shape.id, (o) => !own.has(o) && at.has(o) && !within(at.get(o)!, subnetId));
        return nb.length ? mean(nb.map((id) => cy(at.get(id)!))) : Infinity;
      };
      const slots = cards.map((c) => ({ x: c.x, y: c.y })).sort((a, b) => a.y - b.y || a.x - b.x);
      const ordered = [...cards].sort((a, b) => key(a) - key(b) || cmp(a.shape.id, b.shape.id));
      ordered.forEach((c, i) => { c.x = slots[i]!.x; c.y = slots[i]!.y; });
    }
  }

  // ── Absolute → relative to the drawn parent ──
  const drawnParent = (p: Placed<Shape>): Placed<Shape> | null => {
    let cur = p.parent ? at.get(p.parent.id) ?? null : null;
    // Wraps and the "no connections" frame are not React Flow parents (the frame is decoration over the VNet)
    while (cur && (cur.shape.kind === "wrap" || cur.shape.kind === "section")) cur = cur.parent ? at.get(cur.parent.id) ?? null : null;
    return cur;
  };
  const items = new Map<string, LayoutBox>();
  const lanes: LiveLayout["lanes"] = [];
  const sections: LiveLayout["sections"] = [];
  const abs = new Map<string, Rect>();
  for (const p of placed) {
    const s = p.shape;
    if (s.kind === "wrap" || s.kind === "spacer") continue;
    abs.set(s.id, { x: p.x, y: p.y, w: p.w, h: p.h });
    const par = drawnParent(p);
    const b: LayoutBox = { id: s.id, x: p.x - (par?.x ?? 0), y: p.y - (par?.y ?? 0), w: p.w, h: p.h, parent: par?.shape.id ?? null };
    if (s.kind === "lane") lanes.push({ ...b, lane: s.lane!, label: s.label!, category: s.category });
    else if (s.kind === "section") sections.push({ ...b, vnetId: s.vnetId!, label: s.label!, count: s.count ?? 0 });
    else if (s.kind === "summary") summaries.push({ ...b, vnetId: s.vnetId!, subnetIds: s.subnetIds!, names: s.names!, expanded: !!s.expanded });
    else items.set(s.id, b);
    if (s.kind === "subnet") meta.subnetIds.add(s.id);
  }
  for (const n of inet) meta.terminals.add(n.id);

  // ── Corridors and gaps the router bends in ──
  for (const [band, ids] of bandLayerIds) {
    for (let l = 0; l + 1 < ids.length; l++) {
      const a = at.get(ids[l]!), b = at.get(ids[l + 1]!);
      if (a && b) meta.corridorX.set(`${band}:${l}`, (a.x + a.w + b.x) / 2);
    }
  }
  if (laneIngress && vnetCol) meta.ingressGapX = (laneIngress.x + laneIngress.w + vnetCol.x) / 2;
  else if (vnetCol) meta.ingressGapX = vnetCol.x - LIVE.COLUMN_GAP / 2;
  const inetCol = at.get("ingress:inet"), lbCol = at.get("ingress:lb");
  if (inetCol && lbCol) meta.laneInnerGapX = (inetCol.x + inetCol.w + lbCol.x) / 2;

  const top = placed.filter((p) => p.shape.kind !== "wrap" && p.shape.kind !== "spacer" && !drawnParent(p));
  const minX = Math.min(0, ...top.map((p) => p.x));
  const minY = Math.min(0, ...top.map((p) => p.y));
  const maxX = Math.max(0, ...top.map((p) => p.x + p.w));
  const maxY = Math.max(0, ...top.map((p) => p.y + p.h));
  return { items, lanes, sections, summaries, hidden, nicCount, abs, placeMeta: meta, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
