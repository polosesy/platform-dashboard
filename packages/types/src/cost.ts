export type CostSummary = {
  generatedAt: string;
  currency: string;
  currentMonthTotal: number;
  previousMonthTotal: number;
  changePercentage: number;
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
  currentSpend: number;
  forecastedSpend: number;
  currency: string;
  timeGrain: "Monthly" | "Quarterly" | "Annually";
  usedPercentage: number;
};

export type BudgetsResponse = {
  generatedAt: string;
  budgets: BudgetStatus[];
  note?: string;
};
