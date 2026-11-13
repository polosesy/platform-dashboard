// 2026-11-12 audit — defaults that looked measured: a value Azure / Kubernetes did not give is null (shown as a dash
// with the reason), never 0, "Running" or "Succeeded".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pct } from "../src/services/reservations.js";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("reservations: nothing reserved is null, not 0 % used", () => {
  assert.equal(pct(0, 0), null);
  assert.equal(pct(50, 100), 50);
  assert.match(src("../web/src/app/cost/ReservationsPanel.tsx"), /data && data\.reservedHours > 0 \?/);
});

test("cost: a budget without Azure's spend / forecast is null; the month-end figure says it is this platform's arithmetic", () => {
  const svc = src("src/services/cost.ts");
  assert.match(svc, /props\.currentSpend\?\.amount \?\? null/);
  assert.match(svc, /props\.forecastSpend\?\.amount \?\? null/);
  const page = src("../web/src/app/cost/page.tsx");
  assert.match(page, /cost\.projected"/);
  assert.match(page, /cost\.projectedHint/);
  assert.match(page, /cost\.forecastNone/);
});

test("nodes: an unread pod list is null (the total becomes a dash)", () => {
  assert.match(src("src/services/observabilityAggregator.ts"), /podsResult \? \(podsPerNode\.get\(name\) \?\? 0\) : null/);
  assert.match(src("src/services/containerInsightsCollector.ts"), /podCount: null,/);
  assert.match(src("../web/src/app/observability/components/InfraTab.tsx"), /ob\.podsUnread/);
});

test("AKS objects: kinds whose list failed are named in `gaps`, and their cards show a dash", () => {
  assert.match(src("src/services/kubernetes.ts"), /const gaps = LISTED\.filter\(\(_, i\) => settled\[i\]\?\.status === "rejected"\)/);
  const page = src("../web/src/app/kubernetes/page.tsx");
  assert.match(page, /k8s\.res\.gapsTitle/);
  assert.match(page, /unread\(\["Node"\]\) \? "—"/);
});

test("node pools: no default power / provisioning state", () => {
  for (const f of ["src/services/azure.ts", "src/services/edgeDetailService.ts", "src/services/specGenerator.ts"]) {
    const s = src(f);
    assert.ok(!/\?\? "Running"|\|\| "Running"/.test(s), `${f}: default Running`);
    assert.ok(!/\?\? "Succeeded"|\|\| "Succeeded"/.test(s), `${f}: default Succeeded`);
  }
});

test("cost: the budget card — the most-used budget, else why there is no number (never 0 %)", async () => {
  const ns = await import("../../web/src/lib/costView.ts");
  const cv = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
  const b = (budgetName: string, usedPercentage: number | null) => ({ budgetName, amount: 100, currentSpend: usedPercentage, forecastedSpend: null, currency: "USD", timeGrain: "Monthly" as const, usedPercentage });
  assert.deepEqual(cv.budgetCard(null, null, true), { state: "loading" });
  assert.deepEqual(cv.budgetCard(null, { status: 403 }, false), { state: "failed", status: 403 });
  assert.deepEqual(cv.budgetCard([], null, false), { state: "none" });
  assert.deepEqual(cv.budgetCard([b("a", null)], null, false), { state: "noSpend", budgets: 1 });
  assert.deepEqual(cv.budgetCard([b("a", 40), b("b", 91.5), b("c", null)], null, false), { state: "ok", pct: 91.5, name: "b", budgets: 3, measured: 2 });
  assert.ok(!src("../web/src/app/cost/page.tsx").includes("budgetUsedPercentage"), "the card no longer reads a summary field the API never set");
});
