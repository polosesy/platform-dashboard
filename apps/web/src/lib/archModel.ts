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

import type { ArchitectureGraph, ArchitectureNode, InboundExposure } from "@aud/types";
import { measure, place, type PackBox, type PackNode } from "./boxPack";
import { routeOrthogonal, type RouteBox, type RRect, type Side } from "./archRoute";

export type ArchEdgeKind = "ingress" | "exposure" | "routes" | "privateLink" | "peering" | "outbound" | "udr" | "egress" | "hybrid" | "vnetIntegration" | "logging";
export const ARCH_EDGE_KINDS: ArchEdgeKind[] = ["ingress", "routes", "privateLink", "peering", "hybrid", "outbound", "udr", "egress", "vnetIntegration", "exposure", "logging"];
/** Layers drawn by default; VM public-IP exposure and logging are opt-in to keep the first view readable. */
export const DEFAULT_LAYERS: ArchEdgeKind[] = ["ingress", "routes", "privateLink", "peering", "hybrid", "outbound", "udr", "egress", "vnetIntegration"];
/**
 * Relationships repeated across the diagram (every PE → its service, every subnet → its NAT gateway, every
 * integrated app → its subnet): drawn only for the selected tile / box unless "all lines" is on — their facts stay
 * on screen as chips and badges (PE "→ target", PaaS "PE n", subnet "NAT name", app "VNet integration").
 */
export const FOCUS_KINDS: ReadonlySet<ArchEdgeKind> = new Set(["privateLink", "outbound", "udr", "vnetIntegration"]);

export type PaasCategory = "app" | "data" | "security" | "messaging" | "monitoring" | "dns" | "other";
export const PAAS_ORDER: PaasCategory[] = ["app", "data", "security", "messaging", "monitoring", "dns", "other"];

export const internetId = (region: string) => `internet:${region}`;
/** The Internet as the place outbound traffic goes (NAT → Internet): drawn on the right, apart from the inbound one */
export const internetOutId = (region: string) => `internet:${region}:out`;
/** "internet:koreacentral" / "internet:koreacentral:out" → "koreacentral" */
export const internetRegionOf = (id: string) => id.slice("internet:".length).replace(/:out$/, "");

const EXPOSURE_RANK: Record<InboundExposure["state"], number> = { open: 4, scoped: 3, unknown: 2, noNsg: 1, closed: 0 };
const mostExposedState = (a: InboundExposure["state"] | undefined, b: InboundExposure["state"]) => (a && EXPOSURE_RANK[a] >= EXPOSURE_RANK[b] ? a : b);

export type ArchResource = {
  id: string;
  node: ArchitectureNode;
  /** Region key ("koreacentral"); "global" for non-regional services; "unknown" when Azure reported no location */
  region: string;
  subnetId: string | null;
  /** Subnets beyond the one the tile is drawn in (multi-NIC VMs, multi-pool AKS) */
  extraSubnets: string[];
  privateIps: string[];
  publicIps: string[];
  /** Internet → this host through its own public IP (PIP-04, from the API's NSG verdict); most exposed NIC wins */
  exposure?: InboundExposure["state"];
  /** NIC-level NSG names */
  nsgs: string[];
  /** AKS: absorbed node-pool scale sets */
  nodePools: string[];
  /** Flexible-mode scale set: its instance VMs (ordinary VM resources, catalog VMSS-03) */
  instances: string[];
  nicCount: number;
};

/** A subnet's first exit (API services/subnetEgress.ts, catalog NET-09): via, target, and a NAT a UDR bypasses */
export type ArchEgress = {
  via: "appliance" | "gateway" | "nat" | "publicIp" | "default" | "noExit" | "dropped" | "unknown";
  targetId?: string; holder?: "firewall" | "vm" | "ilb"; nextHopIp?: string; evidence?: string;
  routeTable?: { name: string; prefix: string }; unresolved?: "none" | "ambiguous" | "unreadable";
  bgpMayOverride?: boolean; natBypassed?: string; ipForwardingOff?: boolean;
};
export type ArchSubnet = {
  node: ArchitectureNode;
  /** Its first exit, when the API read it (older graphs / the sample: absent) */
  egress?: ArchEgress;
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
  /** Public entry points of the region (left, by the Internet) */
  edge: string[];
  /** Outbound-only exits (NAT gateways, public LBs with no inbound rule) — the right side, by the outbound Internet */
  egress: string[];
  outside: string[];
  paas: Record<PaasCategory, string[]>;
  /** Public IPs attached to nothing */
  unusedPublicIps: ArchCleanupItem[];
  /** Public IPs whose owner is not in the graph — detail = owner type from the ID */
  unresolvedPublicIps: ArchCleanupItem[];
  /** NSGs associated with nothing */
  unusedNsgs: ArchCleanupItem[];
};
/** state: peering (the worse side's peeringState), hybrid (worst connection status), ingress "unknown" (config unread) */
export type ArchEdge = { id: string; kind: ArchEdgeKind; source: string; target: string; state?: string };

/**
 * An on-premises site (catalog EDGE-09): a local network gateway reached by S2S connections of a VPN gateway in the
 * graph — from the gateway's metadata.s2s (not a graph node). One site per local network gateway; connections without
 * a readable one are a site each. Status and byte counters are as read with the topology (not live, not a rate).
 */
export type ArchSite = {
  id: string; name: string; gatewayId: string; region: string;
  prefixes: string[]; peerIp: string | null; fqdn: string | null; bgp: boolean; lngKnown: boolean;
  connections: Array<{ name: string; status: string; protocol: string | null; ingressBytes: number | null; egressBytes: number | null; nat: boolean }>;
};

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
  /**
   * Traffic-entry order (computeFlowRanks): resource id → steps from the Internet along configured inward lines
   * (Internet 0 → Front Door 1 → App Gateway 2 → backends 3 …); chains no Internet line reaches start at
   * FLOW_UNREACHED. Ordering only — never a drawn line. `flowVia` = the step before (for "why here").
   */
  flowRank: Map<string, number>;
  flowVia: Map<string, string>;
  /** On-premises sites by id ("site:<lng id>") */
  sites: Map<string, ArchSite>;
  totals: {
    regions: number; vnets: number; subnets: number; tiles: number; vms: number; publicIpResources: number;
    privateEndpoints: number; unusedPublicIps: number; unresolvedPublicIps: number; unusedNsgs: number; otherNics: number;
  };
};

const lower = (s: string) => s.toLowerCase();
/**
 * Region rules (docs/architecture/azure-resource-relationships.md): REG-01 a location is the region box ·
 * REG-02 "global" only when Azure says so (Front Door, Traffic Manager, DNS zones) · REG-03 no location =
 * "unknown", never guessed · REG-04 a Private Endpoint line may cross regions
 */
export const UNKNOWN_REGION = "unknown";
const regionKey = (loc: string | undefined) => (loc && loc.trim() ? lower(loc).replace(/\s+/g, "") : UNKNOWN_REGION);

const PAAS_KIND: Partial<Record<string, PaasCategory>> = {
  appService: "app", functionApp: "app",
  storage: "data", sql: "data", cosmosDb: "data", redis: "data", postgres: "data",
  keyVault: "security",
  serviceBus: "messaging", eventHub: "messaging",
  logAnalytics: "monitoring", appInsights: "monitoring",
  dns: "dns",
};
/** Network edge of a region: entry points and egress. */
const EDGE_KINDS = new Set<string>(["lb", "natGateway", "appGateway", "firewall", "agc", "vnetGateway", "bastion"]);
const GLOBAL_KINDS = new Set<string>(["frontDoor", "trafficManager"]);
const COMPUTE_KINDS = new Set<string>(["vm", "vmss", "aks", "containerApp"]);
const OMITTED = new Set<string>(["subscription", "resourceGroup"]);
/** Ingress targets: a public IP on these is an entry point, not a single exposed host. */
// VPN/ER gateway and Bastion: their public IP is the service's own entry (CT-07), not a host's
const ENTRY_KINDS = new Set<string>(["lb", "appGateway", "firewall", "vnetGateway", "bastion"]);

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
  const edgesIn: Array<{ kind: string; s: string; t: string; meta?: ArchitectureGraph["edges"][number]["metadata"] }> = [];
  const out = new Map<string, Array<{ kind: string; target: string }>>();
  const inc = new Map<string, Array<{ kind: string; source: string }>>();
  for (const e of graph.edges) {
    const s = lower(e.source), t = lower(e.target);
    if (!byId.has(s) || !byId.has(t)) continue;
    edgesIn.push({ kind: e.kind, s, t, ...(e.metadata ? { meta: e.metadata } : {}) });
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
    const eg = n.metadata?.egress as ArchEgress | undefined;
    const sub: ArchSubnet = { node: n, vnetId: vnetId!, resources: [], nsgs: [], natGateways: [], otherNics: 0, publicIps: [], ...(eg?.via ? { egress: eg } : {}) };
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
  // Flexible-mode instances: ordinary VMs that name their scale set — drawn inside the scale-set tile (VMSS-03)
  const flexOwner = new Map<string, string>();
  for (const [id, n] of byId) if (n.kind === "vm") for (const e of outOf(id, "member-of")) if (kindOf(e.target) === "vmss" && !vmssOwner.has(e.target)) flexOwner.set(id, e.target);
  const flexMembers = (vmss: string) => [...flexOwner].filter(([, o]) => o === vmss).map(([vm]) => vm).sort();

  // ── tiles ──
  const resources = new Map<string, ArchResource>();
  for (const [id, n] of byId) {
    // The subscription is the outer frame of the drawing; resource groups are a filter, not a box
    if (n.kind === "subscription") { account(id, "container"); continue; }
    if (OMITTED.has(n.kind)) { account(id, "omitted"); continue; }
    if (n.kind === "vnet" || n.kind === "subnet" || n.kind === "nic" || n.kind === "nsg" || n.kind === "publicIP") continue;
    if (n.kind === "vmss" && vmssOwner.has(id)) continue;
    if (n.kind === "vm" && flexOwner.has(id)) continue;
    const r: ArchResource = { id, node: n, region: regionKey(n.location), subnetId: null, extraSubnets: [], privateIps: [], publicIps: [], nsgs: [], nodePools: [], instances: [], nicCount: 0 };
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
    } else if (["vmss", "lb", "appGateway", "firewall", "privateEndpoint", "containerApp", "agc", "vnetGateway", "bastion"].includes(n.kind)) {
      subs = subnetsOf(id, ["network", "connects", "attached-to"]);
      if (n.kind === "vmss") {
        // Flexible: the instances' NICs place the tile when the scale-set model names no subnet
        for (const vm of flexMembers(id)) {
          r.instances.push(byId.get(vm)!.name);
          for (const e of inOf(vm, "bound-to")) {
            if (kindOf(e.source) !== "nic") continue;
            r.nicCount++;
            subs.push(...subnetsOf(e.source, ["attached-to"]));
            const ip = ipOf(byId.get(e.source));
            if (ip) r.privateIps.push(ip);
          }
        }
      }
    } else if (n.kind === "postgres" || n.kind === "redis") {
      // VNet-injected only through an explicit subnet relation (PAAS-02 delegated subnet, PAAS-04 Redis injection);
      // service-endpoint rules are not placement
      subs = subnetsOf(id, ["network"]);
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
  for (const [vm, set] of flexOwner) account(vm, resources.has(set) ? "absorbed" : "omitted", resources.has(set) ? set : undefined);
  /** The tile that draws a VM: itself, or its Flexible scale set */
  const vmTile = (vm: string | undefined): string | undefined => {
    if (!vm) return undefined;
    if (resources.has(vm)) return vm;
    const set = flexOwner.get(vm);
    return set && resources.has(set) ? set : undefined;
  };

  // NICs: into their VM; otherwise counted on their subnet (never re-classified by name)
  const nicSubnet = new Map<string, string>();
  for (const [id, n] of byId) {
    if (n.kind !== "nic") continue;
    const owner = vmTile(nicOwner.get(id));
    if (owner) { account(id, "absorbed", owner); continue; }
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
      const vm = vmTile(nicOwner.get(e.target));
      if (vm) { pushUnique(resources.get(vm)!.nsgs, n.name); into ??= vm; continue; }
      const viaNic = nicSubnet.get(e.target);
      if (viaNic) { pushUnique(subnets.get(viaNic)!.nsgs, n.name); into ??= viaNic; }
    }
    if (into) account(id, "absorbed", into);
    else { bucket(regionKey(n.location)).unusedNsgs.push({ id, name: n.name }); account(id, "counted"); }
  }

  const edges: ArchEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (kind: ArchEdgeKind, source: string, target: string, state?: string) => {
    if (source === target) return;
    const [a, b] = kind === "peering" && source > target ? [target, source] : [source, target];
    const id = `${kind}:${a}->${b}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, kind, source: a, target: b, ...(state ? { state } : {}) });
  };
  // NET-09: a NAT carries outbound traffic only for subnets whose first exit it is. Graphs without exits read (older
  // API, the sample) keep drawing every attached NAT
  const egressKnown = [...subnets.values()].some((s) => !!s.egress);
  const natUsed = new Set([...subnets.values()].filter((s) => s.egress?.via === "nat" && s.egress.targetId).map((s) => lower(s.egress!.targetId!)));
  /** The tile that shows an absorbed endpoint (NIC → VM, node-pool VMSS → AKS). */
  const shownAs = (id: string): string | null => {
    if (resources.has(id)) return id;
    const k = kindOf(id);
    if (k === "nic") return vmTile(nicOwner.get(id)) ?? null;
    if (k === "vm") return vmTile(id) ?? null;
    if (k === "vmss") { const aks = vmssOwner.get(id); return aks && resources.has(aks) ? aks : null; }
    return null;
  };

  // Public IPs → owner badge; Internet → owner line (entry points = ingress, hosts = exposure) — PIP-01;
  // a public IP with no owner is listed for cleanup — PIP-03
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
      // A NAT Gateway public IP is egress-only; an entry point no inbound rule uses (outbound-only LB, App Gateway
      // with only private listeners) is not an inbound path either (catalog LB-04, AGW-02)
      const noInbound = ENTRY_KINDS.has(ok) && r.node.metadata?.inboundRules === 0;
      // A host's own public IP (PIP-04): the line only when the NSGs let the Internet in — closed / noNsg (Standard
      // without an NSG is closed by default) keep the badge, no line; no verdict (older API, sample) keeps the line
      const verdict = (byId.get(ownerId)?.metadata?.inboundExposure as InboundExposure | undefined)?.state;
      if (!ENTRY_KINDS.has(ok) && verdict) r.exposure = mostExposedState(r.exposure, verdict);
      const closed = !ENTRY_KINDS.has(ok) && (verdict === "closed" || verdict === "noNsg");
      if (ok !== "natGateway" && !noInbound && !closed) addEdge(ENTRY_KINDS.has(ok) ? "ingress" : "exposure", internetId(r.region), owner);
      // NAT gateway with a public IP: the subnets' outbound path to the Internet (configuration, never traffic)
      // to the Internet on the right (outbound), only when some subnet's first exit is this NAT (NET-09)
      if (ok === "natGateway" && (!egressKnown || natUsed.has(owner))) addEdge("egress", owner, internetOutId(r.region));
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

  // AGC-03: Internet → Application Gateway for Containers only through a public frontend
  for (const r of resources.values()) {
    if (r.node.kind === "agc" && Number(r.node.metadata?.publicFrontends ?? 0) > 0) addEdge("ingress", internetId(r.region), r.id);
    // EDGE-12: Internet → Front Door (Standard/Premium) when an enabled endpoint has an enabled route — the profile's
    // public entry. Configuration not readable → a dashed "unknown" line; classic / no route → none (never assumed)
    if (r.node.kind === "frontDoor" && !r.node.metadata?.classic) {
      const m = r.node.metadata ?? {};
      if (m.configUnreadable) addEdge("ingress", internetId("global"), r.id, "unknown");
      else if (Number(m.activeRoutes ?? 0) > 0 && Number(m.endpoints ?? 0) > 0) addEdge("ingress", internetId("global"), r.id);
    }
  }

  // Configuration lines
  for (const { kind, s, t, meta } of edgesIn) {
    const sk = kindOf(s), tk = kindOf(t);
    // LB / AGW → backend, AGC → AKS (AGC-04), Front Door → origin resource (EDGE-04..06, crosses regions)
    if (kind === "routes" && (sk === "lb" || sk === "appGateway" || sk === "agc" || sk === "frontDoor")) {
      const target = shownAs(t);
      if (target && resources.has(s)) addEdge("routes", s, target);
    } else if (kind === "routes" && tk === "lb" && (sk === "vmss" || sk === "vm")) {
      // Outbound SNAT rule (scale set → LB) — same pair as the inbound rule, one line
      const source = shownAs(s);
      if (source) addEdge("routes", t, source);
    } else if (kind === "privateLink") {
      const target = shownAs(t);
      if (resources.has(s) && target) addEdge("privateLink", s, target);
    } else if (kind === "peering" && vnets.has(s) && vnets.has(t)) {
      addEdge("peering", s, t, meta?.peeringState);
    } else if (subnets.has(s) && tk === "natGateway" && resources.has(t)) {
      // The NAT is attached either way (badge); the line only when it is the subnet's first exit (NET-09)
      const eg = subnets.get(s)!.egress;
      if (!eg || eg.via === "nat") addEdge("outbound", s, t);
      pushUnique(subnets.get(s)!.natGateways, byId.get(t)!.name);
    } else if (kind === "routes" && subnets.has(s) && meta?.rel === "SEC-04") {
      // SEC-04: the subnet's 0.0.0.0/0 UDR goes to this appliance (firewall / NVA VM / its internal LB) — first exit only
      const target = shownAs(t);
      if (target) addEdge("udr", s, target);
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
      r = { key: k, vnets: [], edge: [], egress: [], outside: [], paas: { app: [], data: [], security: [], messaging: [], monitoring: [], dns: [], other: [] }, ...c };
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
    // Outbound-only exits on the right: NAT gateways, a public LB no inbound rule uses (LB-04 — e.g. AKS SNAT)
    if (k === "natGateway" || (k === "lb" && r.node.metadata?.inboundRules === 0 && r.publicIps.length > 0)) reg.egress.push(r.id);
    else if (EDGE_KINDS.has(k)) reg.edge.push(r.id);
    else if (COMPUTE_KINDS.has(k)) reg.outside.push(r.id);
    // PaaS outside VNets (SQL logical server PAAS-05, public-access PostgreSQL PAAS-03): the region's PaaS lane
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
    reg.egress.sort(byName);
    reg.outside.sort(byName);
    for (const c of PAAS_ORDER) reg.paas[c].sort(byName);
    reg.unusedPublicIps.sort(byItem);
    reg.unresolvedPublicIps.sort(byItem);
    reg.unusedNsgs.sort(byItem);
  }
  for (const r of resources.values()) { r.privateIps.sort(); r.publicIps.sort(); r.nsgs.sort(); r.nodePools.sort(); r.instances.sort(); }
  // "Region unknown" last
  regionList.sort((a, b) => Number(a.key === UNKNOWN_REGION) - Number(b.key === UNKNOWN_REGION) || regionTiles(b) - regionTiles(a) || a.key.localeCompare(b.key));
  global.sort(byName);
  edges.sort((a, b) => a.id.localeCompare(b.id));

  // ── on-premises sites (EDGE-09): per local network gateway, from the VPN gateways' metadata.s2s ──
  type S2s = { name?: string; status?: string; protocol?: string | null; ingressBytes?: number | null; egressBytes?: number | null; nat?: boolean; connectionId?: string;
    lng?: { id?: string; name?: string; prefixes?: string[]; peerIp?: string | null; fqdn?: string | null; bgp?: boolean } | null };
  const sites = new Map<string, ArchSite>();
  const STATUS_RANK: Record<string, number> = { connected: 0, connecting: 1, unknown: 2, notconnected: 3 };
  for (const r of [...resources.values()].sort((a, b) => cmpStr(a.id, b.id))) {
    if (r.node.kind !== "vnetGateway") continue;
    for (const c of (r.node.metadata?.s2s as S2s[] | undefined) ?? []) {
      const key = lower(c.lng?.id ?? c.connectionId ?? `${r.id}/${c.name ?? "connection"}`);
      const id = `site:${key}`;
      const site = sites.get(id) ?? (() => {
        const s: ArchSite = {
          id, name: c.lng?.name ?? c.name ?? "on-premises", gatewayId: r.id, region: r.region,
          prefixes: [...(c.lng?.prefixes ?? [])], peerIp: c.lng?.peerIp ?? null, fqdn: c.lng?.fqdn ?? null, bgp: !!c.lng?.bgp, lngKnown: !!c.lng, connections: [],
        };
        sites.set(id, s);
        return s;
      })();
      site.connections.push({ name: c.name ?? "", status: c.status ?? "Unknown", protocol: c.protocol ?? null, ingressBytes: c.ingressBytes ?? null, egressBytes: c.egressBytes ?? null, nat: !!c.nat });
    }
  }
  for (const s of sites.values()) {
    const worst = s.connections.map((c) => c.status).sort((a, b) => (STATUS_RANK[lower(b)] ?? 2) - (STATUS_RANK[lower(a)] ?? 2))[0] ?? "Unknown";
    addEdge("hybrid", s.gatewayId, s.id, worst);
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const flow = computeFlowRanks(resources, edges);
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
    flowRank: flow.rank,
    flowVia: flow.via,
    sites,
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

// ──────────────────────────────────────────────────────────────
// Traffic-entry order — "left to right = the way requests come in"
// ──────────────────────────────────────────────────────────────

/** Configured lines that point the way a request travels inward (Internet → entry → backend → PE → service) */
const FLOW_KINDS: ReadonlySet<ArchEdgeKind> = new Set(["ingress", "exposure", "routes", "privateLink"]);
/**
 * Not used: VNet integration is the app's OUTBOUND path; outbound / egress are return paths (they would pull NAT to
 * the right); peering has no direction; logging is sideways.
 */
const FLOW_ROOT = "internet";
/** Front Door / Traffic Manager are public by design: ranked right after the Internet (ordering only, never a line) */
const PUBLIC_ENTRY_KINDS = new Set<string>(["trafficManager"]);
/** Chains no Internet line reaches (an internal LB → its pool, PE → service) are ranked from their own start, after these */
export const FLOW_UNREACHED = 1000;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Longest-path layering over the inward lines (Sugiyama): a resource's rank is the most steps any configured inward
 * path takes to reach it — Internet 0, Front Door 1, the App Gateway that is its origin 2 (even when that gateway also
 * has its own public IP), the scale set behind it 3. Lines that loop share one rank (strongly connected components).
 * Deterministic: depends only on the graph. O(V + E).
 */
export function computeFlowRanks(resources: ReadonlyMap<string, ArchResource>, edges: readonly ArchEdge[]): { rank: Map<string, number>; via: Map<string, string> } {
  const key = (id: string) => (id.startsWith("internet:") ? FLOW_ROOT : id);
  const adj = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    nodes.add(a);
    nodes.add(b);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of edges) {
    if (!FLOW_KINDS.has(e.kind)) continue;
    const a = key(e.source), b = key(e.target);
    if ((a === FLOW_ROOT || resources.has(a)) && resources.has(b)) link(a, b);
  }
  for (const r of resources.values()) if (PUBLIC_ENTRY_KINDS.has(r.node.kind)) link(FLOW_ROOT, r.id);
  const ids = [...nodes].sort(cmpStr);
  const out = (id: string) => [...(adj.get(id) ?? [])].sort(cmpStr);

  // Tarjan's strongly connected components (components come out sinks first)
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [];
  const comps: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of out(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const c: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); c.push(w); } while (w !== v);
      comps.push(c.sort(cmpStr));
    }
  };
  for (const v of ids) if (!index.has(v)) visit(v);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => { for (const v of c) compOf.set(v, i); });
  const topo = comps.map((_, i) => i).reverse();

  // Longest path from the Internet, then from the start of every chain it does not reach
  const dist = new Map<number, number>();
  const via = new Map<string, string>();
  const relax = (pass: (c: number) => boolean) => {
    for (const c of topo) {
      if (!pass(c)) continue;
      const d = dist.get(c);
      if (d === undefined) continue;
      for (const v of comps[c]!) {
        for (const w of out(v)) {
          const t = compOf.get(w)!;
          if (t === c || !pass(t)) continue;
          const cur = dist.get(t);
          if (cur === undefined || d + 1 > cur) {
            dist.set(t, d + 1);
            for (const m of comps[t]!) via.set(m, v);
          }
        }
      }
    }
  };
  const root = compOf.get(FLOW_ROOT);
  if (root !== undefined) { dist.set(root, 0); relax(() => true); }
  const reached = new Set(dist.keys());
  for (const c of topo) {
    if (reached.has(c)) continue;
    if (!dist.has(c)) dist.set(c, FLOW_UNREACHED);
    // propagate from this start (its predecessors, if any, came earlier in topological order)
    const d = dist.get(c)!;
    for (const v of comps[c]!) {
      for (const w of out(v)) {
        const t = compOf.get(w)!;
        if (t === c || reached.has(t)) continue;
        const cur = dist.get(t);
        if (cur === undefined || d + 1 > cur) { dist.set(t, d + 1); for (const m of comps[t]!) via.set(m, v); }
      }
    }
  }
  const rank = new Map<string, number>();
  for (const [c, d] of dist) for (const v of comps[c]!) if (v !== FLOW_ROOT) rank.set(v, d);
  return { rank, via };
}

/** "Why here": the inward path that sets a tile's rank — ["internet", frontDoor, appGateway, id] (empty = no rank) */
export function flowPath(model: Pick<ArchModel, "flowRank" | "flowVia">, id: string): string[] {
  if (!model.flowRank.has(id)) return [];
  const path = [id];
  const seen = new Set(path);
  let cur = model.flowVia.get(id);
  while (cur && !seen.has(cur)) {
    path.push(cur);
    seen.add(cur);
    cur = model.flowVia.get(cur);
  }
  return path.reverse();
}

/** Tiles drawn for a region (RG, NIC, NSG, public IP never count). */
export function regionTiles(reg: ArchRegion): number {
  return (
    reg.vnets.reduce((s, v) => s + v.subnets.reduce((t, sb) => t + sb.resources.length, 0), 0) +
    reg.edge.length + reg.egress.length + reg.outside.length + PAAS_ORDER.reduce((s, c) => s + reg.paas[c].length, 0)
  );
}

// ──────────────────────────────────────────────────────────────
// Category filter ("표시 범위") — hide + re-layout, with one hop of configured context.
// Works on the model before layout, so layoutArch is unchanged and hidden tiles in the
// same region can never turn into "other region" ghosts.
// ──────────────────────────────────────────────────────────────

export type ArchCategory = "network" | "compute" | PaasCategory;
export const ARCH_CATEGORIES: ArchCategory[] = ["network", "compute", "app", "data", "security", "messaging", "monitoring", "dns", "other"];

/** Same buckets as the layout lanes — never guessed from names. */
export function archCategoryOf(kind: string): ArchCategory {
  if (COMPUTE_KINDS.has(kind)) return "compute";
  if (EDGE_KINDS.has(kind) || GLOBAL_KINDS.has(kind) || kind === "privateEndpoint") return "network";
  return PAAS_KIND[kind] ?? "other";
}

/** Tile count per category in a region ("all" = every region) plus global services. */
export function categoryCounts(model: ArchModel, region: string): Record<ArchCategory, number> {
  const out = Object.fromEntries(ARCH_CATEGORIES.map((c) => [c, 0])) as Record<ArchCategory, number>;
  for (const r of model.resources.values()) {
    if (region !== "all" && r.region !== region && r.region !== "global") continue;
    out[archCategoryOf(r.node.kind)]++;
  }
  return out;
}

/** Line kinds whose other end is kept as context (configured dependencies of a shown tile). */
const CONTEXT_EDGES = new Set<ArchEdgeKind>(["routes", "privateLink"]);

export type ArchFilterView = {
  /** Filtered model (the same object when nothing is filtered) */
  model: ArchModel;
  active: boolean;
  /** Every resource that is drawn (category match + context) */
  keep: ReadonlySet<string> | null;
  /** Resources kept only because a shown tile connects to them (routes / private link, one hop) */
  context: ReadonlySet<string>;
  /** Lines with exactly one end shown — what the filter cut off from visible tiles */
  crossing: ArchEdge[];
  /** Lines with both ends hidden */
  internal: number;
  /** VNet / subnet id → resources hidden inside it */
  hiddenIn: ReadonlyMap<string, number>;
  /** Resources kept (shown + context) / all resources */
  kept: number;
  total: number;
};

export function filterArchModel(model: ArchModel, cats: ReadonlySet<ArchCategory> | null): ArchFilterView {
  const total = model.resources.size;
  if (!cats || ARCH_CATEGORIES.every((c) => cats.has(c))) {
    return { model, active: false, keep: null, context: new Set(), crossing: [], internal: 0, hiddenIn: new Map(), kept: total, total };
  }
  const k0 = new Set<string>();
  for (const r of model.resources.values()) if (cats.has(archCategoryOf(r.node.kind))) k0.add(r.id);
  const context = new Set<string>();
  for (const e of model.edges) {
    if (!CONTEXT_EDGES.has(e.kind)) continue;
    if (k0.has(e.source) && model.resources.has(e.target) && !k0.has(e.target)) context.add(e.target);
    if (k0.has(e.target) && model.resources.has(e.source) && !k0.has(e.source)) context.add(e.source);
  }
  const keep = new Set([...k0, ...context]);
  const networkOn = cats.has("network");
  const hiddenIn = new Map<string, number>();
  const keptVnets = new Map<string, ArchVnet>();
  const keptSubnets = new Map<string, ArchSubnet>();

  const regions: ArchRegion[] = [];
  for (const reg of model.regions) {
    const vnets: ArchVnet[] = [];
    for (const v of reg.vnets) {
      const vid = lower(v.node.id);
      let hiddenV = 0;
      const subs: ArchSubnet[] = [];
      for (const s of v.subnets) {
        const res = s.resources.filter((id) => keep.has(id));
        const hidden = s.resources.length - res.length;
        hiddenV += hidden;
        if (res.length || networkOn) {
          const copy: ArchSubnet = { ...s, resources: res };
          subs.push(copy);
          keptSubnets.set(lower(s.node.id), copy);
          if (hidden) hiddenIn.set(lower(s.node.id), hidden);
        }
      }
      if (subs.length || networkOn) {
        const copy: ArchVnet = { ...v, subnets: subs };
        vnets.push(copy);
        keptVnets.set(vid, copy);
        if (hiddenV) hiddenIn.set(vid, hiddenV);
      }
    }
    const pick = (ids: string[]) => ids.filter((id) => keep.has(id));
    const paas = Object.fromEntries(PAAS_ORDER.map((c) => [c, pick(reg.paas[c])])) as Record<PaasCategory, string[]>;
    const next: ArchRegion = { ...reg, vnets, edge: pick(reg.edge), egress: pick(reg.egress), outside: pick(reg.outside), paas };
    if (vnets.length || regionTiles(next) > 0) regions.push(next);
  }
  const global = model.global.filter((id) => keep.has(id));

  // An end is shown if it is a kept resource, subnet or VNet; the Internet only when its target is
  const shown = (id: string, other: string) =>
    keep.has(id) || keptSubnets.has(id) || keptVnets.has(id) || ((id.startsWith("internet:") || id.startsWith("site:")) && keep.has(other));
  const edges: ArchEdge[] = [];
  const crossing: ArchEdge[] = [];
  let internal = 0;
  for (const e of model.edges) {
    const s = shown(e.source, e.target), t = shown(e.target, e.source);
    if (s && t) edges.push(e);
    else if (s || t) crossing.push(e);
    else internal++;
  }
  return {
    model: { ...model, regions, global, edges, vnets: keptVnets, subnets: keptSubnets },
    active: true,
    keep,
    context,
    crossing,
    internal,
    hiddenIn,
    kept: keep.size,
    total,
  };
}

// ──────────────────────────────────────────────────────────────
// Layout — header-on-top nested boxes, shelf packing, absolute coordinates
// ──────────────────────────────────────────────────────────────

export const ARCH = {
  /** GAP = room between tiles (a line runs in its middle); BOX_GAP = room between boxes (two lines side by side) */
  LEAF_W: 188, LEAF_H: 74, GAP: 14, BOX_GAP: 28, PAD: 12, PILL_W: 236, PILL_H: 72,
  /** Same-kind tiles in one subnet / lane group above this collapse into a stack */
  STACK_AT: 6, LANE_STACK_AT: 4,
  SUBNET_COLS: 3, VNETS_MAX_W: 1400, REGIONS_MAX_W: 2600,
  /** Most columns a tile container may have (manual grid) */
  MAX_COLS: 6,
  /** A VNet laid out as traffic-entry columns falls back to wrapped rows above this width */
  FLOW_VNET_MAX_W: 2600,
} as const;
const HEAD = { root: 0, external: 32, subscription: 40, global: 36, region: 42, vnet: 38, subnet: 32, lane: 32, group: 28 } as const;
/** Header strip height per box type (lines never cross it — the tests check) */
export const ARCH_HEAD: Readonly<Record<keyof typeof HEAD, number>> = HEAD;
const MAXW = {
  root: Infinity, external: ARCH.LEAF_W, subscription: Infinity, global: ARCH.LEAF_W, region: Infinity, vnet: 1260,
  subnet: ARCH.SUBNET_COLS * ARCH.LEAF_W + (ARCH.SUBNET_COLS - 1) * ARCH.GAP,
  lane: ARCH.LEAF_W, group: 2 * ARCH.LEAF_W + ARCH.GAP,
} as const;
/** The one Internet tile — outside the subscription (not an Azure resource); every region's Internet maps to it */
export const INTERNET_TILE = "internet";
/** The Internet outbound traffic goes to (NAT → Internet): one tile on the RIGHT, outside the subscription — traffic
 * reads left → right (in on the left, out on the right), so egress lines never run back across the diagram */
export const INTERNET_OUT_TILE = "internet-out";

export type ArchBoxType = keyof typeof HEAD;
/** One item of a subnet header row (subnetHead): the renderer draws exactly these rows */
export type ArchHeadItem = { k: "name" | "cidr" | "nsg" | "nat" | "egress" | "pip" | "nic" | "hidden" | "more"; n?: number };
/** Exits named on the subnet header (the first one only, NET-09): a UDR to an appliance / the gateway, a dropped default route, an unclear one */
export const shownExit = (e: ArchEgress | undefined) => !!e && (e.via === "appliance" || e.via === "gateway" || e.via === "dropped" || (e.via === "unknown" && e.evidence === "udr"));
export type ArchShape =
  /** rows: a subnet header laid out in rows (name · CIDR · NSG · NAT …) when one row does not fit */
  | { id: string; shape: "box"; type: ArchBoxType; ref?: string; label: string; region?: string; rows?: ArchHeadItem[][] }
  | { id: string; shape: "tile"; ref: string }
  | { id: string; shape: "stack"; ref: string; kind: string; members: string[] }
  /** An expanded stack's own slot: folds it back (ref = the stack id). UI only — no graph node, no edges, not exported */
  | { id: string; shape: "fold"; ref: string; kind: string; n: number }
  | { id: string; shape: "pill"; ref: string }
  | { id: string; shape: "ghost"; ref: string }
  /** regions: the region keys whose Internet lines end here */
  | { id: string; shape: "internet"; regions: string[]; out?: boolean }
  /** An on-premises site (ArchSite, ref = its id) — outside Azure, under the Internet */
  | { id: string; shape: "site"; ref: string };

export type ArchRect = { x: number; y: number; w: number; h: number };
/** head = the header strip height of a box as laid out (taller when a subnet header wraps; 0 for tiles) */
export type ArchPlaced = ArchShape & ArchRect & { depth: number; parent: string | null; head: number };
export type ArchSide = Side;
export type ArchDrawEdge = {
  id: string; kind: ArchEdgeKind; source: string; target: string; count: number;
  /** "focus" = drawn only while one of its ends is selected (FOCUS_KINDS, unless all lines are on) */
  display: "always" | "focus";
  /** Orthogonal route (lib/archRoute): absolute points from the source side to the target side */
  points: Array<[number, number]>;
  sourceSide: Side;
  targetSide: Side;
  /** No free path was found (drawn as an L) */
  fallback?: boolean;
  /** Peering state (worse side) / S2S connection status / "unknown" for an unread entry (ArchEdge.state) */
  state?: string;
  /** Drawn by the user (lib/archArrange applyManualLines): the style chosen, and the auto lines it replaces */
  manual?: "straight" | "curve" | "elbow";
  replaces?: string[];
};
/**
 * A tile container's grid as drawn (manual arrangement, lib/archArrange): `slots[i]` is cell (i % cols, ⌊i / cols⌋) —
 * the unit it holds (a tile, or a stack id for a stack / its fold tile), null for an empty cell; `follower` = a member of
 * an expanded stack (moves with the stack, never on its own).
 */
export type ArchGrid = {
  x0: number; y0: number; cols: number; cellW: number; cellH: number; gap: number;
  slots: Array<{ unit: string | null; shape: string | null; follower?: boolean }>;
  /** The column count was chosen by the user (else automatic) */
  userCols: boolean;
};
export type ArchLayout = {
  shapes: ArchPlaced[];
  edges: ArchDrawEdge[];
  width: number;
  height: number;
  /** Graph id (resource, VNet, subnet) → the shape id it is drawn as right now */
  shownAt: Map<string, string>;
  /** Edges hidden because an end is in a region that is not shown */
  offscreen: ArchEdge[];
  /** Containers whose children the user may reorder → their child shape ids as drawn (lib/archArrange) */
  containers: Map<string, string[]>;
  /** Shape id → the container it can be reordered in */
  containerOf: Map<string, string>;
  /** Member tile of an expanded stack → its stack id (it moves with the stack's fold tile) */
  followers: Map<string, string>;
  /** Tile containers (subnets, lanes, PaaS groups, global) → their grid as drawn */
  grids: Map<string, ArchGrid>;
  /** VNets drawn as traffic-entry columns → the rank of each column, left to right */
  flowColumns: Map<string, number[]>;
  /** VNets drawn as columns → each column and the row below as drawn (subnet ids top → bottom / left → right) */
  bands: Map<string, ArchBand>;
};

export type ArchBandPart = { x: number; y: number; w: number; h: number; ids: string[] };
/** user = the columns are the user's (lib/archArrange bandPlan), not the traffic-entry steps */
export type ArchBand = { cols: ArchBandPart[]; rest: ArchBandPart | null; user: boolean };

/** The user's grid for one tile container: column count, and cells for some of its units ([col, row]) */
export type ArchContainerGrid = { cols?: number; cells?: ReadonlyMap<string, readonly [number, number]> };

/** An empty grid cell: laid out like a tile, never drawn (removed before shapes are returned) */
type HoleShape = { id: string; shape: "hole" };
type TNode = PackNode<ArchShape | HoleShape>;

export type ArchViewOptions = {
  /** Region key to show, or "all" */
  region: string;
  /** VNet ids drawn as a summary pill */
  collapsed: ReadonlySet<string>;
  /** Stack ids the user expanded */
  expandedStacks: ReadonlySet<string>;
  /** Edge kinds to draw (default DEFAULT_LAYERS) */
  layers?: ReadonlySet<ArchEdgeKind>;
  /** Draw FOCUS_KINDS like the others (export "with every line"); default: only for the selection */
  allLines?: boolean;
  /** Subscription frame title (GUIDs masked by the caller); default: the graph's subscription node name */
  subscriptionLabel?: string;
  /**
   * The user's order per container (lib/archArrange): container id → child shape ids. Listed ids come first in that
   * order, the rest keep their automatic order after them; ids no longer present are ignored. Order only — the
   * slots stay boxPack's tidy rows, and a tile never leaves its container.
   */
  order?: ReadonlyMap<string, readonly string[]>;
  /** The user's grids (column count, cells) per tile container — empty cells are kept */
  grid?: ReadonlyMap<string, ArchContainerGrid>;
  /**
   * Order by traffic entry (default): tiles, subnets and VNets by flowRank, and a VNet whose subnets are on two or more
   * steps becomes left-to-right columns of subnets. false = by name (the earlier layout).
   */
  flow?: boolean;
  /** Tiles hidden by the category filter per box (the header's "hidden n" badge takes room in the header) */
  hiddenIn?: ReadonlyMap<string, number>;
};

/**
 * VNets collapsed when a view opens: in one region, empty ones and those with more than `limit`
 * tiles; in "all", every VNet. With a category filter only VNets above `limit` are collapsed —
 * a filtered VNet with no shown tiles is not "empty" (its tiles are hidden), and collapsing every
 * VNet in "all" would hide exactly what the filter is meant to show.
 */
export function initialCollapsed(model: ArchModel, region: string, limit = 24, filtered = false): Set<string> {
  const s = new Set<string>();
  for (const reg of model.regions) {
    if (region !== "all" && reg.key !== region) continue;
    for (const v of reg.vnets) {
      const n = v.subnets.reduce((k, sb) => k + sb.resources.length, 0);
      const collapse = filtered ? n > limit : region === "all" || n === 0 || n > limit;
      if (collapse) s.add(lower(v.node.id));
    }
  }
  return s;
}

/** Region shown by default: the one with the most drawn tiles (ties by name). */
export function defaultRegion(model: ArchModel): string {
  return model.regions[0]?.key ?? "all";
}

const HEAD_ROW = 18;
/** Room kept at the start of every header row 1 for the drag grip (never on top of the text) */
export const HEAD_GRIP = 16;
const HEAD_MAX_ROWS = 4;
const textW = (s: string, latin: number, cjk: number) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? cjk : latin), 0);
/** Badge width as drawn (10px bold, 5px padding each side, at most 160px — the CSS max-width) */
const badgeW = (text: string) => Math.min(160, Math.ceil(textW(text, 6.2, 10.5)) + 10);

/**
 * A subnet header in rows — the form: row 1 = name (and the CIDR when it fits), then CIDR · NSG · NAT · public IP ·
 * VM-less NIC · hidden in that order, each row filled while it fits, an item never wider than a row (ellipsis), at most
 * four rows (the rest as "+n"). One row when everything fits (as before). The box width never grows for its header;
 * the layout reserves exactly these rows (head), so text can never spill onto the tiles or the lines.
 * Translated words (public IP n, VM-less NIC n, hidden n) are estimated at their longer language: same layout in both.
 */
export function subnetHead(s: ArchSubnet, hidden: number, w: number): { rows: ArchHeadItem[][]; head: number } {
  const rowW = Math.max(60, w - 18 - HEAD_GRIP);
  const GAP = 6;
  const items: Array<{ it: ArchHeadItem; w: number }> = [];
  const nameW = Math.min(rowW, Math.ceil(textW(s.node.name, 7.4, 12.5)));
  if (s.node.endpoint) items.push({ it: { k: "cidr" }, w: Math.ceil(s.node.endpoint.length * 6.8) });
  if (s.nsgs.length) items.push({ it: { k: "nsg" }, w: badgeW(s.nsgs.length > 1 ? `NSG ${s.nsgs.length}` : `NSG ${s.nsgs[0]}`) });
  if (s.natGateways.length) items.push({ it: { k: "nat" }, w: Math.min(160, badgeW(s.natGateways.length > 1 ? `NAT ${s.natGateways.length}` : `NAT ${s.natGateways[0]}`) + (s.egress?.natBypassed ? 40 : 0)) });
  if (shownExit(s.egress)) items.push({ it: { k: "egress" }, w: 150 });
  if (s.publicIps.length) items.push({ it: { k: "pip" }, w: 74 });
  if (s.otherNics) items.push({ it: { k: "nic" }, w: 96 });
  if (hidden) items.push({ it: { k: "hidden" }, w: 70 });
  const all = nameW + items.reduce((n, x) => n + GAP + x.w, 0);
  if (all <= rowW) return { rows: [[{ k: "name" }, ...items.map((x) => x.it)]], head: HEAD.subnet };
  const rows: ArchHeadItem[][] = [[{ k: "name" }]];
  let used = nameW;
  let i = 0;
  if (items[0]?.it.k === "cidr" && used + GAP + items[0].w <= rowW) { rows[0]!.push(items[0].it); used += GAP + items[0].w; i = 1; }
  used = Infinity; // later items start on row 2
  for (; i < items.length; i++) {
    const x = items[i]!;
    const wi = Math.min(rowW, x.w);
    if (used + GAP + wi > rowW) {
      if (rows.length === HEAD_MAX_ROWS) { rows[rows.length - 1]!.push({ k: "more", n: items.length - i }); break; }
      rows.push([]);
      used = -GAP;
    }
    rows[rows.length - 1]!.push(x.it);
    used += GAP + wi;
  }
  return { rows, head: HEAD.subnet + HEAD_ROW * (rows.length - 1) };
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
  const leaf = (shape: Exclude<ArchShape, { shape: "box" }> | HoleShape, w: number = ARCH.LEAF_W, h: number = ARCH.LEAF_H): TNode => ({ t: "leaf", shape, w, h });
  const box = (shape: Extract<ArchShape, { shape: "box" }>, dir: "row" | "col", children: TNode[], minW?: number, maxW?: number): TNode => ({
    t: "box", shape, dir, children, minW,
    maxW: maxW ?? MAXW[shape.type],
    head: HEAD[shape.type],
    pad: ARCH.PAD,
    // Boxes of boxes get wide gaps: the lanes lines run in (lib/archRoute); tiles keep the narrow one
    gap: shape.type === "root" || children.some((c) => c.t === "box") ? ARCH.BOX_GAP : ARCH.GAP,
    framed: shape.type !== "root",
  });
  const shownAt = new Map<string, string>();
  const containers = new Map<string, string[]>();
  const containerOf = new Map<string, string>();
  /** Member tile of an expanded stack → its stack id: it moves with the stack's fold tile, never on its own */
  const followers = new Map<string, string>();
  /** Children of a reorderable container in the user's order (stable; a stack's fold tile and members follow the stack) */
  const flow = opts.flow !== false;
  const rankOf = (id: string) => (flow ? model.flowRank.get(id) ?? Infinity : Infinity);
  /** Stable: by rank, else as given (the model's name order) */
  const byRank = (ids: readonly string[]) => (flow ? ids.map((id, i) => ({ id, i, r: rankOf(id) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.id) : [...ids]);
  const subnetRank = (s: ArchSubnet) => Math.min(Infinity, ...s.resources.map(rankOf));
  const vnetRank = (v: ArchVnet) => Math.min(Infinity, ...v.subnets.map(subnetRank));
  const colsW = (n: number) => n * ARCH.LEAF_W + (n - 1) * ARCH.GAP;
  /** Grid of each tile container as built (unit per slot), turned into ArchGrid after placement */
  const gridBuilt = new Map<string, { cols: number; userCols: boolean; slots: ArchGrid["slots"] }>();
  const flowColumns = new Map<string, number[]>();
  const bandBuilt = new Map<string, { cols: string[][]; rest: string[]; user: boolean }>();
  /**
   * Automatic order of the side lanes (PaaS zones and their tiles, edge / outside lanes) in traffic-flow mode: the mean
   * height of the shapes they are connected to, from a first placement (two passes — see below). Empty = not used.
   */
  const autoKey = new Map<string, number>();
  const LANE_RE = /^(paas:|lane:edge:|lane:egress:|lane:outside:)/;
  const ordered = (containerId: string, kids: TNode[]): TNode[] => {
    const want = opts.order?.get(containerId) ?? [];
    const wantRank = new Map(want.map((id, i) => [id, i] as const));
    const keyOf = (n: TNode) => {
      const sh = n.shape;
      if (sh.shape === "fold") return sh.ref;
      return followers.get(sh.id) ?? sh.id;
    };
    const out = want.length
      ? kids.map((n, i) => ({ n, i, r: wantRank.get(keyOf(n)) ?? Infinity })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.n)
      : kids;
    const ids = out.filter((n) => !followers.has(n.shape.id)).map((n) => (n.shape.shape === "fold" ? n.shape.ref : n.shape.id));
    containers.set(containerId, ids);
    for (const n of out) containerOf.set(n.shape.id, containerId);
    return out;
  };

  /**
   * Tiles of one container; same-kind runs above `at` become a stack unless expanded. An expanded stack keeps its
   * slot as a fold tile first in the run — the spot the user clicked folds it back (never in shownAt: no edge ends there).
   */
  const tilesOf = (containerId: string, ids: string[], at: number, autoCols: number): TNode[] => {
    const groups = new Map<string, string[]>();
    const seq = autoKey.size && LANE_RE.test(containerId)
      ? byRank(ids).map((id, i) => ({ id, i, k: autoKey.get(id) ?? Infinity })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.id)
      : byRank(ids);
    for (const id of seq) {
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
        if (members.length > at) {
          kids.push(leaf({ id: `fold:${stackId}`, shape: "fold", ref: stackId, kind: k, n: members.length }));
          for (const id of members) followers.set(id, stackId);
        }
        for (const id of members) { kids.push(leaf({ id, shape: "tile", ref: id })); shownAt.set(id, id); }
      }
    }
    return gridded(containerId, ordered(containerId, kids), autoCols);
  };

  /**
   * Lay a tile container's children on its grid: the user's cells first (in cell order; a unit whose cell is taken or
   * outside the columns joins the rest), then every other unit after the last used cell, in order — an empty cell the
   * user left stays empty. An expanded stack's members follow its fold tile into the next free cells. Empty cells are
   * hole leaves (laid out, never drawn); trailing ones are dropped so the box shrinks.
   */
  const gridded = (containerId: string, kids: TNode[], autoCols: number): TNode[] => {
    const user = opts.grid?.get(containerId);
    const cols = Math.max(1, Math.min(ARCH.MAX_COLS, user?.cols ?? autoCols));
    const units: Array<{ key: string; leaves: TNode[] }> = [];
    for (const n of kids) {
      const sh = n.shape;
      const followerOf = followers.get(sh.id);
      if (followerOf && units.length && units[units.length - 1]!.key === followerOf) units[units.length - 1]!.leaves.push(n);
      else units.push({ key: sh.shape === "fold" ? (sh as { ref: string }).ref : sh.id, leaves: [n] });
    }
    const slots: Array<TNode | null> = [];
    const free = (i: number) => slots[i] === undefined || slots[i] === null;
    const put = (i: number, n: TNode) => { while (slots.length < i) slots.push(null); slots[i] = n; };
    const placeUnit = (u: { leaves: TNode[] }, start: number) => {
      let i = start;
      for (const n of u.leaves) { while (!free(i)) i++; put(i, n); i++; }
    };
    const cells = user?.cells;
    const rest: typeof units = [];
    if (cells?.size) {
      const explicit = units
        .map((u) => ({ u, c: cells.get(u.key) }))
        .filter((x): x is { u: (typeof units)[number]; c: readonly [number, number] } => {
          if (!x.c || x.c[0] >= cols || x.c[0] < 0 || x.c[1] < 0) { rest.push(x.u); return false; }
          return true;
        })
        .map((x) => ({ u: x.u, i: x.c[1] * cols + x.c[0] }))
        .sort((a, b) => a.i - b.i);
      for (const { u, i } of explicit) {
        if (!free(i)) { rest.push(u); continue; }
        placeUnit(u, i);
      }
    } else rest.push(...units);
    // the rest keep their order (ordered()), after the last used cell
    rest.sort((a, b) => units.indexOf(a) - units.indexOf(b));
    for (const u of rest) placeUnit(u, slots.length);
    while (slots.length && slots[slots.length - 1] === null) slots.pop();
    gridBuilt.set(containerId, {
      cols,
      userCols: user?.cols !== undefined,
      slots: slots.map((n) => {
        if (!n) return { unit: null, shape: null };
        const sh = n.shape;
        const f = followers.get(sh.id);
        return { unit: f ?? (sh.shape === "fold" ? (sh as { ref: string }).ref : sh.id), shape: sh.id, ...(f ? { follower: true } : {}) };
      }),
    });
    let hole = 0;
    return slots.map((n) => n ?? leaf({ id: `hole:${containerId}:${hole++}`, shape: "hole" }));
  };
  /** Row box of a tile container: wraps at its grid's column count */
  const tileBox = (shape: Extract<ArchShape, { shape: "box" }>, ids: string[], at: number, autoCols: number, minW?: number): TNode => {
    const kids = tilesOf(shape.id, ids, at, autoCols);
    const cols = gridBuilt.get(shape.id)?.cols ?? autoCols;
    return box(shape, "row", kids, minW, colsW(cols));
  };

  /** A subnet's header rows for its final width (subnetHead): the box keeps exactly that header height */
  const finishSubnet = (n: TNode) => {
    if (n.t !== "box" || n.shape.shape !== "box") return;
    const sb = model.subnets.get(n.shape.id);
    if (!sb) return;
    const h = subnetHead(sb, opts.hiddenIn?.get(n.shape.id) ?? 0, measure(n).w);
    n.head = h.head;
    n.shape.rows = h.rows;
  };
  const subnetNode = (s: ArchSubnet, autoCols: number = ARCH.SUBNET_COLS): TNode => {
    const sid = lower(s.node.id);
    shownAt.set(sid, sid);
    // Width = its grid (whole tiles — one column is one tile wide); a long header wraps to more rows instead of
    // widening the box (that read as an empty cell)
    const n = tileBox({ id: sid, shape: "box", type: "subnet", ref: sid, label: s.node.name }, s.resources, ARCH.STACK_AT, autoCols, colsW(1) + 2 * ARCH.PAD);
    finishSubnet(n);
    return n;
  };
  /** One width for the automatic boxes of a column (a tidy column); a box whose columns the user chose keeps its own */
  const evenWidths = (members: TNode[]) => {
    const auto = members.filter((n) => n.t === "box" && opts.grid?.get(n.shape.id)?.cols === undefined) as PackBox<ArchShape | HoleShape>[];
    const w = Math.max(0, ...auto.map((n) => measure(n).w));
    for (const n of auto) { n.minW = w; finishSubnet(n); }
  };

  /** Subnets with data / private-endpoint tiles and no inward line: the last column (web → app → data) */
  const DATA_KINDS = new Set<string>(["privateEndpoint", "postgres", "redis", "sql", "cosmosDb", "storage", "paas", "keyVault"]);
  /**
   * A VNet as traffic-entry columns (Azure Architecture Center: left → right = the way requests come in): subnets of one
   * rank stacked in a column, columns by rank; data subnets nothing reaches last; the rest (Bastion, empty, management)
   * in a row below — a column would read as one more hop. Subnets inside get two columns of tiles (narrower columns).
   * null = fewer than two columns, the user ordered this VNet's subnets themselves, or too wide (wrapped rows then).
   */
  const flowVnetKids = (v: ArchVnet, vid: string): TNode[] | null => {
    const user = opts.grid?.get(`vband:${vid}`);
    if (!flow || (v.subnets.length < 2 && !user?.cells?.size)) return null;
    const sidOf = (sb: ArchSubnet) => lower(sb.node.id);
    if (user?.cells?.size) {
      // The user's columns (lib/archArrange bandPlan): column = position, row = order in it; unlisted → the row below
      const byCol = new Map<number, Array<{ sb: ArchSubnet; r: number }>>();
      const rest: ArchSubnet[] = [];
      for (const sb of v.subnets) {
        const c = user.cells.get(sidOf(sb));
        if (!c) { rest.push(sb); continue; }
        (byCol.get(c[0]) ?? byCol.set(c[0], []).get(c[0])!).push({ sb, r: c[1] });
      }
      const lists = [...byCol.keys()].sort((a, b) => a - b).map((k) => byCol.get(k)!.sort((a, b) => a.r - b.r || cmpStr(sidOf(a.sb), sidOf(b.sb))).map((x) => x.sb));
      return bandKids(vid, lists, lists.map((_, i) => `c${i}`), rest, true);
    }
    const ranks = new Map<ArchSubnet, number>();
    for (const sb of v.subnets) ranks.set(sb, subnetRank(sb));
    const ranked = [...ranks.values()].filter(Number.isFinite);
    const top = ranked.length ? Math.max(...ranked) : 0;
    for (const sb of v.subnets) {
      if (Number.isFinite(ranks.get(sb)!)) continue;
      if (sb.resources.some((id) => DATA_KINDS.has(model.resources.get(id)!.node.kind))) ranks.set(sb, top + 0.5);
    }
    const colRanks = [...new Set([...ranks.values()].filter(Number.isFinite))].sort((a, b) => a - b);
    if (colRanks.length < 2) return null;
    const kids = bandKids(vid, colRanks.map((r) => v.subnets.filter((sb) => ranks.get(sb) === r)), colRanks.map(String), v.subnets.filter((sb) => !Number.isFinite(ranks.get(sb)!)), false);
    if (kids) flowColumns.set(vid, colRanks);
    return kids;
  };
  /**
   * Columns of subnets (each a tidy column of one width) + the row below. Every subnet of the VNet moves in one place
   * (`vband:<vnet>`): to any column, a new column on the right, or the row below (lib/archArrange bandPlan).
   */
  const bandKids = (vid: string, lists: ArchSubnet[][], keys: string[], rest: ArchSubnet[], user: boolean): TNode[] | null => {
    const colIds: string[][] = [];
    const cols: TNode[] = lists.map((list, i) => {
      const cid = `vcol:${vid}:${keys[i]}`;
      const members = ordered(cid, list.map((sb) => subnetNode(sb, 2)));
      containers.delete(cid);
      evenWidths(members);
      colIds.push(members.map((n) => n.shape.id));
      return box({ id: cid, shape: "box", type: "root", label: "" }, "col", members);
    });
    const band = box({ id: `vband:${vid}`, shape: "box", type: "root", label: "" }, "row", cols, undefined, Infinity);
    const bw = measure(band).w;
    if (!user && bw > ARCH.FLOW_VNET_MAX_W) return null;
    const kids: TNode[] = [band];
    let restIds: string[] = [];
    if (rest.length) {
      const rid = `vrest:${vid}`;
      const row = ordered(rid, rest.map((sb) => subnetNode(sb)));
      containers.delete(rid);
      restIds = row.map((n) => n.shape.id);
      kids.push(box({ id: rid, shape: "box", type: "root", label: "" }, "row", row, undefined, Math.max(MAXW.vnet, bw)));
    }
    const all = [...colIds.flat(), ...restIds];
    containers.set(`vband:${vid}`, all);
    for (const id of all) containerOf.set(id, `vband:${vid}`);
    bandBuilt.set(vid, { cols: colIds, rest: restIds, user });
    return kids;
  };

  const vnetNode = (v: ArchVnet): TNode => {
    const vid = lower(v.node.id);
    shownAt.set(vid, vid);
    if (opts.collapsed.has(vid)) {
      for (const s of v.subnets) { shownAt.set(lower(s.node.id), vid); for (const id of s.resources) shownAt.set(id, vid); }
      return leaf({ id: vid, shape: "pill", ref: vid }, ARCH.PILL_W, ARCH.PILL_H);
    }
    const shape = { id: vid, shape: "box", type: "vnet", ref: vid, label: v.node.name } as const;
    const minW = labelWidth(v.node.name, v.node.endpoint, 120, 250);
    const layered = flowVnetKids(v, vid);
    if (layered) return box(shape, "col", layered, minW);
    const subs = flow ? [...v.subnets].map((sb, i) => ({ sb, i, r: subnetRank(sb) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.sb) : v.subnets;
    return box(shape, "row", ordered(vid, subs.map((sb) => subnetNode(sb))), minW);
  };

  const regionNode = (reg: ArchRegion): TNode => {
    const cols: TNode[] = [];
    // Public entry and egress resources of the region (public LB, NAT gateway, firewall, …) — Azure resources, so
    // inside the region; the Internet itself is outside the subscription (INTERNET_TILE)
    if (reg.edge.length) cols.push(tileBox({ id: `lane:edge:${reg.key}`, shape: "box", type: "lane", label: "edge", region: reg.key }, reg.edge, ARCH.LANE_STACK_AT, 1));
    const vnets = flow ? reg.vnets.map((v, i) => ({ v, i, r: vnetRank(v) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.v) : reg.vnets;
    if (reg.vnets.length) cols.push(box({ id: `vnets:${reg.key}`, shape: "box", type: "root", label: "" }, "row", ordered(`vnets:${reg.key}`, vnets.map(vnetNode)), undefined, ARCH.VNETS_MAX_W));
    if (reg.outside.length) cols.push(tileBox({ id: `lane:outside:${reg.key}`, shape: "box", type: "lane", label: "outside", region: reg.key }, reg.outside, ARCH.LANE_STACK_AT, 1));
    // PaaS zones: movable like cards (order), level with what they are connected to in flow mode (autoKey)
    const groups = PAAS_ORDER.filter((c) => reg.paas[c].length)
      .map((c, i) => ({ c, i, k: autoKey.get(`paas:${c}:${reg.key}`) ?? Infinity }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map(({ c }) => tileBox({ id: `paas:${c}:${reg.key}`, shape: "box", type: "group", label: c, region: reg.key }, reg.paas[c], ARCH.LANE_STACK_AT, 2));
    evenWidths(groups);
    if (groups.length) cols.push(box({ id: `lane:paas:${reg.key}`, shape: "box", type: "lane", label: "paas", region: reg.key }, "col", ordered(`lane:paas:${reg.key}`, groups), undefined, MAXW.group + 2 * ARCH.PAD));
    // Outbound exits last (right, by the outbound Internet): NAT gateways, outbound-only public LBs
    if (reg.egress.length) cols.push(tileBox({ id: `lane:egress:${reg.key}`, shape: "box", type: "lane", label: "egress", region: reg.key }, reg.egress, ARCH.LANE_STACK_AT, 1));
    return box({ id: `region:${reg.key}`, shape: "box", type: "region", label: reg.key, region: reg.key }, "row", cols, 320);
  };

  const isInternet = (id: string) => id.startsWith("internet:");
  /** The whole tree (fresh bookkeeping each time — it runs twice in flow mode) */
  const buildRoot = (): { root: TNode; offscreen: ArchEdge[] } => {
  for (const m of [shownAt, containers, containerOf, followers, gridBuilt, flowColumns, bandBuilt] as Array<Map<string, unknown>>) m.clear();
  // Subscription frame: global services, the regions, then other-region ends — everything Azure drew for it
  const subKids: TNode[] = [];
  if (model.global.length) {
    subKids.push(tileBox({ id: "global", shape: "box", type: "global", label: "global" }, model.global, ARCH.LANE_STACK_AT, 1));
  }
  // Regions side by side while they fit, then wrap
  subKids.push(box({ id: "regions", shape: "box", type: "root", label: "" }, "row", shown.map(regionNode), undefined, ARCH.REGIONS_MAX_W));

  // Endpoints in regions that are not shown → ghost tiles so the relationship stays visible
  const offscreen: ArchEdge[] = [];
  if (opts.region !== "all") {
    const ghostIds = new Set<string>();
    for (const e of model.edges) {
      if (!layers.has(e.kind) || isInternet(e.source) || isInternet(e.target) || e.source.startsWith("site:") || e.target.startsWith("site:")) continue;
      const s = shownAt.get(e.source), t = shownAt.get(e.target);
      if (!!s === !!t) continue;
      offscreen.push(e);
      ghostIds.add(s ? e.target : e.source);
    }
    const ids = [...ghostIds].sort();
    if (ids.length) {
      for (const id of ids) shownAt.set(id, `ghost:${id}`);
      subKids.push(box({ id: "elsewhere", shape: "box", type: "global", label: "elsewhere" }, "col", ids.map((id) => leaf({ id: `ghost:${id}`, shape: "ghost", ref: id }))));
    }
  }
  const subNode = model.nodes.size ? [...model.nodes.values()].find((n) => n.kind === "subscription") : undefined;
  const subscription = box({ id: "subscription", shape: "box", type: "subscription", ref: subNode ? lower(subNode.id) : undefined, label: opts.subscriptionLabel ?? subNode?.name ?? "" }, "row", subKids);

  // The Internet: one tile outside the subscription, left (traffic reads left → right), when a drawn line uses it
  const internetEnds = model.edges
    .filter((e) => layers.has(e.kind) && (isInternet(e.source) ? shownAt.has(e.target) : isInternet(e.target) && shownAt.has(e.source)))
    .map((e) => (isInternet(e.source) ? e.source : e.target));
  const internetRegions = [...new Set(internetEnds.filter((id) => !id.endsWith(":out")).map(internetRegionOf))].sort();
  const outRegions = [...new Set(internetEnds.filter((id) => id.endsWith(":out")).map(internetRegionOf))].sort();
  // On-premises sites whose VPN gateway is drawn: outside Azure, under the Internet (EDGE-09)
  const siteLeaves: TNode[] = layers.has("hybrid")
    ? [...model.sites.values()].filter((st) => shownAt.has(st.gatewayId)).sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.id, b.id)).map((st) => {
      shownAt.set(st.id, st.id);
      return leaf({ id: st.id, shape: "site", ref: st.id });
    })
    : [];
  const rootKids: TNode[] = [];
  if (internetRegions.length || siteLeaves.length) {
    for (const k of internetRegions) shownAt.set(internetId(k), INTERNET_TILE);
    const kids: TNode[] = internetRegions.length ? [leaf({ id: INTERNET_TILE, shape: "internet", regions: internetRegions })] : [];
    if (siteLeaves.length) kids.push(box({ id: "onprem", shape: "box", type: "lane", label: "onprem" }, "col", siteLeaves));
    rootKids.push(box({ id: "external", shape: "box", type: "external", label: "external" }, "col", kids));
  }
  rootKids.push(subscription);
  if (outRegions.length) {
    for (const k of outRegions) shownAt.set(internetOutId(k), INTERNET_OUT_TILE);
    rootKids.push(box({ id: "external:out", shape: "box", type: "external", label: "external" }, "col", [leaf({ id: INTERNET_OUT_TILE, shape: "internet", regions: outRegions, out: true })]));
  }
  return { root: box({ id: "root", shape: "box", type: "root", label: "" }, "row", rootKids), offscreen };
  };
  let { root, offscreen } = buildRoot();
  // Flow mode, second pass: the side lanes (PaaS zones and tiles, edge / outside lanes) ordered by the mean height of
  // what they connect to, so their lines run level instead of crossing. Order inside a lane never changes the lane's
  // size, so nothing else moves; the user's order / cells still come first (ordered(), gridded()).
  if (flow) {
    const keys = laneKeys(model, root, shownAt, containerOf, layers, LANE_RE);
    if (keys.size) {
      for (const [k, v] of keys) autoKey.set(k, v);
      ({ root, offscreen } = buildRoot());
    }
  }

  // ── measure / place (lib/boxPack) ──
  const measured = measure(root);
  const shapes: ArchPlaced[] = place(measured)
    .filter((p) => p.shape.shape !== "hole")
    .map((p) => ({ ...p.shape, x: p.x, y: p.y, w: p.w, h: p.h, depth: p.depth, parent: p.parent ? p.parent.id : null, head: p.head }) as ArchPlaced);
  // Unframed wrappers only position their children
  const wrappers = new Set(["root", "regions", ...shapes.filter((s) => /^(vnets|vband|vcol|vrest):/.test(s.id)).map((s) => s.id)]);
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
    else drawn.set(id, { id, kind: e.kind, source: s, target: t, count: 1, display: !opts.allLines && FOCUS_KINDS.has(e.kind) ? "focus" : "always", points: [], sourceSide: "r", targetSide: "l", ...(e.state ? { state: e.state } : {}) });
  }

  // ── routes (lib/archRoute): lines run in the gaps, never through a tile or a box header ──
  // Lines shown together are routed together (their parallel runs are spread apart); focus lines on their own
  const tiles = new Map<string, RRect>(placed.filter((s) => s.shape !== "box").map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
  const boxes: RouteBox[] = placed.filter((s) => s.shape === "box").map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, head: s.head }));
  // A trunk per gateway (one line that branches), per NAT → Internet (they merge at the Internet)
  // Lines into one NAT (subnet → NAT, NAT → outbound Internet) merge into a trunk at their target
  const bundle = (e: ArchDrawEdge) => (e.kind === "egress" || e.kind === "outbound" ? `to:${e.target}` : e.kind === "peering" ? e.id : e.source);
  for (const display of ["always", "focus"] as const) {
    const list = [...drawn.values()].filter((e) => e.display === display);
    const routed = routeOrthogonal(tiles, boxes, list.map((e) => ({ id: e.id, source: e.source, target: e.target, bundle: bundle(e) })));
    for (const e of list) {
      const r = routed.get(e.id);
      if (!r) continue;
      e.points = r.points;
      e.sourceSide = r.sourceSide;
      e.targetSide = r.targetSide;
      if (r.fallback) e.fallback = true;
    }
  }
  const edges = [...drawn.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const id of followers.keys()) containerOf.delete(id);
  // Grids as drawn: a tile container's body starts below its header, inside its padding
  const grids = new Map<string, ArchGrid>();
  for (const [cid, g] of gridBuilt) {
    const b = placed.find((x) => x.id === cid);
    if (!b || b.shape !== "box") continue;
    grids.set(cid, { x0: b.x + ARCH.PAD, y0: b.y + b.head, cols: g.cols, cellW: ARCH.LEAF_W, cellH: ARCH.LEAF_H, gap: ARCH.GAP, slots: g.slots, userCols: g.userCols });
  }
  const byId = new Map(placed.map((s) => [s.id, s] as const));
  const part = (ids: string[]): ArchBandPart => {
    const rs = ids.map((id) => byId.get(id)!).filter(Boolean);
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0, ids };
  };
  const bands = new Map<string, ArchBand>();
  for (const [vid, b] of bandBuilt) bands.set(vid, { cols: b.cols.filter((c) => c.length).map(part), rest: b.rest.length ? part(b.rest) : null, user: b.user });
  return { shapes: placed, edges, width: measured.w, height: measured.h, shownAt, offscreen, containers, containerOf, followers, grids, flowColumns, bands };
}

/**
 * Ordering keys of side-lane tiles and PaaS zones: the mean centre height of the shapes each resource is connected to
 * (drawn layers, other end outside its own lane), from a first placement; a zone pools its tiles. Whole pixels.
 */
function laneKeys(model: ArchModel, root: TNode, shownAt: Map<string, string>, containerOf: Map<string, string>, layers: ReadonlySet<ArchEdgeKind>, laneRe: RegExp): Map<string, number> {
  const cy = new Map<string, number>();
  for (const p of place(measure(root))) cy.set(p.shape.id, p.y + p.h / 2);
  const laneOf = (shape: string | undefined) => {
    const c = shape ? containerOf.get(shape) : undefined;
    return c && laneRe.test(c) ? c : null;
  };
  const ys = new Map<string, number[]>();
  for (const e of model.edges) {
    if (!layers.has(e.kind)) continue;
    for (const [me, other] of [[e.source, e.target], [e.target, e.source]] as const) {
      const s = shownAt.get(me), o = shownAt.get(other);
      const lane = laneOf(s);
      if (!lane || !o || o === s || laneOf(o) === lane) continue;
      const y = cy.get(o);
      if (y === undefined) continue;
      (ys.get(me) ?? ys.set(me, []).get(me)!).push(y);
    }
  }
  const out = new Map<string, number>();
  const zone = new Map<string, number[]>();
  for (const [id, list] of ys) {
    out.set(id, Math.round(list.reduce((a, b) => a + b, 0) / list.length));
    const c = laneOf(shownAt.get(id));
    if (c?.startsWith("paas:")) (zone.get(c) ?? zone.set(c, []).get(c)!).push(...list);
  }
  for (const [c, list] of zone) out.set(c, Math.round(list.reduce((a, b) => a + b, 0) / list.length));
  return out;
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
