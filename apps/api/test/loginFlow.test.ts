import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as loginNs from "../../web/src/lib/loginFlow.ts";
import * as cmdNs from "../../web/src/lib/commandPalette.ts";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const lf = ((loginNs as unknown as { default?: typeof loginNs }).default ?? loginNs) as typeof loginNs;
const cp = ((cmdNs as unknown as { default?: typeof cmdNs }).default ?? cmdNs) as typeof cmdNs;
const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;

test("sign-in: the page to return to is only a path on this site (no open redirect)", () => {
  assert.equal(lf.safeNext("/observability?tab=slo"), "/observability?tab=slo");
  assert.equal(lf.safeNext(encodeURIComponent("/cost?x=1")), "/cost?x=1");
  for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined, "/login", "/login?next=/x", "%E0%A4%A"]) {
    assert.equal(lf.safeNext(bad), "/", String(bad));
  }
});

test("sign-in: reasons are a fixed list; the /login URL carries next and reason", () => {
  assert.equal(lf.loginReason("expired"), "expired");
  assert.equal(lf.loginReason("<script>"), null, "unknown values are ignored, never echoed");
  assert.equal(lf.loginUrl("/cost", "expired"), "/login?next=%2Fcost&reason=expired");
  assert.equal(lf.loginUrl("/"), "/login");
  assert.equal(lf.loginUrl("https://evil.example"), "/login", "a foreign next is dropped");
});

test("sign-in: MSAL failures → the reason the page explains", () => {
  assert.equal(lf.reasonOfError({ errorCode: "consent_required" }), "consent");
  assert.equal(lf.reasonOfError(new Error("AADSTS65001: The user or administrator has not consented")), "consent");
  assert.equal(lf.reasonOfError(new Error("AADSTS50011: The redirect URI does not match")), "redirectUri");
  assert.equal(lf.reasonOfError({ errorCode: "interaction_required" }), "expired");
  assert.equal(lf.reasonOfError(new Error("something else")), "error");
  // Every reason has its words on the page, in both languages
  const keys = msg.T as Record<string, { ko: string; en: string }>;
  for (const r of ["expired", "consent", "norole", "error", "redirectUri"]) {
    for (const part of ["t", "d"]) assert.ok(keys[`login.reason.${r}.${part}`]?.ko && keys[`login.reason.${r}.${part}`]?.en, `login.reason.${r}.${part}`);
  }
});

test("quick open: every screen once, words must all match, label hits first, ↑↓ wrap", () => {
  const t = (k: string) => (msg.T as Record<string, { ko: string }>)[k]?.ko ?? k;
  const screens = cp.paletteScreens(t);
  assert.equal(new Set(screens.map((s) => s.href)).size, screens.length, "no screen twice");
  assert.ok(screens.length >= 20);
  assert.deepEqual(cp.filterPalette(screens, ""), screens, "empty query = everything in menu order");
  const cost = cp.filterPalette(screens, "비용");
  assert.equal(cost[0]?.href, "/cost", "a label hit ranks first");
  assert.ok(cp.filterPalette(screens, "/security").every((s) => s.href?.startsWith("/security") || `${s.desc}${s.group}`.toLowerCase().includes("/security")));
  assert.equal(cp.filterPalette(screens, "비용 존재하지않는단어").length, 0, "every word must match");
  assert.equal(cp.moveIndex(0, -1, 5), 4);
  assert.equal(cp.moveIndex(4, 1, 5), 0);
  assert.equal(cp.moveIndex(3, 1, 0), 0);
});

import * as briefNs from "../../web/src/lib/briefing.ts";
const bf = ((briefNs as unknown as { default?: typeof briefNs }).default ?? briefNs) as typeof briefNs;

const OFF = { state: "off" as const };
test("briefing: worst first, loading is 'reading' and failed is 'not checked' (never zero or OK), sample is said", () => {
  const all = bf.briefing({
    alerts: { state: "ok", data: { firingUnacked: 3, high: 1 } },
    health: { state: "ok", data: { unavailable: 0, degraded: 2, total: 40 } },
    security: { state: "failed" },
    workloads: OFF, slo: OFF, events: OFF, version: OFF,
  });
  assert.deepEqual(all.rows.map((r) => [r.id, r.level]), [["alerts", "danger"], ["health", "warn"], ["security", "unknown"]]);
  assert.equal(all.act, 2);
  assert.equal(all.unchecked, 1);
  assert.equal(bf.headlineKey(all), "brief.head.act");

  const calm = bf.briefing({
    alerts: { state: "ok", data: { firingUnacked: 0, high: 0 } },
    health: { state: "ok", data: { unavailable: 0, degraded: 0, total: 12 }, sample: true },
    security: { state: "ok", data: { high: 0, medium: 0 } },
    workloads: OFF, slo: OFF, events: OFF, version: OFF,
  });
  assert.equal(calm.act, 0);
  assert.ok(calm.rows.every((r) => r.level === "ok" && r.group === "fine"));
  assert.equal(calm.sample, true);
  assert.equal(bf.headlineKey(calm), "brief.head.ok");

  // The defect this replaces: a source that had not answered yet read "could not be read" and the headline stayed "reading"
  const reading = bf.briefing({
    alerts: { state: "loading" }, health: { state: "ok", data: { unavailable: 1, degraded: 0, total: 5 } }, security: { state: "loading" },
    workloads: OFF, slo: OFF, events: OFF, version: OFF,
  });
  assert.equal(reading.unchecked, 0, "loading is not 'not checked'");
  assert.equal(reading.loading, 2);
  assert.equal(bf.headlineKey(reading), "brief.head.actSoFar", "what arrived is said at once");
  assert.equal(bf.headlineKey({ act: 0, unchecked: 0, loading: 1 }), "brief.head.reading");
  assert.equal(bf.headlineKey({ act: 0, unchecked: 2, loading: 0 }), "brief.head.unchecked");
  const none = bf.briefing({ alerts: { state: "ok" }, health: { state: "failed" }, security: { state: "failed" }, workloads: OFF, slo: OFF, events: OFF, version: OFF });
  assert.equal(none.unchecked, 3, "ok without data = not checked");
});

test("briefing: the cluster's rows — danger workloads, SLO burn, events still occurring, version", () => {
  const b = bf.briefing({
    cluster: "aks-a",
    alerts: OFF, health: OFF, security: OFF,
    workloads: { state: "ok", data: { danger: 2, warn: 1, total: 30, worst: "shop/api" } },
    slo: { state: "ok", data: { burning: 0, exhausted: 1, total: 8, worst: "shop/api" } },
    events: { state: "ok", data: { recent: 4, total: 60, topReason: "BackOff" } },
    version: { state: "ok", data: { state: "patch", current: "1.33.2", to: "1.33.5", poolsBehind: 0 } },
  });
  assert.deepEqual(b.rows.map((r) => [r.id, r.level, r.group]), [
    ["workloads", "danger", "now"], ["slo", "warn", "now"], ["events", "warn", "now"], ["version", "info", "know"],
  ]);
  assert.equal(b.act, 3, "an available patch is good to know, not something to act on now");
  assert.equal(b.rows[0]!.params.worst, "shop/api");
  const quiet = bf.briefing({
    alerts: OFF, health: OFF, security: OFF,
    workloads: { state: "ok", data: { danger: 0, warn: 0, total: 30 } },
    slo: { state: "ok", data: { burning: 0, exhausted: 0, total: 0 } },
    events: { state: "ok", data: { recent: 0, total: 3 } },
    version: { state: "ok", data: { state: "upToDate", current: "1.33.5", to: null, poolsBehind: 1 } },
  });
  assert.ok(!quiet.rows.some((r) => r.id === "slo"), "no service with request metrics = no SLO line (not an OK)");
  assert.equal(quiet.rows.find((r) => r.id === "version")!.level, "warn", "a pool on another version comes before 'latest'");
  assert.equal(bf.briefing({ alerts: OFF, health: OFF, security: OFF, workloads: OFF, slo: OFF, events: OFF, version: { state: "ok", data: { state: "unknown", current: "", to: null, poolsBehind: 0 } } }).unchecked, 1);
});

test("briefing: every row key and core feature has ko / en strings; the home page uses the briefing", () => {
  const msgs = readFileSync(new URL("../../web/src/lib/i18nMessages.ts", import.meta.url), "utf8");
  const src = readFileSync(new URL("../../web/src/lib/briefing.ts", import.meta.url), "utf8");
  for (const k of new Set([...src.matchAll(/"(brief\.[a-zA-Z.]+)"/g)].map((m) => m[1]!))) assert.ok(msgs.includes(`"${k}"`), k);
  for (const id of ["alerts", "health", "security", "workloads", "slo", "events", "version"]) for (const x of ["loading", "unknown"]) assert.ok(msgs.includes(`"brief.${id}.${x}"`), `${id}.${x}`);
  for (const l of ["danger", "warn", "info", "ok", "unknown", "loading"]) assert.ok(msgs.includes(`"brief.level.${l}"`), l);
  for (const f of bf.CORE_FEATURES) for (const x of ["ask", "body", "go"]) assert.ok(msgs.includes(`"home.feat.${f.id}.${x}"`), `${f.id}.${x}`);
  const page = readFileSync(new URL("../../web/src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<Briefing \/>/);
});
