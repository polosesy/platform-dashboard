import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_QUERIES, SIGNAL_NEEDS, aggregateHeatmap, cpuLevel, heatmapQueries, jvmBand, levelOf, type CpuFacts, type HeatRaw } from "../src/services/workloadHeatmap.js";
import { eventBelongs, mapEvents } from "../src/services/kubeEvents.js";
import { redactLogLine, redactLogText } from "../src/services/logRedaction.js";
import { BUSY_BACKOFF_MS, ERROR_FILTER, logQueries, lokiStateOf, parseLogLine, re2, summarizeLokiDrops, workloadSelector } from "../src/services/lokiLogs.js";

// Shapes measured in a customer Azure Monitor workspace / cluster (2026-10-23) — names are placeholders.
const r = (metric: Record<string, string>, value: number) => ({ metric, value });
const LE = { metric: "loki_process_custom_app_log_errors_total", podLabel: "exported_pod" };

function raw(over: Partial<HeatRaw> = {}): HeatRaw {
  return {
    "family:jvm_gc_max_data_size_bytes": [r({}, 17)], "family:http_server_requests_seconds_count": [r({}, 40)],
    "family:hikaricp_connections_active": [r({}, 9)], "family:hikaricp_connections_pending": [r({}, 9)],
    "family:jvm_memory_max_bytes": [r({}, 34)],
    active: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 1), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 1), r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq" }, 1)],
    podOwners: [
      r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", owner_kind: "ReplicaSet", owner_name: "api-7d9f8c6b5" }, 1),
      r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm", owner_kind: "ReplicaSet", owner_name: "api-7d9f8c6b5" }, 1),
      r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq", owner_kind: "ReplicaSet", owner_name: "coredns-6c9f5d8b7" }, 1),
      r({ namespace: "aks-command", pod: "command-0a1b2c3d", owner_kind: "<none>", owner_name: "<none>" }, 1),
    ],
    rsOwners: [r({ namespace: "app", replicaset: "api-7d9f8c6b5", owner_kind: "Deployment", owner_name: "api" }, 1),
      r({ namespace: "kube-system", replicaset: "coredns-6c9f5d8b7", owner_kind: "Deployment", owner_name: "coredns" }, 1)],
    deployReady: [r({ namespace: "app", deployment: "api" }, 2), r({ namespace: "kube-system", deployment: "coredns" }, 1), r({ namespace: "app", deployment: "batch" }, 0)],
    deployDesired: [r({ namespace: "app", deployment: "api" }, 2), r({ namespace: "kube-system", deployment: "coredns" }, 2), r({ namespace: "app", deployment: "batch" }, 0)],
    memWs: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", container: "api" }, 1), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm", container: "api" }, 1),
      r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq", container: "coredns" }, 1)],
    memRatio: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", container: "api" }, 0.92), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm", container: "api" }, 0.5)],
    cpuUsage: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.2)],
    cpuP95: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.2)],
    cpuRequest: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.5)],
    restarts: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0), r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq" }, 3)],
    notReady: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0), r({ namespace: "aks-command", pod: "command-0a1b2c3d" }, 1)],
    oom: [],
    oldGen: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.5)],
    http5xx: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.2)],
    httpAll: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 10), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 10)],
    poolUsage: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", pool: "hikaripool-1" }, 0.2), r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", pool: "hikaripool-2" }, 0.95)],
    poolPending: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", pool: "hikaripool-1" }, 0)],
    logErrors: [r({ namespace: "app", exported_pod: "api-7d9f8c6b5-bcdfg", pod: "alloy-0" }, 14)],
    ...over,
  };
}

test("heatmap: one tile per workload, worst pod / pool, the customer's thresholds", () => {
  const s = aggregateHeatmap(raw(), { logErrors: LE });
  const api = s.workloads.find((w) => w.workload === "api")!;
  assert.deepEqual([api.kind, api.basis, api.replicas], ["Deployment", "owner", { ready: 2, desired: 2 }]);
  assert.deepEqual([api.cells.memory.value, api.cells.memory.level, api.cells.memory.worstPod], [0.92, "danger", "api-7d9f8c6b5-bcdfg"]);
  assert.deepEqual([api.cells.poolUsage.value, api.cells.poolUsage.level, api.cells.poolUsage.pool], [0.95, "danger", "hikaripool-2"]);
  assert.deepEqual([api.cells.http5xx.value, api.cells.http5xx.level], [0.01, "danger"], "5xx share of the whole workload's traffic");
  assert.deepEqual([api.cells.logErrors.value, api.cells.logErrors.level], [14, "warn"]);
  assert.equal(api.worst, "danger");
  const dns = s.workloads.find((w) => w.workload === "coredns")!;
  assert.deepEqual([dns.cells.ready.level, dns.cells.restarts.value, dns.cells.restarts.level], ["warn", 3, "warn"]);
  assert.deepEqual([dns.cells.oldGen.level, dns.cells.http5xx.level], ["notInstrumented", "notInstrumented"], "not Java — not 0");
  assert.deepEqual([dns.cells.memory.level, dns.cells.memory.code, dns.cells.memory.abs], ["noBaseline", "noLimit", 1], "usage without a limit: bytes, no verdict");
  assert.equal(dns.cells.cpu.level, "notMeasured", "no CPU series at all — not measured");
  assert.equal(s.workloads.find((w) => w.workload === "batch")!.cells.ready.level, "stopped", "0/0 = stopped, not down");
  assert.ok(!s.workloads.some((w) => w.namespace === "aks-command"), "completed pods (command invoke) are not workloads");
});

test("heatmap: a DaemonSet no node matches and a Deployment at 0 are 'nothing to run' everywhere — not unmeasured, not OK", () => {
  const s = aggregateHeatmap(raw({
    dsReady: [r({ namespace: "kube-system", daemonset: "agent-windows" }, 0), r({ namespace: "kube-system", daemonset: "agent" }, 1)],
    dsDesired: [r({ namespace: "kube-system", daemonset: "agent-windows" }, 0), r({ namespace: "kube-system", daemonset: "agent" }, 1)],
    podOwners: [...raw().podOwners!, r({ namespace: "kube-system", pod: "agent-x7k2p", owner_kind: "DaemonSet", owner_name: "agent" }, 1)],
    active: [...raw().active!, r({ namespace: "kube-system", pod: "agent-x7k2p" }, 1)],
    memWs: [...raw().memWs!, r({ namespace: "kube-system", pod: "agent-x7k2p", container: "a" }, 300), r({ namespace: "kube-system", pod: "agent-x7k2p", container: "b" }, 100)],
    cpuUsage: [...raw().cpuUsage!, r({ namespace: "kube-system", pod: "agent-x7k2p" }, 0.04)],
    cpuP95: [...raw().cpuP95!, r({ namespace: "kube-system", pod: "agent-x7k2p" }, 0.04)],
  }), { logErrors: LE });
  const win = s.workloads.find((w) => w.workload === "agent-windows")!;
  assert.deepEqual([win.cells.ready.level, win.cells.ready.code, win.worst], ["stopped", "noNodes", "stopped"]);
  assert.ok(["memory", "cpu", "restarts", "logErrors", "oldGen"].every((m) => win.cells[m as "memory"].code === "noPods"), "log errors 0 must not turn it green");
  const batch = s.workloads.find((w) => w.workload === "batch")!;
  assert.deepEqual([batch.cells.ready.code, batch.worst], ["scaledToZero", "stopped"]);
  const agent = s.workloads.find((w) => w.workload === "agent")!;
  assert.deepEqual([agent.cells.memory.level, agent.cells.memory.abs, agent.cells.cpu.level, agent.cells.cpu.abs, agent.worst], ["noBaseline", 400, "noBaseline", 0.04, "ok"]);
  assert.deepEqual([agent.pods[0]!.memBytes, agent.pods[0]!.cpuCores], [400, 0.04], "containers summed per pod");
  const api = s.workloads.find((w) => w.workload === "api")!;
  assert.equal(api.cells.memory.abs, 1, "a ratio keeps the bytes beside it");
});

test("heatmap: finished pods never make a tile or a pod row, but their log ERRORs still count for a live workload", () => {
  const base = raw();
  const s = aggregateHeatmap(raw({
    podOwners: [...base.podOwners!, r({ namespace: "app", pod: "api-7d9f8c6b5-zzzzz", owner_kind: "ReplicaSet", owner_name: "api-7d9f8c6b5" }, 1)],
    restarts: [...base.restarts!, r({ namespace: "aks-command", pod: "command-0a1b2c3d" }, 0), r({ namespace: "app", pod: "api-7d9f8c6b5-zzzzz" }, 3)],
    memWs: [...base.memWs!, r({ namespace: "aks-command", pod: "command-0a1b2c3d", container: "c" }, 5)],
    logErrors: [...base.logErrors!, r({ namespace: "app", exported_pod: "api-7d9f8c6b5-zzzzz", pod: "alloy-0" }, 6)],
  }), { logErrors: LE });
  assert.ok(!s.workloads.some((w) => w.namespace === "aks-command"), "a Succeeded command-invoke pod seen by restarts / cAdvisor");
  const api = s.workloads.find((w) => w.workload === "api")!;
  assert.deepEqual(api.pods.map((p) => p.pod), ["api-7d9f8c6b5-bcdfg", "api-7d9f8c6b5-hjklm"], "the replaced pod is not listed");
  assert.equal(api.cells.logErrors.value, 20, "its ERRORs in the window still belong to the workload");
});

// 2026-11-05 stg, MiB: limit · heap max · heap committed · non-heap committed · direct · RSS (integration namespace)
const JVM_PODS: Record<string, [number, number, number, number, number, number]> = {
  "pg-5474f57d6-gbwbj": [750, 545, 151, 202, 18, 537], // MaxRAMPercentage 75 — a full heap does not fit
  "sched-9df66d6fc-dcbnk": [1075, 520, 193, 271, 17, 761], // 13Mi short — inside the estimate's error
  "gw-9468bf7b7-4j4qd": [1536, 742, 268, 244, 35, 802],
};
function jvmRaw(over: Partial<HeatRaw> = {}): HeatRaw {
  const Mi = 1024 * 1024;
  const pods = Object.keys(JVM_PODS);
  const per = (i: number) => pods.map((pod) => r({ namespace: "app", pod }, JVM_PODS[pod]![i]! * Mi));
  const rs = (pod: string) => pod.split("-").slice(0, 2).join("-");
  return raw({
    podOwners: pods.map((pod) => r({ namespace: "app", pod, owner_kind: "ReplicaSet", owner_name: rs(pod) }, 1)),
    rsOwners: pods.map((pod) => r({ namespace: "app", replicaset: rs(pod), owner_kind: "Deployment", owner_name: pod.split("-")[0]! }, 1)),
    active: pods.map((pod) => r({ namespace: "app", pod }, 1)),
    deployReady: [], deployDesired: [], memWs: [], memRatio: [], oldGen: [], cpuUsage: [], cpuP95: [], cpuRequest: [], httpAll: [], poolUsage: [], poolPending: [], logErrors: [],
    podMemLimit: per(0), jvmHeapMax: per(1), jvmHeapCommitted: per(2), jvmNonheapCommitted: per(3), jvmDirect: per(4), memRss: per(5),
    jvmNonheap: per(3),
    ...over,
  });
}

test("heatmap: JVM headroom = limit − (heap max + non-heap committed + direct + native); band max(100Mi, 10%)", () => {
  const Mi = 1024 * 1024;
  const s = aggregateHeatmap(jvmRaw(), {});
  const cell = (w: string) => s.workloads.find((x) => x.workload === w)!.cells.jvmHeadroom;
  const pg = cell("pg");
  // native = 537 − 151 − (202 + 18) = 166 → 750 − (545 + 220 + 166) = −181 < −band(100)
  assert.deepEqual([Math.round(pg.value! / Mi), pg.level, pg.code, Math.round(pg.jvm!.native! / Mi), pg.jvm!.band / Mi], [-181, "danger", "configDeficit", 166, 100]);
  const sched = cell("sched");
  assert.deepEqual([Math.round(sched.value! / Mi), sched.level, sched.code], [-13, "warn", "marginal"], "short, but inside the estimate's error");
  const gw = cell("gw");
  assert.deepEqual([Math.round(gw.value! / Mi), gw.level, gw.code], [260, "ok", undefined]);
  assert.equal(s.flags.find((f) => f.metric === "jvmHeadroom")!.count, 1, "the red strip counts danger only");
  assert.equal(jvmBand(2560 * Mi), 256 * Mi, "10% of a large limit");
});

test("heatmap: Serial / Parallel heap max counts the second survivor space; G1 (no survivor series) unchanged", () => {
  const Mi = 1024 * 1024;
  const pg = "pg-5474f57d6-gbwbj";
  // 11-05 stg: eden 150.5 + survivor 18.75 (×2) + tenured 376 = -Xmx 563.75 (750 × 75%); one survivor committed 5.2
  const s = aggregateHeatmap(jvmRaw({ jvmSurvivorMax: [r({ namespace: "app", pod: pg }, 18.75 * Mi)], jvmSurvivorCommitted: [r({ namespace: "app", pod: pg }, 5.25 * Mi)] }), {});
  const c = s.workloads.find((x) => x.workload === "pg")!.cells.jvmHeadroom;
  // native = 537 − (151 + 5.25) − 220 = 160.75 → 750 − (563.75 + 220 + 160.75) = −194.5
  assert.deepEqual([c.jvm!.heapMax / Mi, c.jvm!.heapCommitted! / Mi, c.jvm!.native! / Mi, c.value! / Mi, c.code], [563.75, 156.25, 160.75, -194.5, "configDeficit"]);
  const g1 = aggregateHeatmap(jvmRaw(), {}).workloads.find((x) => x.workload === "pg")!.cells.jvmHeadroom;
  assert.equal(g1.jvm!.heapMax / Mi, 545, "no survivor series (G1 reports max -1) — nothing added");
  const q = heatmapQueries('cluster="a"', 60);
  assert.match(q.jvmSurvivorMax!, /id=~"\(\?i\)\(ps \)\?survivor space"/, "anchored regex — G1 Survivor Space does not match");
});

test("heatmap: Old Gen = live after major GC / max — never jvm_memory_usage_after_gc; live 0 = no major GC yet, not 0 %", () => {
  const q = heatmapQueries('cluster="a"', 60);
  // stg 2026-11-12: after_gc 93.6 % (tenured now, garbage included) vs live 41.4 % on the same SerialGC pod
  assert.ok(Object.values(q).every((e) => !e.includes("jvm_memory_usage_after_gc")), "after_gc counts promoted garbage");
  assert.match(q.oldGen!, /jvm_gc_live_data_size_bytes\{cluster="a"\}\) > 0\) \/ on \(namespace, pod\)/);
  assert.match(q.oldGenNoMajorGc!, /== 0$/);
  const p = "api-7d9f8c6b5-hjklm";
  const s = aggregateHeatmap(raw({ oldGen: [], oldGenNoMajorGc: [r({ namespace: "app", pod: p }, 0)] }), {});
  const c = s.workloads.find((x) => x.workload === "api")!.cells.oldGen;
  assert.deepEqual([c.value, c.level, c.code, c.worstPod], [null, "noBaseline", "noMajorGc", p]);
  const both = aggregateHeatmap(raw({ oldGenNoMajorGc: [r({ namespace: "app", pod: p }, 0)] }), {});
  assert.equal(both.workloads.find((x) => x.workload === "api")!.cells.oldGen.value, 0.5, "a pod with a ratio wins over one without");
});

test("heatmap: JVM headroom short while memory ≥ 80%, Old Gen ≥ 70% or OOMKilled in the window = danger (imminent)", () => {
  const p = "sched-9df66d6fc-dcbnk";
  const hot = aggregateHeatmap(jvmRaw({ memRatio: [r({ namespace: "app", pod: p, container: "app" }, 0.82)] }), {});
  const c = hot.workloads.find((x) => x.workload === "sched")!.cells.jvmHeadroom;
  assert.deepEqual([c.level, c.code], ["danger", "imminent"]);
  const old = aggregateHeatmap(jvmRaw({ oldGen: [r({ namespace: "app", pod: p }, 0.75)] }), {});
  assert.equal(old.workloads.find((x) => x.workload === "sched")!.cells.jvmHeadroom.code, "imminent");
  const oom = aggregateHeatmap(jvmRaw({ oom: [r({ namespace: "app", pod: p }, 1)] }), {});
  assert.equal(oom.workloads.find((x) => x.workload === "sched")!.cells.jvmHeadroom.code, "imminent");
  const gw = aggregateHeatmap(jvmRaw({ memRatio: [r({ namespace: "app", pod: "gw-9468bf7b7-4j4qd", container: "app" }, 0.85)] }), {});
  assert.equal(gw.workloads.find((x) => x.workload === "gw")!.cells.jvmHeadroom.level, "ok", "busy but a full heap still fits");
});

test("heatmap: JVM headroom without committed / RSS series falls back to non-heap in use, marked partial", () => {
  const Mi = 1024 * 1024;
  const s = aggregateHeatmap(jvmRaw({ jvmHeapCommitted: [], jvmNonheapCommitted: [], jvmDirect: [], memRss: [] }), {});
  const pg = s.workloads.find((x) => x.workload === "pg")!.cells.jvmHeadroom;
  // 750 − (545 + 202) = 3 — no native estimate (no RSS, no working set)
  assert.deepEqual([Math.round(pg.value! / Mi), pg.level, pg.jvm!.native, pg.jvm!.partial], [3, "warn", null, true]);
  const ws = aggregateHeatmap(jvmRaw({ memRss: [], memWs: [r({ namespace: "app", pod: "pg-5474f57d6-gbwbj", container: "app" }, 544 * Mi), r({ namespace: "app", pod: "pg-5474f57d6-gbwbj", container: "fluentd" }, 60 * Mi)] }), {});
  assert.equal(Math.round(ws.workloads.find((x) => x.workload === "pg")!.cells.jvmHeadroom.jvm!.rss! / Mi), 544, "the largest container's working set, not the pod's sum");
  const base = raw();
  const nolimit = aggregateHeatmap(raw({ jvmHeapMax: [r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq" }, 100 * Mi)], podMemLimit: [], active: base.active }), {});
  const dns = nolimit.workloads.find((w) => w.workload === "coredns")!.cells.jvmHeadroom;
  assert.deepEqual([dns.level, dns.code], ["noBaseline", "noLimit"], "a JVM without a memory limit has nothing to subtract from");
  assert.match(heatmapQueries('cluster="a"', 60).jvmHeapMax!, /sum by \(namespace, pod\) \(max by \(namespace, pod, id\) \(jvm_memory_max_bytes\{cluster="a",area="heap"\}\) > 0\)/, "G1 pools report -1; one series per pool");
});

test("heatmap: native memory is the larger of now and the pod's 24-hour peak (glibc hands arenas back)", () => {
  const Mi = 1024 * 1024;
  // 11-05 stg: a Spring app at native 322Mi now, 394Mi at its peak — a full heap is 72Mi further over the limit than "now" says
  const s = aggregateHeatmap(jvmRaw({
    jvmNativePeak: [r({ namespace: "app", pod: "sched-9df66d6fc-dcbnk" }, 352 * Mi), r({ namespace: "app", pod: "gw-9468bf7b7-4j4qd" }, 100 * Mi)],
    podAge: [r({ namespace: "app", pod: "sched-9df66d6fc-dcbnk" }, 140 * 3600), r({ namespace: "app", pod: "gw-9468bf7b7-4j4qd" }, 1800)],
  }), {});
  const cell = (w: string) => s.workloads.find((x) => x.workload === w)!.cells.jvmHeadroom;
  const sched = cell("sched");
  // native now = 761 − 193 − (271 + 17) = 280, peak 352 → 1075 − (520 + 288 + 352) = −85 (band 107.5 — still marginal)
  assert.deepEqual([Math.round(sched.value! / Mi), sched.level, Math.round(sched.jvm!.native! / Mi), Math.round(sched.jvm!.nativePeak! / Mi), sched.jvm!.observedHours], [-85, "warn", 280, 352, 24]);
  const gw = cell("gw");
  assert.deepEqual([Math.round(gw.value! / Mi), gw.jvm!.observedHours], [260, 0.5], "a lower peak never lowers the estimate; a young pod says how little it has seen");
  const q = heatmapQueries('cluster="a"', 60);
  assert.match(q.jvmNativePeak!, /^max_over_time\(\(clamp_min\(.*, 0\)\)\[1440m:5m\]\)$/, "a day whatever the window");
  assert.match(q.jvmNativePeak!, /area=~"heap\|nonheap"\}\) or max by \(namespace, pod, id\) \(jvm_buffer_memory_used_bytes/);
});

test("heatmap: memory shows the window's peak beside the level, which stays on now", () => {
  const s = aggregateHeatmap(raw({ memPeak: [r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm", container: "api" }, 1.9), r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg", container: "api" }, 1.05)] }), {});
  const mem = s.workloads.find((w) => w.workload === "api")!.cells.memory;
  // bcdfg: ws 1 at 92% → limit 1/0.92; its peak 1.05 → 96.6%
  assert.deepEqual([mem.level, mem.worstPod, Math.round(mem.peak!.ratio! * 1000)], ["danger", "api-7d9f8c6b5-bcdfg", 966]);
  const dns = aggregateHeatmap(raw({ memPeak: [r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq", container: "coredns" }, 3)] }), {});
  assert.deepEqual(dns.workloads.find((w) => w.workload === "coredns")!.cells.memory.peak, { ratio: null, bytes: 3 }, "no limit: bytes only");
  assert.match(heatmapQueries('cluster="a"', 360).memPeak!, /max_over_time\(container_memory_working_set_bytes\{cluster="a",container!="",container!="POD"\}\[360m\]\)/);
});

test("heatmap: AKS-managed workloads keep their CPU / memory but leave the flag strip", () => {
  const over = { memRatio: [...raw().memRatio!, r({ namespace: "kube-system", pod: "coredns-6c9f5d8b7-xzrtq", container: "coredns" }, 0.95)] };
  const plain = aggregateHeatmap(raw(over), {});
  assert.equal(plain.flags.find((f) => f.metric === "memory")!.count, 2);
  const s = aggregateHeatmap(raw(over), { managed: new Set(["Deployment/kube-system/coredns"]) });
  const dns = s.workloads.find((w) => w.workload === "coredns")!;
  assert.deepEqual([dns.managed, dns.cells.memory.level], [true, "danger"], "the value stands");
  assert.equal(s.flags.find((f) => f.metric === "memory")!.count, 1, "only the app's memory is in the strip");
  assert.equal(s.flags.find((f) => f.metric === "restarts")!.count, 1, "restarts of an AKS add-on still count");
  assert.equal(s.workloads.find((w) => w.workload === "api")!.managed, undefined);
  assert.equal(aggregateHeatmap(raw(over), { managed: new Set(["DaemonSet/kube-system/coredns"]) }).workloads.find((w) => w.workload === "coredns")!.managed, undefined, "kind must match");
});

test("heatmap: a query that did not answer makes its signals queryFailed — not OK, not 'not measured'", () => {
  const s = aggregateHeatmap(raw(), { logErrors: LE, failed: new Set(["cpuPsi"]) });
  const api = s.workloads.find((w) => w.workload === "api")!;
  assert.deepEqual([api.cells.cpu.level, api.cells.cpu.code], ["notMeasured", "queryFailed"], "no PSI = no danger verdict possible");
  assert.equal(s.flags.find((f) => f.metric === "cpu")!.count, null);
  assert.equal(api.cells.memory.level, "danger", "the other signals stand");
  const j = aggregateHeatmap(jvmRaw(), { failed: new Set(["jvmHeapCommitted"]) });
  assert.equal(j.workloads.find((w) => w.workload === "pg")!.cells.jvmHeadroom.code, "queryFailed");
  const dns = aggregateHeatmap(raw(), { failed: new Set(["jvmHeapCommitted"]) }).workloads.find((w) => w.workload === "coredns")!;
  assert.equal(dns.cells.jvmHeadroom.level, "notInstrumented", "not a Java workload — its rows say so");
  const blind = aggregateHeatmap(raw(), { failed: new Set(["jvmHeapMax"]) }).workloads.find((w) => w.workload === "coredns")!;
  assert.equal(blind.cells.jvmHeadroom.code, "queryFailed", "the query that shows who is Java failed — unknown for everyone");
  const idle = aggregateHeatmap(raw(), { failed: new Set(["memRatio"]) }).workloads.find((w) => w.workload === "batch")!;
  assert.equal(idle.cells.memory.code, "noPods", "nothing to run stays nothing to run");
  // every name the failure rules use is a real query (a rename must not silently disable them)
  const q = heatmapQueries('cluster="a"', 60, LE);
  assert.deepEqual([...CORE_QUERIES, ...Object.values(SIGNAL_NEEDS).flat()].filter((n) => !(n in q)), []);
});

test("heatmap CPU: danger is pressure (PSI / throttling), not the ratio; over the request under 100m is no verdict", () => {
  const f = (o: Partial<CpuFacts>): CpuFacts => ({ now: null, p95: null, avg: null, max: null, request: null, psi: null, throttle: null, ...o });
  // 11-05 stg: data-transformation 429% at start-up — the window's p95 without the warm-up is 0.9 × request
  assert.deepEqual(cpuLevel(f({ now: 4.29, p95: 0.9, request: 1 })), { level: "ok", value: 0.9 });
  assert.deepEqual(cpuLevel(f({ p95: 0.0625, request: 0.03125 })), { level: "ok", value: 2, code: "belowFloor" }, "31m request at 63m — no load");
  assert.deepEqual(cpuLevel(f({ p95: 0.125, request: 0.0625, psi: 0.01 })), { level: "warn", value: 2 }, "63m request at 125m — capacity planning");
  assert.equal(cpuLevel(f({ p95: 0.3, request: 0.1, psi: 0.02 })).level, "warn", "300% without waiting is not danger");
  assert.equal(cpuLevel(f({ p95: 0.05, request: 0.1, psi: 0.12 })).level, "danger", "starving under its request");
  assert.equal(cpuLevel(f({ p95: 0.05, request: 0.1, psi: 0.06 })).level, "warn");
  assert.equal(cpuLevel(f({ p95: 0.02, request: 0.02, throttle: 0.3 })).level, "danger", "an AKS add-on hitting its CPU limit");
  assert.deepEqual(cpuLevel(f({ now: 0.5, request: 0.1 })), { level: "noBaseline", value: null, code: "warmingUp" }, "only a starting container in the window");
  assert.deepEqual(cpuLevel(f({ p95: 0.04 })), { level: "noBaseline", value: null, code: "noRequest" });
});

test("heatmap CPU: the tile shows the worst verdict, its p95 cores and the window's breakdown", () => {
  const s = aggregateHeatmap(raw({
    cpuUsage: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.9), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 0.05)],
    cpuP95: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.04), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 0.06)],
    cpuAvg: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.03)],
    cpuRequest: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.05), r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 0.05)],
    cpuPsi: [r({ namespace: "app", pod: "api-7d9f8c6b5-hjklm" }, 0.11)],
  }), { logErrors: LE });
  const cpu = s.workloads.find((w) => w.workload === "api")!.cells.cpu;
  assert.deepEqual([cpu.level, cpu.worstPod, cpu.abs, cpu.cpu!.psi], ["danger", "api-7d9f8c6b5-hjklm", 0.06, 0.11], "waiting beats a higher 5-minute value");
  const api = s.workloads.find((w) => w.workload === "api")!;
  assert.equal(Math.round(api.pods.find((p) => p.pod === "api-7d9f8c6b5-bcdfg")!.cpu! * 100), 80, "pod rows show p95 / request, not the last 5 minutes");
});

test("heatmap queries: CPU / 5xx follow the window, warm-up left out per container, OOM inside the window", () => {
  const h = heatmapQueries('cluster="a"', 60);
  const d = heatmapQueries('cluster="a"', 1440);
  assert.match(h.cpuP95!, /^quantile_over_time\(0\.95, .*\[60m:1m\]\)$/);
  assert.match(d.cpuP95!, /\[1440m:5m\]\)$/);
  assert.match(h.cpuP95!, /unless on \(namespace, pod, container\) \(time\(\) - max by \(namespace, pod, container\) \(kube_pod_container_state_started\{cluster="a"\}\) < 600\)/);
  assert.match(d.http5xx!, /increase\(http_server_requests_seconds_count\{cluster="a",status=~"5\.\.",uri!~"\/actuator\.\*"\}\[1440m\]\)/);
  assert.match(d.oom!, /kube_pod_container_status_last_terminated_timestamp\{cluster="a"\} > time\(\) - 86400/);
  assert.ok(!("cpuRatio" in h), "the ratio is taken in TypeScript");
});

test("heatmap 5xx: the share over the window; under 20 requests it is shown, not judged", () => {
  const few = aggregateHeatmap(raw({ http5xx: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 1)], httpAll: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 10)] }), { logErrors: LE });
  const c = few.workloads.find((w) => w.workload === "api")!.cells.http5xx;
  assert.deepEqual([c.value, c.level, c.code, c.requests], [0.1, "noTraffic", "lowTraffic", 10]);
  const many = aggregateHeatmap(raw({ http5xx: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 1)], httpAll: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 400)] }), { logErrors: LE });
  const m = many.workloads.find((w) => w.workload === "api")!.cells.http5xx;
  assert.deepEqual([m.value, m.level, m.requests], [0.0025, "ok", 400]);
});

test("heatmap: missing families are notMeasured with a null flag; flags count the strip's levels", () => {
  const s = aggregateHeatmap(raw({ "family:hikaricp_connections_pending": [], poolPending: [] }), {});
  assert.deepEqual(s.missing, ["logErrors", "poolPending"].sort((a, b) => ["ready", "memory", "cpu", "restarts", "oldGen", "jvmHeadroom", "http5xx", "logErrors", "poolUsage", "poolPending"].indexOf(a) - ["ready", "memory", "cpu", "restarts", "oldGen", "jvmHeadroom", "http5xx", "logErrors", "poolUsage", "poolPending"].indexOf(b)));
  const flag = (m: string) => s.flags.find((f) => f.metric === m)!.count;
  assert.equal(flag("poolPending"), null);
  assert.equal(flag("logErrors"), null);
  assert.equal(flag("memory"), 1);
  assert.equal(flag("restarts"), 1, "any restart flags (their strip)");
  assert.equal(s.workloads.find((w) => w.workload === "api")!.cells.poolPending.level, "notMeasured");
});

test("heatmap queries: one count per family (never `a or b`), cluster-scoped, the log counter's pod label", () => {
  const q = heatmapQueries('cluster="aks-a"', 60, LE);
  assert.ok(!Object.values(q).some((v) => / or hikaricp/.test(v)));
  assert.ok(Object.values(q).every((v) => v.includes('cluster="aks-a"')));
  assert.match(q.logErrors!, /sum by \(namespace, exported_pod\)/);
  assert.match(q.restarts!, /changes\(kube_pod_container_status_restarts_total\{cluster="aks-a"\}\[60m\]\)/);
  assert.equal(levelOf("oldGen", 0.7), "warn");
});

test("events: Warning only, the workload's objects, newest first, message only for operators (redacted)", () => {
  const ev = (name: string, type: string, t: string, message = "") => ({ type, reason: "BackOff", message, count: 2, lastTimestamp: new Date(t) as unknown as Date,
    involvedObject: { kind: "Pod", name, namespace: "app" }, metadata: { namespace: "app" } });
  const items = [ev("api-7d9f8c6b5-bcdfg", "Warning", "2026-10-23T01:00:00Z", "probe failed token=abcdef123456"),
    ev("api-7d9f8c6b5-hjklm", "Normal", "2026-10-23T02:00:00Z"), ev("apigw-1", "Warning", "2026-10-23T03:00:00Z"), ev("api", "Warning", "2026-10-23T04:00:00Z")];
  const viewer = mapEvents(items as never, { workload: "api", messages: false });
  assert.deepEqual(viewer.map((e) => e.name), ["api", "api-7d9f8c6b5-bcdfg"], "apigw-1 shares the prefix but not the workload");
  assert.ok(viewer.every((e) => e.message === undefined));
  const operator = mapEvents(items as never, { workload: "api", messages: true });
  assert.equal(operator[1]!.message, "probe failed token=[REDACTED]");
  assert.ok(eventBelongs({ name: "api-0", kind: "Pod" }, "api"));
});

test("events: count is cumulative from the first occurrence; time is the last (the TTL runs from it)", () => {
  // stg 2026-10-29: a readiness probe failing for days kept one event alive — ×1311 since 10-23, not in the last hour
  const base = { type: "Warning", reason: "Unhealthy", involvedObject: { kind: "Pod", name: "pyroscope-0", namespace: "monitor" }, metadata: { namespace: "monitor" } };
  const [e] = mapEvents([{ ...base, count: 1311, firstTimestamp: new Date("2026-10-23T17:15:23Z"), lastTimestamp: new Date("2026-10-29T01:01:33Z") }] as never, { messages: false });
  assert.deepEqual([e!.time, e!.firstTime, e!.count], ["2026-10-29T01:01:33.000Z", "2026-10-23T17:15:23.000Z", 1311]);
  const [noFirst] = mapEvents([{ ...base, count: 3, lastTimestamp: new Date("2026-10-29T01:01:33Z") }] as never, { messages: false });
  assert.equal(noFirst!.firstTime, undefined, "no first time → the panel keeps the plain ×count");
  // events.k8s.io-style: lastTimestamp empty, eventTime = first, series.lastObservedTime = last
  const [series] = mapEvents([{ ...base, eventTime: new Date("2026-10-28T21:38:00Z"), series: { count: 1098, lastObservedTime: new Date("2026-10-29T01:01:33Z") } }] as never, { messages: false });
  assert.deepEqual([series!.time, series!.firstTime, series!.count], ["2026-10-29T01:01:33.000Z", "2026-10-28T21:38:00.000Z", 1098], "the last time is not the series' first");
});

test("redaction: tokens, keys, PEM, SAS — clean lines untouched", () => {
  assert.equal(redactLogLine("Authorization: Bearer abcdefghijklmnop").line, "Authorization: [REDACTED]");
  assert.equal(redactLogLine('{"password":"hunter22"}').line, '{"password":"[REDACTED]"}');
  assert.equal(redactLogLine("Handler [TENANT-ID:][TOKEN-ID:Q2xvdWR5U2t5Mz][USER-ID:demo.user] - [422]").line,
    "Handler [TENANT-ID:][TOKEN-ID:[REDACTED]][USER-ID:demo.user] - [422]", "MDC token / session ids");
  assert.equal(redactLogLine("JSESSIONID=ABCDEF0123456789; sessionId: 5f2c9e1a").line, "JSESSIONID=[REDACTED]; sessionId: [REDACTED]");
  assert.match(redactLogLine("AccountKey=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=;EndpointSuffix").line, /AccountKey=\[REDACTED\]/);
  assert.match(redactLogLine("url?sv=2022&sig=abcdEFGH1234%3D&se=1").line, /sig=\[REDACTED\]/);
  assert.equal(redactLogLine("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop").line, "jwt [REDACTED]");
  assert.equal(redactLogText("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----").n, 0, "line by line: a key split over lines …");
  assert.equal(redactLogLine("-----BEGIN PRIVATE KEY-----MIIabc-----END PRIVATE KEY-----").line, "[REDACTED]");
  const clean = "2026-10-23 INFO [svc,,] Started in 3.2 seconds";
  assert.deepEqual(redactLogLine(clean), { line: clean, n: 0 });
});

test("Loki: the API builds the selector from validated names; RE2-escaped; controller patterns", () => {
  const s = workloadSelector("app", "api.v2", ["api.v2-7d9f8c6b5-bcdfg", "bad name"]);
  assert.match(s, /^\{namespace="app", pod=~"api\\\\\.v2-7d9f8c6b5-bcdfg\|api\\\\\.v2-\[bcdfghjklmnpqrstvwxz2456789\]\{6,10\}/);
  assert.ok(!s.includes("bad name"));
  assert.throws(() => workloadSelector('app"} or {x="', "api"), /Kubernetes name/);
  assert.equal(re2("a.b"), "a\\\\.b");
  const q = logQueries(s, true, 60);
  assert.ok(q.lines.endsWith(ERROR_FILTER));
  assert.match(q.exceptions, /^topk\(10, sum by \(exc\) \(count_over_time\(/);
  assert.match(q.exceptions, /\[60m\]\)\)\)$/);
});

test("Loki: lines parsed with level, pod, trace id (never an empty one), ANSI stripped, redacted", () => {
  const p = parseLogLine({ pod: "api-7d9f8c6b5-bcdfg" }, "1761181200000000000",
    "\x1b[31m2026-10-23 ERROR [api,0af7651916cd43dd8448eb211c80319c,b7ad6b7169203331,] Failed password=secret1");
  assert.deepEqual([p.line.level, p.line.pod, p.line.traceId, p.redactions], ["error", "api-7d9f8c6b5-bcdfg", "0af7651916cd43dd8448eb211c80319c", 1]);
  assert.ok(!p.line.text.includes("\x1b"));
  assert.equal(p.line.time, "2025-10-23T01:00:00.000Z");
  const noTrace = parseLogLine({}, "1761181200000000000", "INFO [api,,,] ok");
  assert.deepEqual([noTrace.line.level, noTrace.line.traceId], ["info", undefined]);
  assert.equal(parseLogLine({}, "1761181200000000000", "x", { level: "warn" }).line.level, "warn", "structured metadata wins");
});

test("Loki drops: exporter flow lines grouped; relay node_status lines skipped; network failures are 'unreachable'", () => {
  const flow = (sp: number) => JSON.stringify({ flow: { time: "2026-10-23T01:00:00Z", verdict: "DROPPED", drop_reason_desc: "POLICY_DENIED", traffic_direction: "EGRESS",
    IP: { source: "10.0.0.5", destination: "203.0.113.10" }, l4: { TCP: { source_port: sp, destination_port: 443 } },
    source: { namespace: "monitor", pod_name: "tracer-58777cf44-bcdfg", workloads: [{ name: "tracer" }], identity: 4242 },
    destination: { identity: 2, labels: ["reserved:world"] }, node_name: "node-a" } });
  const s = summarizeLokiDrops([flow(40001), flow(40002), '{"node_status":{"state_change":"NODE_ERROR","node_names":["node-b"]}}']);
  assert.equal(s.flowLines, 2);
  assert.deepEqual(s.drops.map((d) => [d.destination, d.port, d.reason, d.count]), [["world (203.0.113.10)", 443, "POLICY_DENIED", 2]]);
  assert.equal(lokiStateOf(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })).state, "unreachable");
  assert.equal(lokiStateOf(new Error("Loki 400: parse error")).state, "failed");
});

test("Loki: no connection = unreachable (policy hint); a reachable Loki that timed out / cut / 499 / 5xx = busy", () => {
  // 2026-11-05 stg: /ready 200 in 104 ms from the dashboard pod while range reads took ~25 s (499 / 500) — every one
  // of them used to say "a network policy blocks the dashboard"
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const cut = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } });
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const connectTimeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal(lokiStateOf(timeout, true).state, "busy", "timed out, /ready answers");
  assert.equal(lokiStateOf(timeout, false).state, "unreachable", "timed out, /ready does not answer either");
  assert.equal(lokiStateOf(cut, true).state, "busy", "Loki's 30 s write timeout cut the answer");
  for (const e of [refused, connectTimeout, dns]) assert.equal(lokiStateOf(e, true).state, "unreachable", "no connection — /ready is not asked");
  assert.equal(lokiStateOf(new Error("Loki 499: context canceled")).state, "busy");
  assert.equal(lokiStateOf(new Error("Loki 504: gateway timeout")).state, "busy");
  assert.equal(lokiStateOf(new Error("Loki 500: rpc error: code = Canceled desc = context canceled")).state, "busy");
  assert.equal(lokiStateOf(new Error("Loki 500: failed to parse")).state, "failed", "a 500 that is not overload");
  assert.equal(lokiStateOf(new Error("Loki 400: parse error at line 1")).state, "failed");
  assert.equal(BUSY_BACKOFF_MS, 60_000);
});

test("heatmap: CPU 지금 = 15-min average / request (Grafana container map tile) — a lens, floor only over the request", () => {
  const P = { namespace: "app", pod: "api-7d9f8c6b5-bcdfg" };
  const run = (now15: number, request: number | null, over?: number) => aggregateHeatmap(raw({
    cpuNow15: [r(P, now15)], cpuRequest: request === null ? [] : [r(P, request)], cpuUsage: [r(P, 0.3)],
    ...(over === undefined ? {} : { cpuOverSteps: [r(P, over)] }),
  }), { windowMinutes: 360 }).workloads.find((w) => w.workload === "api")!;
  const hot = run(0.11, 0.075, 10);
  assert.deepEqual([hot.cells.cpuNow.level, Math.round(hot.cells.cpuNow.value! * 100)], ["warn", 147], "0.11 core / 75m = 147% — yellow (red from 150%)");
  const red = run(0.16, 0.1, 10);
  assert.equal(red.cells.cpuNow.level, "danger", "160% at 0.16 core");
  assert.deepEqual(red.cells.cpuNow.cpuNow, { avg15: 0.16, now5: 0.3, request: 0.1, overMinutes: 50, windowMinutes: 360 }, "6 h window: 5-min steps");
  const plain = aggregateHeatmap(raw({ memRatio: [], cpuRequest: [r(P, 0.1)], cpuUsage: [r(P, 0.3)] }), {}).workloads.find((w) => w.workload === "api")!;
  const lensed = aggregateHeatmap(raw({ memRatio: [], cpuRequest: [r(P, 0.1)], cpuUsage: [r(P, 0.3)], cpuNow15: [r(P, 0.16)] }), {}).workloads.find((w) => w.workload === "api")!;
  assert.equal(lensed.cells.cpuNow.level, "danger");
  assert.equal(lensed.worst, plain.worst, "a lens never changes the workload's level");
  assert.equal(run(0.12, 0.1).cells.cpuNow.level, "warn", "120%");
  const tiny = run(0.08, 0.05);
  assert.deepEqual([tiny.cells.cpuNow.level, tiny.cells.cpuNow.code], ["noBaseline", "belowFloor"], "over the request under 100m: uncoloured");
  assert.deepEqual([run(0.002, 0.05).cells.cpuNow.level, run(0.002, 0.05).cells.cpuNow.code], ["ok", undefined], "idle under the request: green, not grey");
  const noReq = run(0.2, null).cells.cpuNow;
  assert.deepEqual([noReq.level, noReq.code, noReq.abs], ["noBaseline", "noRequest", 0.2]);
  assert.equal(run(0.16, 0.1).cells.cpuNow.cpuNow!.overMinutes, null, "over-request query missing = not measured");
  const agg = aggregateHeatmap(raw({ cpuNow15: [r(P, 0.16)], cpuRequest: [r(P, 0.1)] }), {});
  assert.ok(!agg.flags.some((f) => f.metric === "cpuNow"), "not in the red strip");
  const q = heatmapQueries('cluster="a"', 60);
  assert.match(q.cpuNow15!, /\[15m\]\)\)$/);
  assert.match(q.cpuOverSteps!, /\[60m:1m\]\)$/);
});
