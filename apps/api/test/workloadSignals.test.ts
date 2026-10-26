import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateHeatmap, heatmapQueries, levelOf, type HeatRaw } from "../src/services/workloadHeatmap.js";
import { eventBelongs, mapEvents } from "../src/services/kubeEvents.js";
import { redactLogLine, redactLogText } from "../src/services/logRedaction.js";
import { ERROR_FILTER, logQueries, lokiStateOf, parseLogLine, re2, summarizeLokiDrops, workloadSelector } from "../src/services/lokiLogs.js";

// Shapes measured in a customer Azure Monitor workspace / cluster (2026-10-23) — names are placeholders.
const r = (metric: Record<string, string>, value: number) => ({ metric, value });
const LE = { metric: "loki_process_custom_app_log_errors_total", podLabel: "exported_pod" };

function raw(over: Partial<HeatRaw> = {}): HeatRaw {
  return {
    "family:jvm_memory_usage_after_gc": [r({}, 17)], "family:http_server_requests_seconds_count": [r({}, 40)],
    "family:hikaricp_connections_active": [r({}, 9)], "family:hikaricp_connections_pending": [r({}, 9)],
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
    cpuRatio: [r({ namespace: "app", pod: "api-7d9f8c6b5-bcdfg" }, 0.4)],
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

test("heatmap: missing families are notMeasured with a null flag; flags count the strip's levels", () => {
  const s = aggregateHeatmap(raw({ "family:hikaricp_connections_pending": [], poolPending: [] }), {});
  assert.deepEqual(s.missing, ["logErrors", "poolPending"].sort((a, b) => ["ready", "memory", "cpu", "restarts", "oldGen", "http5xx", "logErrors", "poolUsage", "poolPending"].indexOf(a) - ["ready", "memory", "cpu", "restarts", "oldGen", "http5xx", "logErrors", "poolUsage", "poolPending"].indexOf(b)));
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
  assert.equal(levelOf("cpu", 1.5), "danger");
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
