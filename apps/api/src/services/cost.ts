import type { Env } from "../env";
import type { CostSummary, CostTrendResponse, CostTrendPoint, CostByResource, BudgetsResponse, BudgetStatus } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ---------- caches ----------
const summaryCache = new CacheManager<CostSummary>(50);
const trendCache = new CacheManager<CostTrendResponse>(50);
const budgetsCache = new CacheManager<BudgetsResponse>(50);

// ---------- helpers ----------
function parseSubscriptionIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function costCacheKey(prefix: string, subscriptionId: string, extra?: string): string {
  return `${prefix}:cost:${subscriptionId}${extra ? `:${extra}` : ""}`;
}

// ---------- Cost Management Query API ----------
type CostQueryRow = [number, string, string]; // [cost, date/group, currency]

async function queryCostManagement(
  armFetcher: Awaited<ReturnType<typeof getArmFetcher>>,
  subscriptionId: string,
  body: Record<string, unknown>,
): Promise<{ rows: CostQueryRow[]; columns: { name: string; type: string }[] }> {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${armFetcher.armToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CostManagement ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { properties?: { rows?: CostQueryRow[]; columns?: { name: string; type: string }[] } };
  return { rows: json.properties?.rows ?? [], columns: json.properties?.columns ?? [] };
}

// ---------- Summary ----------
export async function tryGetCostSummary(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<CostSummary | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = costCacheKey(prefix, subId);
  const cached = summaryCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // Current month actual
  const currentBody = {
    type: "ActualCost",
    dataset: {
      granularity: "None",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
    },
    timeframe: "Custom",
    timePeriod: { from: fmt(monthStart), to: fmt(now) },
  };

  // Previous month actual
  const prevBody = {
    type: "ActualCost",
    dataset: {
      granularity: "None",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
    },
    timeframe: "Custom",
    timePeriod: { from: fmt(prevMonthStart), to: fmt(prevMonthEnd) },
  };

  const [currentResult, prevResult] = await Promise.all([
    queryCostManagement(fetcher, subId, currentBody),
    queryCostManagement(fetcher, subId, prevBody),
  ]);

  const currentTotal = currentResult.rows[0]?.[0] ?? 0;
  const previousTotal = prevResult.rows[0]?.[0] ?? 0;
  const currency = currentResult.rows[0]?.[2] ?? prevResult.rows[0]?.[2] ?? "USD";
  const changePercentage = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

  const summary: CostSummary = {
    generatedAt: new Date().toISOString(),
    currency,
    currentMonthTotal: currentTotal,
    previousMonthTotal: previousTotal,
    changePercentage: Math.round(changePercentage * 10) / 10,
    forecastedTotal: currentTotal * (daysInMonth(now) / now.getDate()),
  };

  summaryCache.set(key, summary, env.AZURE_COST_CACHE_TTL_MS);
  return summary;
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// ---------- Trend ----------
export async function tryGetCostTrend(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string; granularity?: "daily" | "monthly" },
): Promise<CostTrendResponse | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const granularity = opts?.granularity ?? "daily";
  const prefix = bearerKeyPrefix(bearerToken);
  const key = costCacheKey(prefix, subId, `trend:${granularity}`);
  const cached = trendCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);

  const now = new Date();
  const from = granularity === "daily"
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const body = {
    type: "ActualCost",
    dataset: {
      granularity: granularity === "daily" ? "Daily" : "Monthly",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
    },
    timeframe: "Custom",
    timePeriod: { from: fmt(from), to: fmt(now) },
  };

  const result = await queryCostManagement(fetcher, subId, body);

  const data: CostTrendPoint[] = result.rows.map((row) => ({
    date: typeof row[1] === "string" ? row[1] : String(row[1]),
    cost: row[0],
    currency: typeof row[2] === "string" ? row[2] : "USD",
  }));

  const resp: CostTrendResponse = {
    generatedAt: new Date().toISOString(),
    granularity,
    data,
  };

  trendCache.set(key, resp, env.AZURE_COST_CACHE_TTL_MS);
  return resp;
}

// ---------- Budgets ----------
type ArmBudgetProperties = {
  amount?: number;
  timeGrain?: string;
  currentSpend?: { amount?: number; unit?: string };
  forecastSpend?: { amount?: number; unit?: string };
};

type ArmBudget = {
  name?: string;
  properties?: ArmBudgetProperties;
};

export async function tryGetBudgets(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<BudgetsResponse | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = costCacheKey(prefix, subId, "budgets");
  const cached = budgetsCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const url = `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Consumption/budgets?api-version=2023-11-01`;
  const json = await fetcher.fetchJson<{ value?: ArmBudget[] }>(url);

  const budgets: BudgetStatus[] = (json.value ?? []).map((b) => {
    const props = b.properties ?? {};
    const amount = props.amount ?? 0;
    const currentSpend = props.currentSpend?.amount ?? 0;
    const forecastedSpend = props.forecastSpend?.amount ?? 0;
    const currency = props.currentSpend?.unit ?? "USD";
    const timeGrain = (props.timeGrain ?? "Monthly") as BudgetStatus["timeGrain"];
    return {
      budgetName: b.name ?? "unknown",
      amount,
      currentSpend,
      forecastedSpend,
      currency,
      timeGrain,
      usedPercentage: amount > 0 ? Math.round((currentSpend / amount) * 1000) / 10 : 0,
    };
  });

  const resp: BudgetsResponse = {
    generatedAt: new Date().toISOString(),
    budgets,
  };

  budgetsCache.set(key, resp, env.AZURE_COST_CACHE_TTL_MS);
  return resp;
}
