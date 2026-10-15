import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as styleNs from "../../web/src/lib/liveStyle.ts";

const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const St = ((styleNs as unknown as { default?: typeof styleNs }).default ?? styleNs) as typeof styleNs;
const { liveLayout, LIVE } = L;

// ── synthetic VNet shaped like a real hub: 8 subnets with resources, 5 empty, NAT under the VNet ──

const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", bindings: {}, ...extra });
const group = (id: string, icon: "vnet" | "subnet", parentId?: string): DiagramNodeSpec => node(id, { icon, nodeType: "group", parentId, resourceKind: icon });
const edge = (id: string, source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({ id, source, target, bindings: {}, ...extra });

function hubSpec(): DiagramSpec {
  const nodes: DiagramNodeSpec[] = [group("vnet", "vnet")];
  const filled: Array<[string, string[]]> = [
    ["snet-agw", ["appGateway"]], ["snet-trust", ["lb"]], ["snet-lbi", ["lb"]], ["snet-web", ["vm", "vm", "vmss", "lb"]],
    ["snet-untrust", ["vm", "vm"]], ["snet-jbx", ["vm"]], ["snet-was", ["vm", "vmss"]], ["snet-pep", ["privateEndpoint"]],
  ];
  for (const [s, kinds] of filled) {
    nodes.push(group(s, "subnet", "vnet"));
    kinds.forEach((k, i) => nodes.push(node(`${s}-${k}-${i}`, { icon: k as DiagramNodeSpec["icon"], resourceKind: k, parentId: s, subResources: k === "vm" ? [{ id: `${s}-nic-${i}`, label: "nic", kind: "nic", endpoint: "10.0.0.4" }] : undefined })));
  }
  for (const s of ["GatewaySubnet", "snet-mgmt", "snet-psql", "snet-ha", "snet-spare"]) nodes.push(group(s, "subnet", "vnet"));
  nodes.push(node("nic-orphan", { icon: "nic", resourceKind: "nic", parentId: "snet-was" }));
  nodes.push(node("nsg-embedded", { icon: "nsg", resourceKind: "nsg", parentId: "snet-web", metadata: { nsgAttachedTo: "snet-web" } }));
  nodes.push(node("nat", { icon: "natGateway", resourceKind: "natGateway", parentId: "vnet" }));
  nodes.push(node("inet-out", { icon: "internet", resourceKind: "internet", metadata: { direction: "egress" } }));
  nodes.push(node("inet-in", { icon: "internet", resourceKind: "internet", metadata: { direction: "ingress" } }));
  nodes.push(node("kv", { icon: "keyVault", resourceKind: "keyVault" }));
  nodes.push(node("ghost-vm", { metadata: { ghostOf: "other-vnet" }, resourceKind: "vm" }));
  return {
    version: "1", id: "hub", name: "hub", createdAt: "", updatedAt: "", groups: [],
    settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" },
    nodes,
    edges: [],
  };
}

type Box = { id: string; x: number; y: number; w: number; h: number; parent: string | null };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("hub VNet: aspect ≤ 2, no sibling overlaps, every child inside its parent", () => {
  const lay = liveLayout(hubSpec());
  const vnet = lay.items.get("vnet")!;
  assert.ok(vnet.w / vnet.h <= 2.0, `aspect ${(vnet.w / vnet.h).toFixed(2)}`);
  const all: Box[] = [...lay.items.values(), ...lay.lanes, ...lay.summaries];
  const byParent = new Map<string, Box[]>();
  for (const b of all) (byParent.get(b.parent ?? "") ?? byParent.set(b.parent ?? "", []).get(b.parent ?? "")!).push(b);
  for (const [parent, kids] of byParent) {
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) assert.ok(!overlaps(kids[i]!, kids[j]!), `${kids[i]!.id} / ${kids[j]!.id}`);
    if (!parent) continue;
    const p = all.find((b) => b.id === parent)!;
    for (const k of kids) assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= p.w && k.y + k.h <= p.h, `${k.id} inside ${parent}`);
  }
});

test("cards keep their size; a subnet uses at most three columns", () => {
  const spec = hubSpec();
  const lay = liveLayout(spec);
  for (const n of spec.nodes.filter((x) => x.parentId?.startsWith("snet-") && !lay.hidden.has(x.id))) {
    const b = lay.items.get(n.id)!;
    assert.equal(b.w, LIVE.CARD_W);
    assert.equal(b.h, LIVE.CARD_H); // one size for every card (sub-resources are chips inside it)
  }
  const web = [...lay.items.values()].filter((b) => b.parent === "snet-web");
  assert.ok(new Set(web.map((b) => b.x)).size <= LIVE.SUBNET_COLS);
});

test("empty subnets fold into one row; it opens and folds again", () => {
  const spec = hubSpec();
  const folded = liveLayout(spec);
  assert.equal(folded.summaries.length, 1);
  assert.equal(folded.summaries[0]!.names.length, 5);
  for (const id of folded.summaries[0]!.subnetIds) assert.ok(folded.hidden.has(id));
  assert.equal(folded.summaries[0]!.expanded, false);
  const open = liveLayout(spec, { expandedEmpty: new Set(["vnet"]) });
  // opened: the subnets are drawn and the row stays (last) to fold them again
  assert.equal(open.summaries.length, 1);
  assert.equal(open.summaries[0]!.expanded, true);
  assert.ok(open.items.has("GatewaySubnet") && !open.hidden.has("GatewaySubnet"));
});

test("NAT sits on the egress rail before the Internet; inbound Internet is left of the VNet", () => {
  const lay = liveLayout(hubSpec());
  const nat = lay.items.get("nat")!;
  const out = lay.items.get("inet-out")!;
  assert.equal(nat.parent, "lane:egress");
  assert.equal(out.parent, "lane:egress");
  assert.ok(nat.x < out.x, "NAT then Internet, left to right");
  const inLane = lay.lanes.find((l) => l.lane === "ingress")!;
  const vnet = lay.items.get("vnet")!;
  assert.ok(inLane.x + inLane.w < vnet.x);
  assert.equal(lay.items.get("kv")!.parent, "lane:paas:security");
  assert.equal(lay.items.get("ghost-vm")!.parent, "lane:ghost");
});

test("a NIC without a VM is a count on its subnet, an embedded NSG is not drawn", () => {
  const lay = liveLayout(hubSpec());
  assert.ok(lay.hidden.has("nic-orphan"));
  assert.equal(lay.nicCount.get("snet-was"), 1);
  assert.ok(lay.hidden.has("nsg-embedded"));
});

test("subnet order: entry → compute → data → management", () => {
  const lay = liveLayout(hubSpec());
  const pos = (id: string) => { const b = lay.items.get(id)!; return b.y * 10_000 + b.x; };
  assert.ok(pos("snet-agw") < pos("snet-web"));
  assert.ok(pos("snet-web") < pos("snet-pep"));
  assert.ok(pos("snet-pep") < pos("snet-jbx")); // jumpbox = management
});

// ── line grammar ──

const byId = new Map<string, DiagramNodeSpec>([
  ["inet", node("inet", { icon: "internet", resourceKind: "internet" })],
  ["lb", node("lb", { icon: "lb", resourceKind: "lb" })],
  ["vmss", node("vmss", { icon: "vmss", resourceKind: "vmss" })],
  ["pe", node("pe", { icon: "privateEndpoint", resourceKind: "privateEndpoint" })],
  ["kv", node("kv", { icon: "keyVault", resourceKind: "keyVault" })],
  ["nat", node("nat", { icon: "natGateway", resourceKind: "natGateway" })],
  ["sub", node("sub", { icon: "subnet", nodeType: "group", resourceKind: "subnet" })],
  ["vm", node("vm", { resourceKind: "vm" })],
  ["pg", node("pg", { icon: "postgres", resourceKind: "postgres" })],
]);
const EDGES = [
  edge("in", "inet", "lb", { edgeKind: "network", flowType: "ingress" }),
  edge("be", "lb", "vmss", { edgeKind: "routes", flowType: "ingress", protocol: "TCP/443" }),
  edge("snat", "vmss", "lb", { edgeKind: "routes" }),
  edge("pl", "pe", "kv", { edgeKind: "privateLink" }),
  edge("nat-out", "nat", "inet", { edgeKind: "outbound-internet" }),
  edge("dflt", "sub", "inet", { edgeKind: "outbound-internet", animation: "dash" }),
  edge("guess", "vm", "pg", { edgeKind: "inferred", evidence: "inferred" }),
];

test("every line style is a distinct (colour, dash) pair; the legend lists exactly the styles in use", () => {
  const combos = St.LIVE_STYLE_ORDER.map((k) => `${St.liveStroke(k)}|${St.LIVE_EDGE_LOOK[k].dash ?? ""}`);
  assert.equal(new Set(combos).size, combos.length);
  // red is reserved for fault impact
  for (const k of St.LIVE_STYLE_ORDER) assert.notEqual(St.LIVE_EDGE_LOOK[k].color, "danger");
  const keys = St.legendKeys(EDGES, byId);
  assert.deepEqual(new Set(keys), new Set(EDGES.map((e) => St.liveEdgeStyleKey(e, byId))));
  assert.deepEqual(keys, ["ingress", "config", "privateLink", "egress", "egressDeprecated", "inferred"]);
});

test("dashes only mark weaker evidence", () => {
  for (const k of St.LIVE_STYLE_ORDER) {
    const dashed = !!St.LIVE_EDGE_LOOK[k].dash;
    assert.equal(dashed, k === "inferred" || k === "egressDeprecated", k);
  }
});

test("relationship labels: short, no guesses, no 'a → a'", () => {
  const labels = EDGES.map((e) => St.relationLabel(e, byId));
  assert.deepEqual(labels.map((l) => l?.key ?? null), ["ld.rel.ingress", "ld.rel.routesProto", "ld.rel.routes", "ld.rel.privateLink", "ld.rel.outNat", "ld.rel.outDefault", null]);
  assert.equal(labels[3]!.vars!.target, "Key Vault");
  assert.equal(St.clipLabel("x".repeat(40)).length, 24);
  assert.equal(St.clipLabel("short"), "short");
});

test("LB ↔ VMSS drawn both ways becomes one line with two arrowheads", () => {
  const { drop, both } = St.mergeReversePairs(EDGES);
  assert.deepEqual([...drop], ["snat"]);
  assert.deepEqual([...both], ["be"]);
});

// ── unconnected and unused resources: a regular place, not the gaps beside the connected flow ──

function looseSpec(): DiagramSpec {
  const nodes: DiagramNodeSpec[] = [group("vnet", "vnet")];
  const sub = (s: string, kind: string, n = 1) => {
    nodes.push(group(s, "subnet", "vnet"));
    for (let i = 0; i < n; i++) nodes.push(node(`${s}-${i}`, { icon: kind as DiagramNodeSpec["icon"], resourceKind: kind, parentId: s }));
  };
  sub("snet-a", "vm", 2); sub("snet-b", "vm", 2); sub("snet-c", "vm", 2); // connected: a → b → c
  sub("snet-zz-pep", "privateEndpoint"); sub("snet-jbx", "vm"); sub("snet-agw", "appGateway"); sub("snet-app", "vm", 3); // no links
  nodes.push(node("pip-unused", { icon: "publicIP", resourceKind: "publicIP", metadata: { unused: "true" } }));
  nodes.push(node("nsg-detached", { icon: "nsg", resourceKind: "nsg", metadata: { detached: "true" } }));
  nodes.push(node("kv", { icon: "keyVault", resourceKind: "keyVault" }));
  return {
    version: "1", id: "loose", name: "loose", createdAt: "", updatedAt: "", groups: [],
    settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" },
    nodes,
    edges: [edge("e1", "snet-a-0", "snet-b-0", { edgeKind: "routes" }), edge("e2", "snet-b-1", "snet-c-0", { edgeKind: "routes" }), edge("e3", "snet-zz-pep-0", "kv", { edgeKind: "privateLink" })],
  };
}

test("subnets with no link sit in a titled grid below the connected flow, in tier → name order", () => {
  const lay = liveLayout(looseSpec());
  const sec = lay.sections.find((s) => s.vnetId === "vnet");
  assert.ok(sec, "a 'no connections' frame");
  assert.equal(sec!.label, "ld.section.isolated");
  const abs = (id: string) => lay.abs.get(id)!;
  const flowBottom = Math.max(...["snet-a", "snet-b", "snet-c"].map((s) => abs(s).y + abs(s).h));
  const loose = ["snet-agw", "snet-app", "snet-jbx"];
  const frame = lay.abs.get(sec!.id)!;
  assert.ok(frame.y >= flowBottom, "below the flow, never beside it");
  for (const s of loose) {
    const r = abs(s);
    assert.ok(r.x >= frame.x && r.y >= frame.y + LIVE.LANE_HEAD && r.x + r.w <= frame.x + frame.w && r.y + r.h <= frame.y + frame.h, `${s} inside the frame`);
    assert.equal(lay.items.get(s)!.parent, "vnet", "the frame is decoration: the subnet keeps the VNet as parent");
  }
  // entry (App Gateway) → compute → management (jbx): reading order left → right, top → bottom
  const order = [...loose].sort((a, b) => abs(a).y - abs(b).y || abs(a).x - abs(b).x);
  assert.deepEqual(order, ["snet-agw", "snet-app", "snet-jbx"]);
  // a Private Endpoint subnet linked to its PaaS is connected, not "no connections"
  assert.ok(lay.placeMeta.subnet.has("snet-zz-pep"));
  // rows start at the same left edge (a grid, not a scatter)
  const rows = new Map<number, number[]>();
  for (const s of loose) (rows.get(abs(s).y) ?? rows.set(abs(s).y, []).get(abs(s).y)!).push(abs(s).x);
  for (const xs of rows.values()) assert.equal(Math.min(...xs), frame.x + LIVE.PAD);
});

test("unused public IPs and detached NSGs get their own lane at the bottom of the right column", () => {
  const lay = liveLayout(looseSpec());
  assert.equal(lay.placeMeta.laneOf.get("pip-unused"), "unused");
  assert.equal(lay.placeMeta.laneOf.get("nsg-detached"), "unused");
  assert.equal(lay.placeMeta.laneOf.get("kv"), "paas");
  const unused = lay.lanes.find((l) => l.lane === "unused")!;
  const others = lay.lanes.filter((l) => l.lane !== "unused" && l.lane !== "ingress");
  for (const o of others) assert.ok(unused.y >= o.y + o.h, `${o.id} above the unused lane`);
});

test("no frame when nothing in the VNet is connected (the grid alone)", () => {
  const s = looseSpec();
  const lay = liveLayout({ ...s, edges: [] });
  assert.equal(lay.sections.length, 0);
});

test("detached NSGs placed in a subnet by resource-group guess join the unused lane too (one place for all)", () => {
  const s = looseSpec();
  s.nodes.push(node("nsg-guessed", { icon: "nsg", resourceKind: "nsg", parentId: "snet-jbx", metadata: { detached: "true", placement: "rg-guess" } }));
  const lay = liveLayout(s);
  assert.equal(lay.placeMeta.laneOf.get("nsg-guessed"), "unused");
  assert.notEqual(lay.items.get("nsg-guessed")!.parent, "snet-jbx", "not inside the subnet any more");
  const lane = lay.lanes.find((l) => l.lane === "unused")!;
  const members = ["pip-unused", "nsg-detached", "nsg-guessed"].map((id) => lay.abs.get(id)!);
  for (const m of members) assert.ok(m.x >= lane.x && m.y >= lane.y && m.x + m.w <= lane.x + lane.w && m.y + m.h <= lane.y + lane.h);
});
