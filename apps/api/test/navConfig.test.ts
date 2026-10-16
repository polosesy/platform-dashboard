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
const { NAV_GROUPS, isItemActive, activeGroupKey, activeNavItem, sectionBefore } = nav;

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

test("every page route appears in the menu exactly once", () => {
  const routes = pageRoutes().sort();
  const hrefs = items.map((i) => i.href).sort();
  assert.deepEqual(hrefs, [...new Set(hrefs)], "no duplicate menu entries");
  assert.deepEqual(hrefs, routes);
  assert.equal(routes.length, 18);
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
  assert.equal(activeGroupKey("/does-not-exist"), null);
  assert.equal(activeNavItem("/does-not-exist"), null);
});

test("group order and shape: 7 slots, single-item groups are direct links", () => {
  assert.deepEqual(NAV_GROUPS.map((g) => g.key), ["overview", "azure", "network", "kubernetes", "security", "cost", "settings"]);
  assert.deepEqual(NAV_GROUPS.filter((g) => g.items.length === 1).map((g) => g.key), ["overview", "cost"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "settings")!.items.map((i) => i.href), ["/settings/connections", "/settings/features"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "azure")!.items.map((i) => i.href), ["/architecture", "/live-diagram", "/health"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "network")!.items.map((i) => i.href), ["/network", "/hubble"]);
  assert.deepEqual(
    NAV_GROUPS.find((g) => g.key === "security")!.items.map((i) => i.href),
    ["/security/risk", "/security", "/security/findings", "/security/identity", "/security/threats", "/security/compliance", "/policies"],
  );
});

test("sections: only in the security group, contiguous, translated, never repeating an item label", () => {
  for (const g of NAV_GROUPS) {
    const secs = g.items.map((i) => i.section);
    if (g.key !== "security") { assert.ok(secs.every((s) => !s), `${g.key} has no sections`); continue; }
    assert.ok(secs.every(Boolean), "every security item has a section");
    const seen = new Set<string>();
    secs.forEach((s, i) => {
      if (s !== secs[i - 1]) { assert.ok(!seen.has(s!), `section ${s} is contiguous`); seen.add(s!); }
    });
    assert.deepEqual([...seen], ["nav.section.crossRisk", "nav.section.azureSecurity", "nav.section.clusterSecurity"]);
    assert.deepEqual(g.items.map((_, i) => sectionBefore(g.items, i)), ["nav.section.crossRisk", "nav.section.azureSecurity", null, null, null, null, "nav.section.clusterSecurity"]);
    for (const it of g.items) assert.notEqual(msg.T[it.labelKey]!.ko, msg.T[it.section!]!.ko, `${it.href} label differs from its section heading`);
  }
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
