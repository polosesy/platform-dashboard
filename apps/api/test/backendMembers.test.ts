// Backend-pool members and frontends of LB / Application Gateway (catalog AGW-01..05, LB-02..04, VMSS-04),
// plus the spec bindings and diagram facts that use them. Synthetic fixtures only (all-zero subscription).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
import { backendServerKeys, buildAddressIndex, parseFrontends, parsePools, resolveMember } from "../src/services/backendMembers.js";
import { edgeBindings, generateDiagramSpec } from "../src/services/specGenerator.js";
import { mergeSeries } from "../src/services/metricsCollector.js";
import * as lbNs from "../../web/src/lib/liveBackends.ts";

const lb = ((lbNs as unknown as { default?: typeof lbNs }).default ?? lbNs) as typeof lbNs;

const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers";
const id = (type: string, name: string) => `${SUB}/${type}/${name}`;
const VNET = id("microsoft.network/virtualnetworks", "hub");
const PEER = id("microsoft.network/virtualnetworks", "spoke");
const OTHER = id("microsoft.network/virtualnetworks", "elsewhere");
const NIC_A = id("microsoft.network/networkinterfaces", "nic-a");
const NIC_B = id("microsoft.network/networkinterfaces", "nic-b");
const VMSS = id("microsoft.compute/virtualmachinescalesets", "web");
const ILB = id("microsoft.network/loadbalancers", "ilb");
const SITE = id("microsoft.web/sites", "app1");

const agwProps = {
  frontendIPConfigurations: [
    { name: "fe-priv", properties: { privateIPAddress: "10.0.0.10" } },
    { name: "fe-pub", properties: { publicIPAddress: { id: "/x/pip-agw" } } },
    { name: "fe-pub-idle", properties: { publicIPAddress: { id: "/x/pip-idle" } } },
  ],
  httpListeners: [
    { name: "l-pub-80", properties: { frontendIPConfiguration: { id: "/agw/frontendIPConfigurations/fe-pub" } } },
    { name: "l-pub-8083", properties: { frontendIPConfiguration: { id: "/agw/frontendIPConfigurations/fe-pub" } } },
    { name: "l-priv", properties: { frontendIPConfiguration: { id: "/agw/frontendIPConfigurations/fe-priv" } } },
    { name: "l-idle", properties: { frontendIPConfiguration: { id: "/agw/frontendIPConfigurations/fe-pub-idle" } } },
  ],
  requestRoutingRules: [
    { name: "r1", properties: { httpListener: { id: "/agw/httpListeners/l-pub-80" }, backendAddressPool: { id: "/agw/backendAddressPools/pool-a" }, backendHttpSettings: { id: "/agw/backendHttpSettingsCollection/s80" } } },
    { name: "r2", properties: { httpListener: { id: "/agw/httpListeners/l-pub-8083" }, backendAddressPool: { id: "/agw/backendAddressPools/pool-a" }, backendHttpSettings: { id: "/agw/backendHttpSettingsCollection/s8080" } } },
    { name: "r3", properties: { httpListener: { id: "/agw/httpListeners/l-priv" }, backendAddressPool: { id: "/agw/backendAddressPools/pool-b" }, backendHttpSettings: { id: "/agw/backendHttpSettingsCollection/s80" } } },
  ],
  backendHttpSettingsCollection: [{ name: "s80", properties: { port: 80 } }, { name: "s8080", properties: { port: 8080 } }],
  backendAddressPools: [
    { name: "pool-a", properties: { backendAddresses: [{ ipAddress: "10.0.1.4" }, { fqdn: "APP1.azurewebsites.net" }] } },
    { name: "pool-b", properties: { backendIPConfigurations: [{ id: `${NIC_B}/ipConfigurations/ipconfig1` }] } },
    { name: "pool-unused", properties: { backendAddresses: [{ ipAddress: "10.0.1.9" }] } },
  ],
};

test("AGW frontends: public + private; only rule-bound listeners count; an idle public frontend is not an entry", () => {
  const fes = parseFrontends("appGateway", agwProps, (pip) => (pip === "/x/pip-agw" ? "203.0.113.20" : undefined));
  const by = Object.fromEntries(fes.map((f) => [f.name, f]));
  assert.deepEqual([by["fe-pub"]!.kind, by["fe-pub"]!.ip, by["fe-pub"]!.listeners, by["fe-pub"]!.ruleBound], ["public", "203.0.113.20", ["l-pub-80", "l-pub-8083"], true]);
  assert.deepEqual([by["fe-priv"]!.kind, by["fe-priv"]!.ip, by["fe-priv"]!.ruleBound], ["private", "10.0.0.10", true]);
  assert.equal(by["fe-pub-idle"]!.ruleBound, false, "a listener no rule uses carries nothing");
});

test("AGW pools: NIC references, IPs and FQDNs; ports from the rules' HTTP settings; unused pools have no inbound refs", () => {
  const pools = Object.fromEntries(parsePools("appGateway", agwProps).map((p) => [p.name, p]));
  assert.deepEqual(pools["pool-a"]!.members, [{ via: "ip", address: "10.0.1.4" }, { via: "fqdn", address: "app1.azurewebsites.net" }]);
  assert.deepEqual(pools["pool-a"]!.ports, [80, 8080]);
  assert.deepEqual(pools["pool-b"]!.members, [{ via: "nic", ref: NIC_B.toLowerCase() }]);
  assert.equal(pools["pool-unused"]!.inboundRuleRefs, 0);
  assert.deepEqual(backendServerKeys("10.0.1.4", [80, 8080]), ["10.0.1.4:80", "10.0.1.4:8080"], "BackendServer is ip:port");
});

test("an address resolves only to exactly one holder in the allowed VNets", () => {
  const idx = buildAddressIndex([
    { address: "10.0.1.4", targetId: NIC_A.toLowerCase(), vnetId: VNET.toLowerCase(), source: "nic" },
    { address: "10.0.1.5", targetId: NIC_A.toLowerCase(), vnetId: VNET.toLowerCase(), source: "nic" },
    { address: "10.0.1.5", targetId: NIC_B.toLowerCase(), vnetId: VNET.toLowerCase(), source: "nic" },
    { address: "10.9.0.4", targetId: NIC_B.toLowerCase(), vnetId: PEER.toLowerCase(), source: "nic" },
    { address: "10.7.0.4", targetId: NIC_B.toLowerCase(), vnetId: OTHER.toLowerCase(), source: "nic" },
    { address: "10.0.2.100", targetId: ILB.toLowerCase(), vnetId: VNET.toLowerCase(), source: "lbFrontend" },
    { address: "app1.azurewebsites.net", targetId: SITE.toLowerCase(), source: "site" },
  ]);
  const known = new Set([NIC_A, NIC_B, ILB, SITE, VMSS].map((x) => x.toLowerCase()));
  const scope = new Set([VNET, PEER].map((x) => x.toLowerCase()));
  assert.deepEqual(resolveMember({ via: "ip", address: "10.0.1.4" }, scope, idx, known), { targetId: NIC_A.toLowerCase(), evidence: "ipMatch", source: "nic" });
  assert.deepEqual(resolveMember({ via: "ip", address: "10.0.1.5" }, scope, idx, known), { unresolved: "ambiguous", candidates: 2 });
  assert.deepEqual(resolveMember({ via: "ip", address: "10.0.1.99" }, scope, idx, known), { unresolved: "none" });
  assert.equal((resolveMember({ via: "ip", address: "10.9.0.4" }, scope, idx, known) as { targetId: string }).targetId, NIC_B.toLowerCase(), "a connected peer counts");
  assert.deepEqual(resolveMember({ via: "ip", address: "10.7.0.4" }, scope, idx, known), { unresolved: "none" }, "an unpeered VNet does not");
  assert.equal((resolveMember({ via: "ip", address: "10.0.2.100" }, scope, idx, known) as { targetId: string }).targetId, ILB.toLowerCase(), "AGW → AKS internal LB by its frontend IP");
  assert.deepEqual(resolveMember({ via: "fqdn", address: "app1.azurewebsites.net" }, scope, idx, known), { targetId: SITE.toLowerCase(), evidence: "fqdnMatch", source: "site" });
  assert.deepEqual(resolveMember({ via: "fqdn", address: "api.example.com" }, scope, idx, known), { unresolved: "fqdn" });
  const uniformNic = `${VMSS}/virtualMachines/0/networkInterfaces/nic`.toLowerCase();
  assert.deepEqual(resolveMember({ via: "nic", ref: uniformNic }, scope, idx, known), { targetId: VMSS.toLowerCase(), evidence: "cfg" }, "a Uniform instance NIC is the scale set");
  // LB IP pool: only the member's own VNet
  assert.deepEqual(resolveMember({ via: "ip", address: "10.9.0.4", vnetId: VNET.toLowerCase() }, scope, idx, known), { unresolved: "none" });
});

test("LB pools: NIC wins over IP in loadBalancerBackendAddresses; rule references are known or unknown", () => {
  const pools = parsePools("lb", {
    backendAddressPools: [
      { name: "p-nic", properties: { loadBalancingRules: [{ id: "r" }], loadBalancerBackendAddresses: [{ properties: { networkInterfaceIPConfiguration: { id: `${NIC_A}/ipConfigurations/c` }, ipAddress: "10.0.1.4" } }] } },
      { name: "p-ip", properties: { loadBalancerBackendAddresses: [{ properties: { ipAddress: "10.0.1.7", virtualNetwork: { id: VNET } } }] } },
      { name: "p-out", properties: { outboundRules: [{ id: "o" }], backendIPConfigurations: [{ id: `${NIC_B}/ipConfigurations/c` }] } },
    ],
  });
  assert.deepEqual(pools.map((p) => [p.name, p.members.map((m) => m.via), p.inboundRuleRefs, p.outboundRuleRefs]), [
    ["p-nic", ["nic"], 1, null], ["p-ip", ["ip"], null, null], ["p-out", ["nic"], null, 1],
  ]);
  assert.equal(pools[1]!.members[0]!.vnetId, VNET.toLowerCase());
});

// ── live spec: ingress by public listeners, backend member bindings, chips ──

const node = (kind: ArchitectureNode["kind"], azureId: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id: azureId.toLowerCase(), kind, name: azureId.split("/").pop()!, azureId: azureId.toLowerCase(), location: "koreacentral", resourceGroup: "rg", ...extra,
});
const edge = (kind: ArchitectureEdge["kind"], s: string, t: string, metadata?: ArchitectureEdge["metadata"]): ArchitectureEdge => ({ id: `${kind}:${s}->${t}`, kind, source: s.toLowerCase(), target: t.toLowerCase(), metadata });

test("spec: an AGW with public + private frontends is an inbound path read by its public listeners; member lines carry quality", async () => {
  const V = VNET, SN_AGW = `${VNET}/subnets/snet-agw`, SN_WEB = `${VNET}/subnets/snet-web`;
  const AGW = id("microsoft.network/applicationgateways", "agw");
  const VM = id("microsoft.compute/virtualmachines", "vm-web"), VMF = id("microsoft.compute/virtualmachines", "vmss-web_1");
  const NIC = id("microsoft.network/networkinterfaces", "vm-web-nic"), NICF = id("microsoft.network/networkinterfaces", "vmss-web-nic");
  const FLEX = id("microsoft.compute/virtualmachinescalesets", "vmss-web");
  const KLB = id("microsoft.network/loadbalancers", "kubernetes");
  const graph: ArchitectureGraph = {
    generatedAt: "", nodes: [
      node("vnet", V), node("subnet", SN_AGW, { endpoint: "10.0.0.0/24" }), node("subnet", SN_WEB, { endpoint: "10.0.1.0/24" }),
      node("appGateway", AGW, { endpoint: "10.0.0.10", metadata: { inboundRules: 2, privateListeners: 1, frontends: [
        { name: "fe-pub", kind: "public", ip: "203.0.113.20", listeners: ["l-pub-80", "l'x"], ruleBound: true },
        { name: "fe-priv", kind: "private", ip: "10.0.0.10", listeners: ["l-priv"], ruleBound: true },
      ], unresolvedBackends: [{ pool: "pool-a", address: "192.0.2.9", reason: "none" }] } }),
      node("vm", VM), node("nic", NIC, { endpoint: "10.0.1.5" }), node("vm", VMF), node("nic", NICF, { endpoint: "10.0.1.4" }),
      node("vmss", FLEX, { metadata: { orchestrationMode: "Flexible", capacity: 1 } }),
      node("lb", KLB, { endpoint: "203.0.113.30", metadata: { inboundRules: 0, outboundRules: 1, managedBy: "aks", frontends: [{ name: "fe", kind: "public", ip: "203.0.113.30", listeners: [], ruleBound: false }] } }),
    ],
    edges: [
      edge("contains", V, SN_AGW), edge("contains", V, SN_WEB), edge("connects", SN_AGW, AGW),
      edge("attached-to", SN_WEB, NIC), edge("bound-to", NIC, VM), edge("attached-to", SN_WEB, NICF), edge("bound-to", NICF, VMF),
      edge("member-of", VMF, FLEX),
      edge("routes", AGW, NIC, { rel: "AGW-04", via: "ip", pool: "pool-a", address: "10.0.1.5", ports: [80], evidence: "ipMatch", direction: "inbound" }),
      edge("routes", AGW, NICF, { rel: "AGW-04", via: "ip", pool: "pool-b", address: "10.0.1.4", ports: [80], evidence: "ipMatch", direction: "inbound" }),
    ],
  };
  const { spec } = await generateDiagramSpec(graph, "00000000-0000-0000-0000-000000000000");
  const byLabel = (l: string) => spec.nodes.find((x) => x.label === l)!;
  const agw = byLabel("agw");
  assert.deepEqual(agw.subResources?.map((s) => s.kind), ["publicIP", "frontendIP"], "both frontends");
  const inbound = spec.edges.find((x) => x.target === agw.id && x.flowType === "ingress" && spec.nodes.find((n) => n.id === x.source)?.resourceKind === "internet");
  assert.ok(inbound, "Internet → AGW");
  assert.equal(inbound!.bindings.throughput?.filter, "Listener eq 'l-pub-80' or Listener eq 'l''x'", "public listeners only, quotes doubled");
  assert.ok(inbound!.bindings.gatewayTotal, "context: all listeners");
  assert.deepEqual(inbound!.caveats, ["ld.edge.caveat.publicFrontend"]);
  const member = spec.edges.find((x) => x.source === agw.id && x.target === byLabel("vm-web").id)!;
  assert.deepEqual(member.backend, { via: "ip", pool: "pool-a", address: "10.0.1.5", ports: [80], evidence: "ipMatch" });
  assert.equal(member.bindings.backendRequests?.filter, "BackendServer eq '10.0.1.5:80'");
  assert.equal(member.bindings.backendConnectMs?.metric, "BackendConnectTime");
  assert.equal(member.bindings.throughput, undefined, "no per-member bytes exist — no particles");
  assert.equal(byLabel("vmss-web_1").metadata?.scaleSet, "vmss-web", "Flexible instance keeps its card, with the scale-set chip");
  assert.ok(!spec.edges.some((x) => x.source === byLabel("vmss-web_1").id && x.target === byLabel("vmss-web")?.id), "member-of is not a line");
  const k = byLabel("kubernetes");
  assert.ok(!spec.edges.some((x) => x.target === k.id && x.flowType === "ingress"), "an outbound-only LB is not an inbound path");
  assert.deepEqual(lb.gatewayFacts(k.metadata), { unresolved: 0, aksManaged: true, outboundOnly: true });
  assert.deepEqual(lb.gatewayFacts(agw.metadata), { unresolved: 1, aksManaged: false, outboundOnly: false });
  assert.equal(lb.unresolvedBackends(agw.metadata)[0]!.address, "192.0.2.9");
});

test("edge bindings: LB member probe by BackendIPAddress; a VMSS-model line gets no member metric", () => {
  const byId = new Map([["lb", { icon: "lb", resourceKind: "lb" }], ["vm", { icon: "vm", resourceKind: "vm" }]] as const);
  const probe = edgeBindings({ edgeKind: "routes", source: "lb", target: "vm", backend: { via: "nic", address: "10.0.1.4" } }, byId as never);
  assert.equal(probe.bindings.probe?.filter, "BackendIPAddress eq '10.0.1.4'");
  assert.deepEqual(edgeBindings({ edgeKind: "routes", source: "lb", target: "vm", backend: { via: "vmssModel" } }, byId as never).bindings, {});
});

test("a dimension filter's series are merged: totals add, averages average", () => {
  const merged = mergeSeries([
    { data: [{ timeStamp: "t1", total: 2, average: 10 }, { timeStamp: "t2", total: 3 }] },
    { data: [{ timeStamp: "t1", total: 5, average: 20 }] },
  ]);
  assert.deepEqual(merged, [{ timeStamp: "t1", total: 7, average: 15 }, { timeStamp: "t2", total: 3 }]);
  assert.deepEqual(mergeSeries([{ data: [{ timeStamp: "a", total: 1 }] }]), [{ timeStamp: "a", total: 1 }]);
  assert.deepEqual(mergeSeries([]), []);
});

test("canvas label carries the measured member quality", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.n ?? ""}`;
  assert.equal(lb.withBackendValue("App GW", { responsesPerMin: 54.4 }, t), "App GW · ld.edge.perMin:54");
  assert.equal(lb.withBackendValue("LB", { probePct: 100 }, t), "LB · ld.edge.probeShort:100");
  assert.equal(lb.withBackendValue("LB", {}, t), "LB");
});
