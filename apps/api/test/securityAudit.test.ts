// 보안 탭 사실 감사 (docs/architecture/security-roadmap.md '보안 탭 감사' — 2026-11-17): every defect found, pinned.
// The numbers themselves were checked against independent Resource Graph KQL on two stg subscriptions (equal); these
// tests hold the labels, units and "unknown is not zero" rules. Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALERTS_SHOWN, collectPosture, mergeCompliance, mergeControls, mergePlans } from "../src/services/securityPosture.js";
import * as avNs from "../../web/src/lib/advisoryView.ts";

const AV = ((avNs as unknown as { default?: typeof avNs }).default ?? avNs) as typeof avNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("several subscriptions: one row per control / standard / plan (they came back once per subscription, summed twice)", () => {
  const c = (n: string, cur: number, max: number, u: number) => ({ controlName: n, currentScore: cur, maxScore: max, weight: 1, healthyResourceCount: 1, unhealthyResourceCount: u });
  assert.deepEqual(mergeControls([c("MFA", 1, 10, 2), c("MFA", 2.5, 10, 3), c("Encrypt", 4, 4, 0)]).map((x) => [x.controlName, x.currentScore, x.maxScore, x.unhealthyResourceCount]),
    [["MFA", 3.5, 20, 5], ["Encrypt", 4, 4, 0]]);
  assert.deepEqual(mergeCompliance([{ name: "MCSB", state: "Failed", passed: 46, failed: 17, skipped: 0 }, { name: "MCSB", state: "Passed", passed: 45, failed: 18, skipped: 1 }]),
    [{ name: "MCSB", state: "Mixed", passed: 91, failed: 35, skipped: 1 }]);
  assert.deepEqual(mergePlans([{ name: "Containers", tier: "Standard" }, { name: "Containers", tier: "Free" }, { name: "Servers", tier: "Standard" }, { name: "Servers", tier: "Standard" }]),
    [{ name: "Servers", tier: "Standard" }, { name: "Containers", tier: "Mixed" }], "on only where on in every subscription — coverage never claims one it misses");
});

test("alerts past the cap are said ('200+'), not shown as all of them", async () => {
  const row = (i: number) => ({ id: `a${i}`, dn: "x", sev: "Medium", st: "Active", t: `2026-11-16T00:${String(i % 60).padStart(2, "0")}:00Z` });
  const arm = {
    postJson: async (_u: string, body: { query: string }) => ({
      data: /locations\/alerts/.test(body.query) ? Array.from({ length: ALERTS_SHOWN + 1 }, (_, i) => row(i)) : [],
    }),
  };
  const p = await collectPosture(arm as never, ["00000000-0000-0000-0000-0000000000aa"]);
  assert.equal(p.alerts.length, ALERTS_SHOWN);
  assert.equal(p.alertsTruncated, true);
  const under = await collectPosture({ postJson: async (_u: string, b: { query: string }) => ({ data: /locations\/alerts/.test(b.query) ? [row(1)] : [] }) } as never, ["00000000-0000-0000-0000-0000000000aa"]);
  assert.equal(under.alertsTruncated, undefined);
  assert.match(read("../src/services/securityPosture.ts"), /take \$\{ALERTS_SHOWN \+ 1\}/);
});

test("overview: 'affected resources' never falls back to the findings sum; invisible plans are '—', not '0 / 0'; alerts '+'", () => {
  const page = read("../../web/src/app/security/page.tsx");
  assert.doesNotMatch(page, /n \?\? findings\(sev\)/, "the inflated findings sum under the 'affected resources' label");
  assert.match(page, /value=\{recGap \|\| n === null \? "—" : n\.toLocaleString\(\)\}/);
  assert.match(page, /plansGap \|\| !posture\.plans\.length \? "—"/);
  assert.match(page, /posture\.alertsTruncated \? "\+" : ""/);
  assert.match(page, /sec\.unhealthyResources/, "a control's count is unhealthy resources, not 'issues'");
  const threats = read("../../web/src/app/security/threats/page.tsx");
  assert.match(threats, /plansUnknown \? t\("sec\.noAlertsPlansUnknown"\)/, "no plan rows = coverage unknown, not 'all on'");
  assert.doesNotMatch(read("../../web/src/app/security/compliance/page.tsx"), /sec\.noStandards"/, "not visible ≠ none assigned");
  assert.match(read("../../web/src/app/security/risk/page.tsx"), /title=\{t\("risk\.noLinkedFindingHint"\)\}>—</, "no linked finding ≠ 0 findings");
});

test("urgent vulnerabilities: OSV not (fully) checked is never 'clean'; Defender findings of the chosen cluster's subscription only; feed time = fetch time", () => {
  assert.equal(AV.osvChecked({ sources: [{ id: "osv", state: "ok" }] }), true);
  for (const st of ["failed", "disabled", "signin"]) assert.equal(AV.osvChecked({ sources: [{ id: "osv", state: st }] }), false, st);
  assert.equal(AV.osvChecked({ sources: [] }), false);
  const page = read("../../web/src/app/security/advisories/page.tsx");
  assert.match(page, /osvChecked\(d\) \? t\("adv\.sbom\.clean"\) : t\("adv\.sbom\.notChecked"\)/);
  const vdb = read("../src/services/vulnDb.ts");
  assert.match(vdb, /partial: failed && matches\.length > 0/);
  const col = read("../src/services/advisoriesCollector.ts");
  assert.match(col, /state: osv\.failed \|\| osv\.partial \? "failed" : "ok"/);
  assert.match(col, /\.\.\.\(clusterSub \? \{ subscriptions: \[clusterSub\] \} : \{\}\)/, "Resource Graph scoped to the cluster's subscription");
  const feeds = read("../src/services/advisoryFeeds.ts");
  assert.match(feeds, /checkedAt: feedFetchedAt\(/);
  assert.doesNotMatch(feeds, /state: "ok", checkedAt: now, url/);
});

test("menu: by the question a person comes with — each section names a job, the cluster's posture beside the cloud's", () => {
  const nav = read("../../web/src/lib/navConfig.ts");
  assert.ok(nav.indexOf('"/security", "securityOverview"') < nav.indexOf('"/security/risk", "securityRisk"'), "overview first");
  assert.ok(nav.indexOf('"/security/findings", "securityFindings"') < nav.indexOf('"/policies", "clusterSecurity"'), "cloud and cluster configuration together");
});

test("plans: a pricing on one resource is not the subscription's plan (stg: an RG-scoped identity saw one → coverage '1 / 1')", async () => {
  const arm = { postJson: async (_u: string, b: { query: string }) => ({ data: /pricings/.test(b.query)
    ? [{ name: "Containers", tier: "Standard", res: true }, { name: "VirtualMachines", tier: "Free", res: false }] : [] }) };
  const p = await collectPosture(arm as never, ["00000000-0000-0000-0000-0000000000aa"]);
  assert.deepEqual(p.plans, [{ name: "VirtualMachines", tier: "Free" }]);
  assert.deepEqual(p.resourcePlans, [{ name: "Containers", tier: "Standard" }]);
  assert.match(read("../src/services/securityPosture.ts"), /res=id has '\/resourceGroups\/'/);
});
