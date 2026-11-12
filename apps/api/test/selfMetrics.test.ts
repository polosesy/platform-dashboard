// The platform's own metrics, the deploy command's checks and the after-deploy smoke script (2026-11-12 — "먼저 고칠 약점").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordHttp, recordUpstream, renderMetrics, routeLabel, upstreamTarget } from "../src/infra/selfMetrics.js";

const repo = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("self metrics: labels are bounded — the route pattern (never an id), the upstream's kind", () => {
  assert.equal(routeLabel("", "/api/kubernetes/cluster/:id/overview"), "/api/kubernetes/cluster/:id/overview");
  assert.equal(routeLabel("/api", undefined), "unmatched", "a path no route matched is one label, not one per URL");
  assert.equal(upstreamTarget("ARM"), "arm");
  assert.equal(upstreamTarget("LogAnalytics query"), "loganalytics");
  assert.equal(upstreamTarget("https://x/y"), "https");
});

test("self metrics: Prometheus text — counters, cumulative histogram buckets, build info, no tenant data", () => {
  recordHttp("/api/me", "GET", 200, 0.03);
  recordHttp("/api/me", "GET", 200, 0.7);
  recordUpstream("ARM", 429, 0.2);
  recordUpstream("ARM", "timeout", 30);
  const text = renderMetrics("abc1234");
  assert.match(text, /aud_build_info\{version="abc1234"\} 1/);
  assert.match(text, /aud_http_requests_total\{method="GET",route="\/api\/me",status="200"\} 2/);
  assert.match(text, /aud_http_request_duration_seconds_bucket\{route="\/api\/me",le="0\.05"\} 1/);
  assert.match(text, /aud_http_request_duration_seconds_bucket\{route="\/api\/me",le="1"\} 2/, "buckets are cumulative");
  assert.match(text, /aud_http_request_duration_seconds_bucket\{route="\/api\/me",le="\+Inf"\} 2/);
  assert.match(text, /aud_upstream_requests_total\{result="429",target="arm"\} 1/);
  assert.match(text, /aud_upstream_requests_total\{result="timeout",target="arm"\} 1/);
  assert.match(text, /nodejs_version_info\{version="v\d+/);
  assert.ok(!/subscriptions\/|[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), "no ids in the exposition");
});

test("self metrics: served outside /api, before auth; the scrape port answers only /metrics; every Azure call is counted", () => {
  const index = repo("apps/api/src/index.ts");
  assert.ok(index.indexOf('app.get("/metrics"') < index.indexOf('app.use("/api", createAuthMiddleware'), "before auth, not under /api");
  assert.match(index, /metricsApp\.get\("\/metrics", metricsHandler\)/);
  assert.equal((index.match(/metricsApp\.(get|use|post)\(/g) ?? []).length, 1, "the metrics listener has one route");
  assert.match(repo("apps/api/src/infra/azureClientFactory.ts"), /recordUpstream\(label, result,/);
  assert.match(repo("apps/api/src/env.ts"), /AUD_METRICS_PORT: z\.coerce\.number\(\)/);
  const dep = repo("deploy/helm/aud-dashboard/templates/deployment.yaml");
  assert.match(dep, /if \.Values\.metrics\.enabled[\s\S]*prometheus\.io\/scrape/);
  assert.match(repo("deploy/helm/aud-dashboard/values.yaml"), /metrics:\n  enabled: false/);
});

test("deploy command: the saved image must be the build, the running pod must report it, then the smoke script", () => {
  const sh = repo("scripts/aks-test.sh");
  assert.match(sh, /\[ "\$HAVE" = "\$BUILT" \] \|\| \{ echo "the saved image is/);
  assert.match(sh, /rm -rf "\$\{IMG:\?\}"/, "the folder is emptied first (a stale image was pushed once)");
  assert.match(sh, /expected \$BUILT\)"; exit 1/);
  assert.match(sh, /node scripts\/smoke\.mjs "http:\/\/localhost:\$LOCAL_PORT" --version "\$BUILT"/);
  assert.match(repo("scripts/onprem.sh"), /save\) \[\[ "\$\{1:-\}" =~ \^\[A-Za-z0-9\._-\]\+\$ \]\]/);
});

test("smoke script: GET only, the token never printed, a skipped signed-in part is not a pass", () => {
  const s = repo("scripts/smoke.mjs");
  assert.ok(!/method:\s*"(POST|PUT|DELETE)"/.test(s));
  assert.ok(!/console\.(log|error)\([^)]*token/.test(s), "the token is not logged");
  assert.match(s, /add\("SKIPPED", "signed-in checks"/);
  assert.match(s, /sample data reached a signed-in caller/);
  assert.match(s, /\/metrics is not public/);
});
