// AKS 모니터링 › 로그 › 로그 지표 (API services/lokiLogs.ts getLogInsights, web lib/logInsightsView.ts): the
// namespace's logs as counts — per workload (from the pod name, no site-specific Loki label), exception classes,
// ERROR lines over time; a part Loki did not answer is null + a gap, never 0.
// Also the regression of 2026-11-11: sibling tab components shared one React key and were drawn twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getLogInsights, insightQueries, summarizeInsights, workloadOfPod } from "../src/services/lokiLogs.js";
import * as viewNs from "../../web/src/lib/logInsightsView.ts";

const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const END = Date.parse("2026-11-11T07:00:00Z");
const vec = (pod: string, n: number, extra: Record<string, string> = {}) => ({ metric: { pod, ...extra }, value: [END / 1000, String(n)] as [number, string] });

test("workload from the pod name: Deployment · StatefulSet · DaemonSet shapes; anything else is itself", () => {
  assert.equal(workloadOfPod("console-service-6c5678cf88-42b84"), "console-service");
  assert.equal(workloadOfPod("redis-master-0"), "redis-master");
  assert.equal(workloadOfPod("fluentd-x7k2p"), "fluentd");
  assert.equal(workloadOfPod("standalone"), "standalone");
  assert.equal(workloadOfPod("job-with-vowel-aeiou"), "job-with-vowel-aeiou", "a word is not a generated suffix");
});

test("queries: counts by pod over the window, the customer's ANSI-aware ERROR / WARN patterns, exception names by regexp", () => {
  const q = insightQueries('{namespace="app"}', 60);
  assert.match(q.errors, /^sum by \(pod\) \(count_over_time\(\{namespace="app"\} \|~ ".*\(ERROR\|FATAL\).*" \[60m\]\)\)$/);
  assert.match(q.warns, /WARN/);
  assert.match(q.exceptions, /sum by \(pod, exc\).*regexp .*\(\?P<exc>.*\| exc!=""/);
  assert.match(q.timeline, /\[120s\]\)\)$/, "30 buckets over the window");
  assert.match(insightQueries('{namespace="app"}', 5).timeline, /\[10s\]/);
});

test("summary: pods summed into workloads, most errors first; classes distinct over workloads; top 15", () => {
  const s = summarizeInsights({
    errors: [vec("api-7d9f8c6b5-bcdfg", 10), vec("api-7d9f8c6b5-hjklm", 4), vec("db-0", 1)],
    warns: [vec("api-7d9f8c6b5-bcdfg", 3), vec("worker-x7k2p", 9)],
    exceptions: [vec("api-7d9f8c6b5-bcdfg", 8, { exc: "CommonException" }), vec("api-7d9f8c6b5-hjklm", 6, { exc: "CommonException" }), vec("db-0", 1, { exc: "SQLException" }), vec("db-0", 0, { exc: "Zero" })],
    timeline: [],
  }, { minutes: 60, endMs: END });
  assert.deepEqual([s.errors, s.warns], [15, 12]);
  assert.deepEqual(s.services, [{ workload: "api", errors: 14, warns: 3 }, { workload: "db", errors: 1, warns: 0 }, { workload: "worker", errors: 0, warns: 9 }]);
  assert.deepEqual(s.exceptions, [{ workload: "api", cls: "CommonException", count: 14 }, { workload: "db", cls: "SQLException", count: 1 }]);
  assert.equal(s.exceptionClasses, 2);
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(s.timeline?.buckets.reduce((a, b) => a + b, 0), 0);
});

test("summary: a part Loki did not answer is null and a gap — not 0", () => {
  const s = summarizeInsights({ errors: [vec("api-7d9f8c6b5-bcdfg", 2)], warns: null, exceptions: null, timeline: null }, { minutes: 60, endMs: END });
  assert.deepEqual([s.errors, s.warns, s.exceptions, s.exceptionClasses, s.timeline], [2, null, null, null, null]);
  assert.deepEqual(s.gaps, ["warns", "exceptions", "timeline"]);
});

test("timeline: each point lands in the bucket its step ends in; per workload, total = the sum", () => {
  const start = END / 1000 - 3600;
  const s = summarizeInsights({
    errors: [], warns: [], exceptions: [],
    timeline: [
      { metric: { pod: "api-7d9f8c6b5-bcdfg" }, values: [[start + 120, "2"], [start + 3600, "5"]] },
      { metric: { pod: "db-0" }, values: [[start + 120, "1"]] },
    ],
  }, { minutes: 60, endMs: END });
  const tl = s.timeline!;
  assert.equal(tl.buckets.length, 30);
  assert.equal(tl.stepSeconds, 120);
  assert.deepEqual([tl.buckets[0], tl.buckets[29], tl.buckets.reduce((a, b) => a + b, 0)], [3, 5, 8]);
  assert.deepEqual(tl.byWorkload.map((w) => w.workload), ["api", "db"]);
  assert.equal(tl.start, new Date(start * 1000).toISOString());
});

test("the read: signed-in only, windows up to 6 hours, a namespace name", async () => {
  const env = { AUD_ANONYMOUS_SP: false, AUD_ANONYMOUS_K8S: false } as never;
  const C = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks";
  await assert.rejects(getLogInsights(env, undefined, C, { namespace: "app", minutes: 60 }), (e: unknown) => (e as { code?: string }).code === "signin_required");
  await assert.rejects(getLogInsights(env, "t", C, { namespace: "app", minutes: 1440 }), (e: unknown) => (e as { code?: string }).code === "invalid_window");
  await assert.rejects(getLogInsights(env, "t", C, { namespace: 'app"} or {x="', minutes: 60 }), (e: unknown) => (e as { code?: string }).code === "invalid_name");
  const routes = readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8");
  assert.match(routes, /"\/api\/observability\/log-insights", requireRole\(env, "operator"\)/);
  assert.match(routes, /log-insights[\s\S]{0,400}podLogNamespaceAllowed\(env, clusterId, namespace!\)/, "the pod-log gate");
});

test("view: bars relative to the tallest bucket, the peak, which pod opens for a workload", () => {
  const bars = V.timelineBars({ start: "2026-11-11T06:00:00.000Z", stepSeconds: 120, buckets: [0, 1, 50, 0], byWorkload: [] });
  assert.deepEqual(bars.map((b) => b.height), [0, 4, 100, 0], "a small non-zero count stays visible");
  assert.equal(bars[2]!.start, "2026-11-11T06:04:00.000Z");
  assert.equal(V.peakBucket(bars)?.count, 50);
  assert.equal(V.peakBucket(V.timelineBars({ start: "2026-11-11T06:00:00.000Z", stepSeconds: 120, buckets: [0, 0], byWorkload: [] })), null);
  assert.deepEqual(V.timelineBars(null), []);
  const pods = ["api-gateway-7d9f8c6b5-bcdfg", "api-7d9f8c6b5-hjklm", "db-0"];
  assert.equal(V.firstPodOf(pods, "api"), "api-7d9f8c6b5-hjklm", "a longer name sharing the prefix is another workload");
  assert.equal(V.firstPodOf(pods, "db"), "db-0");
  assert.equal(V.firstPodOf(pods, "gone"), null);
  assert.deepEqual([V.shareOf(5, 20), V.shareOf(5, 0), V.shareOf(5, null)], [25, 0, 0]);
});

test("regression: tab components are siblings — each has its own key (one shared key drew the heatmap twice and left it on other tabs)", () => {
  const page = readFileSync(new URL("../../web/src/app/observability/page.tsx", import.meta.url), "utf8");
  const keys = [...page.matchAll(/<(\w+) key=\{([^}]+)\}/g)].map((m) => m[2]!);
  assert.ok(keys.length >= 6);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys among siblings: ${keys.join(" | ")}`);
  assert.ok(keys.every((k) => k.includes("clusterId")), "still one cluster's state each");
  assert.doesNotMatch(page, /key=\{clusterId\}/);
  const msgs = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const has = (k: string) => new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`).test(msgs);
  for (const k of [
    ...["notConfigured", "unreachable", "busy", "failed"].flatMap((s) => [`ob.li.state.${s}`, `ob.li.stateHint.${s}`]),
    ...["errors", "warns", "exceptions", "timeline"].map((g) => `ob.li.gap.${g}`),
  ]) assert.ok(has(k), k);
});
