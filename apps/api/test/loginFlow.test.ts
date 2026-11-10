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

import * as todayNs from "../../web/src/lib/todayStatus.ts";
const td = ((todayNs as unknown as { default?: typeof todayNs }).default ?? todayNs) as typeof todayNs;

test("today: problems first, a source that did not answer is 'not checked' (never zero), sample is said", () => {
  const all = td.todayStatus({
    alerts: { failed: false, data: { firingUnacked: 3, sev1: 1, sev2: 0 } },
    health: { failed: false, data: { unavailable: 0, degraded: 2, total: 40 } },
    security: { failed: true, data: null },
  });
  assert.deepEqual(all.rows.map((r) => [r.id, r.level]), [["alerts", "danger"], ["health", "warn"], ["security", "unknown"]]);
  assert.equal(all.problems, 2);
  assert.equal(all.unchecked, 1);
  const calm = td.todayStatus({
    alerts: { failed: false, data: { firingUnacked: 0, sev1: 0, sev2: 0 } },
    health: { failed: false, data: { unavailable: 0, degraded: 0, total: 12 }, sample: true },
    security: { failed: false, data: { high: 0, medium: 0 } },
  });
  assert.equal(calm.problems, 0);
  assert.ok(calm.rows.every((r) => r.level === "ok"));
  assert.equal(calm.sample, true);
  assert.equal(td.todayStatus({ alerts: { failed: false, data: null }, health: { failed: false, data: null }, security: { failed: false, data: null } }).unchecked, 3, "no data = not checked");
});
