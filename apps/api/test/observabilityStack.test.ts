import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateStack, grafanaExploreUrl, rollup, stackQueries, type StackRaw } from "../src/services/observabilityStack.js";
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

test("Pyroscope is seen only through what Alloy sends it; absent stack pieces are simply not listed", () => {
  const s = aggregateStack(fixture({ profilesSent: [r({ pod: "alloy-traces-5f8d7c6b9-hjklm" }, 40000)] }), C);
  const p = s.components.find((c) => c.kind === "pyroscope")!;
  assert.deepEqual([p.state, p.pods.length, p.checks[0]!.id], ["ok", 0, "profilesSent"]);
  assert.equal(aggregateStack(empty(), C).components.length, 0);
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
