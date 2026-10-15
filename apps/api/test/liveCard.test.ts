import { test } from "node:test";
import assert from "node:assert/strict";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as namesNs from "../../web/src/lib/liveNames.ts";
import * as metricNs from "../../web/src/lib/liveMetricFormat.ts";
import * as statusNs from "../../web/src/lib/liveStatus.ts";
import * as styleNs from "../../web/src/lib/liveStyle.ts";

const N = ((namesNs as unknown as { default?: typeof namesNs }).default ?? namesNs) as typeof namesNs;
const M = ((metricNs as unknown as { default?: typeof metricNs }).default ?? metricNs) as typeof metricNs;
const S = ((statusNs as unknown as { default?: typeof statusNs }).default ?? statusNs) as typeof statusNs;
const ST = ((styleNs as unknown as { default?: typeof styleNs }).default ?? styleNs) as typeof styleNs;

// ── short names (B-10): the VNet's own words are dropped, collisions keep the type prefix ──

test("short names inside a VNet", () => {
  const V = "vnet-demo-poc-eus-001";
  const cards = [
    { id: "a", label: "vm-demo-ngf-a-poc-eus-001", kind: "vm" },
    { id: "b", label: "lb-ips-demo-poc-eus-001", kind: "lb" },
    { id: "c", label: "lbi-ips-demo-poc-eus-001", kind: "lb" },
    { id: "d", label: "vmss-demo-web-demo-poc-eus-001", kind: "vmss" },
    { id: "e", label: "vmss-demo-web-demo-poc-eus-00_9cd5ec7e", kind: "vm" },
  ];
  const m = N.shortNames(cards, () => V);
  assert.equal(m.get("a"), "ngf-a");
  assert.equal(m.get("b"), "lb-ips");
  assert.equal(m.get("c"), "lbi-ips");
  assert.equal(m.get("d"), "web");
  assert.equal(m.get("e"), "web-9cd5ec7e");
  assert.equal(N.shortNames([{ id: "q", label: "krc-app-qa-web-linux-vm06", kind: "vm" }], () => "acme-app-qa-krc-01-vnet").get("q"), "web-linux-vm06");
  // no duplicates in a view
  const values = [...m.values()];
  assert.equal(new Set(values).size, values.length);
  // nothing left → the full name
  assert.equal(N.shortNames([{ id: "z", label: "demo-poc", kind: "vm" }], () => V).get("z"), "demo-poc");
});

test("middle ellipsis keeps the distinguishing end", () => {
  assert.equal(N.middleEllipsis("vmss-was-6bf5355b", 10), "vmss-…355b");
  assert.equal(N.middleEllipsis("short", 10), "short");
});

// ── metric values (B-7, B-8, B-9) ──

test("every number carries its unit", () => {
  assert.deepEqual(M.formatMetric("cpu", 16.43), { value: "16.4", unit: "%" });
  assert.deepEqual(M.formatMetric("availability", 99.96), { value: "100", unit: "%" });
  assert.deepEqual(M.formatMetric("availability", 99.6), { value: "99.6", unit: "%" });
  assert.deepEqual(M.formatMetric("network", 43_008), { value: "42", unit: "KB", unitKey: "ld.unit.perMin" });
  assert.deepEqual(M.formatMetric("rps", 1234), { value: "1.2K", unit: "", unitKey: "ld.unit.perMin" });
  assert.deepEqual(M.formatMetric("latency", 41.6), { value: "42", unit: "ms" });
  for (const k of Object.keys(M.METRIC_META)) {
    const f = M.formatMetric(k, 5);
    // counts (queued messages, replicas, hosts) are plain numbers; everything else carries a unit
    assert.ok(f.unit || f.unitKey || M.METRIC_META[k]!.unit === "count", `${k} has a unit`);
  }
  assert.deepEqual(M.formatMetric("throughput", 7943), { value: "7.9", unit: "Kbps" });
  assert.deepEqual(M.formatMetric("backlog", 12), { value: "12", unit: "" });
});

test("a bound metric without a value is a 미측정 cell, not a number", () => {
  const cells = M.metricCells(["cpu", "network"], { cpu: null, network: null });
  assert.deepEqual(cells.map((c) => c.state), ["unmeasured", "unmeasured"]);
  const trendFirst = M.metricCells(["cpu", "network"], { cpu: 3, network: 1024 }, "network");
  assert.deepEqual(trendFirst.map((c) => c.key), ["network", "cpu"]);
});

test("trend scale starts at 0 so a flat series stays flat", () => {
  assert.deepEqual(M.sparkDomain("cpu", [9.3, 9.5, 9.4]), [0, 20]);
  assert.deepEqual(M.sparkDomain("cpu", [2, 8]), [0, 10]);
  assert.deepEqual(M.sparkDomain("network", [0, 0]), [0, 1]);
  // amplitude on a 28 px trend: 9.3 → 9.5 of 0–20 is under 1 px; 2 → 8 of 0–10 is at least 16 px
  assert.ok(((9.5 - 9.3) / 20) * 28 < 1);
  assert.ok(((8 - 2) / 10) * 28 >= 16);
});

// ── status (B-5, C-5) ──

test("status: nothing assumed, red only for a fault, running alone is not healthy", () => {
  assert.equal(S.cardStatus("unknown").key, "ld.status.unknown");
  assert.equal(S.cardStatus("unknown", "running").key, "ld.power.running");
  assert.equal(S.cardStatus("unknown", "running").tone, "neutral");
  assert.equal(S.cardStatus("ok", "running").tone, "success");
  assert.equal(S.cardStatus("ok", "stopped").key, "ld.power.stopped");
  assert.equal(S.cardStatus("critical").tone, "high");
  assert.equal(S.cardStatus("ok", "running", "source").key, "ld.status.faultSource");
  assert.equal(S.cardStatus("ok", "running", "affected").tone, "medium");
  // only the fault rows are red
  for (const [h, p] of [["unknown", undefined], ["ok", "running"], ["warning", undefined], ["unknown", "deallocated"]] as const) {
    assert.notEqual(S.cardStatus(h, p).tone, "high");
  }
});

// ── full-name tag: the short name's words inside the full name ──

test("name parts mark the words the short name keeps", () => {
  const V = "vnet-demo-poc-eus-001";
  const m = N.shortNamesWithParts([
    { id: "a", label: "vm-ngf-a-demo-poc-eus-001", kind: "vm" },
    { id: "v", label: "vmss-demo-web-demo-poc-eus-00_9cd5ec7e", kind: "vm" },
    { id: "x", label: "lb-web-demo-poc-eus-001", kind: "lb" },
    { id: "y", label: "lbi-web-demo-poc-eus-001", kind: "lb" },
  ], () => V);
  const kept = (id: string) => m.get(id)!.parts.filter((p) => p.kept).map((p) => p.text).join("");
  assert.equal(kept("a"), "ngf-a", "CAF prefix and VNet words dropped, the separator between kept words kept");
  assert.equal(m.get("a")!.parts.map((p) => p.text).join(""), "vm-ngf-a-demo-poc-eus-001", "parts rebuild the full name");
  assert.ok(!m.get("v")!.parts.some((p) => p.text === "00" && p.kept), "a truncated VNet word is dropped");
  for (const id of ["a", "v", "x", "y"]) assert.equal(N.partsText(m.get(id)!.parts), m.get(id)!.text, "parts give the same short name");
  assert.deepEqual([...N.shortNames([{ id: "a", label: "vm-ngf-a-demo-poc-eus-001", kind: "vm" }], () => V)], [["a", "ngf-a"]]);
});

test("a name that falls back to the full name keeps every part", () => {
  const m = N.shortNamesWithParts([{ id: "a", label: "demo-poc", kind: "vm" }], () => "vnet-demo-poc");
  assert.equal(m.get("a")!.text, "demo-poc");
  assert.ok(m.get("a")!.parts.every((p) => p.kept));
});

// ── usage pair (CPU + memory) ──

test("compute cards pair CPU (or DTU) with memory, thresholds from the health rules", () => {
  assert.equal(M.pairPrimary(["cpu", "memory", "network"]), "cpu");
  assert.equal(M.pairPrimary(["dtu", "memory", "connections"]), "dtu");
  assert.equal(M.pairPrimary(["cpu", "network"]), undefined, "no memory → today's layout");
  assert.deepEqual(M.cardMetricOrder(["network", "memory", "cpu"], "network"), ["cpu", "memory", "network"]);
  assert.deepEqual(M.cardMetricOrder(["rps", "latency"], "latency"), ["latency", "rps"]);
  assert.equal(M.usageTone("cpu", 80, 80), "warn");
  assert.equal(M.usageTone("cpu", 79.9, 80), "ok");
  assert.equal(M.usageTone("memory", 90), "warn", "85 without a rule");
  assert.equal(M.usageTone("memory", null), undefined, "no value → no colour");
  assert.equal(M.usageTone("network", 99), undefined, "not a usage metric");
  assert.deepEqual(M.usageThresholds({ health: { source: "composite", rules: [{ metric: "cpu", op: "<", threshold: 80, weight: 1 }, { metric: "network", op: ">", threshold: 0, weight: 1 }] } }), { cpu: 80 });
  assert.equal(M.compactPercent(7.44), "7.4");
  assert.equal(M.compactPercent(9.96), "10");
  assert.equal(M.compactPercent(62.6), "63");
  assert.equal(M.compactPercent(100.4), "100");
  assert.equal(M.compactPercent(0), "0");
});

// ── traffic comets ──

test("comets move at the same pace on long and short lines and fade before the arrowhead", () => {
  for (const level of ["low", "medium", "high", "burst"] as const) {
    const a = ST.particlePlan(level, 200, 1.5), b = ST.particlePlan(level, 600, 1.5);
    const va = 200 / a.dur, vb = 600 / b.dur;
    assert.ok(Math.abs(va - vb) / vb <= 0.05, `${level}: ${va} vs ${vb} px/s`);
    for (const len of [80, 200, 600]) {
      const p = ST.particlePlan(level, len, 2);
      assert.ok((1 - p.fadeOut) * len >= 16 - 1e-9 || p.fadeOut === 0.75, `${level}/${len}: clear of the 14 px arrowhead`);
      assert.ok(p.count >= 1 && p.count <= 6);
      assert.ok(p.r * 2 >= 2 * 2, "head at least twice the line width");
    }
  }
  assert.equal(ST.estimatePathLength("step", 100, -40, 16), 172);
  assert.ok(Math.abs(ST.estimatePathLength("bezier", 30, 40) - 57.5) < 1e-9);
  assert.deepEqual(ST.particlePlan("medium", 300, 1.5), ST.particlePlan("medium", 300, 1.5), "same inputs → same attributes (SMIL does not restart)");
});

test("comet colour: none on a down line, warning when degraded, by relationship otherwise", () => {
  assert.equal(ST.particleTone("config", "down", true), null);
  assert.equal(ST.particleTone("ingress", "degraded", true), "warning");
  assert.equal(ST.particleTone("config", "normal", true), "accent");
  assert.equal(ST.particleTone("privateLink", "normal", true), "privateLink");
  assert.equal(ST.particleTone("egressDeprecated", "normal", true), "egress");
  assert.equal(ST.particleTone("inferred", "normal", true), null);
  assert.match(ST.cometTailPath(3, 14), /^M -14 0 C .* Z$/);
});

// ── every card metric is one the API reads for the kind ──
import { NODE_BINDINGS as NB } from "../src/services/specGenerator.js";

test("CARD_CELLS and NODE_BINDINGS agree, and tones follow the leveled rules", () => {
  for (const [kind, cells] of Object.entries(M.CARD_CELLS)) {
    for (const k of cells) assert.ok(NB[kind]?.[k], `${kind}.${k} is bound by the API`);
    for (const k of cells) assert.ok(M.METRIC_META[k], `${k} has a label and unit`);
  }
  for (const kind of Object.keys(NB)) assert.ok(M.CARD_CELLS[kind], `${kind} has card cells`);
  for (const k of ["nsg", "nic", "logAnalytics", "vnetGateway", "bastion", "paas"]) assert.deepEqual(M.CARD_CELLS[k], [], `${k}: no metric row`);
  assert.deepEqual(M.CARD_CELLS.dns, ["queries"], "DNS zones: query volume over an hour (activity, not health)");
  assert.ok(M.isUsagePair(M.CARD_CELLS.redis!) && M.isUsagePair(M.CARD_CELLS.postgres!) && M.isUsagePair(M.CARD_CELLS.vm!));
  assert.ok(!M.isUsagePair(M.CARD_CELLS.appGateway!) && !M.isUsagePair(M.CARD_CELLS.lb!));
  assert.deepEqual(M.sparkDomain("dataPath", [99, 100]), [95, 100]);
  const lbRules = NB.lb!.health!.rules!;
  assert.equal(M.cellTone("backend", { backend: 0 }, lbRules), "crit");
  assert.equal(M.cellTone("backend", { backend: 95 }, lbRules), "warn");
  assert.equal(M.cellTone("dataPath", { dataPath: 100 }, lbRules), "ok");
  assert.equal(M.cellTone("dataPath", { dataPath: null }, lbRules), undefined);
  // guard: a 50 % availability out of 5 transactions is not judged
  assert.equal(M.cellTone("availability", { availability: 50, transactions: 5 }, NB.storage!.health!.rules!), undefined);
  assert.equal(M.cellTone("availability", { availability: 50, transactions: 50 }, NB.storage!.health!.rules!), "crit");
  assert.deepEqual(M.usageThresholds(NB.vm!), { cpu: 85, memory: 85 }, "the warning line, not the critical one");
  assert.deepEqual(M.cardCells("somethingNew", ["cpu", "memory", "network"]), ["cpu", "memory"]);
  assert.deepEqual(M.cardCells("appGateway", ["rps", "latency"], "rps"), ["rps", "latency"], "the sample diagram keeps its own keys");
  assert.deepEqual(M.cardCells("appGateway", ["requests", "backend", "latency"]), ["requests", "backend"]);
});
