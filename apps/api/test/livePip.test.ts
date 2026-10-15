// Internet → VM through its own public IP (catalog PIP-04) end to end: graph verdict → live spec line and bindings
// → measured resources → card chip → layout / route → infrastructure diagram. Synthetic fixtures (all-zero
// subscription, RFC 5737 addresses).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, DiagramNodeSpec, InboundExposure } from "@aud/types";
import { edgeBindings, generateDiagramSpec } from "../src/services/specGenerator.js";
import { measuredResources } from "../src/services/liveAggregator.js";
import { sumMetricRecords } from "../src/services/metricsCollector.js";
import * as pipNs from "../../web/src/lib/livePip.ts";
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as archNs from "../../web/src/lib/archModel.ts";

const pip = ((pipNs as unknown as { default?: typeof pipNs }).default ?? pipNs) as typeof pipNs;
const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const A = ((archNs as unknown as { default?: typeof archNs }).default ?? archNs) as typeof archNs;

const SUBID = "00000000-0000-0000-0000-000000000000";
const SUB = `/subscriptions/${SUBID}/resourcegroups/rg/providers`;
const id = (type: string, name: string) => `${SUB}/${type}/${name}`;
const node = (kind: ArchitectureNode["kind"], azureId: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id: azureId.toLowerCase(), kind, name: azureId.split("/").pop()!, azureId: azureId.toLowerCase(), location: "koreacentral", resourceGroup: "rg", ...extra,
});
const edge = (kind: ArchitectureEdge["kind"], s: string, t: string): ArchitectureEdge => ({ id: `${kind}:${s}->${t}`, kind, source: s.toLowerCase(), target: t.toLowerCase() });
const ex = (state: InboundExposure["state"], ports: string[] = []): InboundExposure =>
  ({ state, ports, sources: state === "open" ? "any" : state === "scoped" ? "ranges" : "none", rangeCount: state === "scoped" ? 1 : 0, nsgs: ["nic"], reasons: [], basis: "cfg" });

const V = id("microsoft.network/virtualnetworks", "hub"), SN = `${V}/subnets/snet-app`, SN2 = `${V}/subnets/snet-nat`;
const NAT = id("microsoft.network/natgateways", "nat");
const vmSet = [
  { name: "vm-open", state: ex("open", ["22", "443"]), subnet: SN },
  { name: "vm-closed", state: ex("closed"), subnet: SN },
  { name: "vm-nonsg", state: ex("noNsg"), subnet: SN },
  { name: "vm-unknown", state: { ...ex("unknown"), reasons: ["asgUnknown"] }, subnet: SN },
  { name: "vm-natted", state: ex("scoped", ["3389"]), subnet: SN2 },
];
function graph(): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [node("vnet", V), node("subnet", SN, { endpoint: "10.0.1.0/24" }), node("subnet", SN2, { endpoint: "10.0.2.0/24" }), node("natGateway", NAT, { endpoint: "198.51.100.1" })];
  const edges: ArchitectureEdge[] = [edge("contains", V, SN), edge("contains", V, SN2), { ...edge("network", SN2, NAT), metadata: { rel: "EDGE-01" } }];
  vmSet.forEach((v, i) => {
    const VM = id("microsoft.compute/virtualmachines", v.name), NIC = id("microsoft.network/networkinterfaces", `${v.name}-nic`);
    const PIP = id("microsoft.network/publicipaddresses", `${v.name}-pip`);
    nodes.push(node("vm", VM, { metadata: { inboundExposure: v.state } }));
    nodes.push(node("nic", NIC, { endpoint: `10.0.1.${10 + i}`, metadata: { publicIPAzureId: PIP.toLowerCase(), publicIP: `203.0.113.${10 + i}`, publicIPs: [{ id: PIP.toLowerCase(), sku: "Standard" }], inboundExposure: v.state } }));
    nodes.push(node("publicIP", PIP, { endpoint: `203.0.113.${10 + i}`, metadata: { absorbed: true, attachedTo: NIC.toLowerCase() } }));
    edges.push(edge("attached-to", v.subnet, NIC), edge("bound-to", NIC, VM));
  });
  return { generatedAt: "", nodes, edges };
}

test("spec: a line only for open / scoped / unknown VMs; closed and no-NSG keep a chip; bindings read the public IP", async () => {
  const { spec } = await generateDiagramSpec(graph(), SUBID);
  const byLabel = (l: string) => spec.nodes.find((x) => x.label === l)!;
  const inbound = (l: string) => spec.edges.find((e) => e.target === byLabel(l).id && e.flowType === "ingress");
  assert.equal(inbound("vm-open")?.exposure?.state, "open");
  assert.equal(inbound("vm-unknown")?.exposure?.state, "unknown");
  assert.equal(inbound("vm-closed"), undefined, "closed → no line");
  assert.equal(inbound("vm-nonsg"), undefined, "Standard without an NSG is closed by default → no line");
  assert.equal(pip.pipExposure(byLabel("vm-closed").metadata)?.state, "closed", "the card still knows why");

  const open = inbound("vm-open")!;
  assert.equal(open.bindings.synIn?.metric, "SynCount");
  assert.equal(open.bindings.synIn?.on, "publicIp");
  assert.equal(open.bindings.synIn?.filter, "Direction eq 'In'");
  assert.equal(open.bindings.throughput, undefined, "no NAT gateway: received bytes may hold replies — no particles");
  assert.ok(open.caveats?.includes("ld.edge.caveat.pipReplies"));
  const vmPip = byLabel("vm-open").subResources?.find((s) => s.kind === "publicIP");
  assert.match(vmPip?.azureResourceId ?? "", /publicipaddresses\/vm-open-pip$/);
});

test("edge bindings: particles only behind a NAT gateway; nothing to read → no binding (unmeasured, never 0)", () => {
  const vm = (parentId: string, withPip = true): Pick<DiagramNodeSpec, "resourceKind" | "icon" | "subResources" | "parentId" | "metadata"> => ({
    icon: "vm", resourceKind: "vm", parentId,
    subResources: withPip ? [{ id: "p", label: "Public IP", kind: "publicIP", azureResourceId: id("microsoft.network/publicipaddresses", "p") }] : [],
  });
  const byId = new Map<string, Pick<DiagramNodeSpec, "resourceKind" | "icon" | "subResources" | "metadata" | "parentId">>([
    ["in", { icon: "internet", resourceKind: "internet" }],
    ["sn-nat", { icon: "subnet", metadata: { egressVia: "nat" } }],
    ["sn-def", { icon: "subnet", metadata: { egressVia: "default" } }],
    ["vm-nat", vm("sn-nat")], ["vm-def", vm("sn-def")], ["vm-none", vm("sn-def", false)],
  ]);
  const e = (target: string, reasons: string[] = []) => ({ source: "in", target, flowType: "ingress" as const, edgeKind: "network" as const, exposure: { ...ex("open", ["22"]), reasons } });
  assert.equal(edgeBindings(e("vm-nat"), byId).bindings.throughput?.metric, "ByteCount");
  assert.ok(!edgeBindings(e("vm-nat"), byId).caveats?.includes("ld.edge.caveat.pipReplies"));
  assert.equal(edgeBindings(e("vm-nat", ["vnetTagWidened"]), byId).bindings.throughput, undefined, "a 0.0.0.0/0 route may bypass the NAT gateway");
  assert.equal(edgeBindings(e("vm-def"), byId).bindings.throughput, undefined);
  assert.deepEqual(edgeBindings(e("vm-none"), byId).bindings, {});
});

test("measured resources: public IP ids of the card only, same subscription, values summed", () => {
  const good = id("microsoft.network/publicipaddresses", "a");
  const vmNode: DiagramNodeSpec = {
    id: "vm", label: "vm", icon: "vm", resourceKind: "vm", position: { x: 0, y: 0 }, bindings: {},
    azureResourceId: id("microsoft.compute/virtualmachines", "vm"),
    subResources: [
      { id: "1", label: "Public IP", kind: "publicIP", azureResourceId: good },
      { id: "2", label: "Public IP", kind: "publicIP", azureResourceId: id("microsoft.keyvault/vaults", "kv") },
      { id: "3", label: "Public IP", kind: "publicIP", azureResourceId: "/subscriptions/11111111-1111-1111-1111-111111111111/resourcegroups/rg/providers/microsoft.network/publicipaddresses/x" },
    ],
  };
  const nodes = new Map([["vm", vmNode]]);
  const line = { id: "l", source: "in", target: "vm", animation: "flow" as const, bindings: { synIn: { source: "monitor" as const, metric: "SynCount", node: "target" as const, on: "publicIp" as const } } };
  assert.deepEqual(measuredResources(line, nodes).resourceIds, [good]);
  const plain = { ...line, bindings: { t: { source: "monitor" as const, metric: "ByteCount", node: "target" as const } } };
  assert.deepEqual(measuredResources(plain, nodes).resourceIds, [vmNode.azureResourceId]);
  assert.deepEqual(sumMetricRecords([{ synIn: 3, bytesIn: null }, { synIn: 4, bytesIn: 10 }]), { synIn: 7, bytesIn: 10 });
  assert.deepEqual(sumMetricRecords([{ synIn: null }, { synIn: null }]), { synIn: null });
});

test("card chip: words from the NSG verdict; orange only for a configured opening of a risky port", () => {
  assert.deepEqual([pip.pipChip(ex("open", ["22", "443"])).key, pip.pipChip(ex("open", ["22"])).tone], ["ld.card.pip.open", "public"]);
  assert.equal(pip.pipChip(ex("open", ["443"])).tone, undefined, "443 is not a risky port");
  assert.equal(pip.pipChip(ex("open", ["*"])).key, "ld.card.pip.openAll");
  assert.equal(pip.pipChip(ex("unknown")).tone, undefined, "unknown is never coloured");
  assert.equal(pip.pipChip(ex("noNsg")).key, "ld.card.pip.noNsg");
  assert.equal(pip.pipExposure({ pipExposure: "not json" }), null);
  assert.deepEqual(pip.exposureSources({ ...ex("scoped", ["22"]), azureCloud: true }), { key: "ld.pip.src.azureCloud", vars: { n: 1 } });
});

test("layout: Internet → VM lines are drawn only, never layout edges", () => {
  const line = { id: "l", source: "in", target: "vm", animation: "flow" as const, bindings: {}, flowType: "ingress" as const, edgeKind: "network" as const, exposure: ex("open", ["22"]) };
  assert.equal(L.isLayoutEdge(line), false);
  const { exposure: _drop, ...lbLine } = line;
  assert.equal(L.isLayoutEdge(lbLine), true);
});

test("infrastructure diagram: exposure line only when the NSGs let the Internet in", () => {
  const model = A.buildArchModel(graph());
  const exposed = new Set(model.edges.filter((e) => e.kind === "exposure").map((e) => model.nodes.get(e.target)?.name));
  assert.ok(exposed.has("vm-open") && exposed.has("vm-unknown") && exposed.has("vm-natted"));
  assert.ok(!exposed.has("vm-closed") && !exposed.has("vm-nonsg"));
  const closed = [...model.resources.values()].find((r) => r.node.name === "vm-closed")!;
  assert.equal(closed.exposure, "closed");
  assert.equal(closed.publicIps.length, 1, "the badge stays");
});
