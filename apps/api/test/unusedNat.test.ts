// A NAT Gateway no subnet uses (2026-11-16: after a NAT swap the old NAT — 0 subnets, 1 public IP — was drawn as an
// egress card with a "NAT → Internet" line plus a separate public IP card, vanished under a VNet scope, never joined
// the "unused · detached" lane, and the architecture page called it "not an exit — every attached subnet leaves
// through a UDR" with no subnet attached). Synthetic IDs and names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, DiagramNodeSpec, DiagramSpec } from "@aud/types";
import { effectiveBindings, generateDiagramSpec } from "../src/services/specGenerator.js";
import { resolveEvidence } from "../src/services/healthEvidence.js";
import * as scopeNs from "../../web/src/lib/liveScope.ts";
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as archNs from "../../web/src/lib/archModel.ts";

const S = ((scopeNs as unknown as { default?: typeof scopeNs }).default ?? scopeNs) as typeof scopeNs;
const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const A = ((archNs as unknown as { default?: typeof archNs }).default ?? archNs) as typeof archNs;

const SUBID = "00000000-0000-0000-0000-000000000000";
const rid = (rg: string, type: string, name: string) => `/subscriptions/${SUBID}/resourceGroups/${rg}/providers/${type}/${name}`.toLowerCase();
const n = (kind: ArchitectureNode["kind"], azureId: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id: azureId, kind, name: azureId.split("/").pop()!, azureId, location: "koreacentral", resourceGroup: azureId.split("/")[4], ...extra,
});
const e = (kind: ArchitectureEdge["kind"], source: string, target: string, metadata?: ArchitectureEdge["metadata"]): ArchitectureEdge => ({ id: `${kind}:${source}->${target}`, kind, source, target, metadata });

const VNET = rid("rg-net", "microsoft.network/virtualnetworks", "vnet-app");
const SN = `${VNET}/subnets/snet-app`;
const NAT_NEW = rid("rg-net", "microsoft.network/natgateways", "nat-002");
const NAT_OLD = rid("rg-net", "microsoft.network/natgateways", "nat-001");
const PIP_NEW = rid("rg-net", "microsoft.network/publicipaddresses", "pip-nat-002");
const PIP_OLD = rid("rg-net", "microsoft.network/publicipaddresses", "pip-nat-001");

// The swap as Azure reports it: the subnet names the new NAT; the old NAT keeps its public IP and no subnet
const graph = {
  nodes: [
    n("vnet", VNET, { endpoint: "10.0.0.0/16" }),
    n("subnet", SN, { endpoint: "10.0.1.0/24", metadata: { egress: { via: "nat", targetId: NAT_NEW } } }),
    n("natGateway", NAT_NEW, { endpoint: "203.0.113.2", metadata: { publicIpCount: 1 } }),
    n("natGateway", NAT_OLD, { endpoint: "203.0.113.1", metadata: { publicIpCount: 1 } }),
    n("publicIP", PIP_NEW, { endpoint: "203.0.113.2", metadata: { attachedTo: NAT_NEW } }),
    n("publicIP", PIP_OLD, { endpoint: "203.0.113.1", metadata: { attachedTo: NAT_OLD } }),
  ],
  edges: [
    e("contains", VNET, SN),
    e("network", SN, NAT_NEW, { rel: "EDGE-01" }),
    e("network", NAT_NEW, PIP_NEW, { rel: "PIP-02" }),
    e("network", NAT_OLD, PIP_OLD, { rel: "PIP-02" }),
  ],
} as unknown as ArchitectureGraph;

test("spec: a NAT no subnet uses is an unused badge — its public IP a chip on it, no 'NAT → Internet' line, nothing measured", async () => {
  const { spec } = await generateDiagramSpec(graph, SUBID, "manual");
  const byLabel = new Map(spec.nodes.map((x) => [x.label, x]));
  const old = byLabel.get("nat-001")!, cur = byLabel.get("nat-002")!;
  assert.ok(old && cur);
  assert.deepEqual([old.metadata?.unused, old.metadata?.unusedReason, old.metadata?.publicIpCount], ["true", "natNoSubnet", "1"]);
  assert.equal(cur.metadata?.unused, undefined, "the NAT a subnet uses is not unused");
  // its public IP leaves with it — a chip, not a separate "outside the VNet" card
  assert.deepEqual(old.subResources?.map((s) => [s.kind, s.label]), [["publicIP", "pip-nat-001"]]);
  assert.ok(!byLabel.has("pip-nat-001") && !byLabel.has("pip-nat-002"), "no public IP card for either NAT");
  // NET-09: only the used NAT is an exit
  const out = (id: string) => spec.edges.filter((x) => x.source === id && x.edgeKind === "outbound-internet");
  assert.equal(out(old.id).length, 0, "no egress line from the unused NAT");
  assert.equal(out(cur.id).length, 1);
  // nothing flows: no metric reads — at generation and when a stored diagram is normalised
  assert.ok(Object.values(old.bindings).every((b) => b.source === "composite"));
  assert.ok(Object.values(effectiveBindings(old)).every((b) => b.source === "composite"));
  assert.ok(Object.values(effectiveBindings(cur)).some((b) => b.source !== "composite"), "the used NAT is still measured");
  // and Azure defines no state for it — no health pill
  const ev = resolveEvidence({ kind: "natGateway", health: "unknown", judged: false, metrics: {}, unused: true });
  assert.equal(ev.basis, "notApplicable");

  // A subscription with no VNet at all (resource-group boxes): still no egress line for a NAT no subnet uses
  const noVnet = { nodes: graph.nodes.filter((x) => x.kind === "natGateway" || x.kind === "publicIP"), edges: graph.edges.filter((x) => x.metadata?.rel === "PIP-02") } as ArchitectureGraph;
  const { spec: s2 } = await generateDiagramSpec(noVnet, SUBID, "manual");
  assert.equal(s2.edges.filter((x) => x.edgeKind === "outbound-internet").length, 0);
});

const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", resourceKind: "vm", bindings: {}, ...extra });
const vnetSpec = (id: string, rg: string, location = "koreacentral") => node(id, { icon: "vnet", resourceKind: "vnet", nodeType: "group", resourceGroup: rg, location });
const unusedNat = (id: string, rg: string, location = "koreacentral") =>
  node(id, { icon: "natGateway", resourceKind: "natGateway", resourceGroup: rg, location, metadata: { unused: "true", unusedReason: "natNoSubnet" } });

test("VNet scope: an unused resource with no line joins the selected VNet of its resource group and region — said why", () => {
  const spec: DiagramSpec = {
    id: "d", name: "d", updatedAt: "", edges: [],
    nodes: [
      vnetSpec("vnet-a", "rg-net"), vnetSpec("vnet-b", "rg-other"),
      node("snet-a", { icon: "subnet", resourceKind: "subnet", nodeType: "group", parentId: "vnet-a" }),
      node("vm-a", { parentId: "snet-a" }),
      unusedNat("nat-same", "RG-NET"), // resource group names compare without case (ARM)
      unusedNat("nat-other-rg", "rg-other"),
      unusedNat("nat-other-region", "rg-net", "japaneast"),
      node("pip-free", { icon: "publicIP", resourceKind: "publicIP", resourceGroup: "rg-net", location: "koreacentral", metadata: { unused: "true", unusedReason: "notAttached" } }),
      node("kv-lonely", { icon: "keyVault", resourceKind: "keyVault", resourceGroup: "rg-net", location: "koreacentral" }),
    ],
  } as unknown as DiagramSpec;
  const view = S.scopeSpec(spec, new Set(["vnet-a"]));
  const ids = view.nodes.map((x) => x.id);
  assert.ok(ids.includes("nat-same") && ids.includes("pip-free"));
  assert.ok(!ids.includes("nat-other-rg") && !ids.includes("nat-other-region"), "another resource group / region is not this VNet's");
  assert.ok(!ids.includes("kv-lonely"), "only unused · detached resources — a used one needs a line");
  assert.equal(view.nodes.find((x) => x.id === "nat-same")!.metadata?.scopeBasis, "sameResourceGroup");
  assert.equal(spec.nodes.find((x) => x.id === "nat-same")!.metadata?.scopeBasis, undefined, "the spec itself is not changed");
  // the other VNet picks up its own
  assert.ok(S.scopeSpec(spec, new Set(["vnet-b"])).nodes.some((x) => x.id === "nat-other-rg"));
  // nothing selected = the whole diagram, unchanged
  assert.equal(S.scopeSpec(spec, new Set()), spec);
});

test("layout: an unused NAT is a badge in the 'unused · detached' lane (not the egress lane) — billed kinds first", () => {
  const spec: DiagramSpec = {
    id: "d", name: "d", updatedAt: "", edges: [],
    nodes: [
      vnetSpec("vnet-a", "rg-net"),
      node("snet-a", { icon: "subnet", resourceKind: "subnet", nodeType: "group", parentId: "vnet-a" }),
      node("vm-a", { parentId: "snet-a" }),
      node("nsg-x", { icon: "nsg", resourceKind: "nsg", metadata: { detached: "true" } }),
      unusedNat("nat-old", "rg-net"),
      node("pip-y", { icon: "publicIP", resourceKind: "publicIP", metadata: { unused: "true", unusedReason: "notAttached" } }),
    ],
  } as unknown as DiagramSpec;
  const lay = L.liveLayout(spec);
  const ids = ["pip-y", "nat-old", "nsg-x"];
  assert.ok(ids.every((id) => lay.placeMeta.laneOf.get(id) === "unused"));
  assert.deepEqual([lay.abs.get("nat-old")!.w, lay.abs.get("nat-old")!.h], [L.LIVE.NSG_W, L.LIVE.NSG_H]);
  const order = [...ids].sort((a, b) => lay.abs.get(a)!.y - lay.abs.get(b)!.y || lay.abs.get(a)!.x - lay.abs.get(b)!.x);
  assert.deepEqual(order, ids, "public IPs, NAT Gateways (billed while unused), then NSGs");
  // one reason rule for the badge tooltip and the panel
  assert.equal(L.unusedReasonKey(spec.nodes.find((x) => x.id === "nat-old")!), "ld.unusedNatNoSubnet");
  assert.equal(L.unusedReasonKey({ resourceKind: "publicIP", metadata: { unusedReason: "nicNoVm" } } as DiagramNodeSpec), "ld.unusedPipNicNoVm");
  assert.equal(L.unusedReasonKey({ resourceKind: "nsg" } as DiagramNodeSpec), "ld.nsgDetached");
});

test("architecture: the unused NAT is listed for cleanup, has no outbound line, and is not called 'not an exit'", () => {
  const model = A.buildArchModel(graph);
  const reg = model.regions.find((r) => r.key === "koreacentral")!;
  assert.deepEqual(reg.unusedNatGateways.map((x) => [x.name, x.detail]), [["nat-001", "203.0.113.1"]]);
  assert.equal(model.totals.unusedNatGateways, 1);
  const egress = model.edges.filter((x) => x.kind === "egress").map((x) => x.source);
  assert.ok(egress.includes(NAT_NEW) && !egress.includes(NAT_OLD));
  // Without exits read (older API / sample) an attached NAT keeps its line; an unattached one still has none
  const old = { ...graph, nodes: graph.nodes.map((x) => (x.kind === "subnet" ? { ...x, metadata: {} } : x)) } as ArchitectureGraph;
  const egressOld = A.buildArchModel(old).edges.filter((x) => x.kind === "egress").map((x) => x.source);
  assert.ok(egressOld.includes(NAT_NEW) && !egressOld.includes(NAT_OLD));

  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const flow = read("../../web/src/app/architecture/utils/toFlow.ts");
  assert.match(flow, /links\.natUnused\.has\(r\.id\)\) badges\.push\(\{ text: t\("arch\.badge\.natNoSubnet"\)/);
  assert.match(read("../../web/src/app/architecture/page.tsx"), /totals\.unusedNatGateways/);
  assert.match(read("../../web/src/app/architecture/components/Inspector.tsx"), /r\.unusedNatGateways\.map/);
});

test("every new string exists in ko and en", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const all = read("../../web/src/lib/i18nOps.ts") + read("../../web/src/lib/i18nMessages.ts");
  for (const k of ["ld.unusedNatNoSubnet", "ld.panel.sameRgScope", "arch.unusedNat", "arch.badge.natNoSubnet", "arch.badge.natNoSubnetHint"]) {
    assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  }
});
