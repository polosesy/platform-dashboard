import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateStack, gapReason, grafanaExploreUrl, isTransient, notReadySinceQuery, pyroscopeTarget, rollup, stackQueries, withFallback, type StackRaw } from "../src/services/observabilityStack.js";
import type { ObservabilityStackResponse } from "@aud/types";
import { pickScope, scopeMatchers } from "../src/services/promScope.js";
import { parseConnections } from "../src/infra/connectionRegistry.js";
import { loadEnv } from "../src/env.js";

// Shapes measured in a customer Azure Monitor workspace (Alloy → AMW, 2026-10-23) — names are placeholders.
const C = 'cluster="aks-a"';
const r = (metric: Record<string, string>, value: number) => ({ metric, value });
const empty = (): StackRaw => Object.fromEntries(Object.keys(stackQueries(C)).map((k) => [k, []])) as unknown as StackRaw;

function fixture(over: Partial<StackRaw> = {}): StackRaw {
  return { ...empty(),
    alloyBuild: [r({ namespace: "monitor", pod: "alloy-7c4b9d6f8b-bcdfg", version: "v1.20.1" }, 1), r({ namespace: "monitor", pod: "alloy-traces-5f8d7c6b9-hjklm", version: "v1.20.1" }, 1)],
    lokiBuild: [r({ namespace: "monitor", pod: "loki-0", version: "3.7.7" }, 1)],
    tempoBuild: [r({ namespace: "monitor", pod: "tempo-0", version: "v3.1.0" }, 1)],
    rwTotal: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 1800), r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 160), r({ pod: "tempo-0" }, 140)],
    rwFailed: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 0), r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 0), r({ pod: "tempo-0" }, 0)],
    rwLag: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 0)],
    rwPending: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 1878)],
    components: [r({ pod: "alloy-7c4b9d6f8b-bcdfg", health_type: "healthy" }, 28), r({ pod: "alloy-traces-5f8d7c6b9-hjklm", health_type: "healthy" }, 12)],
    configLoad: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 1), r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 1)],
    logsSent: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 8)], logsDropped: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 0)],
    spansAccepted: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 57)],
    lokiIngest: [r({ pod: "loki-0" }, 3491)], tempoSpans: [r({ pod: "tempo-0" }, 17)], tempoDiscarded: [r({ pod: "tempo-0" }, 0)],
    upTotal: [r({ job: "prometheus.scrape.apps" }, 52), r({ job: "kube-state-metrics" }, 2), r({ job: "node" }, 5)],
    upDown: [r({ job: "prometheus.scrape.apps" }, 2)],
    upDownList: [r({ job: "prometheus.scrape.apps", namespace: "app", pod: "api-7d9f8c6b5-x2kqp" }, 0)],
    ksmAge: [r({}, 27)],
    podOwners: [
      r({ namespace: "monitor", pod: "alloy-7c4b9d6f8b-bcdfg", owner_kind: "ReplicaSet", owner_name: "alloy-7c4b9d6f8b" }, 1),
      r({ namespace: "monitor", pod: "alloy-traces-5f8d7c6b9-hjklm", owner_kind: "ReplicaSet", owner_name: "alloy-traces-5f8d7c6b9" }, 1),
      r({ namespace: "monitor", pod: "loki-0", owner_kind: "StatefulSet", owner_name: "loki" }, 1),
    ],
    rsOwners: [
      r({ namespace: "monitor", replicaset: "alloy-7c4b9d6f8b", owner_kind: "Deployment", owner_name: "alloy" }, 1),
      r({ namespace: "monitor", replicaset: "alloy-traces-5f8d7c6b9", owner_kind: "Deployment", owner_name: "alloy-traces" }, 1),
    ],
    ...over,
  };
}

test("components per workload: two Alloy deployments, Loki, Tempo, collectors from scrape jobs", () => {
  const s = aggregateStack(fixture(), C);
  assert.deepEqual(s.components.map((c) => `${c.kind}:${c.name}:${c.state}`), [
    "alloy:alloy:ok", "alloy:alloy-traces:ok", "loki:loki:ok", "tempo:tempo:ok", "kubeStateMetrics:kube-state-metrics:ok", "nodeExporter:node:ok",
  ]);
  const alloy = s.components[0]!;
  assert.equal(alloy.pods[0]!.version, "v1.20.1");
  assert.deepEqual(alloy.checks.map((c) => c.id), ["remoteWriteFailed", "remoteWriteLag", "remoteWritePending", "componentsUnhealthy", "configLoad", "logsSent", "logsDropped"]);
  assert.ok(alloy.checks.every((c) => c.promql.includes(C)), "every value carries its query");
  assert.deepEqual(s.targets[0], { job: "prometheus.scrape.apps", total: 52, down: 2 });
  assert.deepEqual(s.downTargets, [{ job: "prometheus.scrape.apps", namespace: "app", pod: "api-7d9f8c6b5-x2kqp" }]);
});

test("states are facts: failed writes degrade, nothing written = down, stale KSM, no series = unknown (not 0)", () => {
  const failing = aggregateStack(fixture({ rwFailed: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 9)] }), C);
  assert.equal(failing.components[0]!.state, "degraded");
  const silent = aggregateStack(fixture({ rwTotal: [r({ pod: "alloy-7c4b9d6f8b-bcdfg" }, 0)], rwFailed: [] }), C);
  assert.equal(silent.components[0]!.checks[0]!.state, "down");
  const stale = aggregateStack(fixture({ ksmAge: [r({}, 600)] }), C);
  assert.equal(stale.components.find((c) => c.kind === "kubeStateMetrics")!.state, "stale");
  const noRw = aggregateStack(fixture({ rwTotal: [], rwFailed: [], rwLag: [], rwPending: [] }), C);
  const c0 = noRw.components[0]!.checks[0]!;
  assert.deepEqual([c0.id, c0.value, c0.state], ["remoteWriteFailed", null, "unknown"]);
  const unhealthy = aggregateStack(fixture({ components: [r({ pod: "alloy-7c4b9d6f8b-bcdfg", health_type: "unhealthy" }, 1)] }), C);
  assert.equal(unhealthy.components[0]!.state, "degraded");
});

// stg 2026-10-29: one query (remote-write highest timestamp) held 13–30 s then 504 — the whole tab failed
test("a query that did not answer: only its values read 'query failed', never 0 / none; the rest stands", () => {
  const raw = fixture({ rwLag: [], upDown: [] });
  const s = aggregateStack(raw, C, { failed: new Set(["rwLag", "upDown"]) });
  const alloy = s.components[0]!;
  const lag = alloy.checks.find((c) => c.id === "remoteWriteLag")!;
  assert.deepEqual([lag.value, lag.state, lag.queryFailed], [null, "unknown", true]);
  assert.equal(alloy.checks.find((c) => c.id === "remoteWriteFailed")!.queryFailed, undefined, "other values stay read");
  assert.equal(alloy.state, "ok", "an unread value does not hide the measured ones");
  // No series from `count(up == 0)` = nothing down — but not when the query failed
  assert.deepEqual(s.targets.find((t) => t.job === "prometheus.scrape.apps"), { job: "prometheus.scrape.apps", total: 52, down: null });
  const ksm = s.components.find((c) => c.kind === "kubeStateMetrics")!;
  assert.deepEqual(ksm.checks.map((c) => [c.id, c.state, c.queryFailed ?? false]), [["targetsDown", "unknown", true], ["ksmAge", "ok", false]]);
  // A failed readiness query shows as unread, not as "no readiness known"
  const nr = aggregateStack(fixture(), C, { failed: new Set(["podReady"]) });
  assert.deepEqual(nr.components[0]!.checks.filter((c) => c.id === "podsReady").map((c) => c.queryFailed), [true]);
  // A writer value missing because its query failed is listed (unread), not silently dropped
  const ls = aggregateStack(fixture({ logsSent: [] }), C, { failed: new Set(["logsSent"]) });
  assert.equal(ls.components[0]!.checks.find((c) => c.id === "logsSent")?.queryFailed, true);
});

test("query errors: timeouts / 504 / 429 / network retried once; 4xx and PromQL errors are not", () => {
  const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  assert.equal(gapReason(abort), "timeout");
  assert.equal(gapReason(new Error("Prometheus 504: error: Failed to fetch response in time")), "timeout");
  assert.equal(gapReason(new Error("Prometheus 429: TooManyRequests: slow down")), "throttled");
  assert.equal(gapReason(new Error("Prometheus 400: bad_data: parse error")), "failed");
  assert.ok(isTransient(abort));
  assert.ok(isTransient(new Error("Prometheus 504: error: x")));
  assert.ok(isTransient(new Error("Prometheus 429: TooManyRequests: x")));
  assert.ok(isTransient(new Error("Prometheus 502: error: bad gateway")));
  assert.ok(isTransient(new TypeError("fetch failed")));
  assert.ok(!isTransient(new Error("Prometheus 400: bad_data: parse error")));
  assert.ok(!isTransient(new Error("Prometheus 403: Forbidden: no access")));
  assert.ok(!isTransient(new Error("Prometheus query failed: bad_data")));
});

test("a refresh that fails as a whole shows the last complete answer, marked with when and why", () => {
  const base = { clusterId: "c", windowMinutes: 10, cluster: "aks-a", components: [], targets: [], downTargets: [], grafana: null };
  const good: ObservabilityStackResponse = { ...base, generatedAt: "2026-10-29T05:00:00Z", metricsState: "ok" };
  const failed: ObservabilityStackResponse = { ...base, generatedAt: "2026-10-29T05:03:00Z", metricsState: "failed", message: "This operation was aborted" };
  assert.deepEqual(withFallback(failed, good).stale, { failedAt: "2026-10-29T05:03:00Z", state: "failed", message: "This operation was aborted" });
  assert.equal(withFallback(failed, good).generatedAt, "2026-10-29T05:00:00Z", "the values keep their own time");
  assert.equal(withFallback(failed, undefined), failed, "nothing to fall back to = the failure");
  const forbidden: ObservabilityStackResponse = { ...failed, metricsState: "forbidden" };
  assert.equal(withFallback(forbidden, good), forbidden, "a permission answer is not hidden behind old values");
});

// stg 2026-10-28 21:38–01:14Z: pyroscope-0 not Ready while Alloy kept sending (0 dropped) — the page said "정상"
const SENDING = {
  profilesSent: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 40000)],
  profilesTarget: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm", endpoint: "http://pyroscope.monitor.svc.cluster.local:4040" }, 1)],
  profilesDropped: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 0)],
};
const PYRO_OWNER = r({ namespace: "monitor", pod: "pyroscope-0", owner_kind: "StatefulSet", owner_name: "pyroscope" }, 1);

test("Pyroscope: 'sent > 0' alone is never healthy — its pods' readiness decides", () => {
  // Sent only (no target, no pods): not a verdict
  const sentOnly = aggregateStack(fixture({ profilesSent: SENDING.profilesSent }), C).components.find((c) => c.kind === "pyroscope")!;
  assert.equal(sentOnly.state, "unknown");
  assert.equal(sentOnly.readiness, undefined);
  // The incident: the Service's endpoint pod not Ready (Kubernetes API)
  const ep = aggregateStack(fixture(SENDING), C, { endpointPods: { ready: [], notReady: ["pyroscope-0"] } }).components.find((c) => c.kind === "pyroscope")!;
  assert.equal(ep.state, "degraded");
  assert.deepEqual([ep.name, ep.namespace, ep.target], ["pyroscope", "monitor", "pyroscope.monitor:4040"]);
  assert.deepEqual(ep.readiness, { basis: "endpoints", ready: 0, total: 1, notReady: [{ pod: "pyroscope-0", since: null }] });
  assert.deepEqual(ep.checks.map((c) => [c.id, c.value, c.state]), [["podsReady", 1, "degraded"], ["profilesSent", 40000, "ok"], ["profilesDropped", 0, "ok"]]);
  // A Service with no pods at all = down
  assert.equal(aggregateStack(fixture(SENDING), C, { endpointPods: { ready: [], notReady: [] } }).components.find((c) => c.kind === "pyroscope")!.state, "down");
  // No Kubernetes API: the workload named like the Service, from kube-state-metrics — basis stated
  const ksm = fixture({ ...SENDING, podOwners: [...fixture().podOwners, PYRO_OWNER], podReady: [r({ namespace: "monitor", pod: "pyroscope-0" }, 0)] });
  const byName = aggregateStack(ksm, C).components.find((c) => c.kind === "pyroscope")!;
  assert.deepEqual([byName.state, byName.readiness?.basis, byName.readiness?.ready, byName.pods.map((p) => p.pod)], ["degraded", "sameName", 0, ["pyroscope-0"]]);
  const healthy = aggregateStack({ ...ksm, podReady: [r({ namespace: "monitor", pod: "pyroscope-0" }, 1)] }, C).components.find((c) => c.kind === "pyroscope")!;
  assert.equal(healthy.state, "ok");
  // Drops are a fact even without pods
  const drops = aggregateStack(fixture({ ...SENDING, profilesTarget: [], profilesDropped: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 0.13)] }), C).components.find((c) => c.kind === "pyroscope")!;
  assert.equal(drops.state, "degraded");
  assert.equal(aggregateStack(empty(), C).components.length, 0, "absent stack pieces are simply not listed");
});

test("every component's own pods by Kubernetes readiness; the writer's target parsed from its endpoint label", () => {
  const s = aggregateStack(fixture({ podReady: [r({ namespace: "monitor", pod: "loki-0" }, 0), r({ namespace: "monitor", pod: "alloy-7c4b9d6f8b-bcdfg" }, 1)] }), C);
  const loki = s.components.find((c) => c.kind === "loki")!;
  assert.equal(loki.state, "degraded", "loki receiving bytes but not Ready");
  assert.deepEqual(loki.readiness, { basis: "self", ready: 0, total: 1, notReady: [{ pod: "loki-0", since: null }] });
  const alloy = s.components.find((c) => c.name === "alloy")!;
  assert.deepEqual([alloy.readiness?.ready, alloy.readiness?.total, alloy.state], [1, 1, "ok"]);
  assert.equal(s.components.find((c) => c.kind === "tempo")!.readiness, undefined, "no series → no readiness, not 'Ready'");
  const t = (endpoint: string) => pyroscopeTarget([r({ endpoint }, 1)]);
  assert.deepEqual(t("http://pyroscope.monitor:4040"), { service: "pyroscope", namespace: "monitor", display: "pyroscope.monitor:4040" });
  assert.equal(t("http://pyroscope.monitor.svc:4040")?.service, "pyroscope");
  assert.equal(t("https://profiles.example.com"), null, "outside the cluster → no Service to look up");
  assert.equal(t("http://pyroscope"), null, "no namespace → no guess");
  const q = notReadySinceQuery(C, "monitor", 'p"0');
  assert.ok(q.includes('pod="p\\"0"') && q.includes("[7d:1m]"), q);
});

test("rollup: worst state, unknown never hides a measured value", () => {
  assert.equal(rollup(["ok", "unknown"]), "ok");
  assert.equal(rollup(["unknown", "unknown"]), "unknown");
  assert.equal(rollup(["ok", "degraded", "stale"]), "stale");
  assert.equal(rollup(["down", "stale"]), "down");
});

test("queries: equality on the metric name, 10 m windows, scoped to the cluster", () => {
  for (const q of Object.values(stackQueries(C))) {
    assert.doesNotMatch(q, /__name__/);
    assert.match(q, /cluster="aks-a"/);
  }
  assert.match(stackQueries(C).rwTotal!, /\[10m\]/);
});

test("scope: two collectors writing the same job → one collector, never both summed", () => {
  const s = pickScope([{ cluster: "aks-a", job: "kube-state-metrics", collector: "alloy" }, { cluster: "aks-a", job: "kube-state-metrics" }], "aks-a");
  assert.deepEqual(s, { cluster: "aks-a", job: null, collector: "", basis: "exact" });
  assert.equal(scopeMatchers(s as never), 'cluster="aks-a",collector=""');
  assert.deepEqual(pickScope([{ cluster: "aks-a", job: "j", collector: "alloy" }], "aks-a"), { cluster: "aks-a", job: null, basis: "exact" });
});

test("Grafana links: Explore with the exact query; the connections file accepts only *.grafana.azure.com", () => {
  const u = grafanaExploreUrl("https://g-abc.kr.grafana.azure.com/", "prom-uid", 'up{cluster="aks-a"} == 0');
  assert.match(u, /^https:\/\/g-abc\.kr\.grafana\.azure\.com\/explore\?schemaVersion=1&orgId=1&panes=/);
  const panes = JSON.parse(decodeURIComponent(u.split("panes=")[1]!));
  assert.equal(panes.aud.queries[0].expr, 'up{cluster="aks-a"} == 0');
  const HOME = "11111111-1111-1111-1111-111111111111";
  const S1 = "22222222-2222-2222-2222-222222222222";
  const env = loadEnv({ AZURE_AD_TENANT_ID: HOME, AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: S1 });
  const parse = (endpoint: string) => () => parseConnections({ connections: [{ key: "home", displayName: "Home", tenantId: HOME, mode: "platform",
    subscriptions: [S1], aks: { observability: { grafana: { endpoint, datasources: { prometheus: "prom-uid" } } } } }] }, env);
  assert.equal(parse("https://g-abc.kr.grafana.azure.com")()[0]!.aks?.observability?.grafana?.datasources.prometheus, "prom-uid");
  assert.throws(parse("https://evil.example.com"));
  assert.throws(parse("http://g-abc.kr.grafana.azure.com"));
});

test("workload / node panels are scoped to the cluster and cached per cluster (not per endpoint)", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/services/prometheusCollector.ts"), "utf8");
  assert.doesNotMatch(src, /prom:(workloads|nodes):\$\{endpoint\}/);
  assert.match(src, /familyMatchers\(fetcher, endpoint, clusterId, "container_cpu_usage_seconds_total"/);
  assert.match(src, /familyMatchers\(fetcher, endpoint, clusterId, "node_cpu_seconds_total"/);
  assert.match(src, /group by \(cluster, job, collector\)/);
});
