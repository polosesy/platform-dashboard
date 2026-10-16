import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
import * as layoutNs from "../../web/src/lib/liveLayout.ts";

const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;

// ── several VNets in one view (synthetic names): what sits outside the VNets goes next to what it links to ──
const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", resourceKind: "vm", bindings: {}, ...extra });
const group = (id: string, icon: "vnet" | "subnet", parentId?: string): DiagramNodeSpec => node(id, { icon, nodeType: "group", parentId, resourceKind: icon });
const edge = (source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({ id: `${source}->${target}`, source, target, bindings: {}, ...extra });
const pe = (id: string, sub: string) => node(id, { icon: "privateEndpoint", resourceKind: "privateEndpoint", parentId: sub });
const kv = (id: string) => node(id, { icon: "keyVault", resourceKind: "keyVault" });

/** VNets a..e stacked, each with a VM subnet (several VMs, so each VNet is tall) and a PE subnet */
export function many(): DiagramSpec {
  const vn = ["a", "b", "c", "d", "e"];
  const nodes: DiagramNodeSpec[] = [];
  const edges: DiagramEdgeSpec[] = [];
  for (const v of vn) {
    nodes.push(group(`vnet-${v}`, "vnet"), group(`snet-${v}-app`, "subnet", `vnet-${v}`), group(`snet-${v}-pep`, "subnet", `vnet-${v}`));
    for (let i = 0; i < 6; i++) nodes.push(node(`vm-${v}${i}`, { parentId: `snet-${v}-app` }));
    nodes.push(pe(`pe-${v}`, `snet-${v}-pep`), kv(`kv-${v}`));
    edges.push(edge(`pe-${v}`, `kv-${v}`, { edgeKind: "privateLink" }));
  }
  // An Internet terminal whose only line is a VM's public IP (exposure) — in the fourth VNet
  nodes.push(node("internet-in-vnet-d", { icon: "internet", resourceKind: "internet", metadata: { direction: "ingress" } }));
  edges.push(edge("internet-in-vnet-d", "vm-d3", { edgeKind: "network", flowType: "ingress", exposure: { state: "open", ports: ["443"], nsgs: [], reasons: [] } as unknown as DiagramEdgeSpec["exposure"] }));
  // A Key Vault reached from two VNets: two Private Endpoints in c, one in a → next to c
  nodes.push(pe("pe-a-shared", "snet-a-pep"), pe("pe-c-shared1", "snet-c-pep"), pe("pe-c-shared2", "snet-c-pep"), kv("kv-shared"));
  edges.push(edge("pe-a-shared", "kv-shared", { edgeKind: "privateLink" }), edge("pe-c-shared1", "kv-shared", { edgeKind: "privateLink" }), edge("pe-c-shared2", "kv-shared", { edgeKind: "privateLink" }));
  return { id: "t", name: "t", nodes, edges } as DiagramSpec;
}

const cyOf = (lay: ReturnType<typeof L.liveLayout>, id: string) => { const r = lay.abs.get(id)!; return r.y + r.h / 2; };
const within = (lay: ReturnType<typeof L.liveLayout>, id: string, vnet: string) => { const v = lay.abs.get(vnet)!; const y = cyOf(lay, id); return y >= v.y && y <= v.y + v.h; };

test("several VNets: each PaaS card sits beside its own VNet (one lane segment per VNet), not in one shared box", () => {
  const lay = L.liveLayout(many());
  for (const v of ["a", "b", "c", "d", "e"]) {
    assert.ok(within(lay, `kv-${v}`, `vnet-${v}`), `kv-${v} beside vnet-${v}`);
    assert.ok(Math.abs(cyOf(lay, `kv-${v}`) - cyOf(lay, `pe-${v}`)) < 400, `kv-${v} near its PE`);
  }
  const segs = lay.lanes.filter((l) => l.lane === "paas");
  assert.ok(segs.length >= 5, `segments ${segs.length}`);
  assert.equal(new Set(segs.map((l) => l.id)).size, segs.length, "ids unique");
});

test("an Internet terminal with only a VM public-IP line sits at that VM's height (it used to fall to the middle)", () => {
  const lay = L.liveLayout(many());
  assert.ok(Math.abs(cyOf(lay, "internet-in-vnet-d") - cyOf(lay, "vm-d3")) < L.LIVE.CARD_H, `${cyOf(lay, "internet-in-vnet-d")} vs ${cyOf(lay, "vm-d3")}`);
});

test("a card linked to two VNets goes beside the one with more links; a tie keeps VNet order", () => {
  const lay = L.liveLayout(many());
  assert.ok(within(lay, "kv-shared", "vnet-c"), "two links in c, one in a");
  const s = many();
  const tie = { ...s, edges: s.edges.filter((e) => e.id !== "pe-c-shared2->kv-shared") };
  assert.ok(within(L.liveLayout(tie), "kv-shared", "vnet-a"), "one each: the earlier VNet");
});

test("left and right segments never overlap, and one VNet in view keeps the unsplit lane ids", () => {
  const lay = L.liveLayout(many());
  const boxes = lay.lanes.filter((l) => l.parent === null);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} / ${b.id}`);
  }
  const one = many();
  const keep = new Set(["vnet-a", "snet-a-app", "snet-a-pep", ...one.nodes.filter((n) => n.parentId === "snet-a-app" || n.parentId === "snet-a-pep").map((n) => n.id), "kv-a", "kv-shared"]);
  const single = L.liveLayout({ ...one, nodes: one.nodes.filter((n) => keep.has(n.id)), edges: one.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) });
  assert.ok(single.lanes.every((l) => !l.id.includes("@")), single.lanes.map((l) => l.id).join(","));
});

test("lane segments do not depend on input order", () => {
  const s = many();
  const key = (x: DiagramSpec) => { const lay = L.liveLayout(x); return JSON.stringify({ lanes: lay.lanes, abs: [...lay.abs.entries()].sort() }); };
  const ref = key(s);
  let seed = 5;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5;
  for (let i = 0; i < 10; i++) assert.equal(key({ ...s, nodes: [...s.nodes].sort(rnd), edges: [...s.edges].sort(rnd) }), ref);
});

test("unused · detached lane: one badge size for every kind, public IPs first, then NSGs, by name", () => {
  const s = many();
  const extra = [
    node("nsg-b", { icon: "nsg", resourceKind: "nsg", metadata: { detached: "true" } }),
    node("nsg-a", { icon: "nsg", resourceKind: "nsg", metadata: { detached: "true" } }),
    node("pip-z", { icon: "publicIP", resourceKind: "publicIP", metadata: { unused: "true", unusedReason: "notAttached" } }),
    node("pip-y", { icon: "publicIP", resourceKind: "publicIP", metadata: { unused: "true", unusedReason: "nicNoVm" } }),
  ];
  const lay = L.liveLayout({ ...s, nodes: [...s.nodes, ...extra] });
  const ids = ["pip-y", "pip-z", "nsg-a", "nsg-b"];
  for (const id of ids) assert.deepEqual([lay.abs.get(id)!.w, lay.abs.get(id)!.h], [L.LIVE.NSG_W, L.LIVE.NSG_H], id);
  const order = [...ids].sort((a, b) => lay.abs.get(a)!.y - lay.abs.get(b)!.y || lay.abs.get(a)!.x - lay.abs.get(b)!.x);
  assert.deepEqual(order, ids, "reading order: public IPs, then NSGs, each by name");
  assert.ok(ids.every((id) => lay.placeMeta.laneOf.get(id) === "unused"));
});

test("an outbound-only public LB (AKS SNAT) sits in the outbound lane before its Internet card; inbound rules or unknown keep it inbound", () => {
  const s = many();
  const lbOf = (metadata: Record<string, string>) => node("lb-kubernetes", { icon: "lb", resourceKind: "lb", parentId: "vnet-a", metadata, subResources: [{ kind: "publicIP", id: "pip-out", name: "pip-out", endpoint: "40.0.0.20" }] as DiagramNodeSpec["subResources"] });
  const inetOut = node("internet-out-vnet-a", { icon: "internet", resourceKind: "internet", metadata: { direction: "egress" } });
  const run = (metadata: Record<string, string>) => L.liveLayout({
    ...s,
    nodes: [...s.nodes, lbOf(metadata), inetOut],
    edges: [...s.edges, edge("lb-kubernetes", "vm-a0", { edgeKind: "routes" }), edge("lb-kubernetes", "internet-out-vnet-a", { edgeKind: "outbound-internet", flowType: "egress", label: "LB SNAT" })],
  });
  const lay = run({ inboundRules: "0", outboundRules: "1", managedBy: "aks", placement: "public-frontend" });
  assert.equal(lay.placeMeta.laneOf.get("lb-kubernetes"), "egress", "outbound SNAT only: not an Internet entry point");
  assert.equal(lay.placeMeta.laneOf.get("internet-out-vnet-a"), "egress");
  const lb = lay.abs.get("lb-kubernetes")!, inet = lay.abs.get("internet-out-vnet-a")!;
  assert.ok(lb.x + lb.w <= inet.x, "reads left to right: LB, then the Internet card");
  assert.ok(Math.abs(cyOf(lay, "internet-out-vnet-a") - cyOf(lay, "lb-kubernetes")) < L.LIVE.CARD_H, "same row");
  assert.ok(Math.abs(cyOf(lay, "lb-kubernetes") - cyOf(lay, "vm-a0")) < 400, "beside its backends");
  assert.equal(run({ inboundRules: "1", outboundRules: "1" }).placeMeta.laneOf.get("lb-kubernetes"), "ingress", "an inbound rule: an entry point");
  assert.equal(run({ outboundRules: "1" }).placeMeta.laneOf.get("lb-kubernetes"), "ingress", "rule count unknown: unchanged");
});
