import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResourceHealthStatus } from "@aud/types";
import * as heatNs from "../../web/src/lib/healthHeatmap.ts";

const H = ((heatNs as unknown as { default?: typeof heatNs }).default ?? heatNs) as typeof heatNs;

// Synthetic resources (fake ids only)
const r = (name: string, state: ResourceHealthStatus["availabilityState"], type: string, rg: string, location?: string): ResourceHealthStatus => ({
  resourceId: `/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/${rg}/providers/${type}/${name}`,
  resourceName: name, resourceType: type, resourceGroup: rg, subscriptionId: "00000000-0000-0000-0000-000000000000", availabilityState: state, ...(location ? { location } : {}),
});
const VM = "Microsoft.Compute/virtualMachines", SQL = "Microsoft.Sql/servers/databases", KV = "Microsoft.KeyVault/vaults";
const list = [
  r("vm-b", "Available", VM, "rg-app", "koreacentral"),
  r("vm-a", "Degraded", VM, "rg-app", "koreacentral"),
  r("vm-c", "Unavailable", VM, "rg-app", "koreacentral"),
  r("db-1", "Unavailable", SQL, "rg-data", "koreasouth"),
  r("db-2", "Unavailable", SQL, "rg-data", "koreasouth"),
  r("kv-1", "Available", KV, "rg-data"),
  r("kv-2", "Unknown", KV, "rg-data"),
];

test("groups worst first: the worst state, then more Unavailable, then Degraded; tiles worst first then by name", () => {
  const g = H.groupResources(list, "type");
  assert.deepEqual(g.map((x) => x.label), ["Sql · servers/databases", "Compute · virtualMachines", "KeyVault · vaults"], "2 unavailable before 1 unavailable; Unknown-only last");
  assert.deepEqual(g[1]!.resources.map((x) => x.resourceName), ["vm-c", "vm-a", "vm-b"]);
  assert.equal(g[1]!.worst, "Unavailable");
  assert.deepEqual(g[1]!.counts, { Unavailable: 1, Degraded: 1, Unknown: 0, Available: 1 });
  assert.equal(g[2]!.worst, "Unknown");
});

test("group by resource group / region; a resource without a region goes to the '' group", () => {
  assert.deepEqual(H.groupResources(list, "rg").map((x) => x.key), ["rg-data", "rg-app"]);
  const byRegion = H.groupResources(list, "region");
  assert.ok(byRegion.some((x) => x.key === "" && x.resources.length === 2), "kv-1 and kv-2 have no location");
  assert.equal(H.groupKey(list[0]!, "type"), VM.toLowerCase());
});

test("Unknown is neutral, never a risk color; every problem state has a glyph (not color alone)", () => {
  const unknown = H.stateTone("Unknown");
  assert.ok(unknown.color !== "danger" && unknown.color !== "warning");
  assert.ok(unknown.dashed);
  assert.equal(H.stateTone("Unavailable").color, "danger");
  assert.equal(H.stateTone("Degraded").color, "warning");
  for (const s of ["Unavailable", "Degraded", "Unknown"] as const) assert.ok(H.stateTone(s).glyph, s);
});

test("at most N tiles per group, the rest counted; order does not depend on input order", () => {
  const big = Array.from({ length: 12 }, (_, i) => r(`vm-${String(i).padStart(2, "0")}`, i % 3 ? "Available" : "Degraded", VM, "rg"));
  const g = H.groupResources(big, "type")[0]!;
  assert.deepEqual([H.visibleTiles(g, 5).tiles.length, H.visibleTiles(g, 5).more], [5, 7]);
  assert.equal(H.visibleTiles(g, 50).more, 0);
  const key = (xs: ResourceHealthStatus[]) => JSON.stringify(H.groupResources(xs, "type").map((x) => [x.key, x.resources.map((y) => y.resourceName)]));
  assert.equal(key([...list].reverse()), key(list));
});

test("type labels keep the namespace (KeyVault vs RecoveryServices vaults); user-initiated only from Azure's reasonType", () => {
  assert.equal(H.typeLabel("Microsoft.KeyVault/vaults"), "KeyVault · vaults");
  assert.equal(H.typeLabel("Microsoft.RecoveryServices/vaults"), "RecoveryServices · vaults");
  assert.equal(H.typeLabel("Microsoft.Sql/servers/databases"), "Sql · servers/databases");
  const kv = r("kv", "Available", "Microsoft.KeyVault/vaults", "rg"), rsv = r("rsv", "Available", "Microsoft.RecoveryServices/vaults", "rg");
  assert.deepEqual(H.groupResources([kv, rsv], "type").map((g) => g.label).sort(), ["KeyVault · vaults", "RecoveryServices · vaults"]);
  const stopped = { ...r("vm-s", "Unavailable", VM, "rg"), reasonType: "Customer Initiated" };
  assert.ok(H.isUserInitiated(stopped));
  assert.ok(H.isUserInitiated({ ...stopped, reasonType: "UserInitiated" }));
  assert.ok(!H.isUserInitiated({ ...stopped, reasonType: "Unplanned" }));
  assert.ok(!H.isUserInitiated({ ...stopped, reasonType: undefined }), "no reason type: not assumed");
  assert.ok(!H.isUserInitiated({ ...stopped, availabilityState: "Unknown" }), "only an Unavailable state");
  // Still Unavailable, still red — only lighter
  assert.equal(H.stateTone("Unavailable", true).color, "danger");
  assert.ok(H.stateTone("Unavailable", true).alpha < H.stateTone("Unavailable").alpha);
  const g = H.groupResources([stopped, r("vm-x", "Unavailable", VM, "rg")], "type")[0]!;
  assert.deepEqual(H.groupStateCounts(g), { unavailable: 1, user: 1, degraded: 0, unknown: 0, unlisted: 0, available: 0 });
  assert.deepEqual(H.scopeOptions(H.groupResources(list, "type")).map((o) => o.label), ["Sql · servers/databases", "Compute · virtualMachines", "KeyVault · vaults"]);
});

test("Unknown on a type not on the supported list is '–' (hatched), after Available; Azure's counts unchanged", () => {
  const MA = "Microsoft.Insights/metricAlerts";
  const unlisted = new Set([MA.toLowerCase()]);
  const alert = r("alert-1", "Unknown", MA, "rg-mon");
  const lb = r("lb-1", "Unknown", "Microsoft.Network/loadBalancers", "rg-mon");
  assert.ok(H.isUnlistedUnknown(alert, unlisted));
  assert.ok(!H.isUnlistedUnknown(lb, unlisted), "Unknown on a listed type stays '?'");
  assert.ok(!H.isUnlistedUnknown({ ...alert, availabilityState: "Unavailable" }, unlisted), "another state on an unlisted type is Azure's value");
  const tone = H.stateTone("Unknown", false, true);
  assert.deepEqual([tone.glyph, tone.hatched, tone.dashed], ["–", true, false]);
  assert.ok(tone.color !== "danger" && tone.color !== "warning");
  const ok = r("alert-0", "Available", MA, "rg-mon");
  const g = H.groupResources([alert, ok, lb], "rg", { unlisted })[0]!;
  assert.deepEqual(g.resources.map((x) => x.resourceName), ["lb-1", "alert-0", "alert-1"], "after Available");
  assert.equal(g.counts.Unknown, 2, "Azure's Unknown count keeps both");
  assert.deepEqual(H.groupStateCounts(g), { unavailable: 0, user: 0, degraded: 0, unknown: 1, unlisted: 1, available: 1 });
  // A group with only unlisted-Unknown goes last, even after an all-Available group
  const groups = H.groupResources([alert, r("vm-1", "Available", VM, "rg-app")], "type", { unlisted });
  assert.equal(groups.at(-1)!.key, MA.toLowerCase());
  // No coverage known: nothing changes
  assert.deepEqual(H.groupResources(list, "type").map((x) => x.key), H.groupResources(list, "type", { unlisted: new Set() }).map((x) => x.key));
});
