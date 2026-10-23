import { test } from "node:test";
import assert from "node:assert/strict";
import {
  domainOf,
  mapAlerts,
  mapControls,
  mapPlans,
  mapRecommendations,
  maskGuids,
  plainText,
  resourceRef,
  sampleRef,
} from "../src/services/securityPosture.js";
import { ownerResourceId } from "../src/services/azure.js";

const SUB = "11111111-2222-3333-4444-555555555555";
const VM = `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-01`;

test("resourceRef: name / type / RG, subscription IDs never leak", () => {
  assert.deepEqual(resourceRef(VM), { name: "vm-01", type: "virtualMachines", resourceGroup: "rg-app", armType: "microsoft.compute/virtualmachines" });
  assert.equal(resourceRef(`/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s`)?.armType, "microsoft.network/virtualnetworks/subnets");
  assert.deepEqual(resourceRef(`/subscriptions/${SUB}`), { name: "subscription", type: "subscription", resourceGroup: "" });
  const ws = resourceRef(`/subscriptions/${SUB}/resourceGroups/DefaultResourceGroup-EUS/providers/Microsoft.OperationalInsights/workspaces/DefaultWorkspace-${SUB}-EUS`);
  assert.equal(ws?.name, "DefaultWorkspace-…5555-EUS");
  assert.equal(maskGuids(`a-${SUB}`), "a-…5555");
});

test("sampleRef prefers Defender's ResourceName/Type (identity findings)", () => {
  const id = `/subscriptions/${SUB}/providers/Microsoft.Security/pricings/CloudPosture/securityentitydata/${SUB}`;
  assert.deepEqual(sampleRef({ id, n: "jane.doe", t: "microsoft.security/azureiamuser" }), { name: "jane.doe", type: "azureiamuser", resourceGroup: "" });
  assert.deepEqual(sampleRef({ id, n: SUB, t: "microsoft.security/azureiamuser" })?.name, "…5555");
  assert.deepEqual(sampleRef({ id: VM }), { name: "vm-01", type: "virtualMachines", resourceGroup: "rg-app", armType: "microsoft.compute/virtualmachines" });
  assert.equal(sampleRef({}), null);
});

test("domainOf maps Defender categories, unknown → other", () => {
  assert.equal(domainOf(["IdentityAndAccess"]), "identity");
  assert.equal(domainOf(["Unknown", "Networking"]), "network");
  assert.equal(domainOf(["Container"]), "container");
  assert.equal(domainOf(["Unknown"]), "other");
  assert.equal(domainOf(undefined), "other");
});

test("plainText strips Defender HTML and caps length", () => {
  assert.equal(plainText("1. Open<br>2. Click <a href='x'>Save</a> &amp; done"), "1. Open\n2. Click Save & done");
  assert.equal(plainText("   "), undefined);
  assert.equal(plainText("x".repeat(20), 10)?.length, 10);
});

test("mapRecommendations: drops healthy-only rows, sorts by severity then affected count", () => {
  const recs = mapRecommendations([
    { key: "a", title: "Low many", sev: "Low", unhealthy: 50, healthy: 1, md: { categories: ["Compute"] } },
    { key: "b", title: "High few", sev: "High", unhealthy: 2, healthy: 0, md: { categories: ["IdentityAndAccess"], threats: ["AccountBreach"] } },
    { key: "c", title: "Healthy only", sev: "High", unhealthy: 0, healthy: 9 },
    { key: "d", title: "Medium", sev: "Medium", unhealthy: 5, healthy: 5, md: { remediationDescription: "Do<br>this" }, samples: [{ id: VM }] },
    { key: "e", title: "High many", sev: "High", unhealthy: 9, healthy: 0 },
  ]);
  assert.deepEqual(recs.map((r) => r.key), ["e", "b", "d", "a"]);
  assert.equal(recs[1]!.domain, "identity");
  assert.deepEqual(recs[1]!.threats, ["AccountBreach"]);
  assert.equal(recs[2]!.remediation, "Do\nthis");
  assert.equal(recs[2]!.samples[0]!.name, "vm-01");
  assert.match(recs[0]!.portalUrl, /assessmentKey\/e$/);
});

test("mapControls sorts by points left to gain", () => {
  const c = mapControls([
    { dn: "A", s: { current: 3.9, max: 4 }, u: 1 },
    { dn: "B", s: { current: 0, max: 6 }, u: 10 },
    { dn: "C", s: { current: 1, max: 4 }, u: 3 },
  ]);
  assert.deepEqual(c.map((x) => x.controlName), ["B", "C", "A"]);
});

test("mapPlans lists paid (Standard) plans first", () => {
  assert.deepEqual(mapPlans([{ name: "VirtualMachines", tier: "Free" }, { name: "CloudPosture", tier: "Standard" }]).map((p) => p.name), ["CloudPosture", "VirtualMachines"]);
});

test("mapAlerts: newest first, resource names from ResourceIdentifiers", () => {
  const alerts = mapAlerts([
    { id: "/x/alerts/1", dn: "Old", sev: "Low", t: "2026-10-01T00:00:00Z", rids: [{ AzureResourceId: VM }, { Type: "AAD" }] },
    { id: "/x/alerts/2", dn: "New", sev: "High", t: "2026-10-10T00:00:00Z", rids: null },
  ]);
  assert.deepEqual(alerts.map((a) => a.title), ["New", "Old"]);
  assert.deepEqual(alerts[1]!.resources, [{ name: "vm-01", type: "virtualMachines", resourceGroup: "rg-app", armType: "microsoft.compute/virtualmachines" }]);
  assert.equal(alerts[0]!.id, "2");
});

test("ownerResourceId resolves the top-level owner of an ip configuration", () => {
  assert.equal(ownerResourceId(`${VM.replace("Microsoft.Compute/virtualMachines/vm-01", "Microsoft.Network/networkInterfaces/nic1")}/ipConfigurations/ipconfig1`), `/subscriptions/${SUB}/resourcegroups/rg-app/providers/microsoft.network/networkinterfaces/nic1`);
  const vmssNic = `/subscriptions/${SUB}/resourceGroups/mc_rg/providers/Microsoft.Compute/virtualMachineScaleSets/aks-pool/virtualMachines/0/networkInterfaces/n/ipConfigurations/i`;
  assert.equal(ownerResourceId(vmssNic), `/subscriptions/${SUB}/resourcegroups/mc_rg/providers/microsoft.compute/virtualmachinescalesets/aks-pool`);
  assert.equal(ownerResourceId("not-an-id"), undefined);
});

// ── collection, auth and masking ──
import { collectPosture, safeMessage, tryGetSecurityPosture, type PostureDeps } from "../src/services/securityPosture.js";
import { loadEnv } from "../src/env.js";
import { mockSecurityPosture } from "../src/mockData.js";

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const baseEnv = (extra: Record<string, string> = {}) =>
  loadEnv({ AZURE_SUBSCRIPTION_IDS: SUB, AZURE_AD_TENANT_ID: "t", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", ...extra } as NodeJS.ProcessEnv);

/** Fake Resource Graph: answers by query text; `fail` sections throw a scoped 403. */
function fakeArm(fail: string[] = [], calls = { n: 0 }) {
  return {
    calls,
    postJson: async <T>(_url: string, body: unknown): Promise<T> => {
      calls.n++;
      const q = (body as { query: string }).query;
      const section = q.includes("dcount(rid)") ? "affected" : q.includes("securescorecontrols") ? "controls" : q.includes("securescores") ? "score" : q.includes("regulatorycompliance") ? "compliance" : q.includes("pricings") ? "plans" : q.includes("alerts") ? "alerts" : "recommendations";
      if (fail.includes(section)) throw new Error(`ARM 403: no access to scope '/subscriptions/${SUB}/resourceGroups/rg' for ${SUB}`);
      const data: Record<string, unknown[]> = {
        recommendations: [{ key: "k1", title: "Rec", sev: "High", unhealthy: 2, healthy: 1, md: { categories: ["Networking"] }, samples: [{ id: VM }] }],
        affected: [{ sev: "High", n: 1 }],
        score: [{ s: { current: 8.78, max: 43 } }],
        controls: [{ dn: "C", s: { current: 1, max: 4 }, u: 2 }],
        compliance: [{ name: "SOC-2", st: "Failed", p: 3, f: 1 }],
        plans: [{ name: "CloudPosture", tier: "Standard" }],
        alerts: [],
      };
      return { data: data[section] } as T;
    },
  };
}

test("collectPosture: failed sections become masked gaps, never leaking subscription IDs", async () => {
  const out = await collectPosture(fakeArm(["compliance", "alerts"]), [SUB]);
  assert.deepEqual(out.gaps.map((g) => g.section).sort(), ["alerts", "compliance"]);
  assert.deepEqual(out.score, { current: 8.78, max: 43, percentage: 20.4 });
  assert.equal(out.recommendations[0]!.domain, "network");
  const json = JSON.stringify(out);
  assert.ok(!json.includes("/subscriptions/"), json);
  assert.ok(!GUID_RE.test(json.replace(/"key":"[^"]*"/g, "")), "no GUIDs outside assessment keys");
  await assert.rejects(collectPosture(fakeArm(["recommendations", "affected", "score", "controls", "compliance", "plans", "alerts"]), [SUB]), (e: Error) => !GUID_RE.test(e.message) && !e.message.includes("/subscriptions/"));
  assert.equal(safeMessage(new Error(`denied on /subscriptions/${SUB}/x, id ${SUB}`)), "denied on [scope], id …5555");
});

test("tryGetSecurityPosture auth: OBO with a token, SP only when the switch is on, no SP fallback after OBO", async () => {
  const used: string[] = [];
  const deps = (oboFails = false): PostureDeps => ({
    obo: async () => { used.push("obo"); if (oboFails) throw new Error("AADSTS65001"); return fakeArm(); },
    sp: async () => { used.push("sp"); return fakeArm(); },
  });
  assert.equal(await tryGetSecurityPosture(baseEnv(), undefined, undefined, deps()), null, "anonymous + switch off → mock");
  assert.deepEqual(used, []);
  // the feature flag alone no longer opens the service principal: the dev master switch must be on too
  assert.equal(await tryGetSecurityPosture(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true" }), undefined, undefined, deps()), null);
  assert.deepEqual(used, [], "old flag without AUD_ANONYMOUS_SP → no SP");
  const sp = await tryGetSecurityPosture(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true", AUD_ANONYMOUS_SP: "true" }), undefined, undefined, deps());
  assert.equal(sp?.source, "azure");
  assert.deepEqual(used, ["sp"]);
  used.length = 0;
  await assert.rejects(tryGetSecurityPosture(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true", AUD_ANONYMOUS_SP: "true" }), "token-a.b.c-unique-1", undefined, deps(true)));
  assert.deepEqual(used, ["obo"], "an OBO failure must not fall back to the service principal");
  assert.equal(await tryGetSecurityPosture(baseEnv({ AZURE_SECURITY_ENABLED: "false" }), "t", undefined, deps()), null);
});

test("tryGetSecurityPosture: concurrent identical requests share one set of queries", async () => {
  const calls = { n: 0 };
  const arm = fakeArm([], calls);
  const deps: PostureDeps = { obo: async () => arm, sp: async () => arm };
  const env = baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true", AUD_ANONYMOUS_SP: "true", AZURE_SUBSCRIPTION_IDS: "22222222-2222-2222-2222-222222222222" });
  const [a, b] = await Promise.all([tryGetSecurityPosture(env, undefined, undefined, deps), tryGetSecurityPosture(env, undefined, undefined, deps)]);
  assert.equal(a, b);
  assert.equal(calls.n, 7, "seven sections, one query each");
});

test("affected resources are distinct ids per severity, not the sum over recommendations", async () => {
  const p = await collectPosture(fakeArm(), [SUB]);
  assert.equal(p.recommendations[0]!.unhealthy, 2, "findings: one resource per recommendation");
  assert.deepEqual(p.affected, { High: 1, Medium: 0, Low: 0 });
  const failed = await collectPosture(fakeArm(["affected"]), [SUB]);
  assert.equal(failed.affected, null, "a failed count is null (not collected), never the sum");
  assert.ok(failed.gaps.some((g) => g.section === "affected"));
});

test("env: AZURE_SECURITY_SP_FALLBACK parses as a real boolean and defaults off", () => {
  assert.equal(baseEnv().AZURE_SECURITY_SP_FALLBACK, false);
  assert.equal(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "false" }).AZURE_SECURITY_SP_FALLBACK, false);
  assert.equal(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "0" }).AZURE_SECURITY_SP_FALLBACK, false);
  assert.equal(baseEnv({ AZURE_SECURITY_SP_FALLBACK: "true" }).AZURE_SECURITY_SP_FALLBACK, true);
});

test("mock posture is marked as mock and has no IDs", () => {
  assert.equal(mockSecurityPosture.source, "mock");
  const json = JSON.stringify(mockSecurityPosture);
  assert.ok(!json.includes("/subscriptions/") && !GUID_RE.test(json));
});
