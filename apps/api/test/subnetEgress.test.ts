import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSubnetEgress, resolveSubnetRoutes, type EgressCtx, type EgressSubnet, type RouteTableIn } from "../src/services/subnetEgress.js";

const HUB = "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/virtualnetworks/hub";
const SPOKE = "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/virtualnetworks/spoke";
const FW = "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/azurefirewalls/fw";
const GW = "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/virtualnetworkgateways/gw";
const NAT = "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/natgateways/nat";

const ctx = (o: Partial<EgressCtx> & { peers?: boolean; gateway?: string | null; tunnel?: boolean } = {}): EgressCtx => ({
  holdersOf: o.holdersOf ?? ((ip, vnets) => (ip === "10.0.0.4" && vnets.has(HUB) ? [{ kind: "firewall", targetId: FW }] : [])),
  scope: o.scope ?? ((v) => new Set(o.peers === false ? [v] : [v, HUB])),
  gatewayOf: o.gatewayOf ?? (() => (o.gateway === undefined ? null : o.gateway)),
  forcedTunnel: o.forcedTunnel ?? (() => !!o.tunnel),
});
const rt = (routes: RouteTableIn["routes"], disableBgp = false): RouteTableIn => ({ name: "rt-spoke", routes, disableBgpRoutePropagation: disableBgp });
const sub = (o: Partial<EgressSubnet> = {}): EgressSubnet => ({ vnetId: SPOKE, routeTable: undefined, ...o });

test("no route table: NAT, then default outbound (true / false / not set)", () => {
  assert.equal(resolveSubnetEgress(sub({ natGatewayId: NAT }), ctx()).via, "nat");
  assert.equal(resolveSubnetEgress(sub({ defaultOutboundAccess: "true" }), ctx()).via, "default");
  assert.equal(resolveSubnetEgress(sub({ defaultOutboundAccess: "false" }), ctx()).via, "noExit");
  assert.equal(resolveSubnetEgress(sub(), ctx()).via, "unknown");
});

test("0.0.0.0/0 → firewall in a Connected hub: the appliance is the exit and the NAT is bypassed", () => {
  const e = resolveSubnetEgress(sub({ natGatewayId: NAT, routeTable: rt([{ prefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" }]) }), ctx());
  assert.equal(e.via, "appliance");
  assert.equal(e.targetId, FW);
  assert.equal(e.holder, "firewall");
  assert.equal(e.natBypassed, NAT);
  assert.deepEqual(e.routeTable, { name: "rt-spoke", prefix: "0.0.0.0/0" });
});

test("appliance address: no holder in reach (peer not Connected) / two holders → unresolved, never guessed", () => {
  const r = rt([{ prefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" }]);
  const none = resolveSubnetEgress(sub({ routeTable: r }), ctx({ peers: false }));
  assert.equal(none.unresolved, "none");
  assert.equal(none.targetId, undefined);
  const two = resolveSubnetEgress(sub({ routeTable: r }), ctx({ holdersOf: () => [{ kind: "vm", targetId: "a" }, { kind: "vm", targetId: "b" }] }));
  assert.equal(two.unresolved, "ambiguous");
  const off = resolveSubnetEgress(sub({ routeTable: r }), ctx({ holdersOf: () => [{ kind: "vm", targetId: "nva", ipForwarding: false }] }));
  assert.equal(off.ipForwardingOff, true);
});

test("split default (0.0.0.0/1 + 128.0.0.0/1): same hop wins over 0.0.0.0/0; different hops → unknown", () => {
  const same = resolveSubnetEgress(sub({ routeTable: rt([
    { prefix: "0.0.0.0/0", nextHopType: "Internet" },
    { prefix: "0.0.0.0/1", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" },
    { prefix: "128.0.0.0/1", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" },
  ]) }), ctx());
  assert.equal(same.via, "appliance");
  assert.equal(same.routeTable?.prefix, "split");
  const mixed = resolveSubnetEgress(sub({ routeTable: rt([{ prefix: "0.0.0.0/1", nextHopType: "Internet" }, { prefix: "128.0.0.0/1", nextHopType: "None" }]) }), ctx());
  assert.equal(mixed.via, "unknown");
});

test("next hop gateway / None / Internet; forced tunnelling through the gateway; BGP may override", () => {
  const gw = resolveSubnetEgress(sub({ routeTable: rt([{ prefix: "0.0.0.0/0", nextHopType: "VirtualNetworkGateway" }]) }), ctx({ gateway: GW }));
  assert.deepEqual([gw.via, gw.targetId, gw.bgpMayOverride], ["gateway", GW, true]);
  const dropped = resolveSubnetEgress(sub({ natGatewayId: NAT, routeTable: rt([{ prefix: "0.0.0.0/0", nextHopType: "None" }]) }), ctx());
  assert.deepEqual([dropped.via, dropped.natBypassed], ["dropped", NAT]);
  const inet = resolveSubnetEgress(sub({ natGatewayId: NAT, routeTable: rt([{ prefix: "0.0.0.0/0", nextHopType: "Internet" }]) }), ctx());
  assert.equal(inet.via, "nat", "a UDR to Internet does not override the NAT");
  const tunnel = resolveSubnetEgress(sub({ natGatewayId: NAT }), ctx({ gateway: GW, tunnel: true }));
  assert.deepEqual([tunnel.via, tunnel.evidence, tunnel.natBypassed], ["gateway", "lngDefault", NAT]);
  const noProp = resolveSubnetEgress(sub({ natGatewayId: NAT, routeTable: rt([], true) }), ctx({ gateway: GW, tunnel: true }));
  assert.deepEqual([noProp.via, noProp.bgpMayOverride], ["nat", false], "propagation off: the gateway's default route never arrives");
});

test("route table unreadable → unknown; AzureFirewallSubnet → the firewall's own public IP", () => {
  assert.equal(resolveSubnetEgress(sub({ routeTable: null, natGatewayId: NAT }), ctx()).unresolved, "unreadable");
  const fw = resolveSubnetEgress(sub({ vnetId: HUB, firewall: { id: FW, hasPublicIp: true } }), ctx());
  assert.deepEqual([fw.via, fw.targetId], ["publicIp", FW]);
});

test("route table as configured: every route, its next hop resolved — appliance (one holder), gateway, or why not; defaults first", () => {
  const r = resolveSubnetRoutes(rt([
    { prefix: "10.0.0.0/8", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" },
    { prefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIp: "10.0.0.4" },
    { prefix: "172.16.0.0/12", nextHopType: "VirtualNetworkGateway" },
    { prefix: "192.168.0.0/16", nextHopType: "VirtualAppliance", nextHopIp: "10.9.9.9" },
    { prefix: "203.0.113.0/24", nextHopType: "None" },
  ]), SPOKE, ctx({ gateway: GW }));
  assert.equal(r.state, "ok");
  assert.deepEqual(r.routeTable, { name: "rt-spoke", bgpPropagation: true });
  assert.equal(r.routes[0]!.prefix, "0.0.0.0/0", "the default route first");
  assert.deepEqual(r.routes.find((x) => x.prefix === "10.0.0.0/8")!.target, { id: FW, kind: "firewall" });
  assert.deepEqual(r.routes.find((x) => x.prefix === "172.16.0.0/12")!.target, { id: GW, kind: "gateway" });
  assert.equal(r.routes.find((x) => x.prefix === "192.168.0.0/16")!.unresolved, "none");
  assert.equal(r.routes.find((x) => x.prefix === "203.0.113.0/24")!.target, undefined);
  assert.equal(resolveSubnetRoutes(null, SPOKE, ctx()).state, "unreadable");
  assert.equal(resolveSubnetRoutes(rt([{ prefix: "0.0.0.0/0", nextHopType: "VirtualNetworkGateway" }]), SPOKE, ctx()).routes[0]!.unresolved, "noGateway");
});
