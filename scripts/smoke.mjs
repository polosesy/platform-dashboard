// After a deployment: is the right build running, does it refuse what it must, and — with a signed-in token — does
// every main API answer with real data. Read-only (GET only).
//
//   node scripts/smoke.mjs <base URL> [--version <AUD_VERSION>] [--sample]
//   AUD_SMOKE_TOKEN=<access token for the dashboard API>  adds the signed-in checks
//
//   --sample   the deployment is a demo with sample data on (anonymous answers must then be marked as samples)
//
// The token is the one the browser sends (Authorization: Bearer …, scope Azure.Read.All) — it is read from the
// environment only, never printed, never written. Without it the signed-in part is reported as SKIPPED, not passed.
// Exit code: 0 = no failure · 1 = at least one failure · 2 = usage.

const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) { console.error("usage: node scripts/smoke.mjs <base URL> [--version <v>] [--sample]"); process.exit(2); }
const want = args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined;
const sampleMode = args.includes("--sample");
const token = (process.env.AUD_SMOKE_TOKEN ?? "").trim();

const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });
const isSample = (b) => !!b && typeof b === "object" && (["source", "dataSource", "_source"].some((k) => b[k] === "mock") || b.sample === true || ["signin_required", "mock", "mock data"].includes(b.note));

async function get(path, auth) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, { headers: auth ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60_000), redirect: "manual" });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: null, text: String(e?.message ?? e), ms: Date.now() - t0 };
  }
}
const q = (path, params) => `${path}?${new URLSearchParams(params)}`;

// ---------- the build, liveness, what must stay closed ----------
{
  const h = await get("/healthz");
  if (h.status !== 200 || !h.body?.ok) add("FAIL", "/healthz", `HTTP ${h.status}`);
  else if (want && h.body.version !== want) add("FAIL", "/healthz", `running ${h.body.version}, expected ${want}`);
  else add("ok", "/healthz", `version ${h.body.version ?? "?"}`);
  const r = await get("/readyz");
  add(r.status === 200 ? "ok" : "FAIL", "/readyz", `HTTP ${r.status}`);
  const m = await get("/metrics");
  add(m.status === 404 ? "ok" : "FAIL", "/metrics is not public", `HTTP ${m.status}`);
  const login = await get("/login");
  add(login.status === 200 && /api:\/\//.test(login.text) ? "ok" : "FAIL", "/login carries the sign-in settings", `HTTP ${login.status}`);
  for (const path of ["/api/azure/subscriptions", "/api/kubernetes/clusters", "/api/health/events", "/api/cost/summary", "/api/security/posture", "/api/notifications"]) {
    const a = await get(path);
    const sample = a.status === 200 && isSample(a.body);
    const good = sampleMode ? a.status === 401 || sample : a.status === 401;
    add(good ? "ok" : "FAIL", `anonymous ${path}`, a.status === 200 ? (sample ? "sample (marked)" : "200 with unmarked data") : `HTTP ${a.status}`);
  }
}

// ---------- signed in: real data from every main API ----------
if (!token) {
  add("SKIPPED", "signed-in checks", "set AUD_SMOKE_TOKEN (the API access token) — not verified");
} else {
  const check = async (name, path, look) => {
    const r = await get(path, true);
    if (r.status === 0) return add("FAIL", name, `no answer (${r.text.slice(0, 60)})`), null;
    if (r.status === 401) return add("FAIL", name, "401 — the token is not accepted (expired? wrong audience?)"), null;
    if (r.status === 403 || r.status === 429 || r.status === 501) return add("WARN", name, `HTTP ${r.status} ${r.body?.error ?? ""}`.trim()), null;
    if (r.status !== 200) return add("FAIL", name, `HTTP ${r.status} ${r.body?.error ?? ""}`.trim()), null;
    if (isSample(r.body)) return add("FAIL", name, "sample data reached a signed-in caller"), null;
    add("ok", name, `${look ? look(r.body) : ""} ${r.ms} ms`.trim());
    return r.body;
  };
  const me = await check("/api/me", "/api/me", (b) => `role ${b.role ?? "?"}`);
  if (me) {
    const subs = await check("subscriptions", "/api/azure/subscriptions", (b) => `${(b.subscriptions ?? b).length ?? "?"} subscriptions`);
    const sub = (subs?.subscriptions ?? subs ?? [])[0]?.subscriptionId;
    if (sub) {
      await check("cost summary", q("/api/cost/summary", { subscriptionId: sub }));
      await check("health summary", q("/api/health/summary", { subscriptionId: sub }));
      await check("health coverage", q("/api/health/coverage", { subscriptionId: sub }), (b) => (b.gaps?.length ? `gaps ${b.gaps.length}` : ""));
      await check("security posture", q("/api/security/posture", { subscriptionId: sub, lang: "ko" }), (b) => `${b.recommendations?.length ?? 0} recommendations, ${b.alerts?.length ?? 0} alerts${b.gaps?.length ? `, gaps ${b.gaps.length}` : ""}`);
      await check("architecture graph", q("/api/architecture/graph", { subscriptionId: sub }), (b) => `${b.nodes?.length ?? "?"} nodes`);
      await check("network coverage", q("/api/network/coverage", { subscriptionId: sub }));
    } else add("WARN", "subscription checks", "no subscription visible to this user");
    await check("notifications", "/api/notifications");
    const clusters = await check("clusters", "/api/kubernetes/clusters", (b) => `${(b.clusters ?? b).length ?? "?"} clusters`);
    const cluster = (clusters?.clusters ?? clusters ?? [])[0]?.id;
    if (cluster) {
      const state = (b) => (b.metricsState && b.metricsState !== "ok" ? `state ${b.metricsState}` : b.gaps?.length ? `gaps ${b.gaps.length}` : "");
      await check("cluster config", q("/api/kubernetes/cluster-config", { clusterId: cluster }), (b) => (b.gaps?.length ? `gaps ${b.gaps.join(",")}` : ""));
      await check("heatmap", q("/api/observability/heatmap", { clusterId: cluster, window: "60" }), (b) => `${b.workloads?.length ?? 0} workloads ${state(b)}`.trim());
      await check("app runtimes", q("/api/observability/app-metrics", { clusterId: cluster }), (b) => `${(b.workloads ?? []).filter((w) => w.kinds?.length).length}/${b.workloads?.length ?? 0} with a kind, evidence ${JSON.stringify(b.evidence ?? {})} ${state(b)}`.trim());
      await check("SLO", q("/api/observability/slo", { clusterId: cluster }), state);
      await check("kube events", q("/api/observability/events", { clusterId: cluster, limit: "100" }), (b) => `${b.total ?? b.events?.length ?? 0} warnings`);
      await check("observability stack", q("/api/observability/stack", { clusterId: cluster }), state);
      await check("nodes", q("/api/observability/nodes", { clusterId: cluster }), (b) => `${b.nodes?.length ?? 0} nodes`);
      await check("cluster policies", q("/api/kubernetes/policies", { clusterId: cluster }));
    } else add("WARN", "cluster checks", "no cluster visible to this user");
  }
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.level.padEnd(7)} ${r.name.padEnd(width)}  ${r.detail}`);
const n = (l) => rows.filter((r) => r.level === l).length;
console.log(`\n${n("ok")} ok · ${n("WARN")} warnings · ${n("FAIL")} failures${n("SKIPPED") ? " · signed-in part SKIPPED (not verified)" : ""}`);
process.exit(n("FAIL") ? 1 : 0);
