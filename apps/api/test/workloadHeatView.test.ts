import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HeatCell, HeatLevel, HeatMetric, HeatWorkload } from "@aud/types";
import * as hv from "../../web/src/lib/workloadHeatView.ts";
import * as lvm from "../../web/src/lib/logView.ts";

const v = ((hv as { default?: typeof hv }).default ?? hv) as typeof hv;
const lg = ((lvm as { default?: typeof lvm }).default ?? lvm) as typeof lvm;
const t = (k: string, p?: Record<string, string | number>) => (p ? `${k}:${JSON.stringify(p)}` : k);

const METRICS: HeatMetric[] = ["ready", "memory", "cpu", "restarts", "oldGen", "jvmHeadroom", "http5xx", "logErrors", "poolUsage", "poolPending"];
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
  for (const lv of ["notMeasured", "notInstrumented", "noTraffic", "stopped", "noBaseline", "ok"] as HeatLevel[]) assert.equal(v.isProblem(lv), false);
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
  assert.deepEqual(v.tileText(WS[0]!, "worst", t), { glyph: "●", text: "1/1", more: 0 }, "the live card's ok glyph");
  assert.deepEqual(v.tileText(WS[2]!, "worst", t), { glyph: "■", text: "ob.hm.short.memory 93%", more: 1 });
  assert.equal(v.shortName("argocd-repo-server", "argocd"), "repo-server");
  assert.equal(v.shortName("argocd", "argocd"), "argocd");
  assert.equal(v.shortName("loki", "monitor"), "loki");
  assert.equal(v.sharedPrefix(["acme-gateway", "acme-console-web", "acme-workflow-sap-app"]), "acme-");
  assert.equal(v.sharedPrefix(["acme-workflow-a-app", "acme-workflow-b-app"]), "acme-workflow-", "longest shared word prefix");
  assert.equal(v.sharedPrefix(["acme-gateway", "loki"]), null);
  assert.equal(v.sharedPrefix(["acme-gw", "acme-ui"]), null, "would leave fewer than 3 characters");
  assert.equal(v.sharedPrefix(["only-one"]), null);
  assert.equal(v.shortName("acme-gateway", "integration", "acme-"), "gateway");
  const g = v.groupByNamespace([wl("integration", "acme-gateway"), wl("integration", "acme-console")], "worst");
  assert.equal(g[0]!.prefix, "acme-");
  assert.deepEqual(v.legendLevels(v.groupByNamespace(WS, "worst")), ["danger", "warn", "ok"]);
  assert.equal(v.formatThreshold("ready", 1), null);
  assert.equal(v.formatThreshold("http5xx", 0.01), "1.0%");
  assert.equal(v.formatThreshold("jvmHeadroom", 250 * 1024 * 1024), "250Mi");
  const tight = wl("app", "orders", { jvmHeadroom: { value: 205 * 1024 * 1024, level: "warn" } });
  const over = wl("app", "billing", { jvmHeadroom: { value: -40 * 1024 * 1024, level: "danger" } });
  assert.equal(v.formatCell("jvmHeadroom", tight, t), "205Mi");
  assert.equal(v.formatCell("jvmHeadroom", over, t), "-40Mi", "a heap larger than the limit");
  assert.deepEqual(v.attentionRows([tight, wl("app", "cart", { jvmHeadroom: { value: 100 * 1024 * 1024, level: "warn" } })], "jvmHeadroom").map((r) => r.w.workload),
    ["cart", "orders"], "lower headroom first");
});

test("dynamic heatmap i18n keys exist in both languages", () => {
  const src = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const keys = [...METRICS.map((m) => `ob.hm.short.${m}`), ...v.SIGNAL_GROUPS.map((g) => `ob.hm.group.${g.id}`), ...METRICS.map((m) => `ob.hm.flag.${m}`)];
  for (const k of keys) assert.match(src, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});

test("nothing to run and no baseline: the reason, never '0/0 0/0' or '? 미측정'; idle DaemonSets hide on request", () => {
  const idle = wl("kube-system", "agent-windows", {
    ready: { level: "stopped", code: "noNodes" }, memory: { level: "stopped", code: "noPods" }, cpu: { level: "stopped", code: "noPods" },
  }, "stopped");
  idle.kind = "DaemonSet";
  idle.replicas = { ready: 0, desired: 0 };
  const tt = v.tileText(idle, "worst", t);
  assert.deepEqual(tt, { glyph: "○", text: "ob.hm.code.noNodes", more: 0 }, "one glyph, one word — the old tile said 0/0 0/0");
  assert.equal(v.formatCell("memory", idle, t), "ob.hm.code.noPods");
  const cilium = wl("kube-system", "cilium", { memory: { level: "noBaseline", code: "noLimit", abs: 380497920 }, cpu: { level: "noBaseline", code: "noRequest", abs: 0.0433 } });
  assert.equal(v.formatCell("memory", cilium, t), "363Mi");
  assert.equal(v.formatCell("cpu", cilium, t), "43m");
  assert.equal(v.formatBytes(1.5 * 1024 ** 3), "1.5Gi");
  assert.equal(v.formatCores(1.25), "1.25");
  assert.equal(v.formatCores(0.0001), "1m", "a measured trickle is not 0");
  const all = [...WS, idle, cilium];
  assert.ok(v.groupByNamespace(all, "worst").some((g) => g.workloads.includes(idle)));
  assert.ok(!v.groupByNamespace(all, "worst", { hideIdle: true }).some((g) => g.workloads.includes(idle)));
  assert.deepEqual(v.legendLevels(v.groupByNamespace(all, "worst")), ["danger", "warn", "ok", "stopped"]);
});

test("mosaic: cards sized to their tiles (no empty half cards), never wider than the grid; heights match the CSS", () => {
  assert.equal(v.mosaicColumns(1410), 10, "10 tracks of 132 + 9 gaps of 10");
  assert.equal(v.mosaicColumns(1409), 9);
  assert.equal(v.mosaicColumns(100), 1);
  assert.deepEqual([v.cardShape(1, 10).cols, v.cardShape(1, 10).rows], [1, 1], "a one-workload namespace is one tile wide");
  assert.deepEqual([v.cardShape(2, 10).cols, v.cardShape(6, 10).cols, v.cardShape(8, 10).cols], [2, 3, 4], "no empty slot where avoidable");
  assert.deepEqual([v.cardShape(46, 10).cols, v.cardShape(46, 10).rows], [10, 5]);
  assert.deepEqual([v.cardShape(46, 6).cols, v.cardShape(46, 6).rows], [6, 8], "clamped to the grid");
  // span covers header + padding + rows + the gap below, in 4 px units
  const one = v.cardShape(1, 10);
  assert.equal(one.span, Math.ceil((2 + 30 + 16 + 44 + 10) / 4));
  const css = readFileSync(new URL("../../web/src/app/observability/styles.module.css", import.meta.url), "utf8");
  assert.match(css, /\.hmGroups \{[^}]*grid-auto-rows: 4px;[^}]*column-gap: 10px;/);
  assert.match(css, /\.hmNs \{[^}]*align-self: stretch; margin-bottom: 10px;/, "a card fills its placed rows; the gap is its margin");
  assert.match(css, /\.hmNsHead \{[^}]*height: 30px;/);
  assert.match(css, /\.hmTile \{[^}]*height: 44px;/);
  assert.match(css, /\.hmGrid \{[^}]*gap: 4px; padding: 8px;/);
});

test("packMosaic: no overlap, inside the grid, holes beside tall cards filled, one flat bottom edge, deterministic", () => {
  const cellsOf = (ps: ReturnType<typeof v.packMosaic>) => {
    const seen = new Set<string>();
    for (const p of ps) for (let c = p.col; c < p.col + p.cols; c++) for (let r = p.row; r < p.row + p.span; r++) {
      const k = `${c}:${r}`;
      assert.ok(!seen.has(k), `overlap at ${k}`);
      seen.add(k);
    }
    return seen;
  };
  // The measured stg cluster (2026-10-29): 22 · 35 · 6 · 8 · 2 · 1 · 1 · 1 workloads on 9 tracks
  const counts = [22, 35, 6, 8, 2, 1, 1, 1];
  const ps = v.packMosaic(counts, 9);
  assert.equal(ps.length, counts.length);
  for (const p of ps) assert.ok(p.col >= 0 && p.cols >= 1 && p.col + p.cols <= 9, JSON.stringify(p));
  ps.forEach((p, i) => assert.ok(p.cols * Math.floor((p.span * 4 - 10 - 48 + 4) / 48) >= counts[i]!, `card ${i} holds its tiles: ${JSON.stringify(p)}`));
  const used = cellsOf(ps).size;
  const bottom = Math.max(...ps.map((p) => p.row + p.span));
  // Grid auto-flow left a 5-track hole beside argocd and empty columns under small cards; now ≥ 97% of the rectangle is cards
  assert.ok(used / (9 * bottom) >= 0.97, `filled ${(used / (9 * bottom)).toFixed(3)}`);
  assert.deepEqual(ps[0], { col: 0, cols: 6, row: 0, span: v.cardShape(22, 9).span }, "the first (problem) namespace stays top-left at its shape");
  assert.deepEqual(v.packMosaic(counts, 9), ps, "deterministic");
  // Narrow screens and one namespace
  assert.deepEqual(v.packMosaic([5], 1), [{ col: 0, cols: 1, row: 0, span: v.cardShape(5, 1).span }]);
  assert.deepEqual(v.packMosaic([], 6), []);
  const wide = v.packMosaic([1, 1, 1], 6);
  assert.equal(wide.reduce((s, p) => s + p.cols, 0), 6, "a single row of small cards spreads over the whole width");
});

test("log stream: repeated logger timestamp dropped, logback prefix cut to the message, same error grouped ×n, app frames kept", () => {
  const text = [
    "2026-10-26T13:59:30,355 [http-nio-8080-exec-7] ERROR [svc,9a713f7c3153129db44c0bec949188f1,7b0a6ffe7f3accc8] 1 c.b.w.e.CommonExceptionHandler [TENANT-ID:][TOKEN-ID:[REDACTED]] - [422] Unexpected error [URI: /internal/ai/features/X/runtime, Method: GET]demo.ai.ProviderException: provider for X is inactive: model-120b",
    "\tat demo.ai.runtime.RuntimeService.selectProvider(RuntimeService.java:75)",
    "\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Unknown Source)",
    "\tat org.springframework.aop.support.AopUtils.invokeJoinpointUsingReflection(AopUtils.java:360)",
    "\tat demo.ai.runtime.RuntimeService.getRuntime(RuntimeService.java:45)",
    "Caused by: java.lang.IllegalStateException: inactive",
    "\t... 12 more",
  ].join("\n");
  const p = lg.parseLogText(text);
  assert.ok(p.head.startsWith("[http-nio-8080-exec-7] ERROR"), "leading timestamp removed (the row shows the time)");
  assert.ok(p.summary.startsWith("[422] Unexpected error [URI:"), p.summary);
  assert.deepEqual(p.frames.map((f) => f.app), [true, false, false, true, false]);
  assert.deepEqual(p.causes, ["Caused by: java.lang.IllegalStateException: inactive"]);
  const vf = lg.visibleFrames(p.frames);
  assert.deepEqual([vf.shown.length, vf.folded], [2, 3]);
  const line = (time: string, pod: string, tx: string) => ({ time, level: "error" as const, text: tx, pod });
  const groups = lg.groupLogLines([
    line("2026-10-26T13:59:30Z", "svc-7b7cfc89b-hgd4c", text),
    line("2026-10-26T13:58:10Z", "svc-7b7cfc89b-q2w9x", text.replace("9a713f7c3153129db44c0bec949188f1", "0f1e2d3c4b5a69788796a5b4c3d2e1f0")),
    line("2026-10-26T13:40:00Z", "svc-7b7cfc89b-hgd4c", "2026-10-26T13:40:00,001 [main] ERROR [svc,,] 1 c.Other - connection refused to 192.0.2.4:5432"),
  ]);
  assert.deepEqual(groups.map((g) => g.count), [2, 1], "trace ids differ, the message does not");
  assert.deepEqual([groups[0]!.first, groups[0]!.last, groups[0]!.pods.length], ["2026-10-26T13:58:10Z", "2026-10-26T13:59:30Z", 2]);
  assert.equal(groups[1]!.parsed.summary, "connection refused to 192.0.2.4:5432");
  assert.equal(lg.filterByException(groups, "demo.ai.ProviderException").length, 1);
  assert.equal(lg.shortPod("svc-7b7cfc89b-hgd4c", "svc"), "7b7cfc89b-hgd4c");
  assert.deepEqual(lg.frameLabel("at demo.ai.runtime.RuntimeService.selectProvider(RuntimeService.java:75)"),
    { call: "RuntimeService.selectProvider", where: "(RuntimeService.java:75)", pkg: "demo.ai.runtime" });
  assert.equal(lg.frameLabel("at java.base/java.lang.reflect.Method.invoke(Unknown Source)").call, "Method.invoke", "module prefix dropped");
  assert.equal(lg.parseLogText("plain message without a level").summary, "plain message without a level");
});

test("cluster at a glance: counts only what was measured — idle apart, unmeasured stays null", () => {
  const cell = (level: string) => ({ value: null, level }) as never;
  const wl = (name: string, worst: string, pods: Array<{ ready: boolean | null; restarts: number | null; oom?: boolean }>, replicas = { ready: 1, desired: 1 }) => ({
    namespace: "app", workload: name, kind: "Deployment", basis: "owner", replicas, worst,
    cells: { ready: cell(worst) }, pods: pods.map((p, i) => ({ pod: `${name}-${i}`, memory: null, cpu: null, oom: false, ...p })),
  }) as never;
  const g = v.clusterGlance([
    wl("a", "danger", [{ ready: false, restarts: 4, oom: true }, { ready: true, restarts: 0 }], { ready: 1, desired: 2 }),
    wl("b", "warn", [{ ready: true, restarts: null }]),
    wl("c", "ok", [{ ready: true, restarts: 0 }]),
    wl("d", "noBaseline", [{ ready: null, restarts: null }]),
    wl("e", "stopped", []),
  ]);
  assert.deepEqual(g.workloads, { total: 4, danger: 1, warn: 1, ok: 1, other: 1, idle: 1 });
  assert.deepEqual(g.pods, { ready: 3, measured: 4 });
  assert.equal(g.short, 1);
  assert.deepEqual(g.restarts, { total: 4, workloads: 1 });
  assert.deepEqual(g.oom, { pods: 1, workloads: 1 });
  const none = v.clusterGlance([wl("x", "notMeasured", [{ ready: null, restarts: null }])]);
  assert.equal(none.pods, null, "no Ready series → null, never 0/0");
  assert.equal(none.restarts, null, "no restart series → null, never 0");
});
