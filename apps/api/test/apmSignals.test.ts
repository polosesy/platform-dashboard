import { test } from "node:test";
import assert from "node:assert/strict";
import type { RedService, ServiceGraphResponse } from "@aud/types";
import { RED_MIN_REQUESTS } from "../src/services/workloadRed.js";
import * as sigNs from "../../web/src/lib/apmSignals.ts";

const S = ((sigNs as unknown as { default?: typeof sigNs }).default ?? sigNs) as typeof sigNs;

// Synthetic (2026-11-18 — 서비스 맵 신호 · 목록 · 계측 범위): the rules are facts with a stated threshold — any error,
// a higher p95 bucket than a week ago, ×2 / ½ requests — and nothing is judged under RED_MIN_REQUESTS.
const node = (service: string, ns: string | null, workload: string | null, failed = 0, entry = false): ServiceGraphResponse["nodes"][number] => ({
  service, entry, namespace: ns, workload: workload ? { namespace: ns!, name: workload, kind: "Deployment" } : null,
  inbound: { requests: 100, failed, errorRate: failed / 100 }, outbound: { requests: 0, failed: 0 },
});
const edge = (client: string, server: string): ServiceGraphResponse["edges"][number] => ({
  client, server, kind: "direct", requests: 10, rate: 0.1, failed: 0, errorRate: 0, p95: null, p99: null, lowTraffic: false,
});
const red = (service: string, requests: number, errors: number, p95: number | null, week?: { requests: number; p95: number | null }, workload?: string): RedService => ({
  service, workload: workload ? { namespace: "shop", name: workload, kind: "Deployment" } : null, sameName: workload ? 1 : 0,
  requests, rate: requests / 3600, errors, errorRate: requests ? errors / requests : null,
  p50: null, p95: p95 === undefined ? null : { le: p95 }, p99: null,
  ...(week ? { weekAgo: { requests: week.requests, rate: week.requests / 3600, errors: 0, errorRate: 0, p95: { le: week.p95 } } } : {}),
} as unknown as RedService);

const graph = {
  nodes: [node("user", null, null, 0, true), node("web", "shop", "web"), node("orders", "shop", "orders", 3), node("pay", "shop", "pay"), node("quiet", "shop", "quiet")],
  edges: [edge("user", "web"), edge("web", "orders"), edge("web", "pay"), edge("orders", "pay"), edge("orders", "orders")],
};

test("the web rule's minimum = the API's RED_MIN_REQUESTS", () => {
  assert.equal(S.SIGNAL_MIN_REQUESTS, RED_MIN_REQUESTS);
});

test("signals: errors (spans before graph), slower p95 bucket than a week ago, ×2 / ½ volume; callers and callees", () => {
  const sig = S.serviceSignals(graph, [
    red("web", 1000, 0, 0.25, { requests: 1000, p95: 0.1 }),       // slower bucket → latency
    red("orders", 400, 0, 0.1, { requests: 1000, p95: 0.1 }),      // 0.4× → volume; errors from the graph (3 failed in)
    red("pay", 300, 7, 0.1, { requests: 100, p95: null }),         // 3× → volume; 7 error spans; p95 below a week ago's "> last bucket"
    red("quiet", 10, 0, 0.5, { requests: 5, p95: 0.1 }),           // under 20 on both sides: nothing judged
  ]);
  assert.equal(sig.has("user"), false, "callers outside the traces carry no signals");
  assert.deepEqual(sig.get("web"), { callers: 1, callees: 2, latency: { now: { le: 0.25 }, weekAgo: { le: 0.1 } } });
  assert.deepEqual(sig.get("orders")!.error, { count: 3, rate: 0.03, basis: "graph" });
  assert.deepEqual(sig.get("orders")!.volume, { now: 400, weekAgo: 1000, ratio: 0.4 });
  assert.equal(sig.get("orders")!.callees, 1, "the self call (its own queue) is not a callee");
  assert.deepEqual(sig.get("pay")!.error, { count: 7, rate: 7 / 300, basis: "spans" });
  assert.equal(sig.get("pay")!.latency, undefined, "lower than '> last bucket' a week ago");
  assert.equal(sig.get("pay")!.callers, 2);
  assert.deepEqual(sig.get("quiet"), { callers: 0, callees: 0 });
  assert.deepEqual(S.signalCounts(sig), { error: 2, latency: 1, volume: 2 });
  assert.deepEqual([...S.withSignal(sig, "volume")!].sort(), ["orders", "pay"]);
  assert.equal(S.withSignal(sig, null), null);
  // no RED: only the graph's failures
  assert.deepEqual(S.signalCounts(S.serviceSignals(graph, null)), { error: 1, latency: 0, volume: 0 });
  // a service with requests now and none a week ago: "new" (ratio null)
  assert.deepEqual(S.serviceSignals(graph, [red("web", 50, 0, 0.1, { requests: 0, p95: null })]).get("web")!.volume, { now: 50, weekAgo: 0, ratio: null });
});

test("coverage: scope = namespaces with traced workloads; untraced = their other running workloads; unmatched services apart", () => {
  const workloads = [
    { namespace: "shop", workload: "web", kinds: [{ kind: "jvm" }] },
    { namespace: "shop", workload: "orders", kinds: [] },
    { namespace: "shop", workload: "pay", kinds: [] },
    { namespace: "shop", workload: "quiet", kinds: [] },
    { namespace: "shop", workload: "batch-report", kinds: [{ kind: "python" }] },
    { namespace: "shop", workload: "cart-legacy", kinds: [{ kind: "nodejs" }] },
    { namespace: "kube-system", workload: "coredns", kinds: [{ kind: "go" }] },
  ];
  const g = { nodes: [...graph.nodes, node("cart", "shop", null)] };
  const c = S.instrumentationCoverage(g, [red("ledger", 30, 0, 0.1, undefined, "ledger-api")], workloads);
  assert.deepEqual(c.namespaces, ["shop"], "kube-system has no traced workload — out of scope, not guessed");
  assert.equal(c.total, 6);
  assert.deepEqual(c.untraced.map((w) => w.workload), ["batch-report", "cart-legacy"]);
  assert.deepEqual(c.untraced[0]!.kinds, ["python"]);
  assert.equal(c.traced, 4);
  assert.deepEqual(c.unmatchedServices, ["cart"], "cart matches no workload by name — said, not guessed onto cart-legacy");
});
