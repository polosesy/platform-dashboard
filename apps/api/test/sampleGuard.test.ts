// Facts only (2026-11-12): sample (mock) data reaches an anonymous caller in sample mode and nobody else — a sample
// Service Health event had been read as a real Azure outage on a running deployment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createSampleGuard, isSampleBody, sampleDataEnabled, sampleDecision } from "../src/middleware/sampleGuard.js";
import * as mock from "../src/mockData.js";
import { mockDiagramSpec, generateMockSnapshot } from "../src/services/liveDiagramMock.js";
import * as modeNs from "../../web/src/lib/sampleMode.ts";
import * as cfgNs from "../../web/src/lib/runtimeConfig.ts";
const sm = ((modeNs as unknown as { default?: typeof modeNs }).default ?? modeNs) as typeof modeNs;
const rc = ((cfgNs as unknown as { default?: typeof cfgNs }).default ?? cfgNs) as typeof cfgNs;

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("sample guard: every marker the routes use is recognised; live bodies are not", () => {
  for (const b of [{ source: "mock" }, { dataSource: "mock" }, { _source: "mock", ok: true }, { note: "signin_required", edges: [] }, { note: "mock" }, { note: "mock data" }]) {
    assert.ok(isSampleBody(b), JSON.stringify(b));
  }
  for (const b of [{ source: "azure" }, { note: "partial: 2 subscriptions failed" }, { items: [] }, [{ source: "mock" }], null, "mock"]) {
    assert.ok(!isSampleBody(b), JSON.stringify(b));
  }
});

test("sample guard: a signed-in caller never receives a sample; anonymous only while sample mode is on", () => {
  assert.equal(sampleDecision(true, true, { source: "mock" }), "live_data_unavailable");
  assert.equal(sampleDecision(false, true, { source: "mock" }), "live_data_unavailable");
  assert.equal(sampleDecision(true, false, { source: "mock" }), "pass");
  assert.equal(sampleDecision(false, false, { source: "mock" }), "signin_required");
  assert.equal(sampleDecision(false, true, { source: "azure" }), "pass");
  // production: off unless turned on; development: on unless turned off
  assert.equal(sampleDataEnabled({ AUD_SAMPLE_DATA: undefined, NODE_ENV: "production" }), false);
  assert.equal(sampleDataEnabled({ AUD_SAMPLE_DATA: undefined, NODE_ENV: "development" }), true);
  assert.equal(sampleDataEnabled({ AUD_SAMPLE_DATA: true, NODE_ENV: "production" }), true);
  assert.equal(sampleDataEnabled({ AUD_SAMPLE_DATA: false, NODE_ENV: "development" }), false);
});

function run(envOver: { AUD_SAMPLE_DATA?: boolean; NODE_ENV: "production" | "development" }, bearer: string | undefined, body: unknown) {
  let sent: unknown; let status = 200;
  const res = { status(s: number) { status = s; return this; }, json(b: unknown) { sent = b; return this; } };
  createSampleGuard(envOver)({ auth: bearer ? { bearerToken: bearer } : undefined } as never, res as never, () => undefined);
  (res as unknown as { json: (b: unknown) => void }).json(body);
  return { status, sent: sent as Record<string, unknown> };
}

test("sample guard: the middleware in front of every /api response", () => {
  const signedIn = run({ NODE_ENV: "development" }, "tok", { source: "mock", events: [{ title: "x" }] });
  assert.equal(signedIn.status, 503);
  assert.equal(signedIn.sent.error, "live_data_unavailable");
  assert.equal(signedIn.sent.events, undefined, "nothing of the sample leaves");
  const prodAnon = run({ NODE_ENV: "production" }, undefined, { note: "signin_required", edges: [1] });
  assert.equal(prodAnon.status, 401);
  assert.equal(prodAnon.sent.error, "signin_required");
  const devAnon = run({ NODE_ENV: "development" }, undefined, { note: "signin_required", edges: [1] });
  assert.equal(devAnon.status, 200);
  assert.deepEqual(devAnon.sent, { note: "signin_required", edges: [1], source: "mock", sample: true }, "every sample is stamped the same way");
  const live = run({ NODE_ENV: "production" }, "tok", { source: "azure", n: 1 });
  assert.deepEqual([live.status, live.sent], [200, { source: "azure", n: 1 }]);
  // wired in front of the routes, after the caller is known
  const index = read("../src/index.ts");
  assert.ok(index.indexOf("createSampleGuard(env)") > index.indexOf("createAuthorizeMiddleware(env)"));
  assert.ok(index.indexOf("createSampleGuard(env)") < index.indexOf("registerAllRoutes(app, env)"));
});

test("sample content says it is a sample in the text itself: event · alert · recommendation titles start with [예시]", () => {
  const titles: string[] = [
    ...mock.mockServiceHealthEvents.events.map((e) => e.title),
    ...mock.mockRegionalStatus.regions.flatMap((r) => (r.events ?? []).map((e: { title: string }) => e.title)),
    ...mock.mockSecurityAlerts.alerts.map((a) => a.alertName),
    ...mock.mockSecurityPosture.recommendations.map((r) => r.title),
    ...generateMockSnapshot().alerts.map((a) => a.title),
    mockDiagramSpec.name,
  ];
  assert.ok(titles.length >= 12);
  for (const t of titles) assert.ok(t.startsWith("[예시] "), t);
  // no built-in translation that turns sample sentences into natural Korean (they read like Azure's own)
  assert.doesNotMatch(read("../src/services/health.ts"), /BUILTIN_KO/);
});

test("every route file that can send a sample marks it (source / note) — the guard recognises what they send", () => {
  const dir = new URL("../src/routes/", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    // a mock object sent directly must carry a marker on the same statement (or go through the helpers)
    for (const m of src.matchAll(/res(?:\.status\(\d+\))?\.json\(\{[^\n]*\bmock[A-Z]\w*[^\n]*\}\)/g)) {
      if (!/note:|source:|_source:|dataSource:/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("web: any sample response turns sample mode on (ribbon + watermark) — not left to each page", () => {
  assert.ok(sm.isSampleResponse({ source: "mock" }));
  assert.ok(sm.isSampleResponse({ sample: true }));
  assert.ok(sm.isSampleResponse({ dataSource: "mock" }));
  assert.ok(!sm.isSampleResponse({ source: "azure", note: "partial" }));
  assert.equal(sm.sampleModeStore.get(), false);
  let fired = 0;
  const off = sm.sampleModeStore.subscribe(() => { fired++; });
  sm.noteResponse({ items: [] });
  assert.equal(sm.sampleModeStore.get(), false);
  sm.noteResponse({ source: "mock" });
  assert.equal(sm.sampleModeStore.get(), true);
  sm.clearSampleMode();
  assert.equal(sm.sampleModeStore.get(), false, "a new screen starts clean");
  assert.equal(fired, 2);
  off();
  assert.match(read("../../web/src/lib/api.ts"), /noteResponse\(data\)/, "every API response passes through");
  const shell = read("../../web/src/components/AppShell.tsx");
  assert.match(shell, /sampleRibbon/);
  assert.match(shell, /data-sample=\{sample \|\| undefined\}/);
  assert.match(read("../../web/src/components/AppShell.module.css"), /\.main\[data-sample\]::after[^}]+--sample-watermark/);
  const msgs = read("../../web/src/lib/i18nMessages.ts");
  for (const k of ["sample.ribbon.title", "sample.ribbon.body", "auth.state.noLiveData"]) assert.ok(msgs.includes(`"${k}"`), k);
});

test("web: the 'look around with sample data' way in is offered outside production only (unless turned on)", () => {
  assert.equal(rc.sampleDataOffered({ NODE_ENV: "production" }), false);
  assert.equal(rc.sampleDataOffered({ NODE_ENV: "development" }), true);
  assert.equal(rc.sampleDataOffered({ NODE_ENV: "production", AUD_WEB_SAMPLE_DATA: "true" }), true);
  assert.equal(rc.sampleDataOffered({ NODE_ENV: "development", AUD_WEB_SAMPLE_DATA: "false" }), false);
  assert.match(read("../../web/src/app/login/page.tsx"), /config\.sampleData \?/);
  assert.match(read("../../web/src/app/live-diagram/page.tsx"), /!signedIn \? <Button onClick=\{\(\) => setDiagramId\(SAMPLE_DIAGRAM_ID\)\}/);
});
