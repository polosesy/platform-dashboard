export type CostSummary = {
  generatedAt: string;
  currency: string;
  currentMonthTotal: number;
  previousMonthTotal: number;
  /** The previous month's day 1 to the same day of the month — what month-to-date is compared with */
  previousPeriodTotal?: number;
  /** How many days that comparison covers (day 1 – N) */
  comparedDays?: number;
  /** Month-to-date vs `previousPeriodTotal`, percent — null = nothing to compare with (not 0) */
  changePercentage: number | null;
  forecastedTotal: number;
  budgetTotal?: number;
  budgetUsedPercentage?: number;
  note?: string;
};

export type CostByResource = {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceGroup: string;
  cost: number;
  currency: string;
};

export type CostTrendPoint = {
  date: string;
  cost: number;
  currency: string;
};

export type CostTrendResponse = {
  generatedAt: string;
  granularity: "daily" | "monthly";
  data: CostTrendPoint[];
  note?: string;
};

export type BudgetStatus = {
  budgetName: string;
  amount: number;
  /** null = Azure gave no value (never 0) */
  currentSpend: number | null;
  /** Azure's own forecast for the budget — null = Azure gave none */
  forecastedSpend: number | null;
  currency: string;
  timeGrain: "Monthly" | "Quarterly" | "Annually";
  /** null = no amount or no spend value to divide */
  usedPercentage: number | null;
};

export type BudgetsResponse = {
  generatedAt: string;
  budgets: BudgetStatus[];
  note?: string;
};
