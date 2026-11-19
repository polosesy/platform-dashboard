import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as navNs from "../../web/src/lib/navConfig.ts";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const nav = ((navNs as unknown as { default?: typeof navNs }).default ?? navNs) as typeof navNs;
const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;
const { NAV_GROUPS, NAV_EXEMPT_ROUTES, isItemActive, activeGroupKey, activeNavItem, sectionBefore } = nav;

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/src/app");

/** Every routable page under app/ (route groups and dynamic segments not used in this app). */
export function pageRoutes(dir: string = appDir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pageRoutes(p));
    else if (name === "page.tsx") {
      const rel = relative(appDir, dir).split(sep).join("/");
      out.push(rel ? `/${rel}` : "/");
    }
  }
  return out;
}

const items = NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.key })));

test("every page route appears in the menu exactly once (the sign-in page is the one page outside it)", () => {
  assert.deepEqual([...NAV_EXEMPT_ROUTES], ["/login"]);
  const routes = pageRoutes().filter((r) => !(NAV_EXEMPT_ROUTES as readonly string[]).includes(r)).sort();
  const hrefs = items.map((i) => i.href).sort();
  assert.deepEqual(hrefs, [...new Set(hrefs)], "no duplicate menu entries");
  assert.deepEqual(hrefs, routes);
  assert.equal(routes.length, 29); // + 6 monitoring views of their own (2026-11-19 — they were tabs of /observability) · + /network-path (network path, 2026-11-18) · + /runbooks (사례·런북, 2026-11-13) + /security/explore (그래프 탐색, 2026-11-17)
});

test("each route activates exactly one item (longest match) and its group", () => {
  for (const r of items.map((i) => i.href)) {
    const hits = items.filter((i) => isItemActive(r, i.href));
    assert.equal(hits.length, 1, `${r} → ${hits.map((h) => h.href).join(",")}`);
    assert.equal(hits[0]!.href, r);
    assert.equal(activeGroupKey(r), hits[0]!.group);
  }
  assert.equal(isItemActive("/kubernetes", "/"), false);
  assert.equal(isItemActive("/policies/x", "/policies"), true);
  assert.equal(isItemActive("/policiesx", "/policies"), false, "prefix must end at a path segment");
  assert.equal(isItemActive("/security/findings", "/security"), false, "a sub-page does not also light up its parent");
  assert.equal(activeNavItem("/security/findings/x")?.href, "/security/findings");
  assert.equal(activeNavItem("/security/unknown")?.href, "/security");
  assert.equal(activeNavItem("/security/risk")?.href, "/security/risk");
  assert.equal(isItemActive("/security/risk", "/security"), false);
  assert.equal(activeGroupKey("/policies"), "security");
  assert.equal(activeGroupKey("/hubble"), "infra");
  assert.equal(activeGroupKey("/runbooks"), "ops");
  assert.equal(activeGroupKey("/does-not-exist"), null);
  assert.equal(activeNavItem("/does-not-exist"), null);
});

test("three levels: top category › category (section) › screen — six top categories, one shape", () => {
  // 2026-11-19: 10 top entries of uneven depth (개요 alone, '클러스터 › 클러스터', sections only in two groups) →
  // 6 top categories; every multi-screen top category is divided into categories (except 설정 — two screens)
  assert.deepEqual(NAV_GROUPS.map((g) => g.key), ["overview", "infra", "monitoring", "security", "ops", "settings"]);
  assert.deepEqual(NAV_GROUPS.filter((g) => g.items.length === 1).map((g) => g.key), ["overview"], "only 개요 is a direct link");
  const shape = (k: string) => nav.sectionsOf(NAV_GROUPS.find((g) => g.key === k)!).map((s) => [s.labelKey, s.items.map((i) => i.href)]);
  assert.deepEqual(shape("infra"), [
    ["nav.group.azure", ["/architecture", "/live-diagram", "/health"]],
    ["nav.group.network", ["/network", "/hubble", "/network-path"]],
    ["nav.group.kubernetes", ["/kubernetes"]],
  ]);
  assert.deepEqual(shape("monitoring"), [
    ["nav.section.monState", ["/observability", "/observability/signals", "/observability/nodes"]],
    ["nav.section.monApp", ["/observability/services", "/observability/profiles"]],
    ["nav.section.monData", ["/observability/logs", "/observability/collection"]],
  ]);
  assert.deepEqual(shape("security"), [
    ["nav.section.secPriority", ["/security", "/security/risk", "/security/explore"]],
    ["nav.section.secVulns", ["/security/advisories"]],
    ["nav.section.secPosture", ["/security/findings", "/policies"]],
    ["nav.section.secAccess", ["/security/identity", "/security/threats"]],
    ["nav.section.secAudit", ["/security/compliance"]],
  ]);
  assert.deepEqual(shape("ops"), [["nav.group.cost", ["/cost"]], ["nav.group.notify", ["/notifications", "/runbooks"]]]);
  assert.deepEqual(shape("settings"), [[null, ["/settings/connections", "/settings/features"]]]);
});

test("categories: contiguous within their top category, translated, no name said twice on a path", () => {
  for (const g of NAV_GROUPS) {
    const secs = nav.sectionsOf(g);
    const named = secs.filter((s) => s.labelKey).map((s) => s.labelKey!);
    assert.equal(new Set(named).size, named.length, `${g.key}: a category appears once (contiguous)`);
    assert.ok(secs.every((s) => !!s.labelKey) || secs.length === 1, `${g.key}: all items in categories, or none`);
    for (const sec of secs) {
      if (sec.labelKey) assert.notEqual(msg.T[sec.labelKey]!.ko, msg.T[g.labelKey]!.ko, `${sec.key} differs from its top category`);
      for (const it of sec.items) {
        // a single-link group (개요) has no heading — its link is the category
        if (nav.isCollapsible(g)) assert.notEqual(msg.T[it.labelKey]!.ko, msg.T[g.labelKey]!.ko, `${it.href} differs from its top category`);
        if (sec.labelKey) assert.notEqual(msg.T[it.labelKey]!.ko, msg.T[sec.labelKey]!.ko, `${it.href} differs from its category`);
      }
    }
  }
  // sectionBefore (the home page's card labels) still reads the same categories
  const sec = NAV_GROUPS.find((g) => g.key === "security")!;
  assert.deepEqual(sec.items.map((_, i) => sectionBefore(sec.items, i)), ["nav.section.secPriority", null, null, "nav.section.secVulns", "nav.section.secPosture", null, "nav.section.secAccess", null, "nav.section.secAudit"]);
});

test("every label, description and section has ko and en text", () => {
  const keys = [
    ...NAV_GROUPS.map((g) => g.labelKey),
    ...items.flatMap((i) => [i.labelKey, i.descKey, ...(i.section ? [i.section] : [])]),
    "nav.main", "nav.openMenu", "nav.closeMenu", "nav.brandMeta", "nav.settings",
    "auth.login", "auth.logout", "auth.signingIn", "auth.signedIn", "auth.notConfigured",
  ];
  const missing = keys.filter((k) => !msg.hasTranslation(k));
  assert.deepEqual(missing, []);
});

test("icons are distinct across items and groups", () => {
  const itemIcons = items.map((i) => i.icon);
  const groupIcons = NAV_GROUPS.map((g) => g.icon);
  assert.equal(new Set(itemIcons).size, itemIcons.length, "item icons");
  assert.equal(new Set(groupIcons).size, groupIcons.length, "group icons");
  assert.deepEqual(itemIcons.filter((i) => groupIcons.includes(i)), [], "no item icon reused by a group");
});

test("scope bar: PAGE_SCOPE names only menu screens; the AKS screens share the cluster, the Azure screens the subscription", () => {
  const hrefs = new Set(items.map((i) => i.href));
  for (const k of Object.keys(nav.PAGE_SCOPE)) assert.ok(hrefs.has(k), `PAGE_SCOPE ${k} is a menu screen`);
  for (const k of ["/kubernetes", "/observability", "/hubble", "/policies"]) assert.deepEqual([...nav.PAGE_SCOPE[k]!], ["cluster"], k);
  for (const k of ["/architecture", "/health", "/cost", "/security"]) assert.deepEqual([...nav.PAGE_SCOPE[k]!], ["subscription"], k);
  assert.equal(nav.PAGE_SCOPE["/live-diagram"], undefined, "the live diagram picks its connection and VNet inside");
});

test("folding the menu at both levels: top categories and categories fold; storage is read defensively; a folded level keeps the current page's link", () => {
  assert.equal(nav.isCollapsible(NAV_GROUPS.find((g) => g.key === "overview")!), false);
  assert.ok(NAV_GROUPS.filter((g) => g.key !== "overview").every(nav.isCollapsible));
  const keys = nav.foldableKeys();
  assert.ok(keys.includes("security") && keys.includes("security:nav.section.secVulns") && keys.includes("infra:nav.group.network"), "both levels");
  assert.ok(!keys.includes("overview") && !keys.some((k) => k.startsWith("settings:")), "개요 and the unnamed list of 설정 have no category fold");
  assert.deepEqual([...nav.parseCollapsed('["security","monitoring:nav.section.monApp","azure","overview","nope",3]')].sort(), ["monitoring:nav.section.monApp", "security"], "only known keys (old group keys such as azure are dropped)");
  for (const bad of [null, "", "{", '{"a":1}', "42"]) assert.equal(nav.parseCollapsed(bad).size, 0, String(bad));
  const security = NAV_GROUPS.find((g) => g.key === "security")!;
  assert.equal(nav.shownItems(security, false, "/cost"), security.items, "open: every link");
  assert.deepEqual(nav.shownItems(security, true, "/cost"), [], "folded, elsewhere: none");
  assert.deepEqual(nav.shownItems(security, true, "/security/findings").map((i) => i.href), ["/security/findings"], "folded, here: the current page only");
  const app = nav.sectionsOf(NAV_GROUPS.find((g) => g.key === "monitoring")!).find((x) => x.labelKey === "nav.section.monApp")!;
  assert.deepEqual(nav.visibleItems(app.items, true, "/observability/profiles").map((i) => i.href), ["/observability/profiles"], "a folded category keeps the current page");
  assert.deepEqual(nav.visibleItems(app.items, true, "/observability/logs"), []);
  assert.ok(nav.NAV_COLLAPSE_KEY.startsWith("aud."));
});
