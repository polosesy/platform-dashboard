import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as routeNs from "../../web/src/lib/liveRoute.ts";

const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const R = ((routeNs as unknown as { default?: typeof routeNs }).default ?? routeNs) as typeof routeNs;
const { liveLayout, LIVE } = L;

// ── synthetic diagrams shaped like the real hub (demo) and QA VNets — names only, no real IDs ──

const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", resourceKind: "vm", bindings: {}, ...extra });
const group = (id: string, icon: "vnet" | "subnet", parentId?: string): DiagramNodeSpec => node(id, { icon, nodeType: "group", parentId, resourceKind: icon });
const edge = (source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({ id: `${source}->${target}`, source, target, bindings: {}, ...extra });
const spec = (nodes: DiagramNodeSpec[], edges: DiagramEdgeSpec[]): DiagramSpec => ({
  version: "1", id: "t", name: "t", createdAt: "", updatedAt: "", groups: [],
  settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" }, nodes, edges,
});
const lb = (id: string, parentId: string | undefined, ip: string, kind: "publicIP" | "frontendIP") =>
  node(id, { icon: "lb", resourceKind: "lb", parentId, subResources: [{ id: `${id}/fe`, label: "fe", kind, endpoint: ip }] });

function hub(): DiagramSpec {
  const V = "vnet-hub-poc-001";
  const nodes = [
    group(V, "vnet"),
    ...["snet-web-hub-poc-001", "snet-untrust-hub-poc-001", "snet-trust-hub-poc-001", "snet-lbi-hub-poc-001", "snet-was-hub-poc-001", "snet-agw-hub-poc-001", "snet-jbx-hub-poc-001", "GatewaySubnet", "snet-pep-hub-poc-001"].map((s) => group(s, "subnet", V)),
    node("vm-web-b", { parentId: "snet-web-hub-poc-001" }),
    node("vmss-web", { icon: "vmss", resourceKind: "vmss", parentId: "snet-web-hub-poc-001" }),
    // the public LB was guessed into snet-web by resource group — the layout must take it out
    lb("lb-ips", "snet-web-hub-poc-001", "20.0.0.1", "publicIP"),
    node("vm-ngf-a", { parentId: "snet-untrust-hub-poc-001" }),
    node("vm-ngf-b", { parentId: "snet-untrust-hub-poc-001" }),
    lb("lbi-ips", "snet-trust-hub-poc-001", "10.0.12.10", "frontendIP"),
    lb("lbi-was", "snet-lbi-hub-poc-001", "10.0.40.10", "frontendIP"),
    node("vmss-was-inst", { parentId: "snet-was-hub-poc-001" }),
    node("vmss-was", { icon: "vmss", resourceKind: "vmss", parentId: "snet-was-hub-poc-001" }),
    node("agw", { icon: "appGateway", resourceKind: "appGateway", parentId: "snet-agw-hub-poc-001", subResources: [{ id: "agw/fe", label: "fe", kind: "frontendIP", endpoint: "10.0.20.4" }] }),
    node("vm-jbx", { parentId: "snet-jbx-hub-poc-001" }),
    node("ngw", { icon: "natGateway", resourceKind: "natGateway", parentId: V }),
    node("inet-in", { icon: "internet", resourceKind: "internet", metadata: { direction: "ingress" } }),
    node("inet-out", { icon: "internet", resourceKind: "internet", metadata: { direction: "egress" } }),
  ];
  const edges = [
    edge("inet-in", "lb-ips", { edgeKind: "network", flowType: "ingress" }),
    edge("lb-ips", "vm-ngf-a", { edgeKind: "routes", flowType: "ingress" }),
    edge("lb-ips", "vm-ngf-b", { edgeKind: "routes", flowType: "ingress" }),
    edge("lbi-ips", "vm-ngf-a", { edgeKind: "routes" }),
    edge("lbi-ips", "vm-ngf-b", { edgeKind: "routes" }),
    edge("lbi-was", "vmss-was-inst", { edgeKind: "routes" }),
    ...["snet-web-hub-poc-001", "snet-untrust-hub-poc-001", "snet-was-hub-poc-001", "snet-jbx-hub-poc-001"].map((s) => edge(s, "ngw", { edgeKind: "natgw-association", flowType: "egress" })),
    edge("ngw", "inet-out", { edgeKind: "outbound-internet", flowType: "egress" }),
  ];
  return spec(nodes, edges);
}

function qa(): DiagramSpec {
  const V = "qa-krc-01-vnet";
  const nodes = [
    group(V, "vnet"),
    group("qa-krc-01-vnet-subnet-01", "subnet", V),
    group("was-subnet", "subnet", V),
    group("qa-krc-01-vnet-subnet-03", "subnet", V),
    group("qa-krc-01-vnet-subnet-02", "subnet", V),
    group("AzureBastionSubnet", "subnet", V),
    ...["oracle-lb", "eastus-oracle-lb", "lb-was"].map((id, i) => lb(id, "qa-krc-01-vnet-subnet-01", `40.0.0.${i + 1}`, "publicIP")),
    ...Array.from({ length: 8 }, (_, i) => node(`vm0${i + 1}`, { parentId: "qa-krc-01-vnet-subnet-01" })),
    ...Array.from({ length: 3 }, (_, i) => node(`nsg-${i}`, { icon: "nsg", resourceKind: "nsg", parentId: "qa-krc-01-vnet-subnet-01" })),
    node("was-app", { icon: "appService", resourceKind: "appService", parentId: "was-subnet" }),
    node("pe-was", { icon: "privateEndpoint", resourceKind: "privateEndpoint", parentId: "qa-krc-01-vnet-subnet-03" }),
    node("pe-sa", { icon: "privateEndpoint", resourceKind: "privateEndpoint", parentId: "qa-krc-01-vnet-subnet-03" }),
    node("qa-storage", { icon: "storage", resourceKind: "storage" }),
    node("other-vm04", { metadata: { ghostOf: "other-vnet" } }),
    node("inet-in", { icon: "internet", resourceKind: "internet", metadata: { direction: "ingress" } }),
  ];
  const edges = [
    ...["oracle-lb", "eastus-oracle-lb", "lb-was"].map((id) => edge("inet-in", id, { edgeKind: "network", flowType: "ingress" })),
    edge("oracle-lb", "vm04", { edgeKind: "routes" }),
    edge("eastus-oracle-lb", "other-vm04", { edgeKind: "routes" }),
    edge("pe-was", "was-app", { edgeKind: "privateLink" }),
    edge("pe-sa", "qa-storage", { edgeKind: "privateLink" }),
  ];
  return spec(nodes, edges);
}

type Rect = { x: number; y: number; w: number; h: number };
const ancestors = (lay: ReturnType<typeof liveLayout>, id: string) => {
  const parent = new Map([...lay.items.values()].map((b) => [b.id, b.parent]));
  const out = new Set<string>([id]);
  for (let p = parent.get(id); p; p = parent.get(p) ?? null) out.add(p);
  return out;
};
const segHits = (pts: Array<[number, number]>, r: Rect) => {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i]!, [x2, y2] = pts[i + 1]!;
    if (Math.max(x1, x2) > r.x + 1 && Math.min(x1, x2) < r.x + r.w - 1 && Math.max(y1, y2) > r.y + 1 && Math.min(y1, y2) < r.y + r.h - 1) return true;
  }
  return false;
};

for (const [name, make] of [["hub", hub], ["qa", qa]] as const) {
  test(`${name}: no right-angled line crosses a card or subnet it does not belong to (A-4)`, () => {
    const s = make();
    const lay = liveLayout(s);
    const routes = R.routeEdges(lay, s.edges);
    const bad: string[] = [];
    for (const e of s.edges) {
      const r = routes.get(e.id);
      if (!r || r.kind !== "step") continue;
      const pts = R.stepPolyline(r, lay.abs.get(e.source)!, lay.abs.get(e.target)!);
      const skip = new Set([...ancestors(lay, e.source), ...ancestors(lay, e.target)]);
      for (const [id, rect] of lay.abs) {
        if (skip.has(id) || lay.lanes.some((l) => l.id === id) || !lay.items.has(id)) continue;
        if (lay.items.get(id)!.parent === null) continue; // the VNet box itself
        if (segHits(pts, rect)) bad.push(`${e.id} × ${id}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test(`${name}: lines leave on the side they go (A-5) and bend outside subnet headers (A-6)`, () => {
    const s = make();
    const lay = liveLayout(s);
    for (const [id, r] of R.routeEdges(lay, s.edges)) {
      const e = s.edges.find((x) => x.id === id)!;
      const S = lay.abs.get(e.source)!, T = lay.abs.get(e.target)!;
      if (r.sourceHandle === "s-r" && r.targetHandle === "t-l") assert.ok(T.x >= S.x + S.w, `${id} forward`);
      if (r.sourceHandle === "s-l") assert.ok(T.x + T.w <= S.x, `${id} backward`);
      if (r.kind !== "step" || r.centerX == null) continue;
      const skip = new Set([...ancestors(lay, e.source), ...ancestors(lay, e.target)]);
      const y0 = Math.min(S.y + S.h / 2, T.y + T.h / 2), y1 = Math.max(S.y + S.h / 2, T.y + T.h / 2);
      for (const sid of lay.placeMeta.subnetIds) {
        if (skip.has(sid)) continue;
        const b = lay.abs.get(sid)!;
        const inHeaderX = r.centerX > b.x && r.centerX < b.x + b.w;
        const inHeaderY = y1 > b.y && y0 < b.y + LIVE.SUBNET_HEAD;
        assert.ok(!(inHeaderX && inHeaderY), `${id} bends through the header of ${sid}`);
      }
    }
  });

  test(`${name}: layout and routes do not depend on input order (A-9)`, () => {
    const s = make();
    const key = (x: DiagramSpec) => {
      const lay = liveLayout(x);
      return JSON.stringify({ items: [...lay.items.entries()].sort(), lanes: lay.lanes, abs: [...lay.abs.entries()].sort(), routes: [...R.routeEdges(lay, x.edges).entries()].sort() });
    };
    const ref = key(s);
    let seed = 11;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5;
    for (let i = 0; i < 50; i++) {
      assert.equal(key({ ...s, nodes: [...s.nodes].sort(rnd), edges: [...s.edges].sort(rnd) }), ref);
    }
  });

  test(`${name}: aspect ≤ 2, fit-to-screen ≥ 0.45, no overlaps (A-12, A-13)`, () => {
    const lay = liveLayout(make());
    const vnet = [...lay.items.values()].find((b) => b.parent === null && lay.placeMeta.subnetIds.size && [...lay.placeMeta.subnetIds].some((s) => lay.items.get(s)!.parent === b.id))!;
    assert.ok(vnet.w / vnet.h <= 2.0, `aspect ${(vnet.w / vnet.h).toFixed(2)}`);
    assert.ok(1055 / (lay.bounds.width * 1.06) >= 0.45, `fit ${(1055 / (lay.bounds.width * 1.06)).toFixed(3)} vnet ${vnet.w}x${vnet.h} bounds ${lay.bounds.width}x${lay.bounds.height}`);
    const all = [...lay.items.values(), ...lay.lanes, ...lay.summaries];
    const byParent = new Map<string, typeof all>();
    for (const b of all) (byParent.get(b.parent ?? "") ?? byParent.set(b.parent ?? "", []).get(b.parent ?? "")!).push(b);
    for (const kids of byParent.values()) for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i]!, b = kids[j]!;
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} / ${b.id}`);
    }
  });
}

test("public-only LBs leave their guessed subnet for the inbound lane (A-1); entry subnet is leftmost (A-2)", () => {
  const lay = liveLayout(hub());
  assert.equal(lay.items.get("lb-ips")!.parent, "lane:ingress");
  assert.equal(lay.items.get("lbi-ips")!.parent, "snet-trust-hub-poc-001"); // internal LB stays
  const vnet = lay.abs.get("vnet-hub-poc-001")!;
  assert.equal(lay.abs.get("snet-untrust-hub-poc-001")!.x - vnet.x, LIVE.PAD);
  const q = liveLayout(qa());
  for (const id of ["oracle-lb", "eastus-oracle-lb", "lb-was"]) assert.equal(q.items.get(id)!.parent, "lane:ingress");
});

test("subnets linked by lines share a band; neighbours are at most one layer apart (A-3)", () => {
  const s = hub();
  const lay = liveLayout(s);
  const sub = (id: string) => lay.items.get(id)?.parent ?? "";
  for (const e of s.edges.filter(L.isLayoutEdge)) {
    const a = lay.placeMeta.subnet.get(sub(e.source)), b = lay.placeMeta.subnet.get(sub(e.target));
    if (!a || !b || sub(e.source) === sub(e.target)) continue;
    assert.equal(a.band, b.band);
    assert.ok(Math.abs(a.layer - b.layer) <= 1);
  }
  // untrust is reached from the Internet side first, trust behind it
  assert.equal(lay.placeMeta.subnet.get("snet-untrust-hub-poc-001")!.layer, 0);
  assert.equal(lay.placeMeta.subnet.get("snet-trust-hub-poc-001")!.layer, 1);
});

test("the inbound LB sits at its backends' height, the Internet terminal at the LB's (A-7)", () => {
  const lay = liveLayout(hub());
  const cy = (id: string) => { const r = lay.abs.get(id)!; return r.y + r.h / 2; };
  assert.ok(Math.abs(cy("lb-ips") - (cy("vm-ngf-a") + cy("vm-ngf-b")) / 2) <= 1);
  assert.ok(Math.abs(cy("inet-in") - cy("lb-ips")) <= 1);
});

test("a PaaS lane sits at the height of the Private Endpoints that reach it (A-8)", () => {
  const lay = liveLayout(qa());
  const lane = lay.lanes.find((l) => l.id === "lane:paas:data")!;
  const pe = lay.abs.get("pe-sa")!;
  assert.ok(Math.abs(lane.y + lane.h / 2 - (pe.y + pe.h / 2)) <= 1);
});
