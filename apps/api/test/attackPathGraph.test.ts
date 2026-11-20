// Azure 공격 경로 그림 (2026-11-20 — Wiz Attack Path Visualization): web lib/attackPathGraph.ts lays one path out
// 인터넷 → 진입점 → 관리 ID → 역할 → 데이터. Only what the path holds is drawn: roles joined to their holders, a store
// reached twice is one node, more stores than named = a "+n" node, the stop said, findings folded into the entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AzureAttackPath } from "@aud/types";
import * as gNs from "../../web/src/lib/attackPathGraph.ts";

const G = ((gNs as unknown as { default?: typeof gNs }).default ?? gNs) as typeof gNs;
const base = (over: Partial<AzureAttackPath> = {}): AzureAttackPath => ({
  key: "path:rg/microsoft.compute/virtualmachines/web",
  entry: { name: "web", type: "microsoft.compute/virtualmachines", resourceGroup: "rg", resourceId: "/subscriptions/x/resourcegroups/rg/providers/microsoft.compute/virtualmachines/web" },
  vuln: null, roles: [], ends: "entry", sev: "medium", identity: { principals: 0, otherRoles: 0 }, ...over,
});
const at = (g: gNs.PathGraph, id: string) => g.nodes.find((n) => n.id === id)!;
const edge = (g: gNs.PathGraph, from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);

test("columns: internet → entry → identity → role → data, left to right", () => {
  const g = G.pathGraph(base({
    ends: "data", sev: "high",
    identity: { principals: 1, otherRoles: 0, list: [{ kind: "system", name: "web" }] },
    roles: [{ kind: "data", role: "storage", write: false, scope: "resourceGroup", scopeName: "rg", reaches: [{ kind: "storage", count: 1, names: ["st-1"] }], holders: ["web"] }],
  }));
  assert.deepEqual(g.nodes.map((n) => [n.id, n.col]), [["internet", 0], ["entry", 1], ["id:0", 2], ["role:0", 3], ["data:0", 4]]);
  assert.ok(g.nodes.every((n, i, a) => i === 0 || n.x > a[i - 1]!.x));
  assert.ok(edge(g, "internet", "entry") && edge(g, "entry", "id:0") && edge(g, "id:0", "role:0") && edge(g, "role:0", "data:0"));
  assert.equal(at(g, "role:0").tone, "warn"); // a read role
  assert.equal(g.width, 70 * 2 + 4 * G.COL_W);
});

test("roles join their holders only; a store reached twice is one node; more than named = '+n', never invented", () => {
  const g = G.pathGraph(base({
    ends: "data", sev: "critical", vuln: { count: 4, names: ["a", "b", "c"] },
    identity: { principals: 2, otherRoles: 0, list: [{ kind: "system", name: "web" }, { kind: "user", name: "id-app" }] },
    roles: [
      { kind: "privileged", role: "owner", scope: "resourceGroup", scopeName: "rg", reaches: [{ kind: "storage", count: 3, names: ["st-1", "st-2"] }], holders: ["id-app"] },
      { kind: "data", role: "storage", write: true, scope: "resource", scopeName: "st-1", reaches: [{ kind: "storage", count: 1, names: ["st-1"] }], holders: ["web"] },
    ],
  }));
  // the role held by the first identity is drawn first (no crossing)
  assert.deepEqual(g.nodes.filter((n) => n.col === 3).map((n) => n.id), ["role:1", "role:0"]);
  assert.ok(edge(g, "id:0", "role:1") && edge(g, "id:1", "role:0"));
  assert.ok(!edge(g, "id:0", "role:0") && !edge(g, "id:1", "role:1"));
  const data = g.nodes.filter((n) => n.kind === "data");
  assert.deepEqual(data.map((n) => n.label).sort(), ["st-1", "st-2"]); // st-1 once
  assert.equal(g.edges.filter((e) => e.to === data.find((n) => n.label === "st-1")!.id).length, 2);
  const more = g.nodes.find((n) => n.kind === "more")!;
  assert.deepEqual([more.vars, more.labelKey], [{ n: 1 }, "apg.more"]);
  assert.equal(at(g, "role:0").tone, "danger"); // privileged
  assert.equal(at(g, "entry").badge, 4);
  assert.equal(g.findings, null); // folded
  const open = G.pathGraph(base({ vuln: { count: 4, names: ["a", "b", "c"] }, ends: "entry" }), { expandFindings: true });
  assert.deepEqual([open.findings!.items, open.findings!.more], [["a", "b", "c"], 1]);
  assert.ok(at(open, "entry").y > at(G.pathGraph(base({ vuln: { count: 4, names: ["a", "b", "c"] } })), "entry").y, "the box pushes the graph down, never over it");
});

test("identities without names: one node for all; where the chain stops is a node with the reason", () => {
  const g = G.pathGraph(base({ identity: { principals: 3, otherRoles: 2 }, vuln: { count: 1, names: ["x"] } }));
  assert.deepEqual(at(g, "id:all").vars, { n: 3 });
  assert.deepEqual([at(g, "stop").col, at(g, "stop").subKey, at(g, "stop").subVars], [3, "apg.stopRoles", { o: 2 }]);
  assert.ok(edge(g, "id:all", "stop"));
  const none = G.pathGraph(base({ vuln: { count: 1, names: ["x"] } }));
  assert.deepEqual([at(none, "stop").col, at(none, "stop").subKey], [2, "apg.stopNoIdentity"]);
  assert.ok(edge(none, "entry", "stop"));
  const unknown = G.pathGraph(base({ identityUnknown: true, identity: { principals: 1, otherRoles: 0 } }), { rolesAboveHidden: true });
  assert.equal(at(unknown, "stop").subKey, "apg.stopAboveHidden");
  const limited = G.pathGraph(base({ entry: { ...base().entry, limited: true } }));
  assert.equal(limited.edges.find((e) => e.kind === "exposure")!.limited, true);
});

test("edges: a curve from one circle's right edge to the next one's left edge", () => {
  assert.equal(G.edgePath({ x: 0, y: 10 }, { x: 180, y: 50 }), `M${G.R},10 C90,10 90,50 ${180 - G.R},50`);
  assert.equal(G.shortType("microsoft.compute/virtualmachines"), "virtualmachines");
});
