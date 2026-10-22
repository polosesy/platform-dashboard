// A subnet's first way out to the Internet, from configuration only (catalog NET-09, NET-07, SEC-04, EDGE-01, SEC-07) —
// pure; tested in apps/api/test/subnetEgress.test.ts.
//
// Azure picks the exit in this order: the effective 0.0.0.0/0 route's next hop (a UDR to a virtual appliance or the
// VNet gateway, or a BGP default route = forced tunnelling) > NAT gateway > instance public IP > LB outbound rule >
// default outbound access. Effective routes are a runtime API (networkInterfaces/effectiveRouteTable), so this reads
// what the configuration says — the route table's routes, BGP propagation, the gateway's local network gateways — and
// says "BGP may override" where a gateway could still advertise a route. Only the FIRST exit is named; a NAT that a
// UDR bypasses is named as bypassed (it is attached, but it is not the exit).

export type RouteIn = { prefix: string; nextHopType: string; nextHopIp?: string | null };
export type RouteTableIn = { name: string; routes: RouteIn[]; disableBgpRoutePropagation: boolean };

export type EgressVia = "appliance" | "gateway" | "nat" | "publicIp" | "default" | "noExit" | "dropped" | "unknown";
export type SubnetEgress = {
  via: EgressVia;
  /** The resource traffic leaves through (appliance holder, gateway, NAT, the firewall itself) */
  targetId?: string;
  /** What holds the next-hop address (SEC-04 ipMatch) */
  holder?: "firewall" | "vm" | "ilb";
  nextHopIp?: string;
  evidence: "udr" | "lngDefault" | "cfg";
  routeTable?: { name: string; prefix: "0.0.0.0/0" | "split" };
  /** The next hop could not be tied to exactly one resource */
  unresolved?: "none" | "ambiguous" | "unreadable";
  /** BGP propagation is on and a gateway is reachable: a learned route may still take precedence */
  bgpMayOverride: boolean;
  /** A NAT gateway is attached but the UDR (or forced tunnelling) wins — the NAT is not this subnet's exit */
  natBypassed?: string;
  /** The NIC holding the appliance address does not forward IP traffic */
  ipForwardingOff?: boolean;
};

export type EgressSubnet = {
  vnetId: string;
  /** undefined = no route table; null = associated but unreadable */
  routeTable: RouteTableIn | null | undefined;
  natGatewayId?: string | null;
  /** subnets.properties.defaultOutboundAccess as read ("true" / "false"), undefined = not set */
  defaultOutboundAccess?: string;
  /** AzureFirewallSubnet: the firewall in it and whether it has a public IP */
  firewall?: { id: string; hasPublicIp: boolean } | null;
};

export type ApplianceHolder = { kind: "firewall" | "vm" | "ilb"; targetId: string; ipForwarding?: boolean };
export type EgressCtx = {
  /** Holders of a private address inside the given VNets (exactly the address-index entries) */
  holdersOf: (ip: string, vnets: ReadonlySet<string>) => ApplianceHolder[];
  /** The subnet's VNet and its Connected peers */
  scope: (vnetId: string) => ReadonlySet<string>;
  /** The VPN / ER gateway this VNet reaches: its own, or a hub's through gateway transit (both flags, Connected) */
  gatewayOf: (vnetId: string) => string | null;
  /** That gateway sends the default route on-premises (a local network gateway prefix 0.0.0.0/0, or a default site) */
  forcedTunnel: (gatewayId: string) => boolean;
};

const DEFAULT = "0.0.0.0/0";

/** The default route of a route table: 0.0.0.0/0, or the pair 0.0.0.0/1 + 128.0.0.0/1 (longer prefixes win) */
function defaultRoute(rt: RouteTableIn): { route: RouteIn; prefix: "0.0.0.0/0" | "split" } | { mixed: true } | null {
  const a = rt.routes.find((r) => r.prefix === "0.0.0.0/1"), b = rt.routes.find((r) => r.prefix === "128.0.0.0/1");
  if (a && b) {
    if (a.nextHopType.toLowerCase() === b.nextHopType.toLowerCase() && (a.nextHopIp ?? "") === (b.nextHopIp ?? "")) return { route: a, prefix: "split" };
    return { mixed: true };
  }
  if (a || b) return { mixed: true };
  const d = rt.routes.find((r) => r.prefix === DEFAULT);
  return d ? { route: d, prefix: "0.0.0.0/0" } : null;
}

export function resolveSubnetEgress(s: EgressSubnet, ctx: EgressCtx): SubnetEgress {
  const gateway = ctx.gatewayOf(s.vnetId);
  const propagates = !s.routeTable || !s.routeTable.disableBgpRoutePropagation;
  const bgpMayOverride = propagates && !!gateway;
  const nat = s.natGatewayId ?? undefined;
  const bypassed = (e: SubnetEgress): SubnetEgress => (nat && e.via !== "nat" ? { ...e, natBypassed: nat } : e);

  // 1) the route table cannot be read: nothing about the default route can be said
  if (s.routeTable === null) return { via: "unknown", evidence: "udr", unresolved: "unreadable", bgpMayOverride };

  // 2) a UDR default route
  if (s.routeTable) {
    const d = defaultRoute(s.routeTable);
    if (d && "mixed" in d) return bypassed({ via: "unknown", evidence: "udr", routeTable: { name: s.routeTable.name, prefix: "split" }, bgpMayOverride });
    if (d) {
      const hop = d.route.nextHopType.toLowerCase();
      const rt = { name: s.routeTable.name, prefix: d.prefix } as const;
      if (hop === "virtualappliance") {
        const ip = d.route.nextHopIp ?? "";
        const holders = ip ? ctx.holdersOf(ip, ctx.scope(s.vnetId)) : [];
        const base = { via: "appliance" as const, evidence: "udr" as const, routeTable: rt, nextHopIp: ip, bgpMayOverride };
        if (holders.length !== 1) return bypassed({ ...base, unresolved: holders.length ? "ambiguous" : "none" });
        const h = holders[0]!;
        return bypassed({ ...base, targetId: h.targetId, holder: h.kind, ...(h.ipForwarding === false ? { ipForwardingOff: true } : {}) });
      }
      if (hop === "virtualnetworkgateway") return bypassed({ via: "gateway", evidence: "udr", routeTable: rt, ...(gateway ? { targetId: gateway } : { unresolved: "none" as const }), bgpMayOverride });
      if (hop === "none") return bypassed({ via: "dropped", evidence: "udr", routeTable: rt, bgpMayOverride });
      if (hop === "vnetlocal") return bypassed({ via: "unknown", evidence: "udr", routeTable: rt, bgpMayOverride });
      // "Internet": no override — the next exits apply
    }
  }

  // 3) forced tunnelling configured on the gateway (only when routes propagate to this subnet)
  if (propagates && gateway && ctx.forcedTunnel(gateway)) return bypassed({ via: "gateway", evidence: "lngDefault", targetId: gateway, bgpMayOverride });

  // 4) NAT gateway (EDGE-01)
  if (nat) return { via: "nat", evidence: "cfg", targetId: nat, bgpMayOverride };

  // 4b) AzureFirewallSubnet: the firewall's own public IP
  if (s.firewall?.hasPublicIp) return { via: "publicIp", evidence: "cfg", targetId: s.firewall.id, bgpMayOverride };

  // 5) default outbound access (SEC-07)
  const dfl = s.defaultOutboundAccess?.toLowerCase();
  return { via: dfl === "true" ? "default" : dfl === "false" ? "noExit" : "unknown", evidence: "cfg", bgpMayOverride };
}

// ── UDRs whose next hop is an internal load balancer (NVA behind an ILB — Architecture Center "Deploy highly
// available NVAs"): any prefix, VirtualAppliance, the address held by exactly one ILB frontend in the subnet's VNet
// or its Connected peers. Azure does not count traffic that reaches an internal LB through a UDR in the LB's byte /
// packet / SYN metrics (load-balancer-standard-diagnostics) — so "0 bytes" on such an LB never means "unused".

export type UdrIlbEntry = { subnet: string; vnet: string; routeTable: string; prefixes: string[]; frontendIp: string };
export type UdrIlbFact = { state: "ok" | "unreadable"; routeTables: number; subnets: number; prefixes: number; entries: UdrIlbEntry[] };
export type UdrSubnet = { id: string; name: string; vnetId: string; vnetName: string; routeTable: RouteTableIn | null | undefined };

const MAX_UDR_ENTRIES = 20;

/** LB id → the subnets whose route table sends some prefix to one of its frontend IPs (configuration, not effective routes) */
export function udrNextHopsToIlb(subnets: readonly UdrSubnet[], ctx: Pick<EgressCtx, "holdersOf" | "scope">): Map<string, UdrIlbFact> {
  const acc = new Map<string, { tables: Set<string>; subnets: Set<string>; prefixes: Set<string>; entries: UdrIlbEntry[] }>();
  const sorted = [...subnets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of sorted) {
    if (!s.routeTable) continue;
    const scope = ctx.scope(s.vnetId);
    const byLb = new Map<string, Map<string, string[]>>(); // lb → frontend ip → prefixes
    for (const r of s.routeTable.routes) {
      if (r.nextHopType.toLowerCase() !== "virtualappliance" || !r.nextHopIp) continue;
      const holders = ctx.holdersOf(r.nextHopIp, scope);
      if (holders.length !== 1 || holders[0]!.kind !== "ilb") continue;
      const lb = holders[0]!.targetId.toLowerCase();
      const m = byLb.get(lb) ?? byLb.set(lb, new Map()).get(lb)!;
      (m.get(r.nextHopIp) ?? m.set(r.nextHopIp, []).get(r.nextHopIp)!).push(r.prefix);
    }
    for (const [lb, fes] of byLb) {
      const a = acc.get(lb) ?? acc.set(lb, { tables: new Set(), subnets: new Set(), prefixes: new Set(), entries: [] }).get(lb)!;
      a.tables.add(s.routeTable.name);
      a.subnets.add(s.id);
      for (const [ip, prefixes] of fes) {
        for (const p of prefixes) a.prefixes.add(p);
        if (a.entries.length < MAX_UDR_ENTRIES) a.entries.push({ subnet: s.name, vnet: s.vnetName, routeTable: s.routeTable.name, prefixes: [...prefixes].sort(), frontendIp: ip });
      }
    }
  }
  return new Map([...acc].map(([lb, a]) => [lb, { state: "ok" as const, routeTables: a.tables.size, subnets: a.subnets.size, prefixes: a.prefixes.size, entries: a.entries }]));
}

// ── A subnet's route table as configured, every route with what its next hop resolves to (the live diagram's UDR
// lines and the subnet panel). Configuration, not effective routes: BGP and longer prefixes may still win.

export type UdrRouteOut = {
  prefix: string; nextHopType: string; nextHopIp?: string;
  /** VirtualAppliance: the one holder of the address in reach · VirtualNetworkGateway: the gateway reached */
  target?: { id: string; kind: "firewall" | "vm" | "ilb" | "gateway" };
  unresolved?: "none" | "ambiguous" | "noGateway";
  ipForwardingOff?: boolean;
};
export type SubnetRoutes = { state: "ok" | "unreadable"; routeTable: { name: string; bgpPropagation: boolean } | null; routes: UdrRouteOut[]; total: number };

const MAX_ROUTES = 32;
const prefixLen = (p: string) => Number(p.split("/")[1] ?? 0);

export function resolveSubnetRoutes(rt: RouteTableIn | null, vnetId: string, ctx: Pick<EgressCtx, "holdersOf" | "scope" | "gatewayOf">): SubnetRoutes {
  if (rt === null) return { state: "unreadable", routeTable: null, routes: [], total: 0 };
  const scope = ctx.scope(vnetId);
  const out = rt.routes.map((r): UdrRouteOut => {
    const hop = r.nextHopType.toLowerCase();
    const base: UdrRouteOut = { prefix: r.prefix, nextHopType: r.nextHopType, ...(r.nextHopIp ? { nextHopIp: r.nextHopIp } : {}) };
    if (hop === "virtualappliance") {
      const h = r.nextHopIp ? ctx.holdersOf(r.nextHopIp, scope) : [];
      if (h.length !== 1) return { ...base, unresolved: h.length ? "ambiguous" : "none" };
      return { ...base, target: { id: h[0]!.targetId, kind: h[0]!.kind }, ...(h[0]!.ipForwarding === false ? { ipForwardingOff: true } : {}) };
    }
    if (hop === "virtualnetworkgateway") {
      const gw = ctx.gatewayOf(vnetId);
      return gw ? { ...base, target: { id: gw, kind: "gateway" } } : { ...base, unresolved: "noGateway" };
    }
    return base;
  });
  // Default routes first, then the longer (more specific) prefixes
  out.sort((a, b) => Number(b.prefix === "0.0.0.0/0") - Number(a.prefix === "0.0.0.0/0") || prefixLen(b.prefix) - prefixLen(a.prefix) || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  return { state: "ok", routeTable: { name: rt.name, bgpPropagation: !rt.disableBgpRoutePropagation }, routes: out.slice(0, MAX_ROUTES), total: out.length };
}
