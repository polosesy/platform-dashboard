// 2026-11-11 platform audit — one regression test per class of bug that was found and fixed:
//   • in-cluster backends without their own authentication (Loki · Hubble UI) answered anonymous requests
//   • cache keys that were a count, or left out what the result depends on
//   • a failed read turned into an empty / healthy / sample answer
//   • the web showed another selection's data (useApiQuery kept the previous key's data) and local state survived a
//     cluster / subscription switch
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentKey } from "../src/infra/cacheManager.js";
import { assertSignedInForCluster, defaultSubscriptions } from "../src/infra/azureClientFactory.js";
import { isMissingTable } from "../src/services/containerInsightsCollector.js";
import { getLokiDrops, getPodLogsFromLoki, getWorkloadLogs } from "../src/services/lokiLogs.js";
import { getFlowsFromHubbleUi } from "../src/services/hubbleUiSource.js";
import { getObservabilitySources } from "../src/services/observabilitySources.js";
import { getHubbleSources } from "../src/services/hubbleSources.js";
import * as rangeNs from "../../web/src/lib/timeRange.ts";

const R = ((rangeNs as unknown as { default?: typeof rangeNs }).default ?? rangeNs) as typeof rangeNs;
const api = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const web = (p: string) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), "utf8");
const CLUSTER = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks";
const env = (over: Record<string, unknown> = {}) => ({ AUD_ANONYMOUS_SP: false, AUD_ANONYMOUS_K8S: false, ...over }) as never;

test("in-cluster backends: no token = signin_required before any config or network read (Loki drops · logs · Hubble UI · probes)", async () => {
  assert.throws(() => assertSignedInForCluster(env(), undefined), /Sign in/);
  assert.doesNotThrow(() => assertSignedInForCluster(env(), "token"));
  assert.throws(() => assertSignedInForCluster(env({ AUD_ANONYMOUS_SP: true }), undefined), /Sign in/, "the master switch alone is not the Kubernetes opt-in");
  assert.doesNotThrow(() => assertSignedInForCluster(env({ AUD_ANONYMOUS_SP: true, AUD_ANONYMOUS_K8S: true }), undefined));
  const signin = (e: unknown) => (e as { code?: string }).code === "signin_required";
  await assert.rejects(getLokiDrops(env(), undefined, CLUSTER, 60, async () => null), signin);
  await assert.rejects(getPodLogsFromLoki(env(), undefined, CLUSTER, { namespace: "app", pod: "p", minutes: 60, limit: 10 }), signin);
  await assert.rejects(getWorkloadLogs(env(), undefined, CLUSTER, { namespace: "app", workload: "w", errorsOnly: true, minutes: 60 }), signin);
  await assert.rejects(getFlowsFromHubbleUi(env(), undefined, CLUSTER, { limit: 10 }), signin);
  await assert.rejects(getObservabilitySources(env(), undefined, CLUSTER), signin);
  await assert.rejects(getHubbleSources(env(), undefined, CLUSTER), signin);
});

test("cache keys name what the result depends on — never a count", () => {
  assert.notEqual(contentKey(["a", "b"]), contentKey(["a", "c"]));
  assert.notEqual(contentKey(["ab"]), contentKey(["a", "b"]), "parts are separated");
  assert.equal(contentKey(["a", "b"]), contentKey(["a", "b"]));
  for (const f of ["services/connectionMonitorCollector.ts", "services/appInsightsDependencyCollector.ts", "services/nsgFlowLogCollector.ts"]) {
    const src = api(f);
    assert.doesNotMatch(src, /cacheKey = [^\n]*edges\.length/, `${f}: keyed by the edge count`);
    assert.match(src, /cacheKey = `\$\{cachePrefix\(bearerToken\)\}[^\n]*contentKey\(/, `${f}: caller + diagram`);
  }
  assert.match(api("services/metricsCollector.ts"), /:metrics:\$\{azureResourceId\}:\$\{contentKey\(/, "metric values are the bindings'");
  assert.match(api("services/edgeDetailService.ts"), /vmss-inst:\$\{vmssResourceId\}:\$\{\(aksClusterArmId/, "with / without the cluster are different answers");
  const live = api("services/liveAggregator.ts");
  assert.match(live, /const seriesScope = storeKey\(diagramOwner\(bearerToken\), diagramId\)/, "trend series are the owner's");
  assert.doesNotMatch(live, /`\$\{diagramId\}:\$\{nodeSpec\.id\}/);
});

test("a failed read is an error — not empty, not healthy, not sample data", () => {
  // the NSG panel: sample rules only for sample resources; a real NSG that fails throws
  const liveRoute = api("routes/liveDiagram.ts");
  assert.match(liveRoute, /if \(isSampleResource\(resourceId\)\) \{[^}]*mockNsgRules\(\)/);
  assert.match(liveRoute, /fetchNsgInfo\(env, req\.auth\?\.bearerToken, resourceId, \{ strict: true \}\)/);
  assert.doesNotMatch(liveRoute, /nsg \?\? \{/);
  // Container Insights pod logs: only "no such table" falls through; anything else is a failure
  assert.ok(isMissingTable(new Error("LogAnalytics 400: SemanticError: 'ContainerLogV2' could not be resolved")));
  assert.ok(!isMissingTable(new Error("LogAnalytics 403: AuthorizationFailed")));
  assert.ok(!isMissingTable(new Error("LogAnalytics 429: too many requests")));
  assert.match(api("services/containerInsightsCollector.ts"), /if \(entries\.length === 0 && readFailure\) throw new PodLogReadError\(readFailure\)/);
  // resource health: every subscription failing is an error; a partial read is not cached
  const health = api("services/health.ts");
  assert.match(health, /if \(failed && failed === perSubResults\.length\) throw/);
  assert.match(health, /if \(!failed\) healthCache\.set\(/);
  assert.match(health, /eventsResults\.every\(\(r\) => r\.status === "rejected"\)\) throw/);
  // Hubble: no agent answered = an error (was "no traffic · 0 drops")
  assert.match(api("services/hubbleClient.ts"), /if \(discovery\.total > 0\) throw new HttpError\(502, "hubble_collect_failed"/);
  // Loki: an answer over the body limit is not "no lines"; the drop counts say when they are a floor
  const loki = api("services/lokiLogs.ts");
  assert.match(loki, /if \(lines\.truncated\) return \{ \.\.\.base, state: "failed"/);
  assert.match(loki, /all\.length >= DROP_LINE_LIMIT \? \{ truncated: true \}/);
  // the exporter check compares the same window on both sides
  const hubble = api("routes/hubble.ts");
  assert.match(hubble, /getHubbleMetricsSummary\(env, req\.auth\?\.bearerToken, clusterId, minutes\)/);
  assert.match(hubble, /hasMore: flows\.length >= limit/);
});

test("secure score: ARM's percentage is a ratio (0–1) — the page's number comes from current / max", () => {
  // (2026-11-13) the old /api/security/score and its service are gone; the posture computes the same way
  const src = api("services/securityPosture.ts");
  assert.match(src, /percentage: max > 0 \? Math\.round\(\(current \/ max\) \* 1000\) \/ 10/);
  assert.ok(!src.includes("properties.percentage"), "never ARM's 0–1 ratio as a percent");
});

test("a read without a subscription defaults to what the caller's role can read (or all → refused as an error, never sample)", () => {
  assert.equal(typeof defaultSubscriptions, "function");
  for (const f of ["kubernetes", "securityPosture", "reservations", "health", "cost", "azureEndpoints", "privateLinkUsageCollector"]) {
    assert.match(api(`services/${f}.ts`), /defaultSubscriptions\(env, bearerToken\)/, f);
  }
});

test("web: useApiQuery only ever returns the current key's data; panels are one selection's", () => {
  const hook = web("lib/useApiQuery.ts");
  assert.match(hook, /data: key !== null && state\.dataKey === key \? state\.data : undefined/);
  assert.match(hook, /setState\(\{ key: effectiveKey, data, dataKey: key \}\)/);
  const page = web("app/observability/page.tsx");
  for (const c of ["WorkloadHeatmap", "EventsSection", "SloTab", "NodeMaintenancePanel", "LogsTab", "StackTab"]) {
    const at = page.indexOf(`<${c} key={\``);
    assert.ok(at >= 0 && page.slice(at, at + 80).includes(":${clusterId}`} clusterId={clusterId}"), `${c}: another cluster starts clean (its own key — siblings must not share one)`);
  }
  assert.match(web("app/observability/components/WorkloadHeatmap.tsx"), /<WorkloadHeatPanel key=\{heatKey\(sel\)\}/, "another tile = a new panel");
  assert.match(web("app/health/page.tsx"), /<InstanceHealthPanel\s+key=\{subscriptionId\}/);
  assert.match(web("app/health/page.tsx"), /regionalError \? <ErrorNotice/);
  assert.match(web("app/architecture/hooks/useTeamArrangement.ts"), /useOnChange\(subscriptionId, \(\) => \{ setTeam\(null\); setConflict\(false\); \}\)/);
  assert.match(web("app/live-diagram/page.tsx"), /edgeDetailState\.edgeId === selectedEdgeId \? edgeDetailState\.data : null/);
  assert.match(web("app/observability/components/LogsTab.tsx"), /if \(seq !== requestSeq\.current\) return;/);
  assert.match(web("app/notifications/page.tsx"), /q\.data \? <Inbox data=\{q\.data\} reload=\{reload\} \/>/, "a failed poll keeps the inbox mounted");
  assert.match(web("components/ui/index.tsx"), /e\.key === "Enter" && e\.target instanceof HTMLInputElement\) apply\(\)/, "Enter on 취소 must not apply");
});

test("web: a response without `at` answers a request with one (the server read 'now') — equality left panels loading forever", () => {
  assert.equal(R.answersAt(undefined, undefined), true);
  assert.equal(R.answersAt(undefined, "1762819200"), true, "the server's clock is behind the viewer's");
  assert.equal(R.answersAt("2025-11-11T00:00:00.000Z", String(Date.parse("2025-11-11T00:00:00Z") / 1000)), true);
  assert.equal(R.answersAt("2025-11-11T00:00:00.000Z", "1"), false);
  assert.equal(R.answersAt("2025-11-11T00:00:00.000Z", undefined), false, "a past answer does not answer 'now'");
});
