// Front Door Standard/Premium state: users' requests decide, origin probes are read per routed origin group and can
// only warn. The incident: a profile-wide OriginHealthPercentage of 0 % — from a test group and an unrouted group,
// while the served route's group had probes off — painted a working service red. Synthetic config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afdOriginGroups, MAX_PROBED_GROUPS, type AfdConfig } from "../src/services/frontDoorConfig.js";
import { afdProbeBindings, effectiveBindings } from "../src/services/specGenerator.js";
import { resolveNodeHealth } from "../src/services/healthCalculator.js";
import { resolveEvidence } from "../src/services/healthEvidence.js";
import * as fmtNs from "../../web/src/lib/liveMetricFormat.ts";

const F = ((fmtNs as unknown as { default?: typeof fmtNs }).default ?? fmtNs) as typeof fmtNs;
const probe = { path: "/", method: "HEAD", protocol: "Http", intervalSec: 100 };
const cfg: AfdConfig = {
  endpoints: [{ name: "app", hostName: "app.z01.azurefd.net", enabled: true }, { name: "test", hostName: "t.azurefd.net", enabled: true }, { name: "off", hostName: "o.azurefd.net", enabled: false }],
  groups: [
    { name: "Og-App", probe: null },                 // the served route — probes off
    { name: "og-test", probe },                      // routed, probes on (failing in the incident)
    { name: "og-unused", probe },                    // probes on, no route
    { name: "og-offendpoint", probe },               // only routed on a disabled endpoint
    { name: "og-alldisabled", probe },               // routed, every origin disabled
  ],
  routes: [
    { endpoint: "app", name: "r-app", originGroup: "og-app", enabled: true },
    { endpoint: "test", name: "r-test", originGroup: "og-test", enabled: true },
    { endpoint: "off", name: "r-off", originGroup: "og-offendpoint", enabled: true },
    { endpoint: "test", name: "r-dis", originGroup: "og-alldisabled", enabled: true },
  ],
  origins: [
    { group: "og-app", name: "a", hostName: "203.0.113.10", enabled: true },
    { group: "og-test", name: "t", hostName: "10.0.0.5", enabled: true },
    { group: "og-unused", name: "u", hostName: "198.51.100.7", enabled: true },
    { group: "og-offendpoint", name: "e", hostName: "198.51.100.8", enabled: true },
    { group: "og-alldisabled", name: "d", hostName: "198.51.100.9", enabled: false },
  ],
};

test("origin groups: probe health read only for routed groups with probes on and an enabled origin (original spelling)", () => {
  const g = afdOriginGroups(cfg);
  assert.deepEqual(g.filter((x) => x.probeIndex != null).map((x) => [x.name, x.probeIndex]), [["og-test", 0]]);
  assert.deepEqual(g.find((x) => x.name === "Og-App"), { name: "Og-App", routed: true, probe: null, origins: 1, enabledOrigins: 1 });
  assert.equal(g.find((x) => x.name === "og-unused")!.routed, false);
  assert.equal(g.find((x) => x.name === "og-offendpoint")!.routed, false, "a disabled endpoint takes no traffic");
  assert.equal(g[0]!.routed, true, "routed groups first");
  assert.equal(afdOriginGroups({ ...cfg, groups: undefined }).length, 0, "older cache entry: nothing claimed");
});

test("bindings: one OriginGroup-filtered 5-minute probe per read group; no profile-wide OriginHealthPercentage", () => {
  const b = afdProbeBindings(JSON.stringify([{ name: "og-te'st", probeIndex: 0 }, { name: "x", probeIndex: MAX_PROBED_GROUPS }]));
  assert.deepEqual(Object.keys(b), ["probe0"]);
  assert.equal(b.probe0!.filter, "OriginGroup eq 'og-te''st'");
  assert.equal(b.probe0!.window, "PT5M");
  const eff = effectiveBindings({
    resourceKind: "frontDoor", icon: "frontDoor", bindings: {},
    azureResourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Cdn/profiles/afd",
    metadata: { originGroups: JSON.stringify(afdOriginGroups(cfg)) },
  });
  assert.ok(eff.probe0 && !eff.backend, "per-group probe, no profile-wide backend");
  assert.ok(Object.values(eff).every((x) => x.metric !== "OriginHealthPercentage" || x.filter), "never unfiltered");
});

test("state: probe 0 % with users served → warning (not critical); a high 5xx share → critical; probes off → users decide", () => {
  const b = effectiveBindings({ resourceKind: "frontDoor", icon: "frontDoor", bindings: {}, azureResourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Cdn/profiles/afd", metadata: { originGroups: JSON.stringify(afdOriginGroups(cfg)) } });
  assert.equal(resolveNodeHealth({ requests: 220, errorRate: 0, probe0: 0 }, b).health, "warning");
  assert.equal(resolveNodeHealth({ requests: 220, errorRate: 30, probe0: 100 }, b).health, "critical");
  assert.equal(resolveNodeHealth({ requests: 220, errorRate: 0.2 }, b).health, "ok");
  const ev = resolveEvidence({ kind: "frontDoor", health: "warning", judged: true, metrics: { requests: 220, errorRate: 0, probe0: 0 } });
  assert.deepEqual([ev.health, ev.reasons.includes("ld.ev.afdProbeFailOpen")], ["warning", true]);
});

test("card: Front Door Standard/Premium shows requests and the users' 5xx share; classic keeps backend health", () => {
  assert.deepEqual(F.cardCells("frontDoor", ["requests", "errorRate", "probe0", "latency"]), ["requests", "errorRate"]);
  assert.deepEqual(F.cardCells("frontDoor", ["requests", "backend", "latency"]), ["requests", "backend"]);
});
