// Manual arrangement on the live diagram (lib/liveArrange + liveLayout): cells inside a subnet under the side rules,
// subnet order inside a step, VNet and lane order, ARM-id keys that survive regenerated spec ids, and nothing changes
// without an arrangement. Synthetic specs.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as arrNs from "../../web/src/lib/liveArrange.ts";
import * as archArrNs from "../../web/src/lib/archArrange.ts";

const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const A = ((arrNs as unknown as { default?: typeof arrNs }).default ?? arrNs) as typeof arrNs;
const AA = ((archArrNs as unknown as { default?: typeof archArrNs }).default ?? archArrNs) as typeof archArrNs;
type Arrangement = archArrNs.Arrangement;

const ARM = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers";
const arm = (type: string, name: string) => `${ARM}/${type}/${name}`;
const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", resourceKind: "vm", bindings: {}, ...extra });
const vnet = (id: string) => node(id, { icon: "vnet", resourceKind: "vnet", nodeType: "group", azureResourceId: arm("Microsoft.Network/virtualNetworks", id) });
const subnet = (id: string, parentId: string) => node(id, { icon: "subnet", resourceKind: "subnet", nodeType: "group", parentId, azureResourceId: `${arm("Microsoft.Network/virtualNetworks", parentId)}/subnets/${id}` });
const vm = (id: string, parentId: string, name = id) => node(id, { parentId, label: name, azureResourceId: arm("Microsoft.Compute/virtualMachines", name) });
const edge = (id: string, source: string, target: string): DiagramEdgeSpec => ({ id, source, target, bindings: {} });
const spec = (nodes: DiagramNodeSpec[], edges: DiagramEdgeSpec[] = []): DiagramSpec => ({
  version: "1", id: "t", name: "t", createdAt: "", updatedAt: "", groups: [],
  settings: { refreshIntervalSec: 30, defaultTimeRange: "1h", layout: "manual" }, nodes, edges,
});

/** front (AGW) → web (2 VMs) and → app (1 VM): web and app are both step 1; web holds 4 unlinked VMs too */
function flow(idSuffix = ""): DiagramSpec {
  const s = (x: string) => `${x}${idSuffix}`;
  return spec([
    vnet("v"), subnet("front", "v"), subnet("web", "v"), subnet("app", "v"),
    node(s("agw"), { parentId: "front", icon: "appGateway", resourceKind: "appGateway", label: "agw", azureResourceId: arm("Microsoft.Network/applicationGateways", "agw") }),
    vm(s("w1"), "web", "w1"), vm(s("w2"), "web", "w2"), vm(s("w3"), "web", "w3"), vm(s("w4"), "web", "w4"),
    vm(s("a1"), "app", "a1"),
  ], [edge("e1", s("agw"), s("w1")), edge("e2", s("agw"), s("a1"))]);
}
const centre = (r: { x: number; y: number; w: number; h: number }) => [r.x + r.w / 2, r.y + r.h / 2] as const;

test("assignCells: stored cells stay exactly; a new card goes where it adds no side-rule breach; both-ways alone", () => {
  const u = (id: string, rule: arrNs.CellRule) => ({ id, key: id, rule });
  const rows = A.assignCells([u("R", "last"), u("N", "any"), u("LR", "alone"), u("M", "any")], 3, new Map([["R", [0, 0] as const], ["M", [2, 4] as const]]));
  const where = (id: string) => { for (let r = 0; r < rows.length; r++) { const c = rows[r]!.indexOf(id); if (c >= 0) return [c, r] as const; } return null; };
  assert.deepEqual(where("R"), [0, 0], "the stored cell, even where a right-linked card is not ideal");
  assert.notEqual(where("N")![1], 0, "never right of the right-linked card on its row");
  assert.deepEqual(rows[where("LR")![1]]!.filter(Boolean), ["LR"], "alone on its row");
  assert.equal(where("M")![0], 2, "stored column kept (empty rows above dropped)");
  assert.ok(rows.every((r) => r.some(Boolean)), "no empty row");
  assert.equal(A.rowBreaches(new Map([["R", [0, 0] as const], ["N", [1, 0] as const]]), new Map([["R", "last" as const]])), 1);
});

test("applySequence: listed items take the listed places in the user's order; the rest stay", () => {
  assert.deepEqual(A.applySequence(["a", "b", "c", "d"], ["d", "x", "b"], (s) => s), ["a", "d", "c", "b"]);
  assert.deepEqual(A.applySequence(["a", "b"], undefined, (s) => s), ["a", "b"]);
});

test("no arrangement = the automatic layout, exactly", () => {
  const a = L.liveLayout(flow()), b = L.liveLayout(flow(), { arrangement: AA.EMPTY_ARRANGEMENT });
  assert.deepEqual([...b.items], [...a.items]);
});

test("a card moves to another cell of its subnet; the store keys are ARM ids; regenerated spec ids keep it", () => {
  const lay = L.liveLayout(flow());
  const g = lay.arrange.containers.get("web");
  assert.ok(g && g.kind === "grid", "web is a grid container");
  assert.equal(lay.arrange.containerOf.get("w3"), "web");
  // drop w3 on the cell of w2 (swap) — w1 is linked from the left (first column)
  const target = lay.arrange.abs.get("w2")!;
  const plan = A.livePlan(lay.arrange, "w3", centre(target))!;
  assert.equal(plan.refused, null);
  const next = A.commitPlan(AA.EMPTY_ARRANGEMENT, g, plan.next!);
  const stored = next.grid.get(arm("Microsoft.Network/virtualNetworks", "v").toLowerCase() + "/subnets/web")!;
  assert.ok(stored.cells!.has(arm("Microsoft.Compute/virtualMachines", "w3").toLowerCase()), "keyed by ARM id");
  const after = L.liveLayout(flow(), { arrangement: next });
  assert.deepEqual([after.abs.get("w3")!.x, after.abs.get("w3")!.y], [lay.abs.get("w2")!.x, lay.abs.get("w2")!.y]);
  assert.deepEqual([after.abs.get("w2")!.x, after.abs.get("w2")!.y], [lay.abs.get("w3")!.x, lay.abs.get("w3")!.y]);
  // The same resources under other spec ids (a regenerated diagram)
  const regen = L.liveLayout(flow("-2"), { arrangement: next });
  assert.deepEqual([regen.abs.get("w3-2")!.x, regen.abs.get("w3-2")!.y], [after.abs.get("w3")!.x, after.abs.get("w3")!.y]);
  // Survives serialisation (localStorage / file)
  assert.equal(AA.serializeArrangement(AA.parseArrangement(AA.serializeArrangement(next))), AA.serializeArrangement(next));
});

test("side rules: a move that puts a card left of the left-linked one is refused; breaches already there never block", () => {
  const lay = L.liveLayout(flow());
  const g = lay.arrange.containers.get("web")! as Extract<arrNs.ArrangeContainer, { kind: "grid" }>;
  assert.equal(g.rules.get("w1"), "first");
  const [c1, r1] = g.cells.get("w1")!;
  // a card dropped on the cell left of w1's row neighbour… simplest: w1 into another row's last cell (left of nothing,
  // but a card left of it) → refused
  const other = [...g.cells].find(([id, [c, r]]) => id !== "w1" && r !== r1 && c > 0);
  if (other) {
    const target = lay.arrange.abs.get(other[0])!;
    assert.equal(A.livePlan(lay.arrange, "w1", centre(target))!.refused, "side");
  }
  // A stored cell is honoured as stored (what the user saw stays)
  const stored: Arrangement = { ...AA.EMPTY_ARRANGEMENT, grid: new Map([[g.storeKey, { cols: g.cols, cells: new Map([...g.cells].map(([id, cell]) => [g.keys.get(id)!, cell] as const)) }]]) };
  const after = L.liveLayout(flow(), { arrangement: stored });
  assert.deepEqual([after.abs.get("w1")!.x, after.abs.get("w1")!.y], [lay.abs.get("w1")!.x, lay.abs.get("w1")!.y]);
  assert.equal(c1, 0);
});

test("subnets of one step: reorder inside the step only — the step (layer) never changes", () => {
  const lay = L.liveLayout(flow());
  const step = lay.arrange.containerOf.get("web")!;
  assert.equal(lay.arrange.containerOf.get("app"), step, "web and app share step 1");
  const c = lay.arrange.containers.get(step)!;
  const [first, second] = c.kind === "list" ? c.members : [];
  const above = lay.arrange.abs.get(first!)!;
  const plan = A.livePlan(lay.arrange, second!, [above.x + above.w / 2, above.y + 5])!;
  assert.equal(plan.refused, null);
  const after = L.liveLayout(flow(), { arrangement: A.commitPlan(AA.EMPTY_ARRANGEMENT, c, plan.next!) });
  assert.ok(after.abs.get(second!)!.y < after.abs.get(first!)!.y, "moved above");
  assert.equal(after.placeMeta.subnet.get(second!)!.layer, lay.placeMeta.subnet.get(second!)!.layer);
  assert.equal(lay.arrange.containerOf.get("front"), undefined, "a step with one subnet is not a container");
});

test("VNets: the user's order wins over hub-first; reset forgets it", () => {
  const two = spec([vnet("a"), subnet("sa", "a"), vm("x", "sa"), vnet("b"), subnet("sb", "b"), vm("y", "sb")]);
  const lay = L.liveLayout(two);
  const c = lay.arrange.containers.get("vnets")!;
  assert.equal(c.kind, "list");
  const members = c.kind === "list" ? c.members : [];
  const firstR = lay.arrange.abs.get(members[0]!)!;
  const plan = A.livePlan(lay.arrange, members[1]!, [firstR.x + 10, firstR.y + 5])!;
  const moved = A.commitPlan(AA.EMPTY_ARRANGEMENT, c, plan.next!);
  const after = L.liveLayout(two, { arrangement: moved });
  const order = (l: typeof lay) => [...members].sort((p, q) => l.abs.get(p)!.y - l.abs.get(q)!.y || l.abs.get(p)!.x - l.abs.get(q)!.x);
  assert.deepEqual(order(after), [members[1], members[0]]);
  assert.deepEqual(order(L.liveLayout(two, { arrangement: A.resetContainer(moved, "vnets") })), members);
  assert.deepEqual(A.liveArrangementStatus(moved, new Set(two.nodes.map((n) => n.azureResourceId!.toLowerCase()))), { boxes: 1, stale: 0 });
});
