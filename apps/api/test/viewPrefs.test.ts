// 설정 › 보기 설정 (2026-11-19): the per-browser view preferences (web lib/viewPrefs.ts) — the subscription filter the
// scope bar and every list inherit (Azure Portal's 고급 필터), the start subscription, the menu mode — and the
// directories table (web lib/prefsView.ts: the connections the API declares; AWS / GCP are never invented).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as vNs from "../../web/src/lib/viewPrefs.ts";
import * as pNs from "../../web/src/lib/prefsView.ts";

const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;
const P = ((pNs as unknown as { default?: typeof pNs }).default ?? pNs) as typeof pNs;
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";

test("stored prefs: anything malformed is the default; IDs are lower-cased, unique; a non-ID is dropped", () => {
  assert.deepEqual(V.parseViewPrefs(null), V.DEFAULT_VIEW_PREFS);
  assert.deepEqual(V.parseViewPrefs("{not json"), V.DEFAULT_VIEW_PREFS);
  assert.deepEqual(V.parseViewPrefs(JSON.stringify({ menu: "drawer", filterOn: false, hidden: [A.toUpperCase(), A, "x y", 3], start: B })),
    { menu: "drawer", filterOn: false, hidden: [A], start: B });
  assert.equal(V.parseViewPrefs(JSON.stringify({ menu: "sideways" })).menu, "auto");
});

test("subscription filter: hidden ones leave the scope bar; never all of them; off = everything", () => {
  const all = [{ subscriptionId: A }, { subscriptionId: B.toUpperCase() }, { subscriptionId: C }];
  const r = V.visibleSubscriptions(all, { filterOn: true, hidden: [B] });
  assert.deepEqual([r.list.map((s) => s.subscriptionId), r.hiddenCount, r.ignored], [[A, C], 1, false], "case-insensitive");
  assert.deepEqual(V.visibleSubscriptions(all, { filterOn: false, hidden: [B] }).list.length, 3);
  const none = V.visibleSubscriptions(all, { filterOn: true, hidden: [A, B, C] });
  assert.deepEqual([none.list.length, none.ignored], [3, true], "hiding everything is not applied (and said)");
  // clusters follow their subscription; a cluster ID without one stays; all hidden = not applied
  const clusters = [{ id: `/subscriptions/${A}/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/a` }, { id: `/subscriptions/${B}/resourcegroups/rg/providers/x/y/b` }, { id: "demo" }];
  assert.deepEqual(V.visibleClusters(clusters, { filterOn: true, hidden: [A] }).map((c) => c.id.slice(-1)), ["b", "o"]);
  assert.equal(V.visibleClusters(clusters.slice(0, 1), { filterOn: true, hidden: [A] }).length, 1);
});

test("start subscription: the tab's own choice › the start one (if shown) › the first", () => {
  const list = [{ subscriptionId: A }, { subscriptionId: B }];
  assert.equal(V.initialSubscription(list, B, A), B);
  assert.equal(V.initialSubscription(list, "", B.toUpperCase()), B);
  assert.equal(V.initialSubscription(list, C, C), A, "a choice / start not in the list → the first");
  assert.equal(V.initialSubscription([], "", A), "");
});

test("directories: one row per Azure connection the caller reaches — tenant name, else the connection's; AWS / GCP scopes named", () => {
  const conn = (key: string, extra: object = {}) => ({ key, displayName: `Conn ${key}`, tenantIdTail: "1a2b", mode: "platform" as const, credentialKind: "platform" as const, subscriptionCount: 4, workspaceCount: 0, ...extra });
  const rows = P.directoriesOf([conn("home", { tenantName: "Contoso" }), conn("cust")], [{ subscriptionId: A, connectionKey: "home" }]);
  assert.deepEqual(rows.map((r) => [r.key, r.directory, r.subscriptions]), [["home", "Contoso", 1], ["cust", "Conn cust", 4]]);
  assert.deepEqual(P.PROVIDER_SCOPE, { azure: "subscription", aws: "account", gcp: "project" });
  assert.ok(P.languageName("en").length > 0);
});
