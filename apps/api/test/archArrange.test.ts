import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as modelNs from "../../web/src/lib/archModel.ts";
import * as arrNs from "../../web/src/lib/archArrange.ts";
import * as drawioNs from "../../web/src/lib/archDrawio.ts";

const m = ((modelNs as unknown as { default?: typeof modelNs }).default ?? modelNs) as typeof modelNs;
const A = ((arrNs as unknown as { default?: typeof arrNs }).default ?? arrNs) as typeof arrNs;
const d = ((drawioNs as unknown as { default?: typeof drawioNs }).default ?? drawioNs) as typeof drawioNs;

// ── a small synthetic subscription (fake ids only) ──
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const rid = (type: string, name: string) => `${SUB}/resourcegroups/rg/providers/${type}/${name}`;
const VNET = rid("microsoft.network/virtualnetworks", "vnet");
const S1 = `${VNET}/subnets/web`, S2 = `${VNET}/subnets/app`, S3 = `${VNET}/subnets/pe`;
const vm = (n: string) => rid("microsoft.compute/virtualmachines", n);
const LB = rid("microsoft.network/loadbalancers", "lbi");
const PE = rid("microsoft.network/privateendpoints", "pe-kv");
const KV = rid("microsoft.keyvault/vaults", "kv");
function graph(): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  let k = 0;
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}) => nodes.push({ id, kind, name, location: "koreacentral", azureId: id, resourceGroup: "rg", ...extra });
  const e = (s: string, t: string, kind: ArchitectureEdge["kind"]) => edges.push({ id: `e${k++}`, source: s, target: t, kind });
  n(SUB, "subscription", "sub");
  n(VNET, "vnet", "vnet", { endpoint: "10.0.0.0/16" });
  n(S1, "subnet", "web", { endpoint: "10.0.1.0/24" }); n(S2, "subnet", "app", { endpoint: "10.0.2.0/24" }); n(S3, "subnet", "pe", { endpoint: "10.0.3.0/24" });
  for (const [i, sub] of [[1, S1], [2, S1], [3, S1], [4, S2], [5, S2]] as const) {
    const nic = rid("microsoft.network/networkinterfaces", `nic${i}`);
    n(nic, "nic", `nic${i}`, { endpoint: `10.0.0.${i}` }); n(vm(`vm${i}`), "vm", `vm${i}`);
    e(sub, nic, "attached-to"); e(nic, vm(`vm${i}`), "bound-to");
    if (sub === S2) e(LB, nic, "routes");
  }
  n(LB, "lb", "lbi"); e(S1, LB, "connects");
  n(PE, "privateEndpoint", "pe-kv"); n(KV, "keyVault", "kv"); e(S3, PE, "network"); e(PE, KV, "privateLink");
  return { generatedAt: "2026-01-01T00:00:00Z", nodes, edges };
}
const model = m.buildArchModel(graph());
// By name (flow: false): these tests are about the order / slot mechanics of the classic wrapped rows
const view = (order?: Map<string, string[]>) => m.layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set(), layers: new Set(m.ARCH_EDGE_KINDS), allLines: true, flow: false, ...(order ? { order } : {}) });
const at = (L: ReturnType<typeof view>, id: string) => L.shapes.find((s) => s.id === id)!;
const center = (s: { x: number; y: number; w: number; h: number }): [number, number] => [s.x + s.w / 2, s.y + s.h / 2];

test("order: the user's order is applied inside a container; unlisted ids keep their auto order after it; stale ids ignored", () => {
  const auto = view();
  assert.equal(auto.containers.get(S1)?.[0], LB, "auto order: kinds, then names");
  const ordered = view(new Map([[S1, [vm("vm3"), "gone-id"]]]));
  const ids = ordered.containers.get(S1)!;
  assert.equal(ids[0], vm("vm3"), "listed first");
  assert.ok(at(ordered, vm("vm3")).x < at(ordered, vm("vm1")).x, "drawn first in the row");
  // Same slots: the set of tile rectangles in the subnet is unchanged, only who sits where
  const rects = (L: ReturnType<typeof view>) => (L.containers.get(S1) ?? []).map((id) => at(L, id)).map((s) => `${s.x},${s.y}`).sort();
  assert.deepEqual(rects(ordered), rects(auto));
  // Subnets reorder inside their VNet too
  const sub = view(new Map([[VNET, [S3, S1]]]));
  assert.deepEqual(sub.containers.get(VNET)!.slice(0, 2), [S3, S1]);
});

test("move: a drop lands in the nearest slot of the same container; another subnet is refused; fixed shapes refused", () => {
  const L = view();
  const ids = L.containers.get(S1)!;
  const last = at(L, ids.at(-1)!);
  // A tile dropped on another tile's cell: they swap (tile containers are grids)
  const r = A.moveInOrder(L, ids.at(-1)!, [at(L, ids[0]!).x + 2, center(at(L, ids[0]!))[1]]);
  assert.ok("grid" in r);
  if ("grid" in r) {
    assert.equal(r.containerId, S1);
    assert.deepEqual(r.grid.cells?.get(ids.at(-1)!), [0, 0]);
    assert.equal(r.swapWith, ids[0]);
  }
  // Into the "app" subnet: refused (it would misstate where the VM lives)
  assert.deepEqual(A.moveInOrder(L, vm("vm1"), center(at(L, vm("vm4")))), { refused: "outsideParent" });
  assert.deepEqual(A.moveInOrder(L, ids[0]!, center(at(L, ids[0]!))), { refused: "noChange" });
  assert.deepEqual(A.moveInOrder(L, "subscription", [0, 0]), { refused: "notMovable" });
  void last;
});

test("stack: an open stack's members move with its fold tile, never alone", () => {
  const many = m.buildArchModel((() => {
    const g = graph();
    for (let i = 10; i < 18; i++) {
      const nic = rid("microsoft.network/networkinterfaces", `nicx${i}`);
      g.nodes.push({ id: nic, kind: "nic", name: `nicx${i}`, location: "koreacentral", azureId: nic, resourceGroup: "rg" }, { id: vm(`x${i}`), kind: "vm", name: `x${i}`, location: "koreacentral", azureId: vm(`x${i}`), resourceGroup: "rg" });
      g.edges.push({ id: `a${i}`, source: S1, target: nic, kind: "attached-to" }, { id: `b${i}`, source: nic, target: vm(`x${i}`), kind: "bound-to" });
    }
    return g;
  })());
  const STACK = `stack:${S1}:vm`;
  const L = m.layoutArch(many, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set([STACK]), layers: new Set(m.ARCH_EDGE_KINDS), order: new Map([[S1, [STACK, LB]]]) });
  const ids = L.containers.get(S1)!;
  assert.deepEqual(ids, [STACK, LB], "the stack is one slot; its members are not listed");
  const fold = at(L, `fold:${STACK}`), lb = at(L, LB);
  assert.ok(fold.y < lb.y || (fold.y === lb.y && fold.x < lb.x), "the stack (fold first, then its members) comes before the LB as ordered");
  const member = [...L.followers.keys()][0]!;
  assert.deepEqual(A.moveInOrder(L, member, [0, 0]), { refused: "follower" });
});

test("relation: only configured relationships (any layer, either direction); unrelated, self and frames refused", () => {
  const L = view();
  const r = A.relationBetween(model, L, vm("vm4"), LB.toLowerCase());
  assert.ok(r.ok && r.kinds.includes("routes"), "LB → backend, picked in reverse");
  assert.deepEqual(A.relationBetween(model, L, vm("vm1"), KV.toLowerCase()), { ok: false, reason: "none" });
  assert.deepEqual(A.relationBetween(model, L, vm("vm1"), vm("vm1")), { ok: false, reason: "self" });
  assert.deepEqual(A.relationBetween(model, L, vm("vm1"), "subscription"), { ok: false, reason: "notDrawable" });
  // A layer switched off still counts as a relationship (configuration, not the view)
  const noPl = m.layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set(), layers: new Set(["routes"]) });
  assert.ok(A.relationBetween(model, noPl, PE.toLowerCase(), KV.toLowerCase()).ok);
});

test("manual line: replaces the auto line of its pair, keeps kind and direction, always drawn; geometry by style", () => {
  const L = view();
  const auto = L.edges.filter((e) => e.kind === "routes" && e.target === vm("vm4"));
  assert.equal(auto.length, 1);
  const out = A.applyManualLines(L, [{ source: vm("vm4"), target: LB.toLowerCase(), style: "straight" }]);
  const manual = out.edges.find((e) => e.manual);
  assert.ok(manual);
  assert.equal(manual!.kind, "routes");
  assert.deepEqual([manual!.source, manual!.target], [LB.toLowerCase(), vm("vm4")], "the model's direction, not the click order");
  assert.ok(!out.edges.some((e) => e.id === auto[0]!.id), "the auto line is replaced, not doubled");
  assert.equal(manual!.points.length, 2);
  const elbow = A.applyManualLines(L, [{ source: LB.toLowerCase(), target: vm("vm4"), style: "elbow", bend: 0.25 }]).edges.find((e) => e.manual)!;
  assert.equal(elbow.points.length, 4);
  for (let k = 0; k + 1 < elbow.points.length; k++) assert.ok(elbow.points[k]![0] === elbow.points[k + 1]![0] || elbow.points[k]![1] === elbow.points[k + 1]![1], "elbow runs are axis-aligned");
  const curve = A.applyManualLines(L, [{ source: LB.toLowerCase(), target: vm("vm4"), style: "curve" }]).edges.find((e) => e.manual)!;
  assert.equal(curve.points.length, 4);
  // A focus-kind line drawn by the user stays visible
  const pl = A.applyManualLines(m.layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() }), [{ source: PE.toLowerCase(), target: KV.toLowerCase(), style: "elbow" }]).edges.find((e) => e.manual)!;
  assert.equal(pl.display, "always");
  // Not drawn now (layer off) → skipped, nothing invented
  const hidden = A.applyManualLines(m.layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set(), layers: new Set(["routes"]) }), [{ source: PE.toLowerCase(), target: KV.toLowerCase(), style: "elbow" }]);
  assert.ok(!hidden.edges.some((e) => e.manual));
});

test("draw.io: manual straight / curve / elbow keep their shape", () => {
  const L = A.applyManualLines(view(), [{ source: LB.toLowerCase(), target: vm("vm4"), style: "curve" }, { source: LB.toLowerCase(), target: vm("vm5"), style: "straight" }]);
  const xml = d.toDrawio(L, { label: (s) => s.id, title: "t", caption: ["x"] });
  assert.match(xml, /edgeStyle=none;curved=1;/);
  assert.match(xml, /edgeStyle=none;html=0/);
});

test("persistence: round-trip, junk and other versions read as nothing, values clamped", () => {
  const a = { order: new Map([[S1, [vm("vm2")]]]), grid: new Map(), lines: [{ source: "a", target: "b", style: "elbow" as const, bend: 0.3 }] };
  const back = A.parseArrangement(A.serializeArrangement(a));
  assert.deepEqual([...back.order], [...a.order]);
  assert.deepEqual(back.lines, a.lines);
  assert.deepEqual(A.parseArrangement("not json"), A.EMPTY_ARRANGEMENT);
  assert.deepEqual(A.parseArrangement(JSON.stringify({ v: 3, order: [], lines: [] })), A.EMPTY_ARRANGEMENT);
  assert.ok(A.serializeArrangement(a).startsWith('{"v":1'), "no grid → still written as v1 (older builds read it)");
  assert.equal(A.parseArrangement(JSON.stringify({ v: 1, lines: [{ source: "a", target: "b", style: "zigzag" }, { source: "a", target: "b", style: "curve", bend: 5 }] })).lines[0]!.bend, 0.9);
});

test("drop plan: the slots of the container, the insertion bar, the target slot; outside = refused, nothing to draw for fixed shapes", () => {
  const L = view();
  const ids = L.containers.get(S1)!;
  const first = at(L, ids[0]!);
  const plan = A.dropPlan(L, ids.at(-1)!, [first.x + 2, center(first)[1]]);
  assert.ok("containerId" in plan);
  if (!("containerId" in plan)) return;
  assert.equal(plan.containerId, S1);
  assert.equal(plan.slots.length, ids.length, "one dashed slot per child");
  assert.ok(plan.bar && Math.abs(plan.bar.x - (first.x - 7)) <= 2, "the bar sits in the gap before the first tile");
  assert.ok(plan.target, "equal slots → the slot the tile takes is known");
  assert.deepEqual([plan.target!.x, plan.target!.y], [first.x, first.y]);
  assert.equal(plan.refused, false);
  const out = A.dropPlan(L, ids[0]!, center(at(L, vm("vm4"))));
  assert.ok("containerId" in out && out.refused && out.bar === null);
  assert.deepEqual(A.dropPlan(L, "subscription", [0, 0]), { refused: "notMovable" });
});

test("keyboard: Alt+← / → one slot in reading order, at the ends refused", () => {
  const L = view();
  const ids = L.containers.get(S1)!;
  const r = A.stepInOrder(L, ids[1]!, "left");
  assert.ok(!("refused" in r));
  if (!("refused" in r)) assert.deepEqual(r.order.slice(0, 2), [ids[1], ids[0]]);
  assert.deepEqual(A.stepInOrder(L, ids[0]!, "left"), { refused: "edge" });
  assert.deepEqual(A.stepInOrder(L, ids.at(-1)!, "right"), { refused: "edge" });
});

test("relation index: the same answer as relationBetween for every pair, both directions", () => {
  const L = view();
  const idx = A.relationIndex(model, L);
  const ids = L.shapes.map((s) => s.id);
  for (const a of ids) for (const b of ids) {
    const r = A.relationBetween(model, L, a, b);
    const k = idx.get(a)?.get(b);
    assert.equal(!!k, r.ok, `${a} → ${b}`);
    if (r.ok && k) assert.deepEqual(k, r.kinds);
  }
});

test("handles: elbow bend from the handle position (clamped), curve bulge along the normal, straight none", () => {
  const L = view();
  const elbow = A.applyManualLines(L, [{ source: LB.toLowerCase(), target: vm("vm4"), style: "elbow" }]).edges.find((e) => e.manual)!;
  const h = A.lineHandle(elbow)!;
  assert.equal(h.kind, "bend");
  assert.ok(Math.abs(A.handleValue(elbow, h.at)! - 0.5) < 0.02, "the handle sits at the default bend");
  const horizontal = elbow.sourceSide === "l" || elbow.sourceSide === "r";
  // Far behind the source (away from the target): clamped to 0.1; far beyond the target: 0.9
  const [p0, p3] = [elbow.points[0]!, elbow.points[3]!];
  const back: [number, number] = [p0[0] - (p3[0] - p0[0]) * 10, p0[1] - (p3[1] - p0[1]) * 10];
  const ahead: [number, number] = [p3[0] + (p3[0] - p0[0]) * 10, p3[1] + (p3[1] - p0[1]) * 10];
  assert.equal(A.handleValue(elbow, horizontal ? [back[0], h.at[1]] : [h.at[0], back[1]]), 0.1, "clamped");
  assert.equal(A.handleValue(elbow, horizontal ? [ahead[0], h.at[1]] : [h.at[0], ahead[1]]), 0.9);
  const curve = A.applyManualLines(L, [{ source: LB.toLowerCase(), target: vm("vm4"), style: "curve", bulge: 0.3 }]).edges.find((e) => e.manual)!;
  const ch = A.lineHandle(curve)!;
  assert.equal(ch.kind, "bulge");
  assert.ok(Math.abs(A.handleValue(curve, ch.at)! - 0.3) < 0.02, "the handle reads back the bulge it was drawn with");
  const straight = A.applyManualLines(L, [{ source: LB.toLowerCase(), target: vm("vm4"), style: "straight" }]).edges.find((e) => e.manual)!;
  assert.equal(A.lineHandle(straight), null);
  assert.equal(A.parseArrangement(JSON.stringify({ v: 1, lines: [{ source: "a", target: "b", style: "curve", bulge: -3 }] })).lines[0]!.bulge, -1);
});
