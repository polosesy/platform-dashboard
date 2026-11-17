// 리소스 보안 카드 (security-roadmap 5.3 ④ — 2026-11-17). Checked on stg against independent Resource Graph KQL for a
// VM, a container registry, an AKS cluster and a PostgreSQL server (unhealthy 5 · 8,889 · 579 · 2, alerts 0 · 0 · 1 · 0,
// own roles 1 · 0 · 4 · 0, privileged access 8 each — equal). Synthetic ids and names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEnv } from "../src/env.js";
import { covers, getResourceSecurityCard, roleClass } from "../src/services/resourceSecurityCard.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUB = "00000000-0000-0000-0000-0000000000aa";
const ACR = `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.containerregistry/registries/acr1`;
const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7", KEYOP = "81a9662b-bebf-436f-a333-f67b29880f12";
const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: SUB });

test("role classes by definition id; a scope covers itself and below — never a sibling sharing the prefix", () => {
  assert.deepEqual([roleClass(OWNER), roleClass("2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"), roleClass(KEYOP), roleClass(READER)], ["privileged", "data", "keys", "other"]);
  assert.equal(covers(`/subscriptions/${SUB}`, ACR), true);
  assert.equal(covers(`/subscriptions/${SUB}/resourceGroups/RG/`, ACR), true);
  assert.equal(covers(`/subscriptions/${SUB}/resourceGroups/rg2`, ACR.replace("/rg/", "/rg2x/")), false);
  assert.equal(covers(`/subscriptions/${SUB}/resourceGroups/rg`, ACR.replace("/rg/", "/rg2/")), false, "rg is not rg2");
  assert.equal(covers("/providers/Microsoft.Management/managementGroups/mg", ACR), true);
});

const answers = (fail?: RegExp) => ({
  postJson: async (_u: string, b: { query: string }) => {
    const q = b.query;
    if (fail && fail.test(q)) throw new Error("ARM 403: AuthorizationFailed");
    if (/^resources \| where tolower\(id\) ==/.test(q)) return { data: [{ name: "acr1", type: "microsoft.containerregistry/registries", resourceGroup: "rg", location: "koreacentral",
      identity: { type: "SystemAssigned", principalId: "AAAAAAAA-0000-0000-0000-000000000001" }, properties: { publicNetworkAccess: "Enabled", networkRuleSet: { defaultAction: "Deny", ipRules: [{ value: "1.2.3.4" }] } } }] };
    if (/microsoft\.security\/assessments/.test(q)) return { data: [
      { dn: "Update zlib", sev: "High", st: "Unhealthy", entities: 40, own: 0 },
      { dn: "Disable admin user", sev: "Medium", st: "Unhealthy", entities: 1, own: 1 },
      { dn: "Use private link", sev: "Medium", st: "Healthy", entities: 1, own: 1 },
    ] };
    if (/locations\/alerts/.test(q)) return { data: [{ id: "a1", dn: "Suspicious image pull", sev: "High", st: "Active", t: "2026-11-16T00:00:00Z" }] };
    if (/properties\.principalId\)\) in/.test(q)) return { data: [{ def: KEYOP, scope: `/subscriptions/${SUB}/resourceGroups/rg` }, { def: READER, scope: `/subscriptions/${SUB}` }] };
    if (/trim_end/.test(q)) return { data: [
      { def: OWNER, scope: `/subscriptions/${SUB}`, ptype: "User", pid: "u-1111" },
      { def: OWNER, scope: `/subscriptions/${SUB}/resourceGroups/rg2`, ptype: "User", pid: "u-2222" }, // a sibling group: not covering
      { def: READER, scope: `/subscriptions/${SUB}`, ptype: "Group", pid: "g-3333" },               // other: not listed
      { def: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", scope: ACR, ptype: "ServicePrincipal", pid: "s-4444" },
    ] };
    return { data: [] };
  },
  fetchJson: async (u: string) => ({ properties: { roleName: u.includes(OWNER) ? "Owner" : u.includes(KEYOP) ? "Storage Account Key Operator Service Role" : u.includes(READER) ? "Reader" : "Storage Blob Data Reader" } }),
});

test("card: every section from the resource id — child entities counted, High first; exposure by the combinations' rule; both directions of access", async () => {
  const c = await getResourceSecurityCard(env, "t", ACR, { arm: answers() });
  assert.equal(c.resource.found, true);
  assert.deepEqual(c.recommendations.counts, { unhealthy: 41, healthy: 1, notApplicable: 0, high: 40, medium: 1, low: 0 });
  assert.deepEqual(c.recommendations.items.map((r) => [r.name, r.entities, r.onSelf]), [["Update zlib", 40, false], ["Disable admin user", 1, true]]);
  assert.deepEqual(c.alerts.items.map((a) => a.title), ["Suspicious image pull"]);
  assert.deepEqual([c.exposure.section, c.exposure.factor?.state, c.exposure.factor?.limited], ["ok", "yes", true], "an IP allow list = exposed, limited");
  assert.deepEqual(c.identity.roles.map((r) => [r.roleName, r.class, r.scope]), [["Storage Account Key Operator Service Role", "keys", "resourceGroup"], ["Reader", "other", "subscription"]]);
  assert.deepEqual(c.access.byClass, [{ class: "privileged", assignments: 1, principals: 1 }, { class: "data", assignments: 1, principals: 1 }], "the sibling group's Owner and the Reader are not counted");
  assert.deepEqual(c.access.items.map((x) => [x.roleName, x.principalTail]), [["Owner", "1111"], ["Storage Blob Data Reader", "4444"]]);
  assert.equal(c.access.aboveHidden, false, "subscription-level assignments came back: visible");
});

test("an identity that sees resource-group assignments only: the role sections say so — an empty list is not 'none'", async () => {
  const base = answers();
  const rgOnly = { ...base, postJson: async (u: string, b: { query: string }) => /trim_end/.test(b.query)
    ? { data: [{ def: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", scope: `/subscriptions/${SUB}/resourceGroups/rg`, ptype: "ServicePrincipal", pid: "s-5555" }] } : base.postJson(u, b) };
  const c = await getResourceSecurityCard(env, "t", ACR, { arm: rgOnly });
  assert.deepEqual([c.access.state, c.access.aboveHidden, c.access.byClass.map((x) => x.class)], ["ok", true, ["data"]]);
  const card = read("../../web/src/components/ResourceSecurityCard.tsx");
  assert.match(card, /aboveHidden \? t\("rsc\.noAccessVisible"\)/);
  assert.match(card, /aboveHidden \? t\("rsc\.noRolesVisible"/);
});

test("a section not read is 'failed' (never 'none'), the others still answer", async () => {
  const c = await getResourceSecurityCard(env, "t", ACR, { arm: answers(/locations\/alerts/) });
  assert.equal(c.alerts.state, "failed");
  assert.equal(c.recommendations.state, "ok");
  const noAccess = await getResourceSecurityCard(env, "t", ACR, { arm: answers(/trim_end/) });
  assert.equal(noAccess.access.state, "failed");
  const gone = await getResourceSecurityCard(env, "t", ACR, { arm: answers(/^resources \| where tolower\(id\) ==/) });
  assert.deepEqual([gone.resource.found, gone.exposure.section, gone.identity.state], [false, "failed", "failed"]);
});

test("regression: the alerts query parses — a column named `title` with distinct failed every card on stg", () => {
  const svc = read("../src/services/resourceSecurityCard.ts");
  assert.match(svc, /\| distinct id, dn, sev, st, t/);
  assert.doesNotMatch(svc, /distinct id, title/);
  assert.doesNotMatch(svc, /take_any\(properties\) by id/);
});

test("wiring: signed-in route; the card in 통합 위험 (combinations, paths) and in the diagram inspector (live data only)", () => {
  assert.match(read("../src/routes/security.ts"), /"\/api\/security\/resource-card"[\s\S]{0,200}signin_required[\s\S]{0,120}queryArmResourceId\(req, env, "resourceId"\)/);
  assert.match(read("../../web/src/app/security/risk/AzureRiskPanel.tsx"), /<ResourceSecurityCard resourceId=\{c\.resourceId\} \/>/);
  assert.match(read("../../web/src/app/security/risk/AzurePathsPanel.tsx"), /<ResourceSecurityCard resourceId=\{p\.entry\.resourceId\} \/>/);
  assert.match(read("../../web/src/app/architecture/page.tsx"), /securityCard=\{graph\.source !== "mock"\}/);
  const card = read("../../web/src/components/ResourceSecurityCard.tsx");
  const all = read("../../web/src/lib/i18nMessages.ts");
  const keys = new Set([...card.matchAll(/t\("(rsc\.[\w.]+)"/g)].map((m) => m[1]!));
  for (const k of ["exposedHighIdentity", "exposedIdentity", "exposedHigh", "highIdentity"]) keys.add(`rsc.combo.${k}`);
  for (const k of ["data", "control", "entry"]) keys.add(`rsc.path.${k}`);
  for (const k of ["privileged", "data", "keys", "other"]) keys.add(`rsc.class.${k}`);
  for (const k of ["High", "Medium", "Low"]) keys.add(`rsc.sev.${k}`);
  keys.add("rsc.aboveHidden"); keys.add("azr.reason.rolesAboveHidden"); keys.add("azp.stopAboveHidden");
  for (const k of keys) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});
