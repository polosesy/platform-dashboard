// 보안 개요 팀 범위 (security-roadmap 5.7 ⑤ — 2026-11-17). Synthetic groups, keys and team names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OwnerRule, PostureRecommendation, SecurityTeamScopeResponse } from "@aud/types";
import { loadEnv } from "../src/env.js";
import { ROW_CAP, TEAM_Q, buildTeamScope, getSecurityTeamScope } from "../src/services/securityTeamScope.js";
import * as tsNs from "../../web/src/lib/teamScope.ts";
import * as iqNs from "../../web/src/lib/issueQueue.ts";

const TS = ((tsNs as unknown as { default?: typeof tsNs }).default ?? tsNs) as typeof tsNs;
const IQ = ((iqNs as unknown as { default?: typeof iqNs }).default ?? iqNs) as typeof iqNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUB = "00000000-0000-0000-0000-0000000000aa";

const RULES: OwnerRule[] = [
  { team: "payments", resourceGroups: ["rg-pay-*"] },
  { team: "platform", namespaces: ["kube-system"], resourceGroups: ["rg-aks", "rg-shared"] },
  { team: "observability", namespaces: ["monitor"] }, // namespace rules only
  { team: "payments", resourceGroups: ["rg-billing"] }, // a team named twice: one bucket
];
const rec = (key: string, severity: PostureRecommendation["severity"], domain: PostureRecommendation["domain"]): PostureRecommendation =>
  ({ key, title: `T-${key}`, severity, domain, threats: [], unhealthy: 0, healthy: 0, samples: [], portalUrl: "" });
const RECS = [rec("k-cve", "High", "container"), rec("k-tls", "Medium", "network"), rec("k-tag", "Low", "other")];

const raw = (over: Partial<Parameters<typeof buildTeamScope>[0]> = {}) => buildTeamScope({
  subscriptionId: SUB, owners: RULES, gaps: [],
  inventory: [{ rg: "rg-pay-api", n: 10 }, { rg: "rg-pay-db", n: 4 }, { rg: "rg-billing", n: 2 }, { rg: "rg-aks", n: 30 }, { rg: "rg-misc", n: 5 }, { rg: "", n: 0 }],
  affected: [
    { rg: "rg-pay-api", sev: "High", n: 3 }, { rg: "rg-pay-db", sev: "High", n: 1 }, { rg: "rg-pay-db", sev: "Low", n: 2 },
    { rg: "rg-aks", sev: "High", n: 5 }, { rg: "rg-aks", sev: "Medium", n: 7 }, { rg: "rg-misc", sev: "Medium", n: 1 }, { rg: "", sev: "Medium", n: 1 },
  ],
  findings: [
    { rg: "rg-pay-api", key: "k-cve", sev: "High", n: 40 }, { rg: "rg-pay-db", key: "k-cve", sev: "High", n: 1 }, { rg: "rg-pay-db", key: "k-tag", sev: "Low", n: 2 },
    { rg: "rg-aks", key: "k-cve", sev: "High", n: 9 }, { rg: "rg-aks", key: "k-tls", sev: "Medium", n: 7 }, { rg: "rg-misc", key: "k-tls", sev: "Medium", n: 1 }, { rg: "", key: "k-tls", sev: "Medium", n: 1 },
  ],
  alerts: [
    { id: "a1", sev: "High", rgs: ["rg-aks"] },
    { id: "a2", sev: "Medium", rgs: ["rg-pay-api", "rg-aks", ""] }, // two teams
    { id: "a3", sev: "Low", rgs: [""] }, // no Azure resource
    { id: "a4", sev: "High", rgs: ["rg-misc"] },
  ],
  ...over,
});

test("rows → per-group counts; alert ids don't leave the API, empty groups dropped from an alert", () => {
  const r = raw();
  assert.deepEqual(r.groups.map((g) => g.rg), ["", "rg-aks", "rg-billing", "rg-misc", "rg-pay-api", "rg-pay-db"]);
  assert.deepEqual(r.groups.find((g) => g.rg === "rg-pay-db"), { rg: "rg-pay-db", resources: 4, affected: { High: 1, Medium: 0, Low: 2 } });
  assert.deepEqual(r.alerts, [{ severity: "High", rgs: ["rg-aks"] }, { severity: "Medium", rgs: ["rg-aks", "rg-pay-api"] }, { severity: "Low", rgs: [] }, { severity: "High", rgs: ["rg-misc"] }]);
  assert.ok(!JSON.stringify(r).includes("a2"), "no alert ids");
  assert.equal(raw({ inventory: null }).groups[0]!.resources, null, "inventory not read: null, not 0");
});

test("split by team: the issue list's teamOf (resource-group rules, first rule wins), every group in one bucket — buckets add up to the subscription", () => {
  const v = TS.teamScopeView(raw(), RECS);
  assert.deepEqual(v.buckets.map((b) => b.id), ["payments", "platform", "observability", TS.NO_TEAM, TS.NO_GROUP]);
  const by = (id: string) => v.buckets.find((b) => b.id === id)!;
  assert.deepEqual(by("payments").groups, ["rg-billing", "rg-pay-api", "rg-pay-db"], "two rules of one team: one bucket");
  assert.deepEqual([by("payments").resources, by("payments").affected], [16, { High: 4, Medium: 0, Low: 2 }]);
  assert.deepEqual([by(TS.NO_TEAM).groups, by(TS.NO_GROUP).affected], [["rg-misc"], { High: 0, Medium: 1, Low: 0 }]);
  // same team as the issue list for every group
  for (const g of ["rg-pay-api", "rg-billing", "rg-aks", "rg-misc", "RG-AKS"]) assert.equal(TS.bucketOf(g, RULES), IQ.teamOf([], [g], RULES) ?? TS.NO_TEAM, g);
  // conservation: affected, findings, resources
  for (const s of ["High", "Medium", "Low"] as const) assert.equal(v.buckets.reduce((n, b) => n + (b.affected?.[s] ?? 0), 0), v.total.affected![s], s);
  assert.deepEqual(v.total.affected, { High: 9, Medium: 9, Low: 2 });
  assert.equal(v.buckets.reduce((n, b) => n + (b.findings?.total ?? 0), 0), v.total.findings!.total);
  assert.equal(v.buckets.reduce((n, b) => n + (b.resources ?? 0), 0), v.total.resources);
  assert.equal(v.rgRuleCount, 4);
});

test("a namespace-only team has no Azure resources here (rgRules false — '—', not 0); alerts naming two teams count for both", () => {
  const v = TS.teamScopeView(raw(), RECS);
  const by = (id: string) => v.buckets.find((b) => b.id === id)!;
  assert.equal(by("observability").rgRules, false);
  assert.equal(by("platform").rgRules, true);
  assert.deepEqual([by("platform").alerts!.total, by("payments").alerts!.total, by(TS.NO_TEAM).alerts!.total, by(TS.NO_GROUP).alerts!.total, v.total.alerts!.total], [2, 1, 1, 1, 4]);
  assert.equal(v.alertsShared, 1);
});

test("domains and 'fix first' per team come from the posture recommendations by key; High first, then count", () => {
  const p = TS.teamScopeView(raw(), RECS).buckets.find((b) => b.id === "payments")!;
  assert.deepEqual(p.top.map((x) => [x.title, x.severity, x.n]), [["T-k-cve", "High", 41], ["T-k-tag", "Low", 2]]);
  assert.deepEqual(p.byDomain.map((d) => [d.d, d.total, d.high, d.low]), [["container", 41, 41, 0], ["other", 2, 0, 2]]);
  assert.deepEqual([p.findings!.High, p.findings!.Low, p.findings!.total], [41, 2, 43]);
});

test("보안 권고 · ID·권한 with a team: its recommendations only, counted in its groups, samples its own; 위협 탐지: alerts naming its groups", () => {
  const recs: PostureRecommendation[] = [
    { ...rec("k-cve", "High", "container"), unhealthy: 50, healthy: 3, samples: [{ name: "img-a", type: "registries", resourceGroup: "RG-PAY-API" }, { name: "c1", type: "managedClusters", resourceGroup: "rg-aks" }] },
    { ...rec("k-tls", "Medium", "network"), unhealthy: 9, healthy: 1, samples: [] },
    { ...rec("k-tag", "Low", "other"), unhealthy: 2, healthy: 0, samples: [] },
  ];
  const v = TS.teamScopeView(raw(), recs);
  const pay = v.buckets.find((b) => b.id === "payments")!;
  const scoped = TS.recsInBucket(recs, pay, RULES);
  assert.deepEqual(scoped.map((r) => [r.key, r.unhealthy, r.samples.map((x) => x.name)]), [["k-cve", 41, ["img-a"]], ["k-tag", 2, []]], "k-tls has no finding in payments' groups");
  assert.equal(scoped.reduce((n, r) => n + r.unhealthy, 0), pay.findings!.total, "the table adds up to the overview's team findings");
  // regression (stg: 280 rows for 259 keys — Σ 11,151 for a team with 9,516 findings): one key answered at two
  // severities is two rows; each gets its own severity's count, never the key's total twice
  const twoSev = [{ ...rec("k-img", "High", "container"), unhealthy: 7 }, { ...rec("k-img", "Low", "container"), unhealthy: 3 }];
  const d = raw({ findings: [{ rg: "rg-pay-api", key: "k-img", sev: "High", n: 5 }, { rg: "rg-pay-db", key: "k-img", sev: "Low", n: 2 }] });
  const pb = TS.teamScopeView(d, twoSev).buckets.find((b) => b.id === "payments")!;
  assert.deepEqual(TS.recsInBucket(twoSev, pb, RULES).map((r) => [r.severity, r.unhealthy]), [["High", 5], ["Low", 2]]);
  assert.deepEqual(pb.top.map((x) => [x.severity, x.n]), [["High", 5], ["Low", 2]]);
  // alerts: the same buckets the API counted (raw() alerts → payments 1, platform 2, unowned 1, no group 1)
  const posted = [
    { resources: [{ resourceGroup: "rg-aks" }] }, { resources: [{ resourceGroup: "RG-PAY-API" }, { resourceGroup: "rg-aks" }] },
    { resources: [] }, { resources: [{ resourceGroup: "rg-misc" }] },
  ];
  const inBucket = (id: string) => posted.filter((a) => TS.alertBuckets(a, RULES).includes(id)).length;
  for (const b of v.buckets) assert.equal(inBucket(b.id), b.alerts!.total, b.id);
});

test("a section not read is null for every bucket (shown as '—'), never 0", () => {
  const r = { ...raw(), gaps: [{ section: "alerts", message: "ARM 403" }, { section: "affected", message: "x" }] } as SecurityTeamScopeResponse;
  const v = TS.teamScopeView(r, RECS);
  assert.ok(v.buckets.every((b) => b.alerts === null && b.affected === null));
  assert.ok(v.buckets.every((b) => b.findings !== null));
});

test("reading: four Resource Graph queries, one after another, one subscription; failures and the row cap are gaps", async () => {
  const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: SUB });
  let running = 0, peak = 0;
  const seen: string[] = [];
  const arm = (fail: RegExp | null, capped: RegExp | null) => ({
    postJson: async (_u: string, b: { subscriptions: string[]; query: string }) => {
      assert.deepEqual(b.subscriptions, [SUB]);
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      seen.push(b.query);
      if (fail?.test(b.query)) throw new Error("ARM 403: AuthorizationFailed");
      if (capped?.test(b.query)) return { data: Array.from({ length: 1000 }, (_, i) => ({ rg: `rg-${i}`, key: "k", sev: "Low", n: 1 })), $skipToken: "more" };
      return { data: [] };
    },
  });
  const r = await getSecurityTeamScope(env, "t", SUB, { arm: arm(/locations\/alerts/, /key = name/) });
  assert.equal(peak, 1, "sequential (Resource Graph quota)");
  assert.equal(seen.length, 13, "inventory + affected + 10 pages of findings + alerts");
  assert.deepEqual(r.gaps.map((g) => g.section), ["findings", "alerts"]);
  assert.match(r.gaps[0]!.message, new RegExp(String(ROW_CAP)));
  assert.deepEqual(r.owners, []);
});

test("exact counts: no dcount (an estimate) — in the team queries or the overview's affected KPI; alerts without identifiers kept", () => {
  assert.match(TEAM_Q.affected, /summarize by rid, rg, sev \| summarize n = count\(\) by rg, sev/);
  assert.doesNotMatch(Object.values(TEAM_Q).join("\n"), /dcount/);
  assert.doesNotMatch(read("../src/services/securityPosture.ts").replace(/\/\/.*$/gm, ""), /dcount\(/);
  assert.match(TEAM_Q.alerts, /iff\(array_length\(ri\) > 0, ri, pack_array\(dynamic\(\{\}\)\)\)/);
  // regression (stg): an alert's AzureResourceId says "/resourceGroups/" — the lower-case pattern must see a lower-cased id
  // every extract of the group reads an id that was lower-cased first (rid is `tolower(...)` in the assessments queries)
  for (const q of Object.values(TEAM_Q)) for (const m of q.matchAll(/extract\('\/resourcegroups\/\(\[\^\/\]\+\)', 1, (\w+)/g)) assert.ok(m[1] === "tolower" || m[1] === "rid", m[0]);
  assert.match(TEAM_Q.affected, /rid = tolower\(/);
  assert.match(TEAM_Q.alerts, /extract\('\/resourcegroups\/\(\[\^\/\]\+\)', 1, tolower\(tostring\(r\.AzureResourceId\)\)\)/);
});

test("wiring: signed-in route; the overview uses the team scope, shares the issue list's chosen team; i18n", () => {
  assert.match(read("../src/routes/security.ts"), /"\/api\/security\/team-scope"[\s\S]{0,200}signin_required[\s\S]{0,400}getSecurityTeamScope/);
  const page = read("../../web/src/app/security/page.tsx");
  // one team state for every /security page that splits by resource group (the layout's context)
  const ctx = read("../../web/src/app/security/SecurityContext.tsx");
  assert.match(ctx, /useTeamScope\(subscriptionId, [^)]*TEAM_PAGES\.includes\(path\)/);
  for (const p of ["/security", "/security/findings", "/security/identity", "/security/threats"]) assert.ok(ctx.includes(`"${p}"`), p);
  assert.match(page, /<TeamSummaryPanel /);
  const findings = read("../../web/src/app/security/findings/page.tsx");
  const identity = read("../../web/src/app/security/identity/page.tsx");
  const threats = read("../../web/src/app/security/threats/page.tsx");
  for (const f of [page, findings, identity, threats]) assert.match(f, /<TeamScopeBar team=\{team\}/);
  assert.match(findings, /recsInBucket\(all, b, team\.rules\)/);
  assert.match(identity, /recsInBucket\(all, b, team\.rules\)/);
  assert.match(threats, /alertBuckets\(a, team\.rules\)\.includes\(b\.id\)/);
  const comp = read("../../web/src/app/security/TeamScope.tsx");
  assert.match(comp, /const TEAM_KEY = "aud\.issues\.team"/);
  assert.match(read("../../web/src/app/security/risk/IssueQueue.tsx"), /const TEAM_KEY = "aud\.issues\.team"/, "one choice for both screens");
  const all = read("../../web/src/lib/i18nMessages.ts");
  const keys = new Set([page, comp, findings, identity, threats].flatMap((f) => [...f.matchAll(/t\("(sec\.team\.[\w.]+)"/g)].map((m) => m[1]!)));
  assert.ok(keys.size > 18);
  for (const k of keys) assert.match(all, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});
