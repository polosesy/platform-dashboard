// A load balancer's data path is judged per frontend (2026-11-16, measured on an internal AKS LB: six rules =
// frontend IP × port; Azure's unsplit VipAvailability averaged them — five at 100 %, one at 0 % because the Service
// behind it had zero pods — to 83.3 %; the card turned "fault source" and listed the backend node pools, the cause side,
// as "affected"). Synthetic addresses from the documentation ranges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DiagramEdgeSpec, LiveNode } from "@aud/types";
import { dataPathFrontendIps, effectiveBindings, frontendDataPathBindings } from "../src/services/specGenerator.js";
import { resolveEvidence } from "../src/services/healthEvidence.js";
import { resolveNodeHealth } from "../src/services/healthCalculator.js";
import { buildFaultImpacts } from "../src/services/liveAggregator.js";
import * as webNs from "../../web/src/lib/lbDataPath.ts";

const W = ((webNs as unknown as { default?: typeof webNs }).default ?? webNs) as typeof webNs;

// The measured shape: four rule-bound private frontends (one carries three ports), one frontend without a rule
const FRONTENDS = JSON.stringify([
  { name: "a1", kind: "private", ip: "192.0.2.12", listeners: ["r1"], ruleBound: true },
  { name: "a2", kind: "private", ip: "192.0.2.10", listeners: ["r2"], ruleBound: true },
  { name: "a3", kind: "private", ip: "192.0.2.17", listeners: ["r3", "r4", "r5"], ruleBound: true },
  { name: "a4", kind: "private", ip: "192.0.2.11", listeners: ["r6"], ruleBound: true },
  { name: "a5", kind: "private", ip: "192.0.2.99", listeners: [], ruleBound: false },
]);
const lbNode = { resourceKind: "lb", icon: "lb", bindings: {}, azureResourceId: "/subscriptions/x/resourcegroups/rg/providers/microsoft.network/loadbalancers/lb", metadata: { frontends: FRONTENDS } } as const;
// Azure's numbers that hour: unsplit average 83.3, backend probe average 100, per frontend IP 100/100/100/0
const MEASURED = { dataPath: 83.33333333333333, backend: 100, dp0: 100, dp1: 100, dp2: 100, dp3: 0 };

test("bindings: each rule-bound frontend IP is read on its own; the API and the web agree on the order", () => {
  assert.deepEqual(dataPathFrontendIps(FRONTENDS), ["192.0.2.12", "192.0.2.10", "192.0.2.17", "192.0.2.11"], "frontends without a rule have no data path");
  for (const input of [FRONTENDS, "[]", "not json", undefined, JSON.stringify([{ ip: "x", ruleBound: true }, { ip: "203.0.113.5", ruleBound: true, kind: "public" }])]) {
    assert.deepEqual(W.dataPathFrontendIps(input), dataPathFrontendIps(input), String(input));
  }
  const b = frontendDataPathBindings(FRONTENDS);
  assert.deepEqual(Object.keys(b), ["dp0", "dp1", "dp2", "dp3"]);
  assert.deepEqual([b.dp3!.source, b.dp3!.metric, b.dp3!.filter], ["monitor", "VipAvailability", "FrontendIPAddress eq '192.0.2.11'"]);
});

test("judgement: the average's rule is gone — 5 × 100 % + 1 × 0 % is one frontend down (warning), not a fault source", () => {
  const eff = effectiveBindings(lbNode);
  assert.ok(eff.dp3, "per-frontend binding");
  const rules = eff.health?.source === "composite" ? eff.health.rules ?? [] : [];
  assert.ok(!rules.some((r) => r.metric === "dataPath"), "the unsplit average is not judged");
  assert.ok(rules.some((r) => r.metric === "backend"));
  const judged = resolveNodeHealth(MEASURED, eff);
  assert.equal(judged.health, "ok", "backend probes 100 %: no rule fails on its own");
  const ev = resolveEvidence({ kind: "lb", health: judged.health, judged: true, metrics: MEASURED });
  assert.deepEqual([ev.health, ev.reasons], ["warning", ["ld.ev.lbFrontendPartial"]]);
  // every frontend down = the LB carries nothing
  const all = resolveEvidence({ kind: "lb", health: "ok", judged: true, metrics: { ...MEASURED, dp0: 0, dp1: 50, dp2: 0 } });
  assert.deepEqual([all.health, all.reasons], ["critical", ["ld.ev.lbDataPathDown"]]);
  // all fine = ok; not measured = no verdict from it
  assert.equal(resolveEvidence({ kind: "lb", health: "ok", judged: true, metrics: { dp0: 100, dp1: 100 } }).health, "ok");
  assert.deepEqual(resolveEvidence({ kind: "lb", health: "ok", judged: true, metrics: { dp0: null, dp1: null } }).reasons, []);
  // an LB without frontend facts (older spec, sample) keeps the average's rule
  const old = effectiveBindings({ ...lbNode, metadata: {} });
  assert.ok((old.health?.source === "composite" ? old.health.rules ?? [] : []).some((r) => r.metric === "dataPath"));
});

const live = (id: string, health: LiveNode["health"] = "ok"): LiveNode => ({ id, health, healthScore: 1, metrics: {}, activeAlertIds: [] });
const edge = (id: string, source: string, target: string, edgeKind: string): DiagramEdgeSpec => ({ id, source, target, bindings: {}, edgeKind } as DiagramEdgeSpec);

test("fault impact: a failing entry hurts its callers, not its backends; a failing backend still hurts the entry", () => {
  const edges = [edge("r1", "lb", "pool1", "routes"), edge("r2", "lb", "pool2", "routes"), edge("c1", "agw", "lb", "routes")];
  const [lbDown] = buildFaultImpacts([live("lb", "critical"), live("pool1"), live("pool2"), live("agw")], edges);
  assert.deepEqual(lbDown!.affectedNodeIds, ["agw"], "the backends are the cause side, not affected");
  const [poolDown] = buildFaultImpacts([live("lb"), live("pool1", "critical"), live("pool2"), live("agw")], edges);
  assert.deepEqual(poolDown!.affectedNodeIds, ["lb"]);
  // a warning (one frontend down) starts no spread at all
  assert.equal(buildFaultImpacts([live("lb", "warning"), live("pool1")], edges).length, 0);
});

test("web: each frontend's level, the panel keys, and the strings", () => {
  const dp = W.lbDataPath(FRONTENDS, { ...MEASURED, dp1: 95, dp2: null })!;
  assert.deepEqual(dp.frontends.map((f) => [f.ip, f.level]), [["192.0.2.12", "ok"], ["192.0.2.10", "low"], ["192.0.2.17", "unmeasured"], ["192.0.2.11", "down"]]);
  assert.deepEqual([dp.measured, dp.down, dp.low], [3, 1, 2]);
  assert.equal(W.lbDataPath("[]", MEASURED), null);
  assert.ok(W.isDataPathFrontendKey("dp3") && !W.isDataPathFrontendKey("dataPath"));

  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const panel = read("../../web/src/app/live-diagram/components/ResourceDetailPanel.tsx");
  assert.match(panel, /!isDataPathFrontendKey\(k\)/, "dp<i> are not listed as raw metrics");
  assert.match(panel, /<LbDataPathSection node=\{node\} metrics=\{metrics\} \/>/);
  const all = read("../../web/src/lib/i18nOps.ts");
  for (const k of ["ld.ev.lbDataPathDown", "ld.ev.lbFrontendPartial", "ld.lbdp.title", "ld.lbdp.level.ok", "ld.lbdp.level.low", "ld.lbdp.level.down", "ld.lbdp.level.unmeasured", "ld.lbdp.avgNote", "ld.lbdp.downHint", "ld.lbdp.reason"]) {
    assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  }
});
