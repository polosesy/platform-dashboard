import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as modelNs from "../../web/src/lib/archModel.ts";
import * as arrNs from "../../web/src/lib/archArrange.ts";
import * as drawioNs from "../../web/src/lib/archDrawio.ts";
import * as viewNs from "../../web/src/lib/archView.ts";

const m = ((modelNs as unknown as { default?: typeof modelNs }).default ?? modelNs) as typeof modelNs;
const A = ((arrNs as unknown as { default?: typeof arrNs }).default ?? arrNs) as typeof arrNs;
const d = ((drawioNs as unknown as { default?: typeof drawioNs }).default ?? drawioNs) as typeof drawioNs;
const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;

// ── a synthetic subscription with one inward chain (fake ids only) ──
// Internet → Front Door → App Gateway (snet-agw) → vm-web (snet-web); Internet → public LB → vm-app (snet-app);
// PE → Key Vault (snet-pe, nothing reaches it); vm-mgmt (snet-mgmt) has no inward line
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000";
const rid = (type: string, name: string) => `${SUB}/resourcegroups/rg/providers/${type}/${name}`;
const VNET = rid("microsoft.network/virtualnetworks", "vnet");
const sn = (n: string) => `${VNET}/subnets/${n}`;
const vm = (n: string) => rid("microsoft.compute/virtualmachines", n);
const AFD = rid("microsoft.cdn/profiles", "afd");
const AGW = rid("microsoft.network/applicationgateways", "agw");
const LB = rid("microsoft.network/loadbalancers", "lbe");
const PE = rid("microsoft.network/privateendpoints", "pe-kv");
const KV = rid("microsoft.keyvault/vaults", "kv");
function graph(extraWebVms = 0): ArchitectureGraph {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  let k = 0;
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}) => nodes.push({ id, kind, name, location: "koreacentral", azureId: id, resourceGroup: "rg", ...extra });
  const e = (s: string, t: string, kind: ArchitectureEdge["kind"]) => edges.push({ id: `e${k++}`, source: s, target: t, kind });
  n(SUB, "subscription", "sub");
  n(VNET, "vnet", "vnet", { endpoint: "10.0.0.0/16" });
  // names chosen so that name order is NOT flow order (mgmt < web, app < agw)
  for (const [i, s] of ["agw", "web", "app", "pe", "mgmt"].entries()) n(sn(s), "subnet", s, { endpoint: `10.0.${i}.0/24` });
  const host = (name: string, subnet: string, i: number) => {
    const nic = rid("microsoft.network/networkinterfaces", `nic-${name}`);
    n(nic, "nic", `nic-${name}`, { endpoint: `10.0.9.${i}` }); n(vm(name), "vm", name);
    e(sn(subnet), nic, "attached-to"); e(nic, vm(name), "bound-to");
    return nic;
  };
  // An enabled endpoint with an enabled route: the profile's public entry (EDGE-12)
  n(AFD, "frontDoor", "afd", { location: "global", metadata: { endpoints: 1, activeRoutes: 1 } });
  n(AGW, "appGateway", "agw"); e(sn("agw"), AGW, "connects");
  const pip = (name: string, owner: string) => n(rid("microsoft.network/publicipaddresses", name), "publicIP", name, { endpoint: `203.0.113.${k}`, metadata: { attachedTo: owner } });
  pip("pip-agw", AGW);
  n(LB, "lb", "lbe"); pip("pip-lb", LB);
  e(AFD, AGW, "routes");
  e(AGW, host("vm-web", "web", 1), "routes");
  for (let i = 0; i < extraWebVms; i++) e(AGW, host(`vm-web${i + 2}`, "web", 10 + i), "routes");
  e(LB, host("vm-app", "app", 2), "routes");
  host("vm-mgmt", "mgmt", 3);
  n(PE, "privateEndpoint", "pe-kv"); e(sn("pe"), PE, "network");
  n(KV, "keyVault", "kv"); e(PE, KV, "privateLink");
  return { generatedAt: "2026-01-01T00:00:00Z", nodes, edges };
}
const model = m.buildArchModel(graph());
const lay = (opts: Partial<Parameters<typeof m.layoutArch>[1]> = {}, mod = model) =>
  m.layoutArch(mod, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set(), layers: new Set(m.ARCH_EDGE_KINDS), ...opts });
const at = (L: ReturnType<typeof lay>, id: string) => L.shapes.find((s) => s.id === id)!;
const center = (s: { x: number; y: number; w: number; h: number }): [number, number] => [s.x + s.w / 2, s.y + s.h / 2];

test("flow rank: longest configured inward path — Internet → Front Door 1 → App Gateway 2 → backend 3", () => {
  const r = model.flowRank;
  assert.equal(r.get(AFD), 1, "Front Door: public by design, right after the Internet");
  assert.equal(r.get(AGW), 2, "the gateway's own public IP gives 1, but Front Door → gateway is longer");
  assert.equal(r.get(vm("vm-web")), 3);
  assert.equal(r.get(LB), 1);
  assert.equal(r.get(vm("vm-app")), 2);
  assert.equal(r.get(PE), m.FLOW_UNREACHED, "a chain no Internet line reaches starts after them");
  assert.equal(r.get(KV), m.FLOW_UNREACHED + 1);
  assert.equal(r.has(vm("vm-mgmt")), false, "no inward line → no rank");
  assert.deepEqual(m.flowPath(model, vm("vm-web")), ["internet", AFD, AGW, vm("vm-web")]);
});

test("flow rank: a loop terminates with one rank for its members; input order never changes ranks", () => {
  const g = graph();
  g.edges.push({ id: "loop", source: vm("vm-web"), target: AGW, kind: "routes" });
  const looped = m.buildArchModel(g);
  assert.ok(Number.isFinite(looped.flowRank.get(AGW)!));
  const shuffled = m.buildArchModel({ ...graph(), nodes: [...graph().nodes].reverse(), edges: [...graph().edges].reverse() });
  assert.deepEqual([...shuffled.flowRank].sort(), [...model.flowRank].sort());
});

test("flow layout: a VNet becomes left → right columns by entry step; no inward line → the row below", () => {
  const L = lay();
  const cols = L.flowColumns.get(VNET.toLowerCase());
  assert.ok(cols && cols.length >= 3, "agw/app (2) · web (3) · pe (unreached)");
  const x = (s: string) => at(L, sn(s).toLowerCase()).x;
  assert.ok(x("agw") < x("web") && x("web") < x("pe"), "entry first, data last");
  assert.equal(x("agw"), x("app"), "same step → same column");
  const mgmt = at(L, sn("mgmt").toLowerCase());
  const bottom = Math.max(...["agw", "web", "app", "pe"].map((s) => { const b = at(L, sn(s).toLowerCase()); return b.y + b.h; }));
  assert.ok(mgmt.y > bottom, "no inward line: below the columns, not a column of its own");
  assert.ok(!L.shapes.some((s) => /^(vband|vcol|vrest|hole):/.test(s.id)), "wrappers and holes are never drawn");
  // By name: the earlier wrapped rows
  const byName = lay({ flow: false });
  assert.equal(byName.flowColumns.size, 0);
  assert.ok(at(byName, sn("agw").toLowerCase()).x < at(byName, sn("app").toLowerCase()).x || at(byName, sn("agw").toLowerCase()).y !== at(byName, sn("app").toLowerCase()).y);
});

test("grid: 4 tiles with 2 columns are 2 + 2 and the subnet is two tiles wide", () => {
  const four = m.buildArchModel(graph(3));
  const WEB = sn("web").toLowerCase();
  const L = lay({ flow: false, grid: new Map([[WEB, { cols: 2 }]]) }, four);
  const tiles = L.shapes.filter((s) => s.parent === WEB && s.shape === "tile");
  assert.equal(tiles.length, 4);
  assert.equal(new Set(tiles.map((t) => t.y)).size, 2, "two rows");
  assert.equal(new Set(tiles.map((t) => t.x)).size, 2, "two columns");
  const box = at(L, WEB);
  assert.equal(box.w, Math.max(2 * m.ARCH.LEAF_W + m.ARCH.GAP + 2 * m.ARCH.PAD, 220), "the boundary follows the grid");
  const g = L.grids.get(WEB)!;
  assert.equal(g.cols, 2);
  assert.equal(g.userCols, true);
  // 3 columns: 3 + 1
  const three = lay({ flow: false, grid: new Map([[WEB, { cols: 3 }]]) }, four);
  assert.equal(new Set(three.shapes.filter((s) => s.parent === WEB && s.shape === "tile").map((t) => t.y)).size, 2);
  assert.equal(at(three, WEB).w, 3 * m.ARCH.LEAF_W + 2 * m.ARCH.GAP + 2 * m.ARCH.PAD);
});

test("grid: a lone tile dropped in the + column moves right; the gap stays; never drawn or exported", () => {
  const AGWS = sn("agw").toLowerCase();
  const L = lay({ flow: false });
  const g = L.grids.get(AGWS)!;
  assert.equal(g.slots.length, 1);
  // The overlay offers the occupied cell, empty cells of the row, the + column and the + row
  const plan = A.cellPlan(L, AGW, [g.x0 + (g.cellW + g.gap) * 1 + 20, g.y0 + 20]);
  assert.ok(plan && "containerId" in plan && plan.cells && !plan.refused);
  if (!plan || !("containerId" in plan)) return;
  assert.ok(plan.cells!.some((c) => c.extra && c.row === 1), "a + row below");
  assert.deepEqual(plan.grid?.cells?.get(AGW), [1, 0]);
  const moved = lay({ flow: false, grid: new Map([[AGWS, plan.grid!]]) });
  assert.equal(at(moved, AGW).x, at(L, AGW).x + m.ARCH.LEAF_W + m.ARCH.GAP, "one cell to the right");
  assert.ok(at(moved, AGWS).w >= 2 * m.ARCH.LEAF_W + m.ARCH.GAP, "the subnet grew to keep the empty cell");
  assert.equal(moved.grids.get(AGWS)!.slots[0]!.unit, null, "the left cell is empty");
  assert.ok(!moved.shapes.some((s) => s.id.startsWith("hole:")));
  assert.ok(!d.toDrawio(moved, { label: (s) => s.id, title: "t", caption: ["x"] }).includes("hole:"), "holes are not exported");
  // Close gaps: back to the left, columns stay automatic
  const arr = { order: new Map(), grid: new Map([[AGWS, plan.grid!]]), lines: [] };
  const compact = A.compactBox(arr, moved, AGWS);
  assert.equal(compact.grid.get(AGWS)?.cells, undefined, "no cells left (the column count chosen by the move stays)");
  assert.equal(at(lay({ flow: false, grid: compact.grid, order: compact.order }), AGW).x, at(L, AGW).x);
});

test("grid: drop on a tile swaps; Alt+arrow steps into an empty cell; outside the box is refused", () => {
  const four = m.buildArchModel(graph(3));
  const WEB = sn("web").toLowerCase();
  const L = lay({ flow: false, grid: new Map([[WEB, { cols: 2 }]]) }, four);
  const g = L.grids.get(WEB)!;
  const [a, b] = [g.slots[0]!.unit!, g.slots[1]!.unit!];
  const r = A.moveInOrder(L, a, center(at(L, b)));
  assert.ok("grid" in r && r.swapWith === b);
  if (!("grid" in r)) return;
  assert.deepEqual(r.grid.cells?.get(a), [1, 0]);
  assert.deepEqual(r.grid.cells?.get(b), [0, 0]);
  // Step right from column 2 (cols 2): into the + column (cols grow to 3)
  const step = A.stepCell(L, b, "right");
  assert.ok(step && "grid" in step);
  if (step && "grid" in step) { assert.equal(step.grid.cols, 3); assert.deepEqual(step.grid.cells?.get(b), [2, 0]); }
  assert.deepEqual(A.stepCell(L, a, "left"), { refused: "edge" });
  assert.deepEqual(A.moveInOrder(L, a, center(at(L, vm("vm-app")))), { refused: "outsideParent" });
  // Set columns from the toolbar: order kept, no cells
  const set = A.setCols({ order: new Map(), grid: new Map(), lines: [] }, L, WEB, 1);
  assert.deepEqual(set.grid.get(WEB), { cols: 1 });
  assert.equal(set.order.get(WEB)?.length, 4);
  assert.equal(A.resetBox(set, WEB).grid.has(WEB), false);
});

test("grid: a tile added later goes after the last used cell (a gap the user left stays)", () => {
  const WEB = sn("web").toLowerCase();
  const before = m.buildArchModel(graph(1));
  const L = lay({ flow: false }, before);
  const g = L.grids.get(WEB)!;
  const cells = new Map<string, readonly [number, number]>([[g.slots[0]!.unit!, [0, 0]], [g.slots[1]!.unit!, [2, 0]]]);
  const after = lay({ flow: false, grid: new Map([[WEB, { cols: 3, cells }]]) }, m.buildArchModel(graph(2)));
  const slots = after.grids.get(WEB)!.slots.map((x) => x.unit);
  assert.equal(slots[1], null, "the gap stays");
  assert.equal(slots.length, 4, "the new tile after the last used cell");
});

test("persistence v2: grids round-trip, clamped; v1 still reads", () => {
  const a = { order: new Map([["s", ["x"]]]), grid: new Map([["s", { cols: 2, cells: new Map<string, readonly [number, number]>([["x", [1, 3]]]) }]]), lines: [] };
  const raw = A.serializeArrangement(a);
  assert.ok(raw.startsWith('{"v":2'));
  const back = A.parseArrangement(raw);
  assert.deepEqual(back.grid.get("s"), { cols: 2, cells: new Map([["x", [1, 3]]]) });
  const bad = A.parseArrangement(JSON.stringify({ v: 2, order: [], lines: [], grid: [["s", { cols: 17, cells: [["x", 16, 0], ["y", 1, 1]] }]] }));
  assert.deepEqual(bad.grid.get("s"), { cells: new Map([["y", [1, 1]]]) }, "columns out of range dropped");
  assert.equal(A.parseArrangement(JSON.stringify({ v: 1, order: [["s", ["x"]]], lines: [] })).grid.size, 0);
});

test("gesture watchdog: a move with no button or a blur ends the gesture; a normal release does not", () => {
  let st = { active: false, x: 0, y: 0 };
  let r = V.gestureStep(st, { type: "down", button: 0, x: 10, y: 10 }); st = r.state;
  r = V.gestureStep(st, { type: "move", buttons: 1, x: 20, y: 10 }); st = r.state;
  assert.equal(r.abort, false);
  r = V.gestureStep(st, { type: "move", buttons: 0, x: 400, y: 10 });
  assert.equal(r.abort, true, "the capture tool took the mouseup");
  assert.equal(r.state.active, false);
  st = V.gestureStep({ active: false, x: 0, y: 0 }, { type: "down", button: 0, x: 1, y: 1 }).state;
  assert.equal(V.gestureStep(st, { type: "blur" }).abort, true);
  st = V.gestureStep(st, { type: "up" }).state;
  assert.equal(V.gestureStep(st, { type: "move", buttons: 0, x: 5, y: 5 }).abort, false, "after a real mouseup nothing to end");
  assert.equal(V.gestureStep({ active: false, x: 0, y: 0 }, { type: "down", button: 2, x: 1, y: 1 }).state.active, false, "right button: no gesture");
});

test("viewport lost: off the pane or not a number", () => {
  const pane = { width: 800, height: 600 };
  const b = { width: 2000, height: 1000 };
  assert.equal(V.viewportLost(b, [0, 0, 0.5], pane), false);
  assert.equal(V.viewportLost(b, [5000, 0, 0.5], pane), "off");
  assert.equal(V.viewportLost(b, [-5000, -5000, 1], pane), "off");
  assert.equal(V.viewportLost(b, [Number.NaN, 0, 1], pane), "invalid");
  assert.equal(V.viewportLost(b, [0, 0, 0], pane), "invalid");
  assert.equal(V.viewportLost(b, [0, 0, 1], { width: 0, height: 0 }), false, "pane not measured yet");
});

// ── v4: header rows, widths, PaaS zones, subnet columns ──

test("subnet header: one row when it fits; otherwise name first, then CIDR · NSG · NAT · NIC in order, never wider than the box", () => {
  const sb = (name: string): Parameters<typeof m.subnetHead>[0] => ({
    node: { id: "s", kind: "subnet", name, endpoint: "10.90.201.0/24" }, vnetId: "v", resources: [], nsgs: ["nsg-snet-jbx-northwind-stg-weu-001"], natGateways: ["ng-northwind-stg"], otherNics: 2, publicIps: [],
  });
  const wide = m.subnetHead(sb("web"), 0, 2000);
  assert.equal(wide.rows.length, 1);
  assert.equal(wide.head, m.ARCH_HEAD.subnet);
  const narrow = m.subnetHead(sb("snet-jbx-northwind-stg-weu-001"), 3, m.ARCH.LEAF_W + 2 * m.ARCH.PAD);
  assert.ok(narrow.rows.length >= 2 && narrow.rows.length <= 4);
  assert.equal(narrow.rows[0]![0]!.k, "name");
  assert.deepEqual(narrow.rows.flat().map((x) => x.k).filter((k) => k !== "more"), ["name", "cidr", "nsg", "nat", "nic", "hidden"].slice(0, narrow.rows.flat().filter((x) => x.k !== "more").length));
  assert.equal(narrow.head, m.ARCH_HEAD.subnet + 18 * (narrow.rows.length - 1));
});

test("subnet width = its grid: one column is one tile wide (no header-driven gap); tiles start below the taller header", () => {
  const WEB = sn("web").toLowerCase();
  const L = lay({ flow: false, grid: new Map([[WEB, { cols: 1 }]]) });
  const box = at(L, WEB);
  assert.equal(box.w, m.ARCH.LEAF_W + 2 * m.ARCH.PAD);
  assert.equal(at(L, vm("vm-web")).y, box.y + box.head);
});

test("flow columns: the automatic subnets of a column share one width", () => {
  const L = lay();
  const a = at(L, sn("agw").toLowerCase()), b = at(L, sn("app").toLowerCase());
  assert.equal(a.x, b.x);
  assert.equal(a.w, b.w);
});

test("PaaS zones: movable in their lane (a horizontal insertion bar); in flow mode level with what they connect to", () => {
  const g = graph();
  const ST = rid("microsoft.storage/storageaccounts", "st");
  const PE2 = rid("microsoft.network/privateendpoints", "pe-st");
  g.nodes.push({ id: ST, kind: "storage", name: "st", location: "koreacentral", azureId: ST, resourceGroup: "rg" }, { id: PE2, kind: "privateEndpoint", name: "pe-st", location: "koreacentral", azureId: PE2, resourceGroup: "rg" });
  g.edges.push({ id: "x1", source: sn("mgmt"), target: PE2, kind: "network" }, { id: "x2", source: PE2, target: ST, kind: "privateLink" });
  const mod = m.buildArchModel(g);
  const L = lay({}, mod);
  const DATA = "paas:data:koreacentral", SEC = "paas:security:koreacentral";
  assert.equal(L.containerOf.get(DATA), "lane:paas:koreacentral", "zones are movable");
  const cy = (id: string) => { const s = at(L, id); return s.y + s.h / 2; };
  assert.equal(cy(DATA) < cy(SEC), cy(PE2) < cy(PE), "zone order follows the height of the PEs they connect to");
  // drag the lower zone above the other: a horizontal bar, then the order applies
  const [upper, lower] = cy(DATA) < cy(SEC) ? [DATA, SEC] : [SEC, DATA];
  const plan = A.dropPlan(L, lower, [at(L, upper).x + 20, at(L, upper).y + 5]);
  assert.ok("containerId" in plan && plan.bar && plan.bar.w > plan.bar.h, "column container → horizontal bar");
  if (!("containerId" in plan) || !plan.order) return;
  const moved = lay({ order: new Map([[plan.containerId, plan.order]]) }, mod);
  assert.ok(at(moved, lower).y < at(moved, upper).y, "the user's order wins over the automatic one");
});

test("subnet columns: a subnet goes to any column, a new column or the row below; reset returns to the flow steps", () => {
  const V = VNET.toLowerCase();
  const L = lay();
  const band = L.bands.get(V)!;
  assert.ok(band && band.cols.length >= 3 && !band.user);
  const WEB = sn("web").toLowerCase(), MGMT = sn("mgmt").toLowerCase();
  assert.equal(L.containerOf.get(WEB), `vband:${V}`);
  // to a new column on the right
  const last = band.cols[band.cols.length - 1]!;
  const p1 = A.bandPlan(L, WEB, [last.x + last.w + 60, last.y + 20]);
  assert.ok(p1 && !p1.refused && p1.band && p1.zones?.some((z) => z.kind === "newCol" && z.active));
  const a1 = A.applyBand({ order: new Map(), grid: new Map(), lines: [] }, V, p1!.band!.columns, p1!.band!.rest);
  const L1 = lay({ grid: a1.grid, order: a1.order });
  assert.ok(L1.bands.get(V)!.user);
  assert.ok(at(L1, WEB).x > Math.max(...[sn("agw"), sn("app"), sn("pe")].map((s) => at(L1, s.toLowerCase()).x)), "rightmost");
  // the row-below subnet into the first column, on top
  const first = band.cols[0]!;
  const p2 = A.bandPlan(L1, MGMT, [first.x + 30, first.y + 2]);
  assert.ok(p2?.band && p2.band.columns[0]![0] === MGMT && p2.band.rest.length === 0);
  // keyboard: ↓ at the bottom of a column → the row below
  const colOfWeb = L1.bands.get(V)!.cols.find((c) => c.ids.includes(WEB))!;
  const st = A.stepBand(L1, colOfWeb.ids.at(-1)!, "down");
  assert.ok(st && "band" in st && st.band.rest.includes(colOfWeb.ids.at(-1)!));
  // round trip through the store schema and back to flow steps
  const doc = JSON.parse(A.serializeArrangement(a1)) as { grid: unknown };
  assert.ok(Array.isArray(doc.grid));
  assert.equal(A.resetBand(a1, V).grid.has(`vband:${V}`), false);
  assert.equal(lay({ flow: false, grid: a1.grid, order: a1.order }).bands.size, 0, "by name: wrapped rows, the band is kept but unused");
});

// ── v5: outbound placement (NET-09), Front Door entry (EDGE-12), on-premises sites (EDGE-09), peering state ──

const NAT = rid("microsoft.network/natgateways", "nat");
const FW = rid("microsoft.network/azurefirewalls", "fw");
const GW = rid("microsoft.network/virtualnetworkgateways", "gw");
function egressGraph(): ArchitectureGraph {
  const g = graph();
  const add = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}) => g.nodes.push({ id, kind, name, location: "koreacentral", azureId: id, resourceGroup: "rg", ...extra });
  let k = 900;
  const e = (s: string, t: string, kind: ArchitectureEdge["kind"], metadata?: ArchitectureEdge["metadata"]) => g.edges.push({ id: `v${k++}`, source: s, target: t, kind, ...(metadata ? { metadata } : {}) });
  add(NAT, "natGateway", "nat");
  add(rid("microsoft.network/publicipaddresses", "pip-nat"), "publicIP", "pip-nat", { endpoint: "203.0.113.90", metadata: { attachedTo: NAT } });
  add(FW, "firewall", "fw");
  e(sn("mgmt"), FW, "connects");
  // web and app attached to the NAT; app's first exit is the firewall (UDR), web's is the NAT
  e(sn("web"), NAT, "network");
  e(sn("app"), NAT, "network");
  const sub = (s: string) => g.nodes.find((x) => x.id === sn(s))!;
  sub("web").metadata = { egress: { via: "nat", targetId: NAT, evidence: "cfg" } };
  sub("app").metadata = { egress: { via: "appliance", targetId: FW, holder: "firewall", nextHopIp: "10.0.4.4", routeTable: { name: "rt-app", prefix: "0.0.0.0/0" }, natBypassed: NAT } };
  e(sn("app"), FW, "routes", { rel: "SEC-04", evidence: "ipMatch" });
  // a VPN gateway with two connections to one local network gateway
  add(GW, "vnetGateway", "gw", { metadata: { s2s: [
    { name: "cn-a", status: "Connected", lng: { id: "/x/lng-hq", name: "lng-hq", prefixes: ["192.0.2.0/24"], peerIp: "198.51.100.1" } },
    { name: "cn-b", status: "NotConnected", lng: { id: "/x/lng-hq", name: "lng-hq", prefixes: ["192.0.2.0/24"], peerIp: "198.51.100.1" } },
  ] } });
  e(sn("pe"), GW, "connects");
  return g;
}

test("outbound: a NAT sits in the right lane and leads to the right Internet only for subnets whose first exit it is", () => {
  const mod = m.buildArchModel(egressGraph());
  const reg = mod.regions[0]!;
  assert.deepEqual(reg.egress, [NAT.toLowerCase()]);
  assert.ok(mod.edges.some((x) => x.kind === "outbound" && x.source === sn("web").toLowerCase()), "web → NAT (its exit)");
  assert.ok(!mod.edges.some((x) => x.kind === "outbound" && x.source === sn("app").toLowerCase()), "app: the UDR wins — no NAT line");
  assert.ok(mod.edges.some((x) => x.kind === "udr" && x.source === sn("app").toLowerCase() && x.target === FW.toLowerCase()), "app → firewall (SEC-04)");
  assert.ok(mod.edges.some((x) => x.kind === "egress" && x.target === m.internetOutId("koreacentral")));
  const L = lay({}, mod);
  const at2 = (id: string) => L.shapes.find((s) => s.id === id)!;
  assert.ok(at2(m.INTERNET_OUT_TILE).x > at2("subscription").x + at2("subscription").w - 1, "outbound Internet right of the subscription");
  assert.ok(at2(NAT.toLowerCase()).x > at2(`lane:paas:koreacentral`).x, "the NAT lane is the region's last column");
  // a NAT no subnet leaves through: no line to the Internet
  const g2 = egressGraph();
  g2.nodes.find((x) => x.id === sn("web"))!.metadata = { egress: { via: "default", evidence: "cfg" } };
  assert.ok(!m.buildArchModel(g2).edges.some((x) => x.kind === "egress"));
});

test("Front Door entry (EDGE-12): a line only with an enabled route; unread configuration → an 'unknown' line; none otherwise", () => {
  const ing = (meta: Record<string, unknown>) => {
    const g = graph();
    g.nodes.find((x) => x.id === AFD)!.metadata = meta;
    return m.buildArchModel(g).edges.filter((x) => x.kind === "ingress" && x.target === AFD.toLowerCase());
  };
  assert.equal(ing({ endpoints: 1, activeRoutes: 1 }).length, 1);
  assert.equal(ing({ endpoints: 1, activeRoutes: 0 }).length, 0);
  assert.equal(ing({ configUnreadable: true })[0]?.state, "unknown");
  assert.equal(ing({ classic: true }).length, 0);
  assert.equal(ing({ endpoints: 1, activeRoutes: 1 })[0]?.source, m.internetId("global"));
});

test("on-premises sites (EDGE-09): one per local network gateway, outside Azure under the Internet, with the worst connection status", () => {
  const mod = m.buildArchModel(egressGraph());
  assert.equal(mod.sites.size, 1);
  const site = [...mod.sites.values()][0]!;
  assert.equal(site.connections.length, 2);
  const line = mod.edges.find((x) => x.kind === "hybrid")!;
  assert.deepEqual([line.source, line.target, line.state], [GW.toLowerCase(), site.id, "NotConnected"]);
  const L = lay({}, mod);
  const tile = L.shapes.find((s) => s.id === site.id)!;
  assert.equal(tile.parent, "onprem");
  assert.equal(L.shapes.find((s) => s.id === "onprem")!.parent, "external");
  assert.ok(L.edges.some((x) => x.kind === "hybrid" && x.target === site.id && x.state === "NotConnected"));
  assert.ok(!L.shapes.some((s) => s.id.startsWith("ghost:site:")), "a site is never an 'other region' ghost");
});

test("peering: the line carries the worse side's state", () => {
  const g = graph();
  const V2 = rid("microsoft.network/virtualnetworks", "vnet2");
  g.nodes.push({ id: V2, kind: "vnet", name: "vnet2", location: "koreacentral", azureId: V2, resourceGroup: "rg", endpoint: "10.9.0.0/16" });
  g.edges.push({ id: "p1", source: VNET, target: V2, kind: "peering", metadata: { peeringState: "Initiated" } });
  const e = m.buildArchModel(g).edges.find((x) => x.kind === "peering")!;
  assert.equal(e.state, "Initiated");
});
