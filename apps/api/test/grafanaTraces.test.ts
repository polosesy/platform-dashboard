// 서비스 (APM) › 트레이스 (docs/architecture/apm-parity.md §4c — 2026-11-16): Tempo read through the customer's
// Managed Grafana. Shapes as measured on stg (Grafana 12.4 search + v2 trace); synthetic names, IDs and hosts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { createCredentialProvider, setCredentialProviderForTests } from "../src/infra/connectionCredentials.js";
import { clearConnectionTokens } from "../src/infra/azureClientFactory.js";
import { MOST_RECENT, getTrace, nextPageEnd, searchRows, searchTraces, tempoExploreUrl, traceHex, traceSpans, traceqlFor, validTraceQuery } from "../src/services/grafanaTraces.js";
import * as tvNs from "../../web/src/lib/traceView.ts";

const TV = ((tvNs as unknown as { default?: typeof tvNs }).default ?? tvNs) as typeof tvNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const HOME = "11111111-1111-1111-1111-111111111111";
const CUST = "99999999-9999-9999-9999-999999999999";
const S1 = "22222222-2222-2222-2222-222222222222";
const S3 = "44444444-4444-4444-4444-444444444444";
const APP = "66666666-6666-6666-6666-666666666666";
const CLUSTER = `/subscriptions/${S3}/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks-1`;
const GRAFANA = "https://grafana-example.krc.grafana.azure.com";
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const OPERATOR = jwt({ tid: HOME, oid: "o", roles: ["AUD.Operator"] });

const home = { key: "home", displayName: "Home", tenantId: HOME, mode: "platform", subscriptions: [S1] };
const cust = (grafana: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  key: "custb", displayName: "Customer B", tenantId: CUST, mode: "servicePrincipal", subscriptions: [S3], clientId: APP, secretEnv: "AUD_CONN_CUSTB_SECRET",
  ...(grafana ? { aks: { observability: { grafana } } } : {}), ...over,
});
const envWith = (...connections: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), "aud-tr-"));
  const file = join(dir, "connections.json");
  writeFileSync(file, JSON.stringify({ connections }));
  return loadEnv({ AZURE_AD_TENANT_ID: HOME, AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: S1, AUD_CONNECTIONS_FILE: file });
};
const scopes: string[] = [];
function fakeCredentials() {
  const cred = (tid: string) => ({ getToken: async (scope: string | string[]) => { scopes.push(String(scope)); return { token: jwt({ tid }), expiresOnTimestamp: Date.now() + 3600_000 }; } });
  setCredentialProviderForTests(createCredentialProvider({
    makeSecret: (t) => cred(t), makeCert: (t) => cred(t), makeAssertion: (t) => cred(t),
    readFile: async () => { throw new Error("ENOENT"); }, oboCredential: () => cred(HOME), getEnv: (n) => (n === "AUD_CONN_CUSTB_SECRET" ? "x" : undefined),
  }));
  clearConnectionTokens();
}

// The measured search answer (Tempo through Grafana's datasource proxy)
const SEARCH = {
  traces: [
    { traceID: "0af7651916cd43dd8448eb211c80319c", rootServiceName: "orders", rootTraceName: "GET /orders/{id}", startTimeUnixNano: "1794800000000000000", durationMs: 1234,
      spanSets: [{ spans: [{ spanID: "b7ad6b7169203331", startTimeUnixNano: "1794800000000000000", durationNanos: "1234000000", attributes: [{ key: "status", value: { stringValue: "error" } }] }], matched: 2 }],
      serviceStats: { orders: { spanCount: 5, errorCount: 1 }, payments: { spanCount: 3, errorCount: 2 } } },
    // Tempo prints IDs without leading zeros; a root not yet received
    { traceID: "7651916cd43dd8448eb211c80319c", rootServiceName: "<root span not yet received>", startTimeUnixNano: "1794800001000000000", spanSet: { spans: [], matched: 1 }, serviceStats: { a: { spanCount: 1 } } },
    { traceID: "not-hex" },
  ],
  metrics: { inspectedBytes: "1", completedJobs: 3, totalJobs: 9 },
};
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const T0 = 1794800000000000000n;
const span = (id: string, parent: string | null, name: string, startMs: number, durMs: number, extra: Record<string, unknown> = {}) => ({
  traceId: b64("0af7651916cd43dd8448eb211c80319c"), spanId: b64(id), ...(parent ? { parentSpanId: b64(parent) } : { parentSpanId: "" }), name,
  kind: "SPAN_KIND_SERVER", startTimeUnixNano: String(T0 + BigInt(startMs * 1e6)), endTimeUnixNano: String(T0 + BigInt((startMs + durMs) * 1e6)),
  attributes: [], status: { code: "STATUS_CODE_OK" }, ...extra,
});
const TRACE = {
  trace: { resourceSpans: [
    { resource: { attributes: [{ key: "service.name", value: { stringValue: "orders" } }, { key: "k8s.namespace.name", value: { stringValue: "shop" } }, { key: "k8s.pod.name", value: { stringValue: "orders-7d9f-aaaaa" } }] },
      scopeSpans: [{ scope: {}, spans: [
        span("1111111111111111", null, "GET /orders/{id}", 0, 100, { attributes: [{ key: "http.route", value: { stringValue: "/orders/{id}" } }, { key: "http.status_code", value: { intValue: "500" } }, { key: "auth", value: { stringValue: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" } }],
          status: { code: "STATUS_CODE_ERROR", message: "boom" },
          events: [{ timeUnixNano: String(T0 + 90_000_000n), name: "exception", attributes: [{ key: "exception.type", value: { stringValue: "java.lang.IllegalStateException" } }, { key: "exception.stacktrace", value: { stringValue: `java.lang.IllegalStateException: boom\n${"\tat x.Y.z(Y.java:1)\n".repeat(400)}` } }] }] }),
        span("3333333333333333", "1111111111111111", "SELECT orders", 40, 20, { kind: "SPAN_KIND_CLIENT" }),
      ] }] },
    { resource: { attributes: [{ key: "service.name", value: { stringValue: "payments" } }] },
      scopeSpans: [{ scope: {}, spans: [
        span("2222222222222222", "1111111111111111", "POST /pay", 10, 50, { kind: "SPAN_KIND_INTERNAL", status: {} }),
        span("4444444444444444", "9999999999999999", "orphan", 5, 1),
      ] }] },
  ] },
};

test("filters: validated shapes only (400 otherwise) → one TraceQL span selector", () => {
  assert.equal(traceqlFor({}), "{}");
  assert.equal(traceqlFor({ service: "orders", namespace: "shop", name: "GET /orders/{id}", errorsOnly: true, minDurationMs: 500 }),
    '{ resource.service.name = "orders" && resource.k8s.namespace.name = "shop" && name = "GET /orders/{id}" && status = error && duration >= 500ms }');
  for (const bad of [{ service: 'a" || true' }, { namespace: "Shop" }, { name: 'x" } | {' }, { name: "a\\b" }, { minDurationMs: -1 }, { minDurationMs: 1.5 }]) {
    assert.throws(() => validTraceQuery(bad as never), (e: { status?: number }) => e.status === 400, JSON.stringify(bad));
  }
  const url = new URL(tempoExploreUrl(`${GRAFANA}/`, "tempo-uid", "{ status = error }", "1", "2"));
  assert.equal(url.origin + url.pathname, `${GRAFANA}/explore`);
  assert.deepEqual(JSON.parse(url.searchParams.get("panes")!).aud.queries[0], { refId: "A", datasource: { type: "tempo", uid: "tempo-uid" }, queryType: "traceql", query: "{ status = error }", limit: 20 });
});

test("search: Tempo's rows as they are — IDs padded to 32 hex, per-service spans/errors, matched spans, partial when Tempo stopped early", () => {
  const r = searchRows(SEARCH);
  assert.equal(r.traces.length, 2, "a non-hex ID is dropped");
  assert.equal(r.partial, true);
  const [a, b] = r.traces;
  assert.deepEqual([a!.traceId, a!.rootService, a!.rootName, a!.durationMs, a!.matched, a!.start], ["0af7651916cd43dd8448eb211c80319c", "orders", "GET /orders/{id}", 1234, 2, "2026-11-16T03:33:20.000Z"]);
  assert.deepEqual(a!.services, [{ name: "payments", spans: 3, errors: 2 }, { name: "orders", spans: 5, errors: 1 }], "errors first");
  assert.deepEqual([b!.traceId, b!.rootService, b!.durationMs, b!.matched], ["0007651916cd43dd8448eb211c80319c", null, null, 1]);
  assert.equal(traceHex("ABC"), "00000000000000000000000000000abc");
  assert.throws(() => searchRows({ error: "x" }), /unexpected_shape/);
});

test("trace: OTLP JSON → spans in start order on the trace's own axis; base64 IDs to hex; status, kinds, resource; values masked and capped", () => {
  const t = traceSpans(TRACE);
  assert.deepEqual(t.spans.map((s) => [s.name, s.offsetMs, s.durationMs, s.kind, s.status]), [
    ["GET /orders/{id}", 0, 100, "server", "error"], ["orphan", 5, 1, "server", "ok"], ["POST /pay", 10, 50, "internal", "unset"], ["SELECT orders", 40, 20, "client", "ok"],
  ]);
  const root = t.spans[0]!;
  assert.deepEqual([root.spanId, root.parentId, root.service, root.namespace, root.pod, root.statusMessage], ["1111111111111111", null, "orders", "shop", "orders-7d9f-aaaaa", "boom"]);
  assert.equal(t.spans[2]!.parentId, "1111111111111111");
  assert.deepEqual([t.start, t.durationMs], ["2026-11-16T03:33:20.000Z", 100]);
  assert.equal(root.attributes.find((a) => a.key === "http.status_code")?.value, "500", "intValue as text");
  assert.doesNotMatch(root.attributes.find((a) => a.key === "auth")!.value, /eyJhbGciOiJSUzI1NiJ9/, "a bearer token is masked");
  assert.ok(t.redacted >= 1);
  const stack = root.events[0]!.attributes.find((a) => a.key === "exception.stacktrace")!.value;
  assert.ok(stack.length <= 4001 + 10 && stack.endsWith("…"), "stack trace capped");
  assert.equal(root.events[0]!.offsetMs, 90);
  assert.deepEqual(traceSpans({ batches: [] }).spans, [], "v1 shape, empty");
});

test("reading: through Grafana's datasource proxy with the connection identity's Grafana token; states for every 'not read'", async () => {
  fakeCredentials();
  const seen: Array<{ url: string; auth: string | null }> = [];
  let status = 200;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const body = url.includes("/api/search?") ? SEARCH : TRACE;
    return new Response(status === 200 ? JSON.stringify(body) : "{}", { status });
  }) as typeof fetch;
  try {
    const on = { endpoint: GRAFANA, datasources: { tempo: "tempo-uid" }, traces: true };
    const e = envWith(home, cust(on, { roles: ["operator"] }));
    const r = await searchTraces(e, OPERATOR, CLUSTER, { service: "orders", errorsOnly: true }, 60, 1_794_800_000, 20);
    assert.equal(r.state, "ok");
    assert.equal(r.traces.length, 2);
    const u = new URL(seen[0]!.url);
    assert.equal(`${u.origin}${u.pathname}`, `${GRAFANA}/api/datasources/proxy/uid/tempo-uid/api/search`);
    assert.deepEqual([u.searchParams.get("q"), u.searchParams.get("start"), u.searchParams.get("end"), u.searchParams.get("limit")], ['{ resource.service.name = "orders" && status = error } with (most_recent=true)', String(1_794_800_000 - 3600), "1794800000", "20"]);
    assert.equal(r.since, 1_794_800_000 - 3600);
    assert.equal(r.next, null, "2 rows < limit 20: the last page");
    // a later page keeps the window start and ends at `before`
    const r2 = await searchTraces(e, OPERATOR, CLUSTER, { service: "orders", errorsOnly: true }, 60, 1_794_800_000, 2, { since: 1_794_800_000 - 3600, before: 1_794_799_000 });
    const u2 = new URL(seen.at(-1)!.url);
    assert.deepEqual([u2.searchParams.get("start"), u2.searchParams.get("end")], [String(1_794_800_000 - 3600), "1794799000"]);
    assert.equal(r2.next, 1_794_798_999, "2 rows = limit: a next page — never past this page's end (the fixture's rows are newer than `before`)");
    await assert.rejects(searchTraces(e, OPERATOR, CLUSTER, {}, 60, undefined, 20, { since: 10, before: 5 }), (x: { status?: number }) => x.status === 400);
    await assert.rejects(searchTraces(e, OPERATOR, CLUSTER, {}, 60, undefined, 20, { since: 1_794_700_000, before: 1_794_800_000 }), (x: { status?: number }) => x.status === 400, "wider than the window");
    assert.match(seen[0]!.auth ?? "", /^Bearer /);
    assert.ok(scopes.includes("ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default"), "the Managed Grafana audience");
    assert.ok(r.exploreUrl?.startsWith(`${GRAFANA}/explore?`));

    const d = await getTrace(e, OPERATOR, CLUSTER, "0af7651916cd43dd8448eb211c80319c");
    assert.equal(d.state, "ok");
    assert.equal(new URL(seen.at(-1)!.url).pathname, "/api/datasources/proxy/uid/tempo-uid/api/v2/traces/0af7651916cd43dd8448eb211c80319c");
    await assert.rejects(getTrace(e, OPERATOR, CLUSTER, "../x"), (x: { status?: number }) => x.status === 400);

    status = 403;
    assert.equal((await searchTraces(e, OPERATOR, CLUSTER, { service: "other" }, 60)).state, "forbidden");
    status = 404;
    assert.equal((await getTrace(e, OPERATOR, CLUSTER, "ffff")).state, "notFound");

    const before = seen.length;
    assert.equal((await searchTraces(envWith(home, cust({ ...on, traces: undefined }, { roles: ["operator"] })), OPERATOR, CLUSTER, {}, 60)).state, "notConfigured", "opt-in off");
    assert.equal((await searchTraces(envWith(home, cust({ endpoint: GRAFANA, datasources: {}, traces: true }, { roles: ["operator"] })), OPERATOR, CLUSTER, {}, 60)).state, "notConfigured", "no tempo UID");
    assert.equal((await searchTraces(envWith(home, cust(undefined, { roles: ["operator"] })), OPERATOR, CLUSTER, {}, 60)).state, "notConfigured");
    const lh = { key: "custl", displayName: "L", tenantId: CUST, mode: "lighthouse", subscriptions: [S3], aks: { observability: { grafana: on } } };
    assert.equal((await searchTraces(envWith(home, lh), OPERATOR, CLUSTER, {}, 60)).state, "unsupportedMode");
    assert.equal(seen.length, before, "nothing sent when not configured");
    await assert.rejects(searchTraces(e, undefined, CLUSTER, {}, 60), (x: { status?: number }) => x.status === 401, "anonymous: sign in");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("paging: most_recent (gapless — measured), the next page's end = oldest start + 1, never past this page or the window", () => {
  assert.equal(MOST_RECENT, " with (most_recent=true)");
  const at = (sec: number) => ({ start: new Date(sec * 1000).toISOString() });
  assert.equal(nextPageEnd([at(1000), at(990)], 3, 900, 1100), null, "fewer than the limit: the last page");
  assert.equal(nextPageEnd([at(1000), at(990), at(950)], 3, 900, 1100), 951);
  assert.equal(nextPageEnd([at(1099), at(1099)], 2, 900, 1100), 1099, "all in this page's last second: still moves back");
  assert.equal(nextPageEnd([at(900), at(900)], 2, 900, 1100), null, "reached the window start");
});

test("problem groups: endpoints by errors and by p95 bucket (spanmetrics), the slow filter = the p95 bucket's lower edge; pages merged once", () => {
  const ep = (name: string, requests: number, errors: number, le: number | null | undefined) => ({ name, requests, errors, p95: le === undefined ? null : { le } });
  const svc = (service: string, endpoints: ReturnType<typeof ep>[]) => ({
    service, workload: null, sameName: 0, requests: 0, rate: 0, errors: 0, errorRate: null, p50: null, p95: null, p99: null, actuatorRate: 0, lowTraffic: false, endpoints,
  });
  const services = [svc("orders", [ep("GET /orders/{id}", 100, 3, 0.25), ep('GET /bad"name', 5, 9, 1)]), svc("pay", [ep("POST /pay", 40, 7, null), ep("GET /ping", 9, 0, 0.1)])];
  const g = TV.problemGroups(services, [0.1, 0.25, 0.5, 1, 2.5]);
  assert.deepEqual(g.errors.map((x) => [x.service, x.name, x.count]), [["pay", "POST /pay", 7], ["orders", "GET /orders/{id}", 3]], "a name the API refuses is left out");
  assert.deepEqual(g.slow.map((x) => [x.name, x.minDurationMs]), [["POST /pay", 2500], ["GET /orders/{id}", 100], ["GET /ping", 0]], "> last bucket first; ≤0.25 s → from 100 ms");
  const r = (id: string, matched = 1) => ({ traceId: id, rootService: null, rootName: null, start: "", durationMs: null, services: [], matched });
  assert.deepEqual(TV.mergePages([[r("a"), r("b")], [r("b"), r("c", 2)]]).map((x) => x.traceId), ["a", "b", "c"]);
  assert.equal(TV.matchedSpans([r("a"), r("c", 2)]), 3);
});

test("waterfall: each span under its parent, siblings by start, a missing parent starts its own branch; bars on the trace axis", () => {
  const t = traceSpans(TRACE);
  const rows = TV.waterfall(t.spans, t.durationMs);
  assert.deepEqual(rows.map((r) => [r.span.name, r.depth]), [["GET /orders/{id}", 0], ["POST /pay", 1], ["SELECT orders", 1], ["orphan", 0]]);
  assert.deepEqual([rows[1]!.leftPct, rows[1]!.widthPct], [10, 50]);
  assert.equal(rows[3]!.widthPct, 1);
  assert.deepEqual(TV.traceCounts(t.spans), { spans: 4, errors: 1, services: 2 });
  assert.equal(TV.exceptionOf(t.spans[0]!)?.type, "java.lang.IllegalStateException");
  assert.deepEqual([TV.msText(0.4), TV.msText(5.25), TV.msText(250), TV.msText(1234), TV.msText(90_000), TV.msText(null)], ["<1 ms", "5.3 ms", "250 ms", "1.23 s", "1.5 min", "—"]);
  const cyc = TV.waterfall([{ ...t.spans[0]!, parentId: "3333333333333333" }, { ...t.spans[3]!, parentId: "1111111111111111" }]);
  assert.ok(cyc.length <= 2, "a cycle never loops");
});

test("wiring: operator-gated routes, the opt-in in the connection schema, the 트레이스 view and its i18n", () => {
  const routes = read("../src/routes/observability.ts");
  assert.match(routes, /"\/api\/observability\/traces", requireRole\(env, "operator"\)/);
  assert.match(routes, /"\/api\/observability\/trace", requireRole\(env, "operator"\)/);
  assert.match(read("../src/infra/connectionRegistry.ts"), /traces: z\.boolean\(\)\.optional\(\)/);
  const tab = read("../../web/src/app/observability/components/SloTab.tsx");
  assert.ok(readFileSync(new URL("../../web/src/lib/navConfig.ts", import.meta.url), "utf8").includes('"/observability/services/traces"'), "the traces view is a menu item (2026-11-19)");
  assert.match(tab, /onTraces=\{openTraces\}/);
  const all = read("../../web/src/lib/i18nOps.ts");
  const view = read("../../web/src/app/observability/components/TracesView.tsx");
  const keys = new Set([...view.matchAll(/t\("(ob\.tr\.[\w.]+)"/g)].map((m) => m[1]!));
  for (const s of ["notConfigured", "forbidden", "unsupportedMode", "notFound", "failed"]) keys.add(`ob.tr.state.${s}`).add(`ob.tr.stateHint.${s}`);
  for (const k of ["server", "client", "internal", "producer", "consumer", "unspecified"]) keys.add(`ob.tr.kind.${k}`);
  for (const k of ["ok", "error", "unset"]) keys.add(`ob.tr.status.${k}`);
  for (const k of [...keys, "ob.slo.view.traces", "ob.ep.traces", "ob.ep.tracesHint"]) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  assert.doesNotMatch(view, /<button/, "kit buttons only");
  // 2026-11-17: the trace opened at the end of a long list — now a row right after its trace row, scrolled into view
  assert.match(view, /return open \? \[row, \(\s*<tr key=\{`\$\{r\.traceId\}:detail`\} className=\{styles\.trDetailRow\}>\s*<td colSpan=\{5\}>/);
  assert.match(view, /scrollIntoView\(\{ block: tall \? "start" : "nearest"/);
  assert.doesNotMatch(view, /\{traceId \? <TraceDetail/, "no detail after the list");
});
