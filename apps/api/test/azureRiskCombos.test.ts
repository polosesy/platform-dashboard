// 보안 › 이슈·통합 위험 › Azure 위험 조합 (docs/architecture/security-roadmap.md 5.3 ② — 2026-11-17). Checked on stg
// against independent Resource Graph joins (High-finding resources 699 · 13 · 5, privileged identity 3 · 0 · 0,
// High ∧ privileged 1 · 0 · 0 — equal). Synthetic ids and names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { InboundExposure } from "@aud/types";
import { azureRiskKey, fromId, getAzureRiskCombos, judgeCombos, paasExposureFactor, scopeKind, vmExposure, type CombosInput } from "../src/services/azureRiskCombos.js";
import { ISSUE_KEY } from "../src/services/issueStateStore.js";
import { loadEnv } from "../src/env.js";
import * as iqNs from "../../web/src/lib/issueQueue.ts";

const IQ = ((iqNs as unknown as { default?: typeof iqNs }).default ?? iqNs) as typeof iqNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUB = "00000000-0000-0000-0000-0000000000aa";
const id = (rg: string, t: string, n: string) => `/subscriptions/${SUB}/resourcegroups/${rg}/providers/${t}/${n}`;
const VM = "microsoft.compute/virtualmachines";
const ex = (state: InboundExposure["state"], extra: Partial<InboundExposure> = {}): InboundExposure => ({ state, ports: ["22"], sources: state === "open" ? "any" : "ranges", rangeCount: 1, nsgs: ["nic"], reasons: [], basis: "cfg", ...extra });

test("ids: any ARM id (nested types, no resource group) → name / full type / group; the issue key has no subscription", () => {
  assert.deepEqual(fromId(id("rg-a", "Microsoft.Compute/virtualMachines", "vm1")), { resourceGroup: "rg-a", type: VM, name: "vm1" });
  assert.deepEqual(fromId(`/subscriptions/${SUB}/resourceGroups/rg-a/providers/Microsoft.ContainerRegistry/registries/acr1/repositories/app`),
    { resourceGroup: "rg-a", type: "microsoft.containerregistry/registries/repositories", name: "app" }, "a nested resource (dropped by a one-level parse — 669 of 699 on stg)");
  assert.deepEqual(fromId(`/subscriptions/${SUB}/providers/Microsoft.Security/pricings/VirtualMachines`), { resourceGroup: "", type: "microsoft.security/pricings", name: "VirtualMachines" });
  assert.equal(fromId("/not/an/id"), null);
  const k = azureRiskKey("RG-A", VM, "Vm 1");
  assert.equal(k, "azure:rg-a/microsoft.compute/virtualmachines/vm-1");
  assert.match(k, ISSUE_KEY);
  assert.ok(!k.includes(SUB));
  assert.deepEqual([scopeKind(`/subscriptions/${SUB}`), scopeKind(`/subscriptions/${SUB}/resourceGroups/rg`), scopeKind(id("rg", VM, "x")), scopeKind("/providers/Microsoft.Management/managementGroups/mg")],
    ["subscription", "resourceGroup", "resource", "managementGroup"]);
});

test("exposure facts: VM = the diagram's NSG verdict (scoped = limited), PaaS = public access + body rules; unknown stays unknown", () => {
  assert.deepEqual(vmExposure(undefined), { state: "no", detail: "no public IP" });
  assert.equal(vmExposure(ex("open")).state, "yes");
  assert.deepEqual([vmExposure(ex("scoped")).state, vmExposure(ex("scoped")).limited], ["yes", true]);
  assert.equal(vmExposure(ex("closed")).state, "no");
  assert.deepEqual(vmExposure(ex("unknown", { reasons: ["nsgUnreadable"] })), { state: "unknown", reason: "nsgUnreadable" });
  const st = "microsoft.storage/storageaccounts";
  assert.equal(paasExposureFactor(st, { publicNetworkAccess: "Enabled", networkAcls: { defaultAction: "Allow" } }).state, "yes");
  assert.equal(paasExposureFactor(st, { publicNetworkAccess: "Enabled", networkAcls: { defaultAction: "Deny" } }).state, "no");
  assert.equal(paasExposureFactor(st, { publicNetworkAccess: "Disabled" }).state, "no");
  assert.deepEqual(paasExposureFactor(st, {}), { state: "unknown", reason: "publicAccessUnset" });
  assert.deepEqual(paasExposureFactor("microsoft.sql/servers", { publicNetworkAccess: "Enabled" }), { state: "unknown", reason: "childRules" }, "firewall rules are child resources — not read here");
});

const P_OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", P_READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
const res = (rg: string, t: string, n: string) => ({ name: n, type: t, resourceGroup: rg });
const base = (): CombosInput => ({
  exposure: [
    { id: id("rg", VM, "open-vm"), ...res("rg", VM, "open-vm"), ...vmExposure(ex("open")) },
    { id: id("rg", VM, "scoped-vm"), ...res("rg", VM, "scoped-vm"), ...vmExposure(ex("scoped")) },
    { id: id("rg", VM, "unk-vm"), ...res("rg", VM, "unk-vm"), ...vmExposure(ex("unknown")) },
  ],
  high: new Map([
    [id("rg", VM, "open-vm"), { count: 3, names: ["a"], ...res("rg", VM, "open-vm") }],
    [id("rg", VM, "scoped-vm"), { count: 1, names: ["b"], ...res("rg", VM, "scoped-vm") }],
    [id("rg", VM, "unk-vm"), { count: 1, names: ["c"], ...res("rg", VM, "unk-vm") }],
    [id("rg", VM, "inner-vm"), { count: 2, names: ["d"], ...res("rg", VM, "inner-vm") }],
  ]),
  identities: new Map([
    [id("rg", VM, "open-vm"), { principals: ["p-1"], ...res("rg", VM, "open-vm") }],
    [id("rg", VM, "inner-vm"), { principals: ["p-2"], ...res("rg", VM, "inner-vm") }],
    [id("rg", "microsoft.web/sites", "app"), { principals: ["p-3"], ...res("rg", "microsoft.web/sites", "app") }],
  ]),
  roles: [
    { principalId: "P-1", roleDefGuid: P_OWNER, scope: `/subscriptions/${SUB}` },
    { principalId: "p-2", roleDefGuid: P_OWNER.toUpperCase(), scope: `/subscriptions/${SUB}/resourceGroups/rg` },
    { principalId: "p-3", roleDefGuid: P_READER, scope: `/subscriptions/${SUB}` },
  ],
});

test("combinations: two or more 'yes' per resource; kinds and levels; listed-sources-only exposure one level lower", () => {
  const r = judgeCombos(base(), SUB);
  assert.deepEqual(r.combos.map((c) => [c.name, c.kind, c.sev]), [
    ["open-vm", "exposedHighIdentity", "critical"],
    ["inner-vm", "highIdentity", "medium"],
    ["scoped-vm", "exposedHigh", "medium"],
  ], "by level, then by High findings (inner-vm 2 > scoped-vm 1)");
  assert.deepEqual(r.combos[0]!.identity.roles, [{ role: "owner", scope: "subscription" }], "principal ids and definition ids compared case-insensitively");
  assert.equal(r.combos[2]!.exposure.limited, true);
  assert.deepEqual(r.counts, { exposed: 2, high: 4, privileged: 2, combos: 3, undetermined: 1 }, "unk-vm: High yes, exposure unknown → undetermined, not dropped silently");
  assert.ok(!r.combos.some((c) => c.name === "app"), "a Reader role is not privileged");
  for (const c of r.combos) assert.match(c.key, ISSUE_KEY);
});

test("unknown is never 'no': unread sources make their factor unknown (and the resource undetermined), never n/a or absent", () => {
  const noRoles = judgeCombos({ ...base(), roles: null }, SUB);
  assert.deepEqual(noRoles.combos.map((c) => [c.name, c.kind]), [["open-vm", "exposedHigh"], ["scoped-vm", "exposedHigh"]]);
  assert.equal(noRoles.combos[0]!.identity.state, "unknown");
  assert.equal(noRoles.combos[0]!.identity.reason, "rolesUnread");
  const vmUnread = judgeCombos({ ...base(), exposure: [], exposureUnread: { vm: true, paas: false } }, SUB);
  assert.equal(vmUnread.combos.find((c) => c.name === "open-vm")!.exposure.state, "unknown", "the diagram failed: a VM's exposure is unknown, not n/a");
  const appOwner = [...base().roles!, { principalId: "p-3", roleDefGuid: P_OWNER, scope: `/subscriptions/${SUB}` }];
  const appOnly = judgeCombos({ exposure: [], high: new Map(), identities: base().identities, roles: appOwner, exposureUnread: { vm: false, paas: true } }, SUB);
  assert.ok(appOnly.counts.undetermined >= 1, "PaaS public access unread: a privileged app is undetermined");
});

test("assignments above the resource groups not visible (Reader on groups only): 'no privileged role' becomes unknown", async () => {
  const b = base();
  b.identities!.set(id("rg", VM, "scoped-vm"), { principals: ["p-3"], ...res("rg", VM, "scoped-vm") }); // a Reader only
  const hidden = judgeCombos({ ...b, rolesAboveHidden: true }, SUB);
  assert.equal(judgeCombos(b, SUB).combos.find((c) => c.name === "scoped-vm")!.identity.detail, "no privileged role", "visible: a fact");
  const all = [...hidden.combos.map((c) => c.identity), ...hidden.undetermined.flatMap((u) => u.unknown.filter((x) => x.factor === "identity"))];
  assert.ok(hidden.combos.every((c) => c.identity.detail !== "no privileged role"), "never 'no privileged role' when the subscription level can't be seen ('no managed identity' stays a fact)");
  assert.ok(all.some((f) => f.reason === "rolesAboveHidden"));
  assert.ok(judgeCombos(base(), SUB).combos.some((c) => c.identity.state === "no" || c.identity.state === "yes"));
  const [p] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_READER, scope: `/subscriptions/${SUB}/resourceGroups/rg` }], { rolesAboveHidden: true }));
  assert.deepEqual([p!.identityUnknown, p!.ends], [true, "entry"], "the chain may go further through a role we can't see — said, not dropped");
  // reading: one probe for any subscription-level assignment; none back = hidden (stg deployed identity: 46 assignments, none above)
  const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: SUB });
  const arm = (aboveRows: unknown[]) => ({
    postJson: async (_u: string, b: { query: string }) => {
      if (/take 1 \| project x = 1/.test(b.query)) return { data: aboveRows };
      if (/authorizationresources/.test(b.query)) return { data: [] };
      if (/isnotempty\(identity\)/.test(b.query)) return { data: [{ id: id("rg", VM, "open-vm"), name: "open-vm", type: VM, resourceGroup: "rg", sp: "11111111-1111-1111-1111-111111111111", ua: [] }] };
      if (/severity == 'High'/.test(b.query)) return { data: [{ rid: id("rg", VM, "open-vm"), count: 2, names: ["x"] }] };
      return { data: [] };
    },
  });
  const vm = async () => [{ id: id("rg", VM, "open-vm"), ...res("rg", VM, "open-vm"), ...vmExposure(ex("open")) }];
  const h = await getAzureRiskCombos(env, "t-hidden", SUB, { arm: arm([]), graphExposure: vm });
  assert.deepEqual([h.rolesAboveHidden, h.combos[0]!.identity.state, h.combos[0]!.identity.reason], [true, "unknown", "rolesAboveHidden"]);
  const v = await getAzureRiskCombos(env, "t-visible", SUB, { arm: arm([{ x: 1 }]), graphExposure: vm });
  assert.deepEqual([v.rolesAboveHidden, v.combos[0]!.identity.state], [undefined, "no"]);
});

test("reading: Resource Graph queries scoped to the one subscription; a failed section is a gap, its factor unknown", async () => {
  const seen: string[] = [];
  const arm = {
    postJson: async (_u: string, b: { subscriptions: string[]; query: string }) => {
      assert.deepEqual(b.subscriptions, [SUB]);
      seen.push(b.query.split("|")[0]!.trim());
      if (/authorizationresources/.test(b.query)) throw new Error("ARM 403: AuthorizationFailed");
      if (/userassignedidentities/.test(b.query)) return { data: [] };
      if (/isnotempty\(identity\)/.test(b.query)) return { data: [{ id: id("rg", VM, "open-vm"), name: "open-vm", type: VM, resourceGroup: "rg", sp: "11111111-1111-1111-1111-111111111111", ua: [] }] };
      if (/severity == 'High'/.test(b.query)) return { data: [{ rid: id("rg", VM, "open-vm"), count: 2, names: ["x"] }] };
      return { data: [] };
    },
  };
  const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: SUB });
  const r = await getAzureRiskCombos(env, "t", SUB, { arm, graphExposure: async () => [{ id: id("rg", VM, "open-vm"), ...res("rg", VM, "open-vm"), ...vmExposure(ex("open")) }] });
  assert.deepEqual(r.gaps.map((g) => g.section), ["roles"]);
  assert.deepEqual([r.combos[0]!.kind, r.combos[0]!.identity.state], ["exposedHigh", "unknown"]);
  assert.ok(seen.some((q) => q.startsWith("securityresources")) && seen.some((q) => q.startsWith("resources")));
});

test("issue list: one issue per combination (azure:…), subscription scope; a gap never turns stored issues into 'not detected'", () => {
  const combos = judgeCombos(base(), SUB);
  const resp = { subscriptionId: SUB, generatedAt: "2026-11-17T00:00:00Z", ...combos, gaps: [] };
  const states = { "azure:rg/microsoft.compute/virtualmachines/gone-vm": { status: "resolved", updatedAt: "2026-11-01T00:00:00Z", rev: 1 } } as never;
  const q = IQ.buildIssueQueue({ clusterId: null, states, now: new Date("2026-11-17T01:00:00Z"), azureRisk: resp, azureTitle: (c) => `${c.name}!` });
  assert.deepEqual(q.items.map((i) => [i.source, i.sev, i.title]).sort(), [["azure", "critical", "open-vm!"], ["azure", "medium", "inner-vm!"], ["azure", "medium", "scoped-vm!"]]);
  assert.deepEqual(q.items[0]!.resourceGroups, ["rg"]);
  assert.equal(q.notDetected, 1, "read fully and no longer produced");
  const partial = IQ.buildIssueQueue({ clusterId: null, states, now: new Date(), azureRisk: { ...resp, gaps: [{ section: "roles", message: "x" }] } });
  assert.equal(partial.notDetected, 0, "a factor unread: absence proves nothing");
});

test("wiring: signed-in route, the queue's source list, the evidence panel, i18n", () => {
  assert.match(read("../src/routes/security.ts"), /"\/api\/security\/azure-risk"[\s\S]{0,200}signin_required/);
  assert.match(read("../../web/src/app/security/risk/IssueQueue.tsx"), /const SOURCES: IssueSource\[\] = \["combo", "azure",/);
  const page = read("../../web/src/app/security/risk/page.tsx");
  assert.match(page, /<AzureRiskPanel data=\{azureRisk\}/);
  assert.match(page, /azureRisk: azureRisk \?\? null, azureTitle/);
  const panel = read("../../web/src/app/security/risk/AzureRiskPanel.tsx");
  const all = read("../../web/src/lib/i18nMessages.ts");
  const keys = new Set([...panel.matchAll(/t\("(azr\.[\w.]+)"/g)].map((m) => m[1]!));
  for (const k of ["exposedHighIdentity", "exposedIdentity", "exposedHigh", "highIdentity"]) keys.add(`azr.kind.${k}`);
  for (const k of ["yes", "no", "unknown", "na"]) keys.add(`azr.state.${k}`);
  for (const k of ["exposure", "high", "identity"]) keys.add(`azr.factor.${k}`);
  for (const k of ["owner", "contributor", "uaa", "rbacAdmin"]) keys.add(`azr.role.${k}`);
  for (const k of ["managementGroup", "subscription", "resourceGroup", "resource"]) keys.add(`azr.scope.${k}`);
  for (const k of ["exposureVm", "exposurePaas", "findings", "identities", "roles"]) keys.add(`azr.section.${k}`);
  keys.add("iq.source.azure");
  for (const k of keys) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});

// ── 공격 경로 (5.3 ③) ──
import { attackPaths, inScope } from "../src/services/azureRiskCombos.js";
const KV = "microsoft.keyvault/vaults", ST = "microsoft.storage/storageaccounts";
const jewels = [
  { id: id("rg", KV, "kv-1"), name: "kv-1", type: KV }, { id: id("rg", ST, "st-1"), name: "st-1", type: ST },
  { id: id("rg2", ST, "st-2"), name: "st-2", type: ST }, { id: id("other", "microsoft.sql/servers", "sql-1"), name: "sql-1", type: "microsoft.sql/servers" },
];
const entry = (n: string, e = ex("open")) => ({ id: id("rg", VM, n), ...res("rg", VM, n), ...vmExposure(e) });
const pathInput = (roles: CombosInput["roles"], over: Partial<CombosInput> = {}): CombosInput => ({
  exposure: [entry("web")], high: new Map(), identities: new Map([[id("rg", VM, "web"), { principals: ["pw"], ...res("rg", VM, "web") }]]), roles, jewels, ...over,
});

test("scope: a role's scope covers itself and what is below — never a sibling sharing the prefix (rg vs rg2)", () => {
  assert.equal(inScope(id("rg", ST, "st-1"), `/subscriptions/${SUB}/resourceGroups/RG`), true);
  assert.equal(inScope(id("rg2", ST, "st-2"), `/subscriptions/${SUB}/resourceGroups/rg`), false);
  assert.equal(inScope(id("rg", ST, "st-1"), id("rg", ST, "st-1")), true);
  assert.equal(inScope(id("rg", ST, "st-1"), `/subscriptions/${SUB}/`), true);
});

test("paths: data roles reach their service only, inside the scope; privileged reaches every store in scope; key roles reach via keys", () => {
  const blobReader = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", kvSecretsUser = "4633458b-17de-408a-b874-0445c86b69e6", keyOperator = "81a9662b-bebf-436f-a333-f67b29880f12";
  const [p] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: blobReader, scope: `/subscriptions/${SUB}/resourceGroups/rg` }]));
  assert.deepEqual([p!.ends, p!.sev, p!.roles[0]!.kind, p!.roles[0]!.role, p!.roles[0]!.write], ["data", "high", "data", "storage", false]);
  assert.deepEqual(p!.roles[0]!.reaches, [{ kind: "storage", count: 1, names: ["st-1"] }], "not the Key Vault in the same group, not st-2 in rg2");
  const [k] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: kvSecretsUser, scope: id("rg", KV, "kv-1") }]));
  assert.deepEqual(k!.roles[0]!.reaches, [{ kind: "keyVault", count: 1, names: ["kv-1"] }]);
  const [o] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_OWNER, scope: `/subscriptions/${SUB}` }]));
  assert.deepEqual(o!.roles[0]!.reaches.map((x) => [x.kind, x.count]), [["keyVault", 1], ["storage", 2], ["database", 1]]);
  const [ko] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: keyOperator, scope: `/subscriptions/${SUB}/resourceGroups/rg2` }]));
  assert.deepEqual([ko!.roles[0]!.viaKeys, ko!.roles[0]!.write, ko!.roles[0]!.reaches], [true, true, [{ kind: "storage", count: 1, names: ["st-2"] }]],
    "Storage Account Key Operator: listKeys = the data (a data-role-only check missed it on stg)");
  const [hi] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_OWNER, scope: `/subscriptions/${SUB}` }], { high: new Map([[id("rg", VM, "web"), { count: 2, names: ["x"], ...res("rg", VM, "web") }]]) }));
  assert.deepEqual([hi!.sev, hi!.vuln?.count], ["critical", 2], "exposed + vulnerable + reaches data");
});

test("paths: where the chain stops is a fact; scoped exposure one level lower; unread identities said, not hidden", () => {
  assert.deepEqual(attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_READER, scope: `/subscriptions/${SUB}` }])), [], "exposed, no finding, no reach — not a path");
  const high = new Map([[id("rg", VM, "web"), { count: 1, names: ["x"], ...res("rg", VM, "web") }]]);
  const [e] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_READER, scope: `/subscriptions/${SUB}` }], { high }));
  assert.deepEqual([e!.ends, e!.sev, e!.identity], ["entry", "medium", { principals: 1, otherRoles: 1 }], "stg's 5 paths: exposed VM, High finding, a Reader role only");
  const [l] = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: P_OWNER, scope: `/subscriptions/${SUB}` }], { exposure: [entry("web", ex("scoped"))], high }));
  assert.deepEqual([l!.ends, l!.sev], ["data", "high"], "critical lowered one step: listed sources only");
  const [u] = attackPaths(pathInput(null));
  assert.deepEqual([u!.identityUnknown, u!.ends], [true, "entry"], "roles unread: the path may go further — said");
  assert.deepEqual(attackPaths(pathInput([], { exposure: [entry("web", ex("closed"))] })), [], "not exposed: no path from the Internet");
});

test("issue list: paths that reach data or control are issues (path:…); a path stopping at the entry is not", () => {
  const blobReader = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1";
  const reach = attackPaths(pathInput([{ principalId: "pw", roleDefGuid: blobReader, scope: `/subscriptions/${SUB}/resourceGroups/rg` }]));
  const stop = attackPaths(pathInput([], { exposure: [entry("db")], high: new Map([[id("rg", VM, "db"), { count: 1, names: ["x"], ...res("rg", VM, "db") }]]) }));
  const resp = { subscriptionId: SUB, generatedAt: "2026-11-17T00:00:00Z", combos: [], paths: [...reach, ...stop], counts: { exposed: 2, high: 1, privileged: 0, combos: 0, undetermined: 0, paths: 2 }, gaps: [] };
  const q = IQ.buildIssueQueue({ clusterId: null, states: {}, now: new Date(), azureRisk: resp as never, azurePathTitle: (p) => `${p.entry.name} → ${p.ends}` });
  assert.deepEqual(q.items.map((i) => [i.key, i.title]), [["path:rg/microsoft.compute/virtualmachines/web", "web → data"]]);
  assert.match(q.items[0]!.key, ISSUE_KEY);
  assert.match(q.items[0]!.href, /#azure-rg-microsoft-compute-virtualmachines-web-path$/);
  const panel = read("../../web/src/app/security/risk/AzurePathsPanel.tsx");
  const all = read("../../web/src/lib/i18nMessages.ts");
  const keys = new Set([...panel.matchAll(/t\("(azp\.[\w.]+)"/g)].map((m) => m[1]!));
  for (const k of ["data", "control", "entry"]) keys.add(`azp.ends.${k}`);
  for (const k of ["keyVault", "storage", "database"]) keys.add(`azp.jewel.${k}`);
  for (const k of ["keyVault", "storage"]) keys.add(`azp.data.${k}`);
  for (const k of keys) assert.match(all, new RegExp(`"${k.replace(/\./g, "\.")}": \{ ko: "[^"]+", en: "[^"]+" \}`), k);
});

// ── 판단 불가 572 진단 (2026-11-17): 429 · child entities · child rules ──
import { aksExposureFactor, rollUpHigh, rulesExposure, topLevelId } from "../src/services/azureRiskCombos.js";
import { isRgThrottle, query } from "../src/services/securityPosture.js";

test("Resource Graph quota (429): waited and retried — stg's 'can't tell 572' came from one throttled identity read", async () => {
  assert.equal(isRgThrottle(new Error("ARM 429: RateLimiting: Please provide below info")), true);
  assert.equal(isRgThrottle(new Error("ARM 403: AuthorizationFailed")), false);
  let calls = 0;
  const waits: number[] = [];
  const flaky = { postJson: async () => { calls++; if (calls < 3) throw new Error("ARM 429: RateLimiting"); return { data: [{ x: 1 }] }; } };
  assert.deepEqual(await query(flaky as never, [SUB], "q", async (ms) => { waits.push(ms); }), [{ x: 1 }]);
  assert.deepEqual([calls, waits.length], [3, 2]);
  const denied = { postJson: async () => { calls++; throw new Error("ARM 403: AuthorizationFailed"); } };
  calls = 0;
  await assert.rejects(query(denied as never, [SUB], "q", async () => {}), /403/);
  assert.equal(calls, 1, "a refusal is not retried");
  const always = { postJson: async () => { throw new Error("ARM 429: RateLimiting"); } };
  await assert.rejects(query(always as never, [SUB], "q", async () => {}), /429/, "three tries, then the gap is real");
});

test("child entities roll up: an image / container finding is its registry's / cluster's (669 of 699 were such entities)", () => {
  const reg = id("rg", "microsoft.containerregistry/registries", "acr1");
  assert.deepEqual(topLevelId(`${reg}/securityentitydata/abc`), { id: reg, child: true });
  assert.deepEqual(topLevelId(reg), { id: reg, child: false });
  const m = rollUpHigh([{ rid: `${reg}/securityentitydata/a`, count: 3, names: ["zlib"] }, { rid: `${reg}/securityentitydata/b`, count: 2, names: ["zlib", "curl"] }, { rid: reg, count: 1, names: ["admin user"] }]);
  assert.deepEqual(m.get(reg), { count: 6, names: ["zlib", "curl", "admin user"], children: 2, resourceGroup: "rg", type: "microsoft.containerregistry/registries", name: "acr1" });
});

test("exposure rule, one for all: any address = yes; public IP allow list = yes, limited; VNet rules only = no; AKS private = no", () => {
  const rules = (da: "Allow" | "Deny", ips: number) => ({ defaultAction: da, ipRules: ips, vnetRules: 0, source: "networkAcls" }) as never;
  assert.equal(rulesExposure("Enabled", rules("Allow", 0)).state, "yes");
  assert.deepEqual([rulesExposure("Enabled", rules("Deny", 2)).state, rulesExposure("Enabled", rules("Deny", 2)).limited], ["yes", true], "like an NSG 'scoped'");
  assert.equal(rulesExposure("Enabled", rules("Deny", 0)).state, "no");
  assert.equal(rulesExposure("Disabled", rules("Allow", 0)).state, "no");
  assert.equal(aksExposureFactor({ apiServerAccessProfile: { enablePrivateCluster: true } }).state, "no");
  assert.deepEqual(aksExposureFactor({ apiServerAccessProfile: { enablePrivateCluster: false, authorizedIPRanges: ["1.2.3.4/32"] } }).limited, true);
  assert.equal(aksExposureFactor({}).state, "yes", "public API server, no authorized ranges");
  assert.equal(paasExposureFactor("microsoft.containerservice/managedclusters", { apiServerAccessProfile: { enablePrivateCluster: true } }).state, "no");
});

test("undetermined is listed with the factor and the reason — and the child-rule types are read, not left unknown", () => {
  const pg = "microsoft.dbforpostgresql/flexibleservers";
  const r = judgeCombos({
    exposure: [{ id: id("rg", pg, "pg1"), ...res("rg", pg, "pg1"), ...paasExposureFactor(pg, { network: { publicNetworkAccess: "Enabled" } }) }],
    high: new Map([[id("rg", pg, "pg1"), { count: 1, names: ["x"], ...res("rg", pg, "pg1") }]]), identities: new Map(), roles: [],
  }, SUB);
  assert.deepEqual(r.undetermined, [{ name: "pg1", type: pg, resourceGroup: "rg", yes: ["high"], unknown: [{ factor: "exposure", reason: "childRules" }] }]);
  const svc = read("../src/services/azureRiskCombos.ts");
  assert.match(svc, /readChildRules\(fetcher as never, f\.id, f\.type\)/, "PostgreSQL / MySQL / SQL firewall rules read for resources with a finding or identity");
  assert.doesNotMatch(svc, /await Promise\.all\(\[\s*vmExpo,/, "the reads go one after another (quota)");
});
