import { test } from "node:test";
import assert from "node:assert/strict";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as tabsNs from "../../web/src/app/policies/tabs.ts";
import * as qpNs from "../../web/src/lib/queryParam.ts";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const tabs = ((tabsNs as unknown as { default?: typeof tabsNs }).default ?? tabsNs) as typeof tabsNs;
const qp = ((qpNs as unknown as { default?: typeof qpNs }).default ?? qpNs) as typeof qpNs;
const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;

test("every legacy panel belongs to exactly one group", () => {
  const all = tabs.POLICY_GROUPS.flatMap((g) => g.panels);
  assert.deepEqual([...all].sort(), [...tabs.PANELS].sort());
  assert.equal(new Set(all).size, all.length);
  for (const p of tabs.PANELS) assert.ok(tabs.groupOfPanel(p).panels.includes(p));
});

test("groupOfPanel falls back to the overview; score cards open config › findings", () => {
  for (const v of ["", "nope", null, undefined]) assert.equal(tabs.groupOfPanel(v).id, "overview");
  assert.equal(tabs.groupOfPanel("findings").id, "config");
  assert.equal(tabs.groupOfPanel("rbac").id, "identity");
  assert.equal(tabs.groupOfPanel("network").id, "exposure");
});

test("group and panel labels are translated", () => {
  const keys = [...tabs.POLICY_GROUPS.map((g) => `pol.group.${g.id}`), ...tabs.PANELS.map((p) => `pol.panel.${p}`)];
  assert.deepEqual(keys.filter((k) => !msg.hasTranslation(k)), []);
});

test("query param helpers: allow-list, fallback removal, other params kept", () => {
  const allowed = ["all", "network", "data"] as const;
  assert.equal(qp.parseParam("?domain=network", "domain", allowed, "all"), "network");
  assert.equal(qp.parseParam("?domain=evil", "domain", allowed, "all"), "all");
  assert.equal(qp.parseParam("", "domain", allowed, "all"), "all");
  assert.equal(qp.withParam("?a=1", "domain", "data", "all"), "?a=1&domain=data");
  assert.equal(qp.withParam("?a=1&domain=data", "domain", "all", "all"), "?a=1");
  assert.equal(qp.withParam("?domain=data", "domain", "all", "all"), "");
  assert.equal(qp.parseParam(qp.withParam("", "q", "a b&c", ""), "q", ["a b&c"], ""), "a b&c", "encoding round-trip");
});
