import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
import { generateDiagramSpec } from "../src/services/specGenerator.js";

// ── synthetic subscription (fake IDs only) ──
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers";
const id = (type: string, name: string) => `${SUB}/${type}/${name}`.toLowerCase();
const n = (kind: ArchitectureNode["kind"], azureId: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id: azureId, kind, name: azureId.split("/").pop()!, azureId, location: "koreacentral", resourceGroup: "rg", ...extra,
});
const e = (kind: ArchitectureEdge["kind"], source: string, target: string, metadata?: ArchitectureEdge["metadata"]): ArchitectureEdge => ({ id: `${kind}:${source}->${target}`, kind, source, target, metadata });

const VNET = id("microsoft.network/virtualnetworks", "hub");
const PEER = id("microsoft.network/virtualnetworks", "spoke");
const SN_NAT = `${VNET}/subnets/snet-app`;
const SN_DEF = `${VNET}/subnets/snet-legacy`;
const SN_OFF = `${VNET}/subnets/snet-locked`;
const NAT = id("microsoft.network/natgateways", "ngw");
const LB = id("microsoft.network/loadbalancers", "lb-public");
const LBI = id("microsoft.network/loadbalancers", "lb-internal");
const VM = id("microsoft.compute/virtualmachines", "vm-app");
const NIC = id("microsoft.network/networkinterfaces", "vm-app-nic");
const VM2 = id("microsoft.compute/virtualmachines", "vm-orphan");

const graph: ArchitectureGraph = {
  nodes: [
    n("vnet", VNET, { endpoint: "10.0.0.0/16" }),
    n("vnet", PEER, { endpoint: "10.1.0.0/16" }),
    n("subnet", SN_NAT, { endpoint: "10.0.1.0/24" }),
    n("subnet", SN_DEF, { endpoint: "10.0.2.0/24", metadata: { defaultOutboundAccess: "true" } }),
    n("subnet", SN_OFF, { endpoint: "10.0.3.0/24", metadata: { defaultOutboundAccess: "false" } }),
    n("natGateway", NAT),
    n("lb", LB, { endpoint: "20.1.2.3" }),
    n("lb", LBI, { endpoint: "10.0.2.10" }),
    n("vm", VM),
    n("nic", NIC, { endpoint: "10.0.1.4", metadata: { publicIP: "52.0.0.9" } }),
    n("vm", VM2), // no NIC edge: only its resource group says where it is
  ],
  edges: [
    e("contains", VNET, SN_NAT), e("contains", VNET, SN_DEF), e("contains", VNET, SN_OFF),
    e("contains", PEER, `${PEER}/subnets/default`),
    e("network", SN_NAT, NAT),
    e("attached-to", SN_NAT, NIC), e("bound-to", NIC, VM),
    e("routes", LB, VM), e("network", SN_DEF, LBI),
    e("peering", VNET, PEER, { peeringState: "Connected" }),
  ],
} as unknown as ArchitectureGraph;

test("spec: subnet outbound path, inbound only to public entry points, VM public IP as a chip, peerings", async () => {
  const { spec } = await generateDiagramSpec(graph, "00000000-0000-0000-0000-000000000000", "manual");
  const byLabel = new Map(spec.nodes.map((x) => [x.label, x]));

  assert.equal(byLabel.get("snet-app")?.metadata?.egressVia, "nat");
  assert.equal(byLabel.get("snet-app")?.metadata?.egressName, "ngw");
  assert.equal(byLabel.get("snet-legacy")?.metadata?.egressVia, "default");
  assert.equal(byLabel.get("snet-locked")?.metadata?.egressVia, "none");

  const lb = byLabel.get("lb-public")!;
  const lbi = byLabel.get("lb-internal")!;
  const inbound = spec.edges.filter((x) => x.flowType === "ingress" && spec.nodes.find((s) => s.id === x.source)?.metadata?.direction === "ingress");
  assert.deepEqual(inbound.map((x) => x.target), [lb.id], "only the public LB is an inbound path");
  assert.ok(!inbound.some((x) => x.target === lbi.id));

  const vm = byLabel.get("vm-app")!;
  assert.ok(vm.subResources?.some((s) => s.kind === "publicIP"), "the VM keeps its public IP chip");
  assert.ok(!spec.edges.some((x) => x.source === vm.id && x.edgeKind === "outbound-internet"), "a VM public IP is a chip, not an outbound line");

  // a public-only LB has no subnet: it belongs to its backends' VNet
  assert.equal(lb.parentId, byLabel.get("hub")!.id);
  assert.equal(lb.metadata?.placement, "public-frontend");
  // a resource placed only by resource group is marked as a guess
  assert.equal(byLabel.get("vm-orphan")?.metadata?.placement, "rg-guess");
  assert.equal(vm.metadata?.placement, undefined);

  const peers = JSON.parse(byLabel.get("hub")!.metadata!.peerings!) as Array<{ name: string; state: string }>;
  assert.deepEqual(peers.map((p) => [p.name, p.state]), [["spoke", "Connected"]]);
});

test("spec: a public LB with no load-balancing rule is not an inbound path; the inbound line reads the LB's In bytes", async () => {
  const LB2 = id("microsoft.network/loadbalancers", "kubernetes");
  const g = {
    nodes: [...graph.nodes.map((x) => (x.id === LB ? { ...x, metadata: { ...x.metadata, inboundRules: 2 } } : x)), n("lb", LB2, { endpoint: "20.9.9.9", metadata: { inboundRules: 0 } })],
    edges: [...graph.edges, e("routes", LB2, VM)],
  } as unknown as ArchitectureGraph;
  const { spec } = await generateDiagramSpec(g, "00000000-0000-0000-0000-000000000000", "manual");
  const byLabel = new Map(spec.nodes.map((x) => [x.label, x]));
  const inbound = spec.edges.filter((x) => x.flowType === "ingress" && spec.nodes.find((s) => s.id === x.source)?.metadata?.direction === "ingress");
  assert.deepEqual(inbound.map((x) => x.target), [byLabel.get("lb-public")!.id], "the outbound-only 'kubernetes' LB gets no Internet line");
  const b = inbound[0]!.bindings.throughput!;
  assert.equal(b.metric, "ByteCount");
  assert.equal(b.filter, "Direction eq 'In'");
  assert.equal(b.node, "target");
  // LB → backend lines carry no Azure Monitor total any more
  assert.ok(!spec.edges.some((x) => x.source === byLabel.get("lb-public")!.id && Object.keys(x.bindings).length));
  // nodes carry the current table
  assert.ok(byLabel.get("lb-public")!.bindings.backend, "LB card: data path + backend health");
});

test("spec: a public IP on a NIC no VM uses is unused (reason nicNoVm), not an 'outside the VNet' card", async () => {
  const PIP = id("microsoft.network/publicipaddresses", "pip-orphan");
  const NIC2 = id("microsoft.network/networkinterfaces", "nic-orphan");
  const g = {
    nodes: [...graph.nodes, n("nic", NIC2, { endpoint: "10.0.1.9", metadata: { publicIPAzureId: PIP } }), n("publicIP", PIP, { endpoint: "52.0.0.10", metadata: { absorbed: true, attachedTo: NIC2 } })],
    edges: [...graph.edges, e("attached-to", SN_NAT, NIC2)],
  } as unknown as ArchitectureGraph;
  const { spec } = await generateDiagramSpec(g, "00000000-0000-0000-0000-000000000000", "manual");
  const pip = spec.nodes.find((x) => x.label === "pip-orphan");
  assert.ok(pip, "drawn");
  assert.deepEqual([pip!.metadata?.unused, pip!.metadata?.unusedReason], ["true", "nicNoVm"]);
  // the VM's own public IP (its NIC is bound to the VM) stays a chip on the VM, never unused
  assert.ok(!spec.nodes.some((x) => x.resourceKind === "publicIP" && x.metadata?.unused === "true" && x.label !== "pip-orphan"));
});

test("spec: a managed cluster is never put in a subnet by resource group; its private API is its own Private Endpoint card", async () => {
  const AKS = id("microsoft.containerservice/managedclusters", "aks-app");
  const PE = id("microsoft.network/privateendpoints", "pe-kube-apiserver");
  const PENIC = id("microsoft.network/networkinterfaces", "pe-kube-apiserver-nic");
  const g = {
    nodes: [...graph.nodes,
      n("aks", AKS, { metadata: { isPrivateCluster: true } }),
      n("privateEndpoint", PE), n("nic", PENIC, { endpoint: "10.0.2.20" })],
    edges: [...graph.edges,
      e("connects", SN_DEF, AKS, { rel: "AKS-01" }),
      e("attached-to", SN_DEF, PENIC), e("bound-to", PENIC, PE), e("private-link", PE, AKS, { groupIds: "management" })],
  } as unknown as ArchitectureGraph;
  const { spec } = await generateDiagramSpec(g, "00000000-0000-0000-0000-000000000000", "manual");
  const aks = spec.nodes.find((x) => x.label === "aks-app")!;
  assert.equal(aks.parentId, undefined, "the cluster resource has no subnet (only its node pools do)");
  assert.notEqual(aks.metadata?.placement, "rg-guess");
  assert.ok(!spec.nodes.some((x) => x.metadata?.archRole === "aks-control-plane"), "no synthetic API server node");
});
