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

// ── Column counts (1열·2열): every subnet's cards, a side lane, a VNet's unconnected subnets ──

const overlapFree = (lay: ReturnType<typeof L.liveLayout>) => {
  const rs = [...lay.items.values()];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i]!, b = rs[j]!;
    if (a.parent !== b.parent) continue;
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} / ${b.id}`);
  }
};
const xsOf = (lay: ReturnType<typeof L.liveLayout>, ids: string[]) => new Set(ids.map((id) => lay.abs.get(id)!.x));
const withGrid = (entries: Array<[string, number]>): Arrangement => ({ ...AA.EMPTY_ARRANGEMENT, grid: new Map(entries.map(([k, cols]) => [k, { cols }] as const)) });

test("every subnet's cards in 1 column (a cap); a subnet's own value wins", () => {
  const auto = L.liveLayout(flow());
  assert.ok(xsOf(auto, ["w1", "w2", "w3", "w4"]).size > 1, "automatic: more than one column");
  const one = L.liveLayout(flow(), { arrangement: withGrid([[A.SUBNET_DEFAULT_KEY, 1]]) });
  assert.equal(xsOf(one, ["w1", "w2", "w3", "w4"]).size, 1);
  overlapFree(one);
  const web = one.arrange.cols.get("web")!;
  assert.equal(web.kind, "subnet");
  const own = L.liveLayout(flow(), { arrangement: withGrid([[A.SUBNET_DEFAULT_KEY, 1], [web.storeKey, 2]]) });
  assert.equal(xsOf(own, ["w1", "w2", "w3", "w4"]).size, 2, "the subnet's own 2 columns");
});

test("a PaaS lane in 2 columns: cards side by side inside the lane, no overlaps; reset → 1 column", () => {
  const nodes: DiagramNodeSpec[] = [vnet("v"), subnet("pe", "v")];
  const edges: DiagramEdgeSpec[] = [];
  for (const i of [1, 2, 3, 4]) {
    nodes.push(node(`pe${i}`, { parentId: "pe", icon: "privateEndpoint", resourceKind: "privateEndpoint", azureResourceId: arm("Microsoft.Network/privateEndpoints", `pe${i}`) }));
    nodes.push(node(`st${i}`, { icon: "storage", resourceKind: "storage", azureResourceId: arm("Microsoft.Storage/storageAccounts", `st${i}`) }));
    edges.push({ ...edge(`pl${i}`, `pe${i}`, `st${i}`), edgeKind: "privateLink" });
  }
  const s = spec(nodes, edges);
  const auto = L.liveLayout(s);
  const laneId = auto.arrange.containerOf.get("st1")!;
  const target = auto.arrange.cols.get(laneId)!;
  assert.deepEqual([target.kind, target.cols, target.max], ["lane", 1, 2]);
  const two = L.liveLayout(s, { arrangement: withGrid([[target.storeKey, 2]]) });
  assert.equal(xsOf(two, ["st1", "st2", "st3", "st4"]).size, 2);
  const lane = two.lanes.find((l) => l.id === laneId)!;
  assert.equal(lane.w, 2 * L.LIVE.CARD_W + L.LIVE.GAP + 2 * L.LIVE.PAD);
  overlapFree(two);
  assert.equal(two.arrange.cols.get(laneId)!.user, true);
  const reset = L.liveLayout(s, { arrangement: A.resetContainer(withGrid([[target.storeKey, 2]]), target.storeKey) });
  assert.equal(xsOf(reset, ["st1", "st2", "st3", "st4"]).size, 1);
});

test("a VNet's unconnected subnets: 1 column lines up, 2 columns even widths; the same input gives the same layout", () => {
  const s = spec([
    ...flow().nodes,
    subnet("iso1", "v"), vm("i1", "iso1"), subnet("iso2", "v"), vm("i2", "iso2"), vm("i2b", "iso2"), vm("i2c", "iso2"),
    subnet("iso3", "v"), vm("i3", "iso3"), subnet("iso4", "v"), vm("i4", "iso4"),
  ], flow().edges);
  const key = L.liveLayout(s).arrange.cols.get("v")!;
  assert.equal(key.kind, "loose");
  const one = L.liveLayout(s, { arrangement: withGrid([[key.storeKey, 1]]) });
  assert.equal(xsOf(one, ["iso1", "iso2", "iso3", "iso4"]).size, 1);
  const two = L.liveLayout(s, { arrangement: withGrid([[key.storeKey, 2]]) });
  assert.equal(xsOf(two, ["iso1", "iso2", "iso3", "iso4"]).size, 2);
  assert.equal(new Set(["iso1", "iso2", "iso3", "iso4"].map((id) => two.abs.get(id)!.w)).size, 1, "even widths");
  overlapFree(two);
  assert.deepEqual([...L.liveLayout(s, { arrangement: withGrid([[key.storeKey, 2]]) }).items], [...two.items]);
  // The column keys survive serialisation and are not stale
  const a = withGrid([[A.SUBNET_DEFAULT_KEY, 1], [key.storeKey, 2], ["lane:paas:data", 2]]);
  assert.equal(AA.serializeArrangement(AA.parseArrangement(AA.serializeArrangement(a))), AA.serializeArrangement(a));
  assert.equal(A.liveArrangementStatus(a, new Set()).stale, 0);
  assert.deepEqual(A.setBoxCols(a, key.storeKey, null).grid.has(key.storeKey), false);
});

test("a subnet's own column count re-flows its cards (1 column → 2 puts cards side by side)", () => {
  const one = L.liveLayout(flow(), { arrangement: withGrid([[A.SUBNET_DEFAULT_KEY, 1]]) });
  const g = one.arrange.containers.get("web")! as Extract<arrNs.ArrangeContainer, { kind: "grid" }>;
  const two = L.liveLayout(flow(), { arrangement: A.setGridCols(withGrid([[A.SUBNET_DEFAULT_KEY, 1]]), g, 2) });
  assert.equal(xsOf(two, ["w1", "w2", "w3", "w4"]).size, 2);
  overlapFree(two);
});

test("cards all linked from the left (an LB's backends): the user's 2 columns spreads them; back to 1 column stacks them", () => {
  const s = spec([
    vnet("v"), subnet("lbi", "v"), subnet("app", "v"),
    node("lb", { parentId: "lbi", icon: "lb", resourceKind: "lb", azureResourceId: arm("Microsoft.Network/loadBalancers", "lb") }),
    vm("a1", "app"), vm("a2", "app"), vm("a3", "app"),
  ], [edge("e1", "lb", "a1"), edge("e2", "lb", "a2"), edge("e3", "lb", "a3")]);
  const auto = L.liveLayout(s);
  const g = auto.arrange.containers.get("app")! as Extract<arrNs.ArrangeContainer, { kind: "grid" }>;
  assert.ok(["a1", "a2", "a3"].every((id) => g.rules.get(id) === "first"), "all linked from the left");
  assert.equal(xsOf(auto, ["a1", "a2", "a3"]).size, 1, "automatic: one column (the side rule)");
  const two = L.liveLayout(s, { arrangement: A.setGridCols(AA.EMPTY_ARRANGEMENT, g, 2) });
  assert.equal(xsOf(two, ["a1", "a2", "a3"]).size, 2, "the user's choice wins");
  overlapFree(two);
  const g2 = two.arrange.containers.get("app")! as Extract<arrNs.ArrangeContainer, { kind: "grid" }>;
  const back = L.liveLayout(s, { arrangement: A.setGridCols(A.setGridCols(AA.EMPTY_ARRANGEMENT, g, 2), g2, 1) });
  assert.equal(xsOf(back, ["a1", "a2", "a3"]).size, 1);
  assert.equal(two.arrange.cols.get("app")!.cols, 2);
});
