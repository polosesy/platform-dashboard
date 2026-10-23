import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HeatCell, HeatLevel, HeatMetric, HeatWorkload } from "@aud/types";
import * as hv from "../../web/src/lib/workloadHeatView.ts";

const v = ((hv as { default?: typeof hv }).default ?? hv) as typeof hv;
const t = (k: string, p?: Record<string, string | number>) => (p ? `${k}:${JSON.stringify(p)}` : k);

const METRICS: HeatMetric[] = ["ready", "memory", "cpu", "restarts", "oldGen", "http5xx", "logErrors", "poolUsage", "poolPending"];
function wl(namespace: string, workload: string, cells: Partial<Record<HeatMetric, Partial<HeatCell>>> = {}, worst?: HeatLevel): HeatWorkload {
  const full = Object.fromEntries(METRICS.map((m) => [m, { value: null, level: "notMeasured" as HeatLevel, ...(m === "ready" ? { level: "ok" as HeatLevel } : {}), ...cells[m] }])) as HeatWorkload["cells"];
  const lv = worst ?? (["danger", "warn", "ok"] as HeatLevel[]).find((x) => METRICS.some((m) => full[m].level === x)) ?? "ok";
  return { namespace, workload, kind: "Deployment", basis: "owner", replicas: { ready: 1, desired: 1 }, worst: lv, cells: full, pods: [] };
}

const WS = [
  wl("argocd", "argocd-repo-server"),
  wl("argocd", "argocd-server", { restarts: { value: 4, level: "warn" } }),
  wl("integration", "signal-service", { memory: { value: 0.93, level: "danger" }, restarts: { value: 2, level: "warn" } }),
  wl("integration", "console-service", { logErrors: { value: 14, level: "warn" } }),
  wl("monitor", "loki", { http5xx: { value: null, level: "noTraffic" } }),
];

test("not measured / not instrumented / no traffic are never problems", () => {
  for (const lv of ["notMeasured", "notInstrumented", "noTraffic", "stopped", "ok"] as HeatLevel[]) assert.equal(v.isProblem(lv), false);
  assert.deepEqual(v.problemSignals(WS[4]!), []);
  assert.deepEqual(v.problemSignals(WS[2]!), ["memory", "restarts"], "danger first");
});

test("namespace cards: worst first, tiles worst first; problems only drops healthy tiles and empty cards", () => {
  const g = v.groupByNamespace(WS, "worst");
  assert.deepEqual(g.map((x) => x.namespace), ["integration", "argocd", "monitor"]);
  assert.deepEqual(g[0]!.workloads.map((w) => w.workload), ["signal-service", "console-service"]);
  assert.deepEqual(g[1]!.workloads.map((w) => w.workload), ["argocd-server", "argocd-repo-server"]);
  assert.equal(g[0]!.counts.danger, 1);
  const p = v.groupByNamespace(WS, "worst", { problemsOnly: true });
  assert.deepEqual(p.map((x) => [x.namespace, x.workloads.length]), [["integration", 2], ["argocd", 1]]);
  // by one signal: only that signal colours
  assert.deepEqual(v.groupByNamespace(WS, "logErrors", { problemsOnly: true }).map((x) => x.workloads[0]!.workload), ["console-service"]);
});

test("needs attention: danger first, then more signals; reason words come from the cells", () => {
  const rows = v.attentionRows(WS, "worst");
  assert.deepEqual(rows.map((r) => r.w.workload), ["signal-service", "argocd-server", "console-service"]);
  assert.deepEqual(rows[0]!.signals, ["memory", "restarts"]);
  assert.equal(v.formatCell("memory", WS[2]!, t), "93%");
  assert.equal(v.formatCell("http5xx", WS[4]!, t), "ob.hm.level.noTraffic", "null → the level word, never 0");
});

test("signal strip: null → not measured, 0 → clear, restart warn only → warn tone", () => {
  const s = v.signalSummary([
    { metric: "memory", count: 1 }, { metric: "restarts", count: 2 }, { metric: "cpu", count: 0 }, { metric: "oldGen", count: null },
  ], WS);
  assert.deepEqual(s.active.map((a) => [a.metric, a.tone]), [["memory", "danger"], ["restarts", "warn"]]);
  assert.deepEqual(s.clear, ["cpu"]);
  assert.deepEqual(s.notMeasured, ["oldGen"]);
});

test("tile text and names", () => {
  assert.deepEqual(v.tileText(WS[0]!, "worst", t), { glyph: "", text: "1/1", more: 0 });
  assert.deepEqual(v.tileText(WS[2]!, "worst", t), { glyph: "✕", text: "ob.hm.short.memory 93%", more: 1 });
  assert.equal(v.shortName("argocd-repo-server", "argocd"), "repo-server");
  assert.equal(v.shortName("argocd", "argocd"), "argocd");
  assert.equal(v.shortName("loki", "monitor"), "loki");
  assert.deepEqual(v.legendLevels(v.groupByNamespace(WS, "worst")), ["danger", "warn", "ok"]);
  assert.equal(v.formatThreshold("ready", 1), null);
  assert.equal(v.formatThreshold("http5xx", 0.01), "1.0%");
});

test("dynamic heatmap i18n keys exist in both languages", () => {
  const src = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const keys = [...METRICS.map((m) => `ob.hm.short.${m}`), ...v.SIGNAL_GROUPS.map((g) => `ob.hm.group.${g.id}`), ...METRICS.map((m) => `ob.hm.flag.${m}`)];
  for (const k of keys) assert.match(src, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});
