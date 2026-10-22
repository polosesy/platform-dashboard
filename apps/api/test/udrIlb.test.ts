import { test } from "node:test";
import assert from "node:assert/strict";
import { udrNextHopsToIlb, type ApplianceHolder, type UdrSubnet } from "../src/services/subnetEgress.js";

// A hub with an internal LB in front of NVAs (synthetic names, RFC 1918 addresses); spokes peered to it
const HUB = "/s/rg/vnets/hub", SPOKE = "/s/rg/vnets/spoke", LONE = "/s/rg/vnets/lone";
const ILB = "/s/rg/lb/lbi-nva", FW = "/s/rg/fw/afw";
const holders = new Map<string, ApplianceHolder[]>([
  ["10.110.12.10", [{ kind: "ilb", targetId: ILB }]],
  ["10.110.1.4", [{ kind: "firewall", targetId: FW }]],
  ["10.110.12.20", [{ kind: "ilb", targetId: ILB }, { kind: "vm", targetId: "/s/rg/vm/x" }]],
]);
const ctx = {
  holdersOf: (ip: string, vnets: ReadonlySet<string>) => (vnets.has(HUB) ? holders.get(ip) ?? [] : []),
  scope: (v: string) => new Set(v === LONE ? [LONE] : [v, HUB]),
};
const rt = (name: string, routes: Array<[string, string, string?]>) => ({ name, disableBgpRoutePropagation: false, routes: routes.map(([prefix, nextHopType, nextHopIp]) => ({ prefix, nextHopType, nextHopIp: nextHopIp ?? null })) });
const sub = (id: string, vnetId: string, routeTable: UdrSubnet["routeTable"]): UdrSubnet => ({ id, name: id.split("/").pop()!, vnetId, vnetName: vnetId.split("/").pop()!, routeTable });

test("UDR next hop → internal LB: any prefix, VirtualAppliance, exactly one ILB holder in reach", () => {
  const shared = rt("rt-spoke", [["0.0.0.0/0", "VirtualAppliance", "10.110.12.10"], ["10.0.0.0/8", "virtualappliance", "10.110.12.10"], ["192.168.0.0/16", "VnetLocal"], ["8.8.8.8/32", "Internet"]]);
  const facts = udrNextHopsToIlb([
    sub(`${SPOKE}/subnets/app`, SPOKE, shared),
    sub(`${SPOKE}/subnets/web`, SPOKE, shared),
    sub(`${SPOKE}/subnets/fw`, SPOKE, rt("rt-fw", [["0.0.0.0/0", "VirtualAppliance", "10.110.1.4"]])),
    sub(`${SPOKE}/subnets/amb`, SPOKE, rt("rt-amb", [["0.0.0.0/0", "VirtualAppliance", "10.110.12.20"]])),
    sub(`${LONE}/subnets/x`, LONE, rt("rt-lone", [["0.0.0.0/0", "VirtualAppliance", "10.110.12.10"]])),
    sub(`${SPOKE}/subnets/none`, SPOKE, undefined),
  ], ctx);
  const f = facts.get(ILB);
  assert.ok(f);
  assert.deepEqual([f!.state, f!.routeTables, f!.subnets, f!.prefixes], ["ok", 1, 2, 2], "one table on two subnets, two prefixes (lowercase type counted)");
  assert.deepEqual(f!.entries[0]!.prefixes, ["0.0.0.0/0", "10.0.0.0/8"]);
  assert.equal(facts.size, 1, "a firewall / ambiguous holder / unpeered VNet is never counted for the LB");
});
