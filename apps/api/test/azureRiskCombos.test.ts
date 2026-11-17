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
