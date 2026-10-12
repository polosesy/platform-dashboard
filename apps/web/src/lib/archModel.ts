// ──────────────────────────────────────────────────────────────
// Infrastructure diagram model (pure — no React, no DOM; tested in apps/api/test/archModel.test.ts)
//
// ArchitectureGraph (Resource Graph, ~500 nodes / ~760 edges) → a draw.io-style diagram:
//   Region › VNet › Subnet › resource tiles, with an edge lane (Internet entry, public LB,
//   NAT, firewall) and a PaaS lane (managed services outside VNets).
//
// Absorption (no tile of their own):
//   NIC → its VM (private IPs); a NIC without a VM → counted on its subnet
//   NSG → subnet badge, or VM badge via its NIC (NSG on a VM-less NIC → its subnet)
//   public IP → owner badge (NIC→VM, LB, App Gateway, NAT, VMSS→AKS; VM-less NIC → subnet)
//   AKS node-pool VMSS → the AKS tile
// Containment is drawn as nesting, so contains / attached-to / bound-to edges are never lines.
// Lines are configuration relationships only (never observed traffic):
//   ingress (Internet → public LB / App Gateway / firewall), exposure (Internet → VM with a
//   public IP), routes (LB/AppGW → backends), private link, peering, outbound (subnet → NAT),
//   VNet integration, logging.
// Nothing is guessed: a public IP whose owner is not in the graph is listed with the owner
// type read from its ID, not drawn.
// ──────────────────────────────────────────────────────────────

import type { ArchitectureGraph, ArchitectureNode } from "@aud/types";

export type ArchEdgeKind = "ingress" | "exposure" | "routes" | "privateLink" | "peering" | "outbound" | "vnetIntegration" | "logging";
export const ARCH_EDGE_KINDS: ArchEdgeKind[] = ["ingress", "routes", "privateLink", "peering", "outbound", "vnetIntegration", "exposure", "logging"];
/** Layers drawn by default; VM public-IP exposure and logging are opt-in to keep the first view readable. */
export const DEFAULT_LAYERS: ArchEdgeKind[] = ["ingress", "routes", "privateLink", "peering", "outbound", "vnetIntegration"];

export type PaasCategory = "app" | "data" | "security" | "messaging" | "monitoring" | "dns" | "other";
export const PAAS_ORDER: PaasCategory[] = ["app", "data", "security", "messaging", "monitoring", "dns", "other"];

export const internetId = (region: string) => `internet:${region}`;

export type ArchResource = {
  id: string;
  node: ArchitectureNode;
  /** Region key ("koreacentral"); "global" for global services */
  region: string;
  subnetId: string | null;
  /** Subnets beyond the one the tile is drawn in (multi-NIC VMs, multi-pool AKS) */
  extraSubnets: string[];
  privateIps: string[];
  publicIps: string[];
  /** NIC-level NSG names */
  nsgs: string[];
  /** AKS: absorbed node-pool scale sets */
  nodePools: string[];
  nicCount: number;
};

export type ArchSubnet = {
  node: ArchitectureNode;
  vnetId: string;
  resources: string[];
  nsgs: string[];
  natGateways: string[];
  /** NICs without a VM (Private Endpoint NICs, leftovers of deleted VMs, …) */
  otherNics: number;
  /** Public IPs on those VM-less NICs */
  publicIps: string[];
};
export type ArchVnet = { node: ArchitectureNode; region: string; subnets: ArchSubnet[] };
export type ArchCleanupItem = { id: string; name: string; detail?: string };
export type ArchRegion = {
  key: string;
  vnets: ArchVnet[];
  edge: string[];
  outside: string[];
  paas: Record<PaasCategory, string[]>;
  /** Public IPs attached to nothing */
  unusedPublicIps: ArchCleanupItem[];
  /** Public IPs whose owner is not in the graph — detail = owner type from the ID */
  unresolvedPublicIps: ArchCleanupItem[];
  /** NSGs associated with nothing */
  unusedNsgs: ArchCleanupItem[];
};
export type ArchEdge = { id: string; kind: ArchEdgeKind; source: string; target: string };

export type ArchAccount = { as: "tile" | "container" | "absorbed" | "counted" | "omitted"; into?: string };
export type ArchModel = {
  /** Every graph node by lowercase id */
  nodes: Map<string, ArchitectureNode>;
  resources: Map<string, ArchResource>;
  vnets: Map<string, ArchVnet>;
  subnets: Map<string, ArchSubnet>;
  regions: ArchRegion[];
  global: string[];
  edges: ArchEdge[];
  /** Graph node id → exactly one bucket: tile, container, absorbed into another id, counted, or omitted */
  accounting: Map<string, ArchAccount>;
  totals: {
    regions: number; vnets: number; subnets: number; tiles: number; vms: number; publicIpResources: number;
    privateEndpoints: number; unusedPublicIps: number; unresolvedPublicIps: number; unusedNsgs: number; otherNics: number;
  };
};

const lower = (s: string) => s.toLowerCase();
const regionKey = (loc: string | undefined) => (loc && loc.trim() ? lower(loc).replace(/\s+/g, "") : "global");

const PAAS_KIND: Partial<Record<string, PaasCategory>> = {
  appService: "app", functionApp: "app",
  storage: "data", sql: "data", cosmosDb: "data", redis: "data", postgres: "data",
  keyVault: "security",
  serviceBus: "messaging", eventHub: "messaging",
  logAnalytics: "monitoring", appInsights: "monitoring",
  dns: "dns",
};
/** Network edge of a region: entry points and egress. */
const EDGE_KINDS = new Set<string>(["lb", "natGateway", "appGateway", "firewall"]);
const GLOBAL_KINDS = new Set<string>(["frontDoor", "trafficManager"]);
const COMPUTE_KINDS = new Set<string>(["vm", "vmss", "aks", "containerApp"]);
const OMITTED = new Set<string>(["subscription", "resourceGroup"]);
/** Ingress targets: a public IP on these is an entry point, not a single exposed host. */
const ENTRY_KINDS = new Set<string>(["lb", "appGateway", "firewall"]);

/** Top-level owner of a child ID (ip configuration, frontend, …) — mirrors apps/api ownerResourceId. */
function ownerOf(id: string): string {
  const parts = lower(id).split("/");
  return parts.length >= 9 && parts[1] === "subscriptions" ? parts.slice(0, 9).join("/") : lower(id);
}
/** "…/providers/microsoft.network/virtualnetworkgateways/x" → "virtualnetworkgateways" */
export function ownerTypeOf(id: string): string {
  const parts = lower(id).split("/");
  return parts.length >= 9 ? parts[7]! : "unknown";
}

const ipOf = (n: ArchitectureNode | undefined) => (n?.endpoint && /^\d{1,3}(\.\d{1,3}){3}$/.test(n.endpoint) ? n.endpoint : undefined);

export function buildArchModel(graph: ArchitectureGraph): ArchModel {
  const byId = new Map<string, ArchitectureNode>();
  for (const n of graph.nodes) byId.set(lower(n.id), n);
  const accounting = new Map<string, ArchAccount>();
  const account = (id: string, as: ArchAccount["as"], into?: string) => {
    if (!accounting.has(id)) accounting.set(id, into ? { as, into } : { as });
  };

  // ── index edges (lowercased, only between known nodes) ──
  const edgesIn: Array<{ kind: string; s: string; t: string }> = [];
  const out = new Map<string, Array<{ kind: string; target: string }>>();
  const inc = new Map<string, Array<{ kind: string; source: string }>>();
  for (const e of graph.edges) {
    const s = lower(e.source), t = lower(e.target);
    if (!byId.has(s) || !byId.has(t)) continue;
    edgesIn.push({ kind: e.kind, s, t });
    (out.get(s) ?? out.set(s, []).get(s)!).push({ kind: e.kind, target: t });
    (inc.get(t) ?? inc.set(t, []).get(t)!).push({ kind: e.kind, source: s });
  }
  const outOf = (id: string, kind?: string) => (out.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  const inOf = (id: string, kind?: string) => (inc.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  const kindOf = (id: string): string | undefined => byId.get(id)?.kind;

  // ── containers: VNets and subnets ──
  const vnets = new Map<string, ArchVnet>();
  const subnets = new Map<string, ArchSubnet>();
  for (const [id, n] of byId) if (n.kind === "vnet") { vnets.set(id, { node: n, region: regionKey(n.location), subnets: [] }); account(id, "container"); }
  for (const [id, n] of byId) {
    if (n.kind !== "subnet") continue;
    const vnetId = id.includes("/subnets/") ? id.slice(0, id.indexOf("/subnets/")) : null;
    const vnet = vnetId ? vnets.get(vnetId) : undefined;
    if (!vnet) { account(id, "omitted"); continue; }
    const sub: ArchSubnet = { node: n, vnetId: vnetId!, resources: [], nsgs: [], natGateways: [], otherNics: 0, publicIps: [] };
    subnets.set(id, sub);
    vnet.subnets.push(sub);
    account(id, "container");
  }
  const subnetsOf = (id: string, kinds: string[]) =>
    [...new Set(inOf(id).filter((e) => kinds.includes(e.kind) && subnets.has(e.source)).map((e) => e.source))].sort();

  // ── NIC → owner VM, VMSS → owner AKS ──
  const nicOwner = new Map<string, string>();
  for (const [id, n] of byId) if (n.kind === "nic") for (const e of outOf(id, "bound-to")) if (kindOf(e.target) === "vm") nicOwner.set(id, e.target);
  const vmssOwner = new Map<string, string>();
  for (const [id, n] of byId) if (n.kind === "aks") for (const e of outOf(id)) if (kindOf(e.target) === "vmss") vmssOwner.set(e.target, id);

  // ── tiles ──
  const resources = new Map<string, ArchResource>();
  for (const [id, n] of byId) {
    if (OMITTED.has(n.kind)) { account(id, "omitted"); continue; }
    if (n.kind === "vnet" || n.kind === "subnet" || n.kind === "nic" || n.kind === "nsg" || n.kind === "publicIP") continue;
    if (n.kind === "vmss" && vmssOwner.has(id)) continue;
    const r: ArchResource = { id, node: n, region: regionKey(n.location), subnetId: null, extraSubnets: [], privateIps: [], publicIps: [], nsgs: [], nodePools: [], nicCount: 0 };
    resources.set(id, r);
    account(id, "tile");
    let subs: string[] = [];
    if (n.kind === "vm") {
      const nics = inOf(id, "bound-to").map((e) => e.source).filter((x) => kindOf(x) === "nic").sort();
      r.nicCount = nics.length;
      for (const nic of nics) {
        subs.push(...subnetsOf(nic, ["attached-to"]));
        const ip = ipOf(byId.get(nic));
        if (ip) r.privateIps.push(ip);
      }
    } else if (n.kind === "aks") {
      // (1) agent pool vnetSubnetID, (2) subnets of its node-pool scale sets, (3) outside any VNet
      const pools = (n.metadata?.agentPoolProfiles as Array<{ vnetSubnetId?: string }> | undefined) ?? [];
      subs.push(...pools.map((p) => (p.vnetSubnetId ? lower(p.vnetSubnetId) : "")).filter((x) => subnets.has(x)));
      subs.push(...subnetsOf(id, ["connects", "network"]));
      for (const [vmss, owner] of [...vmssOwner].sort()) {
        if (owner !== id) continue;
        r.nodePools.push(byId.get(vmss)!.name);
        subs.push(...subnetsOf(vmss, ["network", "connects"]));
      }
    } else if (["vmss", "lb", "appGateway", "firewall", "privateEndpoint", "containerApp"].includes(n.kind)) {
      subs = subnetsOf(id, ["network", "connects", "attached-to"]);
    }
    subs = [...new Set(subs)];
    if (subs.length) {
      r.subnetId = subs[0]!;
      r.extraSubnets = subs.slice(1);
      const sub = subnets.get(r.subnetId)!;
      sub.resources.push(id);
      r.region = vnets.get(sub.vnetId)!.region;
    }
    if (n.kind === "privateEndpoint") { const ip = ipOf(n); if (ip) r.privateIps.push(ip); }
  }
  for (const [vmss, owner] of vmssOwner) account(vmss, "absorbed", owner);

  // NICs: into their VM; otherwise counted on their subnet (never re-classified by name)
  const nicSubnet = new Map<string, string>();
  for (const [id, n] of byId) {
    if (n.kind !== "nic") continue;
    const owner = nicOwner.get(id);
    if (owner && resources.has(owner)) { account(id, "absorbed", owner); continue; }
    const sub = subnetsOf(id, ["attached-to"])[0];
    if (sub) { subnets.get(sub)!.otherNics++; nicSubnet.set(id, sub); account(id, "absorbed", sub); }
    else account(id, "counted");
  }

  // NSGs: subnet badge, VM badge via NIC, subnet badge via a VM-less NIC, else "unused"
  const cleanup = new Map<string, { unusedPublicIps: ArchCleanupItem[]; unresolvedPublicIps: ArchCleanupItem[]; unusedNsgs: ArchCleanupItem[] }>();
  const bucket = (k: string) => cleanup.get(k) ?? cleanup.set(k, { unusedPublicIps: [], unresolvedPublicIps: [], unusedNsgs: [] }).get(k)!;
  const pushUnique = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };
  for (const [id, n] of byId) {
    if (n.kind !== "nsg") continue;
    let into: string | null = null;
    for (const e of outOf(id, "network")) {
      const sub = subnets.get(e.target);
      if (sub) { pushUnique(sub.nsgs, n.name); into ??= e.target; continue; }
      const vm = nicOwner.get(e.target);
      if (vm && resources.has(vm)) { pushUnique(resources.get(vm)!.nsgs, n.name); into ??= vm; continue; }
      const viaNic = nicSubnet.get(e.target);
      if (viaNic) { pushUnique(subnets.get(viaNic)!.nsgs, n.name); into ??= viaNic; }
    }
    if (into) account(id, "absorbed", into);
    else { bucket(regionKey(n.location)).unusedNsgs.push({ id, name: n.name }); account(id, "counted"); }
  }

  const edges: ArchEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (kind: ArchEdgeKind, source: string, target: string) => {
    if (source === target) return;
    const [a, b] = kind === "peering" && source > target ? [target, source] : [source, target];
    const id = `${kind}:${a}->${b}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, kind, source: a, target: b });
  };
  /** The tile that shows an absorbed endpoint (NIC → VM, node-pool VMSS → AKS). */
  const shownAs = (id: string): string | null => {
    if (resources.has(id)) return id;
    const k = kindOf(id);
    if (k === "nic") { const vm = nicOwner.get(id); return vm && resources.has(vm) ? vm : null; }
    if (k === "vmss") { const aks = vmssOwner.get(id); return aks && resources.has(aks) ? aks : null; }
    return null;
  };

  // Public IPs → owner badge; Internet → owner line (entry points = ingress, hosts = exposure)
  for (const [id, n] of byId) {
    if (n.kind !== "publicIP") continue;
    const k = regionKey(n.location);
    const ip = ipOf(n);
    const attached = typeof n.metadata?.attachedTo === "string" ? lower(n.metadata.attachedTo as string) : null;
    const natOwner = inOf(id).find((e) => kindOf(e.source) === "natGateway")?.source ?? null;
    const ownerRaw = attached ?? natOwner;
    if (!ownerRaw) {
      bucket(k).unusedPublicIps.push({ id, name: n.name, detail: ip });
      account(id, "counted");
      continue;
    }
    const ownerId = ownerOf(ownerRaw);
    const owner = shownAs(ownerId);
    if (owner) {
      const r = resources.get(owner)!;
      if (ip && !r.publicIps.includes(ip)) r.publicIps.push(ip);
      account(id, "absorbed", owner);
      const ok = r.node.kind;
      // A NAT Gateway public IP is egress-only, not an inbound path
      if (ok !== "natGateway") addEdge(ENTRY_KINDS.has(ok) ? "ingress" : "exposure", internetId(r.region), owner);
      continue;
    }
    const viaNic = nicSubnet.get(ownerId);
    if (viaNic) {
      // Public IP on a NIC that has no VM — shown on the subnet, no line (nothing to reach)
      if (ip) pushUnique(subnets.get(viaNic)!.publicIps, ip);
      account(id, "absorbed", viaNic);
      continue;
    }
    bucket(k).unresolvedPublicIps.push({ id, name: n.name, detail: ownerTypeOf(ownerId) });
    account(id, "counted");
  }

  // Configuration lines
  for (const { kind, s, t } of edgesIn) {
    const sk = kindOf(s), tk = kindOf(t);
    if (kind === "routes" && (sk === "lb" || sk === "appGateway")) {
      const target = shownAs(t);
      if (target) addEdge("routes", s, target);
    } else if (kind === "routes" && tk === "lb" && (sk === "vmss" || sk === "vm")) {
      // Outbound SNAT rule (scale set → LB) — same pair as the inbound rule, one line
      const source = shownAs(s);
      if (source) addEdge("routes", t, source);
    } else if (kind === "privateLink") {
      const target = shownAs(t);
      if (resources.has(s) && target) addEdge("privateLink", s, target);
    } else if (kind === "peering" && vnets.has(s) && vnets.has(t)) {
      addEdge("peering", s, t);
    } else if (subnets.has(s) && tk === "natGateway" && resources.has(t)) {
      addEdge("outbound", s, t);
      pushUnique(subnets.get(s)!.natGateways, byId.get(t)!.name);
    } else if (subnets.has(s) && (tk === "appService" || tk === "functionApp") && resources.has(t)) {
      addEdge("vnetIntegration", s, t);
    } else if (kind === "logging" && resources.has(s) && resources.has(t)) {
      addEdge("logging", s, t);
    }
  }

  // ── regions: place tiles that are not inside a subnet ──
  const regions = new Map<string, ArchRegion>();
  const region = (k: string) => {
    let r = regions.get(k);
    if (!r) {
      const c = bucket(k);
      r = { key: k, vnets: [], edge: [], outside: [], paas: { app: [], data: [], security: [], messaging: [], monitoring: [], dns: [], other: [] }, ...c };
      regions.set(k, r);
    }
    return r;
  };
  for (const v of vnets.values()) region(v.region).vnets.push(v);
  const global: string[] = [];
  for (const r of resources.values()) {
    if (r.subnetId) continue;
    const k = r.node.kind;
    if (r.region === "global" || GLOBAL_KINDS.has(k)) { r.region = "global"; global.push(r.id); continue; }
    const reg = region(r.region);
    if (EDGE_KINDS.has(k)) reg.edge.push(r.id);
    else if (COMPUTE_KINDS.has(k)) reg.outside.push(r.id);
    else reg.paas[PAAS_KIND[k] ?? "other"].push(r.id);
  }
  for (const k of cleanup.keys()) if (k !== "global") region(k);
  // Cleanup items of global-located public IPs / NSGs stay visible in the global box
  const globalCleanup = cleanup.get("global");
  regions.delete("global");

  // Deterministic order
  const name = (id: string) => resources.get(id)?.node.name ?? id;
  const byName = (a: string, b: string) => name(a).localeCompare(name(b)) || a.localeCompare(b);
  const byItem = (a: ArchCleanupItem, b: ArchCleanupItem) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const regionList = [...regions.values()];
  for (const reg of regionList) {
    // Largest VNets first (fills rows better), then by name
    const size = (v: ArchVnet) => v.subnets.reduce((n, sb) => n + sb.resources.length, 0);
    reg.vnets.sort((a, b) => size(b) - size(a) || a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id));
    for (const v of reg.vnets) {
      v.subnets.sort((a, b) => a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id));
      for (const s of v.subnets) { s.resources.sort(byName); s.nsgs.sort(); s.natGateways.sort(); s.publicIps.sort(); }
    }
    reg.edge.sort(byName);
    reg.outside.sort(byName);
    for (const c of PAAS_ORDER) reg.paas[c].sort(byName);
    reg.unusedPublicIps.sort(byItem);
    reg.unresolvedPublicIps.sort(byItem);
    reg.unusedNsgs.sort(byItem);
  }
  for (const r of resources.values()) { r.privateIps.sort(); r.publicIps.sort(); r.nsgs.sort(); r.nodePools.sort(); }
  regionList.sort((a, b) => regionTiles(b) - regionTiles(a) || a.key.localeCompare(b.key));
  global.sort(byName);
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const all = <K extends "unusedPublicIps" | "unresolvedPublicIps" | "unusedNsgs">(key: K) =>
    regionList.reduce((n, r) => n + r[key].length, 0) + (globalCleanup?.[key].length ?? 0);
  return {
    nodes: byId,
    resources,
    vnets,
    subnets,
    regions: regionList,
    global,
    edges,
    accounting,
    totals: {
      regions: regionList.length,
      vnets: vnets.size,
      subnets: subnets.size,
      tiles: resources.size,
      vms: [...resources.values()].filter((r) => r.node.kind === "vm").length,
      publicIpResources: new Set(edges.filter((e) => e.kind === "exposure" || e.kind === "ingress").map((e) => e.target)).size,
      privateEndpoints: [...resources.values()].filter((r) => r.node.kind === "privateEndpoint").length,
      unusedPublicIps: all("unusedPublicIps"),
      unresolvedPublicIps: all("unresolvedPublicIps"),
      unusedNsgs: all("unusedNsgs"),
      otherNics: [...subnets.values()].reduce((n, s) => n + s.otherNics, 0),
    },
  };
}

/** Tiles drawn for a region (RG, NIC, NSG, public IP never count). */
export function regionTiles(reg: ArchRegion): number {
  return (
    reg.vnets.reduce((s, v) => s + v.subnets.reduce((t, sb) => t + sb.resources.length, 0), 0) +
    reg.edge.length + reg.outside.length + PAAS_ORDER.reduce((s, c) => s + reg.paas[c].length, 0)
  );
}

// ──────────────────────────────────────────────────────────────
// Layout — header-on-top nested boxes, shelf packing, absolute coordinates
// ──────────────────────────────────────────────────────────────

export const ARCH = {
  LEAF_W: 188, LEAF_H: 74, GAP: 10, PAD: 12, PILL_W: 236, PILL_H: 72,
  /** Same-kind tiles in one subnet / lane group above this collapse into a stack */
  STACK_AT: 6, LANE_STACK_AT: 4,
  SUBNET_COLS: 3, VNETS_MAX_W: 1400, REGIONS_MAX_W: 2600,
} as const;
const HEAD = { root: 0, global: 36, region: 42, vnet: 38, subnet: 32, lane: 32, group: 28 } as const;
const MAXW = {
  root: Infinity, global: ARCH.LEAF_W, region: Infinity, vnet: 1260,
  subnet: ARCH.SUBNET_COLS * ARCH.LEAF_W + (ARCH.SUBNET_COLS - 1) * ARCH.GAP,
  lane: ARCH.LEAF_W, group: 2 * ARCH.LEAF_W + ARCH.GAP,
} as const;

export type ArchBoxType = keyof typeof HEAD;
export type ArchShape =
  | { id: string; shape: "box"; type: ArchBoxType; ref?: string; label: string; region?: string }
  | { id: string; shape: "tile"; ref: string }
  | { id: string; shape: "stack"; ref: string; kind: string; members: string[] }
  | { id: string; shape: "pill"; ref: string }
  | { id: string; shape: "ghost"; ref: string }
  | { id: string; shape: "internet"; region: string };

export type ArchRect = { x: number; y: number; w: number; h: number };
export type ArchPlaced = ArchShape & ArchRect & { depth: number; parent: string | null };
export type ArchDrawEdge = { id: string; kind: ArchEdgeKind; source: string; target: string; count: number };
export type ArchLayout = {
  shapes: ArchPlaced[];
  edges: ArchDrawEdge[];
  width: number;
  height: number;
  /** Graph id (resource, VNet, subnet) → the shape id it is drawn as right now */
  shownAt: Map<string, string>;
  /** Edges hidden because an end is in a region that is not shown */
  offscreen: ArchEdge[];
};

type TNode =
  | { t: "box"; shape: Extract<ArchShape, { shape: "box" }>; dir: "row" | "col"; children: TNode[]; minW?: number; maxW?: number }
  | { t: "leaf"; shape: Exclude<ArchShape, { shape: "box" }>; w: number; h: number };

export type ArchViewOptions = {
  /** Region key to show, or "all" */
  region: string;
  /** VNet ids drawn as a summary pill */
  collapsed: ReadonlySet<string>;
  /** Stack ids the user expanded */
  expandedStacks: ReadonlySet<string>;
  /** Edge kinds to draw (default DEFAULT_LAYERS) */
  layers?: ReadonlySet<ArchEdgeKind>;
};

/** VNets collapsed when a view opens: in one region, empty ones and those with more than `limit` tiles; in "all", every VNet. */
export function initialCollapsed(model: ArchModel, region: string, limit = 24): Set<string> {
  const s = new Set<string>();
  for (const reg of model.regions) {
    if (region !== "all" && reg.key !== region) continue;
    for (const v of reg.vnets) {
      const n = v.subnets.reduce((k, sb) => k + sb.resources.length, 0);
      if (region === "all" || n === 0 || n > limit) s.add(lower(v.node.id));
    }
  }
  return s;
}

/** Region shown by default: the one with the most drawn tiles (ties by name). */
export function defaultRegion(model: ArchModel): string {
  return model.regions[0]?.key ?? "all";
}

/** Box width that fits a header: name (~7.4px/char, wider for CJK), CIDR (mono ~6.8px/char) and badges. */
export function labelWidth(name: string, cidr: string | undefined, badges: number, min: number): number {
  const nameW = [...name].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 12.5 : 7.4), 0);
  const w = Math.round(nameW + (cidr ? cidr.length * 6.8 + 8 : 0) + badges + 64);
  return Math.min(Math.max(w, min), 640);
}

export function layoutArch(model: ArchModel, opts: ArchViewOptions): ArchLayout {
  const layers = opts.layers ?? new Set(DEFAULT_LAYERS);
  const shown = opts.region === "all" ? model.regions : model.regions.filter((r) => r.key === opts.region);
  const leaf = (shape: Exclude<ArchShape, { shape: "box" }>, w: number = ARCH.LEAF_W, h: number = ARCH.LEAF_H): TNode => ({ t: "leaf", shape, w, h });
  const box = (shape: Extract<ArchShape, { shape: "box" }>, dir: "row" | "col", children: TNode[], minW?: number, maxW?: number): TNode => ({ t: "box", shape, dir, children, minW, maxW });
  const shownAt = new Map<string, string>();

  /** Tiles of one container; same-kind runs above `at` become a stack unless expanded. */
  const tilesOf = (containerId: string, ids: string[], at: number): TNode[] => {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const k = model.resources.get(id)!.node.kind;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(id);
    }
    const kids: TNode[] = [];
    for (const [k, members] of groups) {
      const stackId = `stack:${containerId}:${k}`;
      if (members.length > at && !opts.expandedStacks.has(stackId)) {
        kids.push(leaf({ id: stackId, shape: "stack", ref: containerId, kind: k, members }));
        for (const id of members) shownAt.set(id, stackId);
      } else {
        for (const id of members) { kids.push(leaf({ id, shape: "tile", ref: id })); shownAt.set(id, id); }
      }
    }
    return kids;
  };

  const subnetNode = (s: ArchSubnet): TNode => {
    const sid = lower(s.node.id);
    shownAt.set(sid, sid);
    // Room for the header (name, CIDR, NSG badge) so the subnet name is not cut off
    const minW = labelWidth(s.node.name, s.node.endpoint, s.nsgs.length ? 96 : 0, 220);
    return box({ id: sid, shape: "box", type: "subnet", ref: sid, label: s.node.name }, "row", tilesOf(sid, s.resources, ARCH.STACK_AT), minW);
  };

  const vnetNode = (v: ArchVnet): TNode => {
    const vid = lower(v.node.id);
    shownAt.set(vid, vid);
    if (opts.collapsed.has(vid)) {
      for (const s of v.subnets) { shownAt.set(lower(s.node.id), vid); for (const id of s.resources) shownAt.set(id, vid); }
      return leaf({ id: vid, shape: "pill", ref: vid }, ARCH.PILL_W, ARCH.PILL_H);
    }
    return box({ id: vid, shape: "box", type: "vnet", ref: vid, label: v.node.name }, "row", v.subnets.map(subnetNode), labelWidth(v.node.name, v.node.endpoint, 120, 250));
  };

  const hasInternet = (key: string) => model.edges.some((e) => (e.kind === "ingress" || e.kind === "exposure") && e.source === internetId(key));

  const regionNode = (reg: ArchRegion): TNode => {
    const cols: TNode[] = [];
    const edgeKids: TNode[] = [];
    if (hasInternet(reg.key)) {
      shownAt.set(internetId(reg.key), internetId(reg.key));
      edgeKids.push(leaf({ id: internetId(reg.key), shape: "internet", region: reg.key }));
    }
    edgeKids.push(...tilesOf(`lane:edge:${reg.key}`, reg.edge, ARCH.LANE_STACK_AT));
    if (edgeKids.length) cols.push(box({ id: `lane:edge:${reg.key}`, shape: "box", type: "lane", label: "edge", region: reg.key }, "col", edgeKids));
    if (reg.vnets.length) cols.push(box({ id: `vnets:${reg.key}`, shape: "box", type: "root", label: "" }, "row", reg.vnets.map(vnetNode), undefined, ARCH.VNETS_MAX_W));
    if (reg.outside.length) cols.push(box({ id: `lane:outside:${reg.key}`, shape: "box", type: "lane", label: "outside", region: reg.key }, "col", tilesOf(`lane:outside:${reg.key}`, reg.outside, ARCH.LANE_STACK_AT)));
    const groups = PAAS_ORDER.filter((c) => reg.paas[c].length).map((c) =>
      box({ id: `paas:${c}:${reg.key}`, shape: "box", type: "group", label: c, region: reg.key }, "row", tilesOf(`paas:${c}:${reg.key}`, reg.paas[c], ARCH.LANE_STACK_AT)),
    );
    if (groups.length) cols.push(box({ id: `lane:paas:${reg.key}`, shape: "box", type: "lane", label: "paas", region: reg.key }, "col", groups, undefined, MAXW.group + 2 * ARCH.PAD));
    return box({ id: `region:${reg.key}`, shape: "box", type: "region", label: reg.key, region: reg.key }, "row", cols, 320);
  };

  const rootKids: TNode[] = [];
  if (model.global.length) {
    rootKids.push(box({ id: "global", shape: "box", type: "global", label: "global" }, "col", tilesOf("global", model.global, ARCH.LANE_STACK_AT)));
  }
  // Regions side by side while they fit, then wrap
  rootKids.push(box({ id: "regions", shape: "box", type: "root", label: "" }, "row", shown.map(regionNode), undefined, ARCH.REGIONS_MAX_W));

  // Endpoints in regions that are not shown → ghost tiles so the relationship stays visible
  const offscreen: ArchEdge[] = [];
  if (opts.region !== "all") {
    const ghostIds = new Set<string>();
    for (const e of model.edges) {
      if (!layers.has(e.kind) || e.kind === "ingress" || e.kind === "exposure") continue;
      const s = shownAt.get(e.source), t = shownAt.get(e.target);
      if (!!s === !!t) continue;
      offscreen.push(e);
      ghostIds.add(s ? e.target : e.source);
    }
    const ids = [...ghostIds].sort();
    if (ids.length) {
      for (const id of ids) shownAt.set(id, `ghost:${id}`);
      rootKids.push(box({ id: "elsewhere", shape: "box", type: "global", label: "elsewhere" }, "col", ids.map((id) => leaf({ id: `ghost:${id}`, shape: "ghost", ref: id }))));
    }
  }
  const root = box({ id: "root", shape: "box", type: "root", label: "" }, "row", rootKids);

  // ── measure / place ──
  type M = { n: TNode; w: number; h: number; rows: M[][] };
  const gapOf = (n: TNode) => (n.t === "box" && n.shape.type === "root" ? 24 : ARCH.GAP);
  const measure = (n: TNode): M => {
    if (n.t === "leaf") return { n, w: n.w, h: n.h, rows: [] };
    const kids = n.children.map(measure);
    const type = n.shape.type;
    const gap = gapOf(n);
    const maxW = n.dir === "col" ? 0 : n.maxW ?? MAXW[type];
    const rows: M[][] = [[]];
    let rw = 0;
    for (const c of kids) {
      const cur = rows[rows.length - 1]!;
      if (cur.length && rw + gap + c.w > maxW) { rows.push([]); rw = 0; }
      rw += (rows[rows.length - 1]!.length ? gap : 0) + c.w;
      rows[rows.length - 1]!.push(c);
    }
    const packed = rows.filter((r) => r.length);
    const innerW = Math.max(0, ...packed.map((r) => r.reduce((s, c) => s + c.w, 0) + gap * (r.length - 1)));
    const innerH = packed.reduce((s, r) => s + Math.max(...r.map((c) => c.h)), 0) + gap * Math.max(0, packed.length - 1);
    const framed = type !== "root";
    const pad = framed ? ARCH.PAD : 0;
    return {
      n,
      w: Math.max(innerW + pad * 2, framed ? n.minW ?? 0 : 0),
      h: HEAD[type] + (packed.length === 0 ? (framed ? 10 : 0) : innerH + pad),
      rows: packed,
    };
  };
  const shapes: ArchPlaced[] = [];
  const place = (m: M, x: number, y: number, depth: number, parent: string | null) => {
    shapes.push({ ...m.n.shape, x, y, w: m.w, h: m.h, depth, parent } as ArchPlaced);
    if (m.n.t === "leaf") return;
    const type = m.n.shape.type;
    const gap = gapOf(m.n);
    const pad = type === "root" ? 0 : ARCH.PAD;
    let cy = y + HEAD[type];
    for (const row of m.rows) {
      let cx = x + pad;
      const rh = Math.max(...row.map((c) => c.h));
      for (const c of row) {
        place(c, cx, cy, depth + 1, m.n.shape.id);
        cx += c.w + gap;
      }
      cy += rh + gap;
    }
  };
  const measured = measure(root);
  place(measured, 0, 0, 0, null);
  // Unframed wrappers only position their children
  const wrappers = new Set(["root", "regions", ...shapes.filter((s) => s.id.startsWith("vnets:")).map((s) => s.id)]);
  const parentOf = new Map(shapes.map((s) => [s.id, s.parent]));
  /** Nearest ancestor that is actually drawn */
  const framedParent = (p: string | null): string | null => {
    let cur = p;
    while (cur && wrappers.has(cur)) cur = parentOf.get(cur) ?? null;
    return cur;
  };
  const placed = shapes
    .filter((s) => !wrappers.has(s.id))
    .map((s) => (s.parent && wrappers.has(s.parent) ? { ...s, parent: framedParent(s.parent) } : s));
  const visible = new Set(placed.map((s) => s.id));

  // ── lines: roll up to what is visible, dedupe, count ──
  const drawn = new Map<string, ArchDrawEdge>();
  for (const e of model.edges) {
    if (!layers.has(e.kind)) continue;
    const s = shownAt.get(e.source), t = shownAt.get(e.target);
    if (!s || !t || s === t || !visible.has(s) || !visible.has(t)) continue;
    const id = `${e.kind}:${s}->${t}`;
    const d = drawn.get(id);
    if (d) d.count++;
    else drawn.set(id, { id, kind: e.kind, source: s, target: t, count: 1 });
  }
  return { shapes: placed, edges: [...drawn.values()], width: measured.w, height: measured.h, shownAt, offscreen };
}

/** Shapes directly connected to `id` by a drawn line (for selection highlight). */
export function neighbours(edges: ArchDrawEdge[], id: string): Set<string> {
  const s = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) s.add(e.target);
    if (e.target === id) s.add(e.source);
  }
  return s;
}

/** Region › VNet › Subnet path of a resource (for the inspector). */
export function locationPath(model: ArchModel, id: string): { region: string; vnet?: ArchitectureNode; subnet?: ArchitectureNode } | null {
  const r = model.resources.get(id);
  if (r) {
    if (!r.subnetId) return { region: r.region };
    const sub = model.subnets.get(r.subnetId)!;
    const vnet = model.vnets.get(sub.vnetId)!;
    return { region: vnet.region, vnet: vnet.node, subnet: sub.node };
  }
  const sub = model.subnets.get(id);
  if (sub) { const v = model.vnets.get(sub.vnetId)!; return { region: v.region, vnet: v.node }; }
  const v = model.vnets.get(id);
  return v ? { region: v.region } : null;
}

/** Ids matching a search (name, IP, CIDR) — tiles, VNets and subnets. */
export function searchArch(model: ArchModel, q: string): string[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hit = (n: ArchitectureNode, extra: string[] = []) =>
    n.name.toLowerCase().includes(s) || (n.endpoint ?? "").toLowerCase().includes(s) || extra.some((x) => x.includes(s));
  const out: string[] = [];
  for (const r of model.resources.values()) if (hit(r.node, [...r.privateIps, ...r.publicIps])) out.push(r.id);
  for (const [id, v] of model.vnets) if (hit(v.node)) out.push(id);
  for (const [id, sb] of model.subnets) if (hit(sb.node)) out.push(id);
  return out.sort();
}
