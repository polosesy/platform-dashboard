import type { Env } from "../env.js";
import type { CostSummary, CostTrendResponse, CostTrendPoint, BudgetsResponse, BudgetStatus } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher, defaultSubscriptions } from "../infra/azureClientFactory.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";

// ---------- caches ----------
const summaryCache = new CacheManager<CostSummary>(50);
const trendCache = new CacheManager<CostTrendResponse>(50);
const budgetsCache = new CacheManager<BudgetsResponse>(50);

function costCacheKey(prefix: string, subscriptionId: string, extra?: string): string {
  return `${prefix}:cost:${subscriptionId}${extra ? `:${extra}` : ""}`;
}

// ---------- dates (UTC — Cost Management periods are UTC calendar days) ----------
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysInUtcMonth(d: Date): number {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
}

/** Cost Management returns UsageDate as a number like 20261001 and BillingMonth as an ISO timestamp. */
function normalizeCostDate(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// ---------- Cost Management Query API ----------
type CostQueryResult = {
  properties?: { rows?: unknown[][]; columns?: { name: string; type: string }[] };
};

/** Rows keyed by column name — column order differs by granularity ([Cost, Currency] vs [Cost, UsageDate, Currency]). */
async function queryCostManagement(
  fetcher: ArmFetcher,
  subscriptionId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const json = await fetcher.postJson<CostQueryResult>(url, body);
  const columns = (json.properties?.columns ?? []).map((c) => c.name.toLowerCase());
  return (json.properties?.rows ?? []).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((name, i) => (obj[name] = row[i]));
    return obj;
  });
}

function actualCostQuery(granularity: "None" | "Daily" | "Monthly", from: Date, to: Date) {
  return {
    type: "ActualCost",
    dataset: {
      granularity,
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
    },
    timeframe: "Custom",
    timePeriod: { from: fmtDate(from), to: fmtDate(to) },
  };
}

function rowCost(row: Record<string, unknown> | undefined): number {
  const v = Number(row?.cost ?? row?.costusd ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function rowCurrency(row: Record<string, unknown> | undefined): string | undefined {
  return typeof row?.currency === "string" ? row.currency : undefined;
}

function resolveSubscription(env: Env, requested: string | undefined, bearerToken: string | undefined): string | undefined {
  return requested ?? defaultSubscriptions(env, bearerToken)[0];
}

/**
 * Pure: the previous month's same stretch — day 1 to the same day of the month (the last day when that month is
 * shorter). Month-to-date against the whole previous month always read as a big drop early in the month
 * (day 12 of 30 = "−60 %" with unchanged spend).
 */
export function previousSamePeriod(now: Date): { from: Date; to: Date; days: number } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Math.min(now.getUTCDate(), lastDay);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m - 1, days)), days };
}

/** Pure: change in percent (one decimal) — null when there is nothing to compare with (never "0 %") */
export function costChange(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
}

// ---------- Summary ----------
export async function tryGetCostSummary(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<CostSummary | null> {
  const subId = resolveSubscription(env, opts?.subscriptionId, bearerToken);
  if (!bearerToken || !subId) return null;

  const key = costCacheKey(bearerKeyPrefix(bearerToken), subId);
  const cached = summaryCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthStart = utcDate(y, m, 1);
  const prevMonthStart = utcDate(y, m - 1, 1);
  const prevMonthEnd = utcDate(y, m, 0);

  const same = previousSamePeriod(now);
  const [currentRows, prevRows, sameRows] = await Promise.all([
    queryCostManagement(fetcher, subId, actualCostQuery("None", monthStart, now)),
    queryCostManagement(fetcher, subId, actualCostQuery("None", prevMonthStart, prevMonthEnd)),
    queryCostManagement(fetcher, subId, actualCostQuery("None", same.from, same.to)),
  ]);

  const currentTotal = rowCost(currentRows[0]);
  const previousTotal = rowCost(prevRows[0]);
  const currency = rowCurrency(currentRows[0]) ?? rowCurrency(prevRows[0]) ?? "USD";
  const previousPeriodTotal = rowCost(sameRows[0]);

  const summary: CostSummary = {
    generatedAt: new Date().toISOString(),
    currency,
    currentMonthTotal: currentTotal,
    previousMonthTotal: previousTotal,
    // Month-to-date against the same days of the previous month (not the whole month)
    previousPeriodTotal,
    comparedDays: same.days,
    changePercentage: costChange(currentTotal, previousPeriodTotal),
    // Linear projection of month-to-date spend over the full month
    forecastedTotal: currentTotal * (daysInUtcMonth(now) / now.getUTCDate()),
  };

  summaryCache.set(key, summary, env.AZURE_COST_CACHE_TTL_MS);
  return summary;
}

// ---------- Trend ----------
export async function tryGetCostTrend(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string; granularity?: "daily" | "monthly" },
): Promise<CostTrendResponse | null> {
  const subId = resolveSubscription(env, opts?.subscriptionId, bearerToken);
  if (!bearerToken || !subId) return null;

  const granularity = opts?.granularity ?? "daily";
  const key = costCacheKey(bearerKeyPrefix(bearerToken), subId, `trend:${granularity}`);
  const cached = trendCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);

  const now = new Date();
  const from = granularity === "daily"
    ? utcDate(now.getUTCFullYear(), now.getUTCMonth(), 1)
    : utcDate(now.getUTCFullYear() - 1, now.getUTCMonth(), 1);

  const rows = await queryCostManagement(
    fetcher,
    subId,
    actualCostQuery(granularity === "daily" ? "Daily" : "Monthly", from, now),
  );

  const data: CostTrendPoint[] = rows
    .map((row) => ({
      date: normalizeCostDate(row.usagedate ?? row.billingmonth),
      cost: rowCost(row),
      currency: rowCurrency(row) ?? "USD",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const resp: CostTrendResponse = {
    generatedAt: new Date().toISOString(),
    granularity,
    data,
  };

  trendCache.set(key, resp, env.AZURE_COST_CACHE_TTL_MS);
  return resp;
}

// ---------- Budgets ----------
type ArmBudget = {
  name?: string;
  properties?: {
    amount?: number;
    timeGrain?: string;
    currentSpend?: { amount?: number; unit?: string };
    forecastSpend?: { amount?: number; unit?: string };
  };
};

export async function tryGetBudgets(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<BudgetsResponse | null> {
  const subId = resolveSubscription(env, opts?.subscriptionId, bearerToken);
  if (!bearerToken || !subId) return null;

  const key = costCacheKey(bearerKeyPrefix(bearerToken), subId, "budgets");
  const cached = budgetsCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.Consumption/budgets?api-version=2023-11-01`;
  const json = await fetcher.fetchJson<{ value?: ArmBudget[] }>(url);

  const budgets: BudgetStatus[] = (json.value ?? []).map((b) => {
    const props = b.properties ?? {};
    const amount = props.amount ?? 0;
    // Azure leaves currentSpend / forecastSpend out until it has evaluated the budget — that is not 0
    const currentSpend = props.currentSpend?.amount ?? null;
    return {
      budgetName: b.name ?? "unknown",
      amount,
      currentSpend,
      forecastedSpend: props.forecastSpend?.amount ?? null,
      currency: props.currentSpend?.unit ?? props.forecastSpend?.unit ?? "USD",
      timeGrain: (props.timeGrain ?? "Monthly") as BudgetStatus["timeGrain"],
      usedPercentage: amount > 0 && currentSpend !== null ? Math.round((currentSpend / amount) * 1000) / 10 : null,
    };
  });

  const resp: BudgetsResponse = {
    generatedAt: new Date().toISOString(),
    budgets,
  };

  budgetsCache.set(key, resp, env.AZURE_COST_CACHE_TTL_MS);
  return resp;
}
