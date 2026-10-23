import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateHubbleMetrics, hubbleQueries, metricsStateOf, metricsWindow, pickScope, promString, type MetricsInput } from "../src/services/hubbleMetrics.js";
import { ownerIndex, resolveWorkload, workloadFromPodName } from "../src/services/workloadOwners.js";
import { pickSource } from "../src/services/hubbleSources.js";
import { AVAILABILITY_KQL, flowLogsKql, rowToHubbleFlow } from "../src/services/containerNetworkLogs.js";
import { HttpError } from "../src/infra/requestParams.js";

// Shapes measured on AKS ACNS (Cilium 1.19) Managed Prometheus, 2026-10-23 — names are placeholders.

test("scope: the cluster label as it is spelled; a sole other value is an alias; several without a match are refused", () => {
  assert.deepEqual(pickScope([{ cluster: "aks-a", job: "prometheus.scrape.hubble" }], "aks-a"), { cluster: "aks-a", job: null, basis: "exact" });
  assert.deepEqual(pickScope([{ cluster: "AKS-A", job: "j" }, { cluster: "aks-b", job: "j" }], "aks-a"), { cluster: "AKS-A", job: null, basis: "exact" });
  assert.deepEqual(pickScope([{ cluster: "stg-alias", job: "j" }], "aks-a"), { cluster: "stg-alias", job: null, basis: "alias" });
  assert.equal(pickScope([{ cluster: "x", job: "j" }, { cluster: "y", job: "j" }], "aks-a"), "ambiguous");
  assert.deepEqual(pickScope([{ job: "j" }], "aks-a"), { cluster: null, job: null, basis: "unscoped" });
  assert.equal(pickScope([], "aks-a"), null);
  const doubled = pickScope([{ cluster: "aks-a", job: "prometheus.scrape.hubble" }, { cluster: "aks-a", job: "networkobservability-hubble" }], "aks-a");
  assert.deepEqual(doubled, { cluster: "aks-a", job: "networkobservability-hubble", basis: "exact" }, "two collectors: one job, never both summed");
});

test("queries: equality matchers only, no regex on the metric name or cluster, whitelisted windows", () => {
  const q = hubbleQueries({ cluster: "aks-a", job: "networkobservability-hubble", basis: "exact" }, 15);
  for (const v of Object.values(q)) {
    assert.doesNotMatch(v, /__name__\s*=~/);
    assert.doesNotMatch(v, /cluster\s*=~/);
    assert.match(v, /cluster="aks-a"/);
  }
  assert.match(q.sides!, /job="networkobservability-hubble"/);
  assert.doesNotMatch(q.podOwners!, /job=/, "kube-state-metrics comes from another job");
  assert.match(q.sides!, /\[15m\]/);
  assert.throws(() => metricsWindow(2880), /window/);
  assert.throws(() => promString('a"\n'), /control/);
  assert.equal(promString('a"b'), '"a\\"b"');
});

const owners = ownerIndex(
  [{ namespace: "app", name: "web-7d9f8c6b5-x2kqp", ownerKind: "ReplicaSet", ownerName: "web-7d9f8c6b5" },
   { namespace: "monitor", name: "tempo-0", ownerKind: "StatefulSet", ownerName: "tempo" },
   { namespace: "kube-system", name: "cilium-x7k2p", ownerKind: "DaemonSet", ownerName: "cilium" }],
  [{ namespace: "app", name: "web-7d9f8c6b5", ownerKind: "Deployment", ownerName: "web" }],
);

test("workloads: owner series first (ReplicaSet → Deployment, StatefulSet), the name pattern otherwise; non-pods never", () => {
  assert.deepEqual(resolveWorkload("app/web-7d9f8c6b5-x2kqp", owners), { namespace: "app", workload: "web", kind: "Deployment", basis: "owner" });
  assert.deepEqual(resolveWorkload("monitor/tempo-0", owners), { namespace: "monitor", workload: "tempo", kind: "StatefulSet", basis: "owner" });
  assert.deepEqual(resolveWorkload("batch/report-28903440-bcdfg", owners), { namespace: "batch", workload: "report-28903440", kind: null, basis: "pattern" });
  assert.equal(resolveWorkload("10.224.0.5", owners), null);
  assert.equal(resolveWorkload("", owners), null);
  assert.equal(workloadFromPodName("app-redis"), "app-redis", "a real word is not a random suffix");
  assert.equal(workloadFromPodName("api-6f9c8d7b4c-hmhx6"), "api");
  assert.equal(workloadFromPodName("pyroscope-0"), "pyroscope");
});

const row = (metric: Record<string, string>, value: number) => ({ metric, value });
const input = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  families: new Set(["hubble_drop_total", "hubble_dns_responses_total", "hubble_lost_events_total"]),
  sides: [row({ source: "app/web-7d9f8c6b5-x2kqp" }, 100.4), row({ destination: "app/web-7d9f8c6b5-x2kqp" }, 50), row({ source: "10.224.0.5" }, 7), row({}, 300)],
  verdicts: [row({ verdict: "forwarded" }, 450), row({ verdict: "dropped" }, 5)],
  protocols: [row({ protocol: "tcp" }, 400), row({ protocol: "icmpv6" }, 0)],
  policyVerdicts: [row({ verdict: "forwarded" }, 20), row({ verdict: "redirected" }, 4)],
  drops: [row({ source: "monitor/tempo-0", reason: "policy_denied" }, 3), row({ reason: "unsupported_l3_protocol" }, 2)],
  dns: [row({ source: "kube-system/coredns-76df789c68-j2bpt", rcode: "non-existent domain" }, 6135), row({ source: "kube-system/coredns-76df789c68-j2bpt", rcode: "No Error" }, 99)],
  lost: 900, podOwners: [], rsOwners: [], ...over,
});

test("aggregation: per-workload sent/received, unattributed kept apart, no edges, NXDOMAIN on the server side", () => {
  const s = aggregateHubbleMetrics({ ...input(), podOwners: [...owners.pods.values()], rsOwners: [...owners.replicaSets.values()] });
  const web = s.workloads.find((w) => w.workload === "web")!;
  assert.deepEqual([web.kind, web.basis, web.pods, web.egressEvents, web.ingressEvents], ["Deployment", "owner", 1, 100, 50]);
  assert.deepEqual(s.unattributed, { egressEvents: 7, ingressEvents: 0, unlabelledEvents: 300 });
  assert.deepEqual(s.byVerdict, { forwarded: 450, dropped: 5, redirected: 0, error: 0 });
  assert.deepEqual(s.protocols, [{ protocol: "tcp", events: 400 }]);
  assert.deepEqual(s.dropsByReason, [{ reason: "policy_denied", count: 3 }, { reason: "unsupported_l3_protocol", count: 2 }]);
  assert.deepEqual(s.policyDenied, [{ namespace: "monitor", workload: "tempo", kind: "StatefulSet", basis: "owner", direction: "EGRESS", count: 3 }]);
  assert.deepEqual(s.dnsErrors, [{ rcode: "non-existent domain", namespace: "kube-system", workload: "coredns", side: "server", count: 6135 }]);
  assert.equal(s.lostEvents, 900);
  assert.deepEqual(s.missing, []);
  assert.ok(!("edges" in s));
});

test("an absent metric family is listed and its fields are null, never 0", () => {
  const s = aggregateHubbleMetrics(input({ families: new Set(), drops: [], dns: [], lost: null }));
  assert.deepEqual(s.missing, ["hubble_drop_total", "hubble_dns_responses_total", "hubble_lost_events_total"]);
  assert.equal(s.lostEvents, null);
  assert.ok(s.workloads.every((w) => w.drops === null && w.dnsErrors === null && w.policyDenied === null));
});

test("failure states: 403 forbidden, 429 throttled, anything else failed", () => {
  assert.equal(metricsStateOf(new Error("Prometheus 403: Forbidden: no access")).state, "forbidden");
  assert.equal(metricsStateOf(new HttpError(403, "connection_forbidden", "x")).state, "forbidden");
  assert.equal(metricsStateOf(new Error("Prometheus 429: TooManyRequests")).state, "throttled");
  assert.equal(metricsStateOf(new Error("timeout")).state, "failed");
});

test("source order: exec > flow logs with rows > metrics > none", () => {
  const f = (exec: boolean, logs: "ok" | "notEnabled", metrics: "ok" | "noWorkspace") =>
    pickSource({ exec: { allowed: exec }, flowLogs: { state: logs, rows1h: logs === "ok" ? 120 : 0, newest: null }, metrics: { state: metrics } });
  assert.equal(f(true, "ok", "ok"), "exec");
  assert.equal(f(false, "ok", "ok"), "flowLogs");
  assert.equal(f(false, "notEnabled", "ok"), "metrics");
  assert.equal(f(false, "notEnabled", "noWorkspace"), "none");
});

test("flow logs: KQL filters only through kqlString / whitelists; a missing table is 0 rows", () => {
  assert.match(AVAILABILITY_KQL, /union isfuzzy=true/);
  const k = flowLogsKql({ minutes: 15, limit: 500, namespace: "a'b", verdict: "dropped", type: "policy-verdict" });
  assert.match(k, /SourceNamespace == 'a\\'b'|SourceNamespace == "a'b"/);
  assert.match(k, /Verdict == 'DROPPED'|Verdict == "DROPPED"/);
  assert.match(k, /toint\(EventType\.type\) == 5/);
  assert.doesNotMatch(flowLogsKql({ minutes: 15, limit: 10, verdict: "x) | take 1" }), /take 1/, "unknown verdict ignored");
});

test("flow logs: a row in Hubble's flow shape becomes a HubbleFlow; absent fields stay empty", () => {
  const f = rowToHubbleFlow({
    TimeGenerated: "2026-10-23T01:00:00Z", Verdict: "FORWARDED", TrafficDirection: "EGRESS", Reply: false, NodeName: "node-a",
    IP: JSON.stringify({ source: "10.0.0.5", destination: "203.0.113.10" }),
    Layer4: { TCP: { source_port: 40000, destination_port: 443, flags: { SYN: true } } },
    SourceNamespace: "app", SourcePodName: "web-7d9f8c6b5-x2kqp", SourceIdentity: 25841, SourceWorkloads: [{ name: "web", kind: "Deployment" }],
    DestinationIdentity: 2, EventType: { type: 5 },
    Policies: [{ name: "app-egress", namespace: "app", kind: "CiliumNetworkPolicy" }],
  });
  assert.equal(f.source.workloadName, "web");
  assert.deepEqual([f.l4Protocol, f.destinationPort, f.tcpFlags, f.eventKind], ["TCP", 443, "SYN", "policy-verdict"]);
  assert.deepEqual(f.allowedBy, [{ name: "app-egress", namespace: "app", kind: "CiliumNetworkPolicy" }]);
  const bare = rowToHubbleFlow({ TimeGenerated: "t", Verdict: "weird" });
  assert.deepEqual([bare.verdict, bare.l4Protocol, bare.destinationPort, bare.allowedBy], ["FORWARDED", "UNKNOWN", 0, undefined]);
});

test("a cluster's workspace is read with the cluster's connection — never the home one by default", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/infra/azureClientFactory.ts"), "utf8");
  assert.doesNotMatch(src, /homeConnection\(env\), PROMETHEUS_SCOPE/);
  const collectors = readFileSync(join(import.meta.dirname, "../src/services/prometheusCollector.ts"), "utf8");
  assert.doesNotMatch(collectors, /getPrometheusFetcherAuto\(env, bearerToken\)/, "every call names the cluster");
  assert.match(collectors, /AZURE_PROMETHEUS_ENDPOINT && clusterConnection\(env, clusterId\)\.connection\.key === homeConnection\(env\)\.key/);
});
