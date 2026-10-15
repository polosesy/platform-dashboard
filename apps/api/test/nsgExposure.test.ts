// Internet → instance-level public IP exposure (catalog PIP-04): subnet NSG then NIC NSG, first match by priority,
// destination after translation, default rules, SKU default. Synthetic rules only (RFC 5737 addresses).
import { test } from "node:test";
import assert from "node:assert/strict";
import { internetInboundExposure, mostExposed, routesWidenVnetTag, type NsgRuleInput } from "../src/services/nsgExposure.js";
import { RISK_PORTS, portSpecTier, portTier } from "../src/services/riskPorts.js";
import * as webPortsNs from "../../web/src/lib/riskPorts.ts";

const webPorts = ((webPortsNs as unknown as { default?: typeof webPortsNs }).default ?? webPortsNs) as typeof webPortsNs;

let prio = 100;
const rule = (p: Record<string, unknown>): NsgRuleInput => ({
  name: `r${prio}`,
  properties: { priority: prio++, direction: "Inbound", access: "Allow", protocol: "Tcp", destinationAddressPrefix: "*", ...p },
});
const nsg = (...securityRules: NsgRuleInput[]) => ({ securityRules });
const VM = { privateIp: "10.1.2.4", asgIds: [] as string[], pipSku: "Standard" };

test("Standard public IP without any NSG is closed by default; Basic is open", () => {
  assert.equal(internetInboundExposure(null, null, VM).state, "noNsg");
  const basic = internetInboundExposure(null, null, { ...VM, pipSku: "Basic" });
  assert.equal(basic.state, "open");
  assert.deepEqual(basic.ports, ["*"]);
});

test("only default rules → closed (DenyAllInBound 65500)", () => {
  const e = internetInboundExposure(nsg(), null, VM);
  assert.equal(e.state, "closed");
  assert.deepEqual(e.nsgs, ["subnet"]);
});

test("allow from * / Internet → open with the ports", () => {
  const e = internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: "*", destinationPortRange: "22" }), rule({ sourceAddressPrefix: "Internet", destinationPortRanges: ["443", "8000-8100"] })), VM);
  assert.equal(e.state, "open");
  assert.equal(e.sources, "any");
  assert.deepEqual(e.ports, ["22", "443", "8000-8100"]);
});

test("a deny with a lower priority number wins over a later allow (first match)", () => {
  const e = internetInboundExposure(null, nsg(
    rule({ access: "Deny", sourceAddressPrefix: "*", destinationPortRange: "22" }),
    rule({ sourceAddressPrefix: "*", destinationPortRange: "22-23" }),
  ), VM);
  assert.equal(e.state, "open");
  assert.deepEqual(e.ports, ["23"]);
});

test("subnet AND NIC: both must allow — port intersection", () => {
  const sub = nsg(rule({ sourceAddressPrefix: "*", destinationPortRanges: ["22", "80"] }));
  const nic = nsg(rule({ sourceAddressPrefix: "*", destinationPortRange: "80" }));
  const e = internetInboundExposure(sub, nic, VM);
  assert.deepEqual(e.ports, ["80"]);
  assert.deepEqual(e.nsgs, ["subnet", "nic"]);
  assert.equal(internetInboundExposure(sub, nsg(), VM).state, "closed");
});

test("listed public ranges → scoped; open ∩ scoped = scoped; disjoint ranges → closed", () => {
  const scopedNic = nsg(rule({ sourceAddressPrefixes: ["203.0.113.0/24", "198.51.100.7"], destinationPortRange: "22" }));
  const s = internetInboundExposure(null, scopedNic, VM);
  assert.equal(s.state, "scoped");
  assert.equal(s.sources, "ranges");
  assert.equal(s.rangeCount, 2);
  const wideSub = nsg(rule({ sourceAddressPrefix: "*", destinationPortRange: "*" }));
  assert.equal(internetInboundExposure(wideSub, scopedNic, VM).state, "scoped");
  const otherSub = nsg(rule({ sourceAddressPrefix: "192.0.2.0/24", destinationPortRange: "22" }));
  assert.equal(internetInboundExposure(otherSub, scopedNic, VM).state, "closed");
});

test("service tags are scoped; AzureCloud is marked; VirtualNetwork / AzureLoadBalancer / private ranges are not Internet", () => {
  const tag = internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: "AzureCloud", destinationPortRange: "22" })), VM);
  assert.equal(tag.state, "scoped");
  assert.equal(tag.sources, "tags");
  assert.equal(tag.azureCloud, true);
  for (const src of ["VirtualNetwork", "AzureLoadBalancer", "10.0.0.0/8", "172.20.1.0/24", "192.168.1.5"]) {
    assert.equal(internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: src, destinationPortRange: "*" })), VM).state, "closed", src);
  }
});

test("destination is matched after translation: another VM's private IP does not expose this one", () => {
  const other = internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: "*", destinationAddressPrefix: "10.1.2.9", destinationPortRange: "22" })), VM);
  assert.equal(other.state, "closed");
  const mine = internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: "*", destinationAddressPrefix: "10.1.2.0/24", destinationPortRange: "22" })), VM);
  assert.equal(mine.state, "open");
});

test("destination ASG: member → applies, not member → ignored, membership unknown → unknown", () => {
  const r = rule({ sourceAddressPrefix: "*", destinationAddressPrefix: undefined, destinationApplicationSecurityGroups: [{ id: "/subscriptions/0/x/asg-web" }], destinationPortRange: "443" });
  assert.equal(internetInboundExposure(null, nsg(r), { ...VM, asgIds: ["/subscriptions/0/x/asg-web"] }).state, "open");
  assert.equal(internetInboundExposure(null, nsg(r), { ...VM, asgIds: [] }).state, "closed");
  const u = internetInboundExposure(null, nsg(r), { ...VM, asgIds: undefined });
  assert.equal(u.state, "unknown");
  assert.ok(u.reasons.includes("asgUnknown"));
});

test("a 0.0.0.0/0 user-defined route widens VirtualNetwork → AllowVnetInBound makes it unknown", () => {
  assert.equal(routesWidenVnetTag([{ properties: { addressPrefix: "0.0.0.0/0" } }]), true);
  assert.equal(routesWidenVnetTag([{ properties: { addressPrefix: "10.20.0.0/16" } }]), false);
  const e = internetInboundExposure(nsg(), null, { ...VM, vnetTagWidened: true });
  assert.equal(e.state, "unknown");
  assert.ok(e.reasons.includes("vnetTagWidened"));
});

test("AVNM present or an NSG that cannot be read → unknown, never closed", () => {
  assert.equal(internetInboundExposure(nsg(), null, { ...VM, avnmPresent: true }).state, "unknown");
  const unread = internetInboundExposure(undefined, null, VM);
  assert.equal(unread.state, "unknown");
  assert.ok(unread.reasons.includes("nsgUnreadable"));
});

test("UDP-only and ICMP rules", () => {
  const e = internetInboundExposure(null, nsg(rule({ protocol: "Udp", sourceAddressPrefix: "*", destinationPortRange: "53" }), rule({ protocol: "Icmp", sourceAddressPrefix: "*", destinationPortRange: "*" })), VM);
  assert.equal(e.state, "open");
  assert.deepEqual(e.ports, ["53/udp"]);
});

test("mostExposed and risk tiers", () => {
  const closed = internetInboundExposure(nsg(), null, VM);
  const open = internetInboundExposure(null, nsg(rule({ sourceAddressPrefix: "*", destinationPortRange: "3389" })), VM);
  assert.equal(mostExposed([closed, open])?.state, "open");
  assert.equal(portTier(22), "critical");
  assert.equal(portTier(1521), "high");
  assert.equal(portTier(443), null);
  assert.equal(portSpecTier(["443", "5600-5700"]), "medium"); // contains 5601
  assert.equal(portSpecTier(["*"]), "critical");
  assert.equal(portSpecTier(["443"]), null);
});

test("the API and web risk-port lists are the same", () => {
  assert.deepEqual(webPorts.RISK_PORTS, RISK_PORTS);
});
