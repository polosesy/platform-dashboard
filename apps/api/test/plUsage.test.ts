import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramNodeSpec, PrivateLinkUsageResponse } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as pluNs from "../../web/src/lib/plUsage.ts";
import * as scopeNs from "../../web/src/lib/liveScope.ts";
import * as styleNs from "../../web/src/lib/liveStyle.ts";

const P = ((pluNs as unknown as { default?: typeof pluNs }).default ?? pluNs) as typeof pluNs;
const S = ((scopeNs as unknown as { default?: typeof scopeNs }).default ?? scopeNs) as typeof scopeNs;
const St = ((styleNs as unknown as { default?: typeof styleNs }).default ?? styleNs) as typeof styleNs;

const n = (id: string, kind: string): DiagramNodeSpec => ({ id, label: id, icon: kind as DiagramNodeSpec["icon"], resourceKind: kind, bindings: {} });
const byId = new Map([n("vm", "vm"), n("pe-kv", "privateEndpoint"), n("kv", "keyVault"), n("pe-r", "privateEndpoint"), n("redis", "redis")].map((x) => [x.id, x]));
const resp: PrivateLinkUsageResponse = {
  generatedAt: "", windowHours: 24, dataSource: "azure",
  endpoints: [
    { peNodeId: "pe-kv", targetNodeId: "kv", connectionState: "Approved", activity: "used" },
    { peNodeId: "pe-r", targetNodeId: "redis", connectionState: "Disconnected", activity: "unknown" },
  ],
  usages: [{ id: "plu:vm>pe-kv", callerNodeId: "vm", peNodeId: "pe-kv", targetNodeId: "kv", attribution: "nic", grade: "access", evidence: [{ source: "kvAudit", grade: "access", requests: 3 }] }],
  unresolved: [{ targetNodeId: "redis", reason: "nicNoVm", nicName: "x" }],
  publicAccess: [{ targetNodeId: "kv", requests: 2, distinctIps: 1 }],
  sources: [{ source: "kvAudit", targetNodeId: "kv", state: "ok" }],
};

test("observed use becomes a workload → PE line, only when both ends are drawn", () => {
  const lines = P.usageEdges(resp, byId, new Set(["vm", "pe-kv", "kv"]));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0]!.source, lines[0]!.target, lines[0]!.edgeKind, lines[0]!.evidence, lines[0]!.label, lines[0]!.protocol], ["vm", "pe-kv", "privateLinkUsage", "observed", "Key Vault", "access"]);
  assert.equal(P.usageEdges(resp, byId, new Set(["pe-kv"])).length, 0, "caller not drawn → no line");
  assert.equal(P.usageEdges(null, byId, new Set(["vm", "pe-kv"])).length, 0);
  // its own layer, on by default, directed, labelled, never comets
  assert.equal(S.edgeLayer(lines[0]!, byId), "privateLinkUsage");
  assert.ok(S.DEFAULT_EDGE_LAYERS.has("privateLinkUsage"));
  assert.ok(S.isDirectedEdge(lines[0]!));
  assert.deepEqual(St.relationLabel(lines[0]!, byId), { key: "ld.rel.privateLinkUsage.access", vars: { target: "Key Vault" } });
  assert.equal(St.particleTone("privateLinkUsage", "normal", true), null);
  assert.ok(!St.LIVE_EDGE_LOOK.privateLinkUsage.dash, "observed → solid");
});

test("chips: used / unknown on PEs, users and public access on the PaaS; disconnected PEs", () => {
  const c = P.usageChips(resp);
  assert.deepEqual(c.get("pe-kv"), [{ key: "ld.plu.chip.used", vars: { count: 1 } }]);
  assert.deepEqual(c.get("pe-r")!.map((x) => x.key), ["ld.plu.chip.unknown", "ld.plu.chip.unresolved"]);
  assert.deepEqual(c.get("kv")!.map((x) => x.key), ["ld.plu.chip.users", "ld.plu.chip.public"]);
  assert.ok(!c.has("redis"), "no users, no public access → no chip");
  assert.deepEqual([...P.disconnectedPes(resp)], ["pe-r"]);
  assert.ok(P.anySourceOn(resp));
  assert.ok(!P.anySourceOn({ ...resp, sources: [{ source: "vnetFlow", state: "disabled", reason: "noFlowLog" }] }));
});

test("unidentified callers fold into groups: distinct IPs, deterministic order, chip count = panel count", () => {
  const P = ((pluNs as unknown as { default?: typeof pluNs }).default ?? pluNs) as typeof pluNs;
  const rows = [
    { targetNodeId: "kv", ip: "10.0.9.11", reason: "ambiguous" as const, basis: "subnet" as const, candidates: ["b", "a"], requests: 3 },
    { targetNodeId: "kv", ip: "10.0.9.10", reason: "ambiguous" as const, basis: "subnet" as const, candidates: ["a", "b"], requests: 9 },
    { targetNodeId: "kv", ip: "10.0.9.10", reason: "ambiguous" as const, basis: "subnet" as const, candidates: ["a", "b"], requests: 1 },
    { targetNodeId: "kv", ip: "10.150.0.5", reason: "notInDiagram" as const, place: { kind: "otherVnet" as const, vnetNodeId: "hub", subnetNodeId: "fw" } },
    { targetNodeId: "kv", reason: "noIp" as const, requests: 4 },
  ];
  const g = P.groupUnresolved(rows);
  assert.deepEqual(g.map((x) => [x.reason, x.ips, x.requests]), [["ambiguous", 2, 13], ["noIp", 1, 4], ["notInDiagram", 1, 0]]);
  assert.deepEqual(g[0]!.sample, ["10.0.9.10", "10.0.9.11"], "most requests first");
  assert.deepEqual(P.groupUnresolved([...rows].reverse()).map((x) => x.key), g.map((x) => x.key), "order of rows does not matter");
  assert.equal(P.unresolvedCount(rows), 4);
});
