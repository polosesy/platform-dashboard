// 비용 관리 — the '예산 사용률' card from the budgets themselves (Azure Consumption budgets). Pure; tested from
// apps/api/test/factsOnly.test.ts. The card never shows a number Azure did not give: no budget, a failed read and a
// budget without a spend value are three different reasons, never "0%".
import type { BudgetStatus } from "@aud/types";

export type BudgetCard =
  | { state: "loading" }
  | { state: "failed"; status?: number }
  | { state: "none" }
  | { state: "noSpend"; budgets: number }
  | { state: "ok"; pct: number; name: string; budgets: number; measured: number };

/**
 * The most-used budget (the one closest to running out) — with how many budgets there are and how many gave a value.
 * `failed` = the budgets request failed (status = its HTTP status when known: 403 = no Cost Management Reader).
 */
export function budgetCard(budgets: BudgetStatus[] | null | undefined, failed: { status?: number } | null, loading: boolean): BudgetCard {
  if (failed) return { state: "failed", ...(failed.status ? { status: failed.status } : {}) };
  if (!budgets) return loading ? { state: "loading" } : { state: "failed" };
  if (budgets.length === 0) return { state: "none" };
  const measured = budgets.filter((b): b is BudgetStatus & { usedPercentage: number } => b.usedPercentage !== null);
  if (measured.length === 0) return { state: "noSpend", budgets: budgets.length };
  const top = measured.reduce((a, b) => (b.usedPercentage > a.usedPercentage || (b.usedPercentage === a.usedPercentage && b.budgetName < a.budgetName) ? b : a));
  return { state: "ok", pct: top.usedPercentage, name: top.budgetName, budgets: budgets.length, measured: measured.length };
}
