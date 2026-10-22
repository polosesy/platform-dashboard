import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as modelNs from "../../web/src/lib/archModel.ts";
import * as routeNs from "../../web/src/lib/archRoute.ts";
import { mockArchitectureGraph } from "../src/mockData.js";

const m = ((modelNs as unknown as { default?: typeof modelNs }).default ?? modelNs) as typeof modelNs;
const r = ((routeNs as unknown as { default?: typeof routeNs }).default ?? routeNs) as typeof routeNs;
type Layout = ReturnType<typeof m.layoutArch>;
type Rect = { x: number; y: number; w: number; h: number };

// ── a "busy" synthetic subscription (fake IDs only): one gateway → 8 backends in 3 subnets, 10 PEs → PaaS,
//    NAT on 4 subnets, peering, a public LB ──
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const rid = (type: string, name: string) => `${SUB}/resourceGroups/rg/providers/${type}/${name}`.toLowerCase();
const VNET = rid("microsoft.network/virtualnetworks", "hub"), VNET2 = rid("microsoft.network/virtualnetworks", "spoke");
const sub = (v: string, n: string) => `${v}/subnets/${n}`;
function busy(): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  let k = 0;
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}) =>
    nodes.push({ id, kind, name, location: "westeurope", azureId: id, resourceGroup: "rg", ...extra });
  const e = (s: string, t: string, kind: ArchitectureEdge["kind"]) => edges.push({ id: `e${k++}`, source: s, target: t, kind });
  n(SUB, "subscription", "Contoso Production");
  n(VNET, "vnet", "hub", { endpoint: "10.0.0.0/16" });
  n(VNET2, "vnet", "spoke", { endpoint: "10.1.0.0/16" });
  e(VNET, VNET2, "peering");
  const subnets = ["agw", "web", "app", "data", "pe"].map((s, i) => { const id = sub(VNET, s); n(id, "subnet", s, { endpoint: `10.0.${i}.0/24` }); return id; });
  const spokeSub = sub(VNET2, "work");
  n(spokeSub, "subnet", "work", { endpoint: "10.1.0.0/24" });
  const AGW = rid("microsoft.network/applicationgateways", "agw");
  n(AGW, "appGateway", "agw"); e(subnets[0]!, AGW, "connects");
  n(rid("microsoft.network/publicipaddresses", "pip-agw"), "publicIP", "pip-agw", { endpoint: "20.0.0.1", metadata: { attachedTo: AGW } });
  // 8 backends: 3 in web, 3 in app, 2 in the spoke
  const places = [subnets[1]!, subnets[1]!, subnets[1]!, subnets[2]!, subnets[2]!, subnets[2]!, spokeSub, spokeSub];
  places.forEach((s, i) => {
    const nic = rid("microsoft.network/networkinterfaces", `nic${i}`), vm = rid("microsoft.compute/virtualmachines", `vm${i}`);
    n(nic, "nic", `nic${i}`, { endpoint: `10.0.9.${i}` }); n(vm, "vm", `vm${i}`);
    e(s, nic, "attached-to"); e(nic, vm, "bound-to"); e(AGW, nic, "routes");
  });
  // 10 PEs → 10 PaaS
  for (let i = 0; i < 10; i++) {
    const pe = rid("microsoft.network/privateendpoints", `pe${i}`), kv = rid("microsoft.keyvault/vaults", `kv${i}`);
    n(pe, "privateEndpoint", `pe${i}`, { endpoint: `10.0.4.${i + 4}` }); n(kv, "keyVault", `kv${i}`);
    e(subnets[4]!, pe, "network"); e(pe, kv, "privateLink");
  }
  // NAT on 4 subnets, with a public IP
  const NAT = rid("microsoft.network/natgateways", "nat");
  n(NAT, "natGateway", "nat");
  for (const s of subnets.slice(1)) e(s, NAT, "network");
  n(rid("microsoft.network/publicipaddresses", "pip-nat"), "publicIP", "pip-nat", { endpoint: "20.0.0.2", metadata: { attachedTo: NAT } });
  // Public LB → app VMs
  const LB = rid("microsoft.network/loadbalancers", "lb");
  n(LB, "lb", "lb", { endpoint: "20.0.0.3", metadata: { inboundRules: 2 } });
  n(rid("microsoft.network/publicipaddresses", "pip-lb"), "publicIP", "pip-lb", { endpoint: "20.0.0.3", metadata: { attachedTo: LB } });
  for (const i of [3, 4]) e(LB, rid("microsoft.network/networkinterfaces", `nic${i}`), "routes");
  return { generatedAt: "2026-01-01T00:00:00Z", nodes, edges };
}

/** Every VNet open, every stack expanded (like 모두 펼치기), every layer on */
function open(model: ReturnType<typeof m.buildArchModel>, region: string, allLines = false) {
  const layers = new Set(m.ARCH_EDGE_KINDS);
  const probe = m.layoutArch(model, { region, collapsed: new Set(), expandedStacks: new Set(), layers });
  const stacks = new Set(probe.shapes.filter((s) => s.shape === "stack").map((s) => s.id));
  return m.layoutArch(model, { region, collapsed: new Set(), expandedStacks: stacks, layers, allLines });
}

/** Every rule of a routed line, for every line of a layout; returns the fallback count */
function checkRoutes(L: Layout, label: string): number {
  const shapes = new Map(L.shapes.map((s) => [s.id, s]));
  const tiles = L.shapes.filter((s) => s.shape !== "box");
  const headers: Rect[] = L.shapes.flatMap((s) => (s.shape === "box" && m.ARCH_HEAD[s.type] > 0 ? [{ x: s.x, y: s.y, w: s.w, h: m.ARCH_HEAD[s.type] }] : []));
  let fallbacks = 0;
  for (const e of L.edges) {
    const where = `${label} ${e.id}`;
    assert.ok(e.points.length >= 2, `${where}: routed`);
    if (e.fallback) { fallbacks++; continue; }
    for (let k = 0; k + 1 < e.points.length; k++) {
      const [a, b] = [e.points[k]!, e.points[k + 1]!];
      assert.ok(a[0] === b[0] || a[1] === b[1], `${where}: segment ${k} is axis-aligned`);
      for (const t of tiles) assert.ok(!r.crossesOpen(a, b, t), `${where}: segment ${k} crosses tile ${t.id}`);
      for (const h of headers) assert.ok(!r.crossesOpen(a, b, h), `${where}: segment ${k} crosses a box header`);
    }
    // Ends sit on the named side of their tiles, and leave / enter it at a right angle
    const onSide = (p: [number, number], s: Rect, side: string) =>
      side === "l" ? p[0] === s.x && p[1] > s.y && p[1] < s.y + s.h
        : side === "r" ? p[0] === s.x + s.w && p[1] > s.y && p[1] < s.y + s.h
        : side === "t" ? p[1] === s.y && p[0] > s.x && p[0] < s.x + s.w
        : p[1] === s.y + s.h && p[0] > s.x && p[0] < s.x + s.w;
    const S = shapes.get(e.source)!, T = shapes.get(e.target)!;
    assert.ok(onSide(e.points[0]!, S, e.sourceSide), `${where}: starts on side ${e.sourceSide}`);
    assert.ok(onSide(e.points.at(-1)!, T, e.targetSide), `${where}: ends on side ${e.targetSide}`);
    const horiz = (s: string) => s === "l" || s === "r";
    const [p0, p1] = [e.points[0]!, e.points[1]!], [q1, q0] = [e.points.at(-2)!, e.points.at(-1)!];
    assert.equal(p0[1] === p1[1], horiz(e.sourceSide), `${where}: leaves at a right angle`);
    assert.equal(q0[1] === q1[1], horiz(e.targetSide), `${where}: arrives at a right angle`);
  }
  return fallbacks;
}

test("routes: axis-aligned, never through a tile or a box header, ends on the tiles' sides (busy subscription)", () => {
  const model = m.buildArchModel(busy());
  for (const allLines of [false, true]) {
    const L = open(model, "westeurope", allLines);
    assert.ok(L.edges.length >= 20, "a busy picture");
    assert.equal(checkRoutes(L, `busy allLines=${allLines}`), 0, "every line found a free path");
  }
});

test("routes: the sample subscription in every region and in 'all'", () => {
  const model = m.buildArchModel(mockArchitectureGraph);
  for (const region of [...model.regions.map((x) => x.key), "all"]) {
    const L = open(model, region, true);
    assert.equal(checkRoutes(L, region), 0, `${region}: no fallback`);
  }
});

test("routes: same input → same points; shuffled graph → same points", () => {
  const g = busy();
  const a = open(m.buildArchModel(g), "westeurope", true);
  const b = open(m.buildArchModel(g), "westeurope", true);
  const shuffled = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
  const c = open(m.buildArchModel(shuffled), "westeurope", true);
  const pts = (L: Layout) => L.edges.map((e) => `${e.id}:${JSON.stringify(e.points)}`);
  assert.deepEqual(pts(a), pts(b));
  assert.deepEqual(pts(c), pts(a));
});

test("routes: parallel runs of different sources do not overlap in a lane", () => {
  const L = open(m.buildArchModel(busy()), "westeurope", true);
  type Run = { id: string; source: string; at: number; lo: number; hi: number; v: boolean };
  const runs: Run[] = [];
  for (const e of L.edges) for (let k = 1; k + 2 < e.points.length; k++) {
    const [a, b] = [e.points[k]!, e.points[k + 1]!];
    const v = a[0] === b[0];
    runs.push({ id: e.id, source: e.kind === "egress" || e.kind === "outbound" ? `to:${e.target}` : e.source, at: v ? a[0] : a[1], lo: Math.min(v ? a[1] : a[0], v ? b[1] : b[0]), hi: Math.max(v ? a[1] : a[0], v ? b[1] : b[0]), v });
  }
  let shared = 0;
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const [p, q] = [runs[i]!, runs[j]!];
    // A few pixels where a run meets another at its bend is a junction, not a shared lane
    if (p.v !== q.v || p.at !== q.at || p.source === q.source || Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo) < 8) continue;
    shared++;
  }
  // A full lane may still share (the nudge never cuts a tile); in this picture every lane has room
  assert.equal(shared, 0, "collinear overlapping runs of different sources");
});

test("boundaries: the Internet is outside the subscription; regions and global services inside it", () => {
  const model = m.buildArchModel(busy());
  const L = open(model, "westeurope");
  const at = (id: string) => L.shapes.find((s) => s.id === id)!;
  const subBox = at("subscription"), net = at(m.INTERNET_TILE), region = at("region:westeurope");
  const inside = (c: Rect, p: Rect) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
  assert.ok(net && !inside(net, subBox), "Internet outside the subscription");
  assert.ok(net.x + net.w <= subBox.x, "… and left of it (traffic reads left → right)");
  assert.ok(inside(region, subBox), "region inside the subscription");
  assert.equal(subBox.shape === "box" && subBox.label, "Contoso Production", "framed with the subscription name");
  assert.equal(at(model.regions[0]!.egress.find((id) => id.includes("natgateways"))!).parent, "lane:egress:westeurope", "NAT gateway: the region's outbound lane");
  // In from the Internet on the left, out to the Internet on the right
  assert.ok(L.edges.some((e) => e.kind === "ingress" && e.source === m.INTERNET_TILE));
  assert.ok(L.edges.some((e) => e.kind === "egress" && e.target === m.INTERNET_OUT_TILE));
  const out = at(m.INTERNET_OUT_TILE);
  assert.ok(out && out.x >= subBox.x + subBox.w, "the outbound Internet is right of the subscription");
});

test("focus lines: Private Link / NAT / VNet integration are drawn for the selection unless every line is on", () => {
  const model = m.buildArchModel(busy());
  const quiet = open(model, "westeurope");
  const focus = quiet.edges.filter((e) => e.display === "focus").map((e) => e.kind);
  assert.ok(focus.length >= 14 && focus.every((k) => m.FOCUS_KINDS.has(k)), "PE → PaaS and subnet → NAT wait for a selection");
  assert.ok(quiet.edges.filter((e) => e.display === "always").every((e) => !m.FOCUS_KINDS.has(e.kind)));
  const all = open(model, "westeurope", true);
  assert.ok(all.edges.every((e) => e.display === "always"));
});

test("routing a large subscription stays fast", () => {
  const model = m.buildArchModel(mockArchitectureGraph);
  const t0 = performance.now();
  open(model, "all", true);
  assert.ok(performance.now() - t0 < 3000, "layout + routes under 3 s");
});
