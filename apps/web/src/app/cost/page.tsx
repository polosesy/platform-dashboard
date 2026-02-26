"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { CostSummary, CostTrendResponse, BudgetsResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

function fmtCurrency(n: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function budgetTone(pct: number): "Safe" | "Warn" | "Danger" {
  if (pct >= 90) return "Danger";
  if (pct >= 70) return "Warn";
  return "Safe";
}

export default function CostPage() {
  const getApiToken = useApiToken();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [trend, setTrend] = useState<CostTrendResponse | null>(null);
  const [budgets, setBudgets] = useState<BudgetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getApiToken()
      .then(async (token) => {
        const base = apiBaseUrl();
        const [s, t, b] = await Promise.all([
          fetchJsonWithBearer<CostSummary>(`${base}/api/cost/summary`, token),
          fetchJsonWithBearer<CostTrendResponse>(`${base}/api/cost/trend?granularity=${granularity}`, token),
          fetchJsonWithBearer<BudgetsResponse>(`${base}/api/cost/budgets`, token),
        ]);
        if (cancelled) return;
        setSummary(s);
        setTrend(t);
        setBudgets(b);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getApiToken, granularity]);

  const trendMax = useMemo(() => {
    const max = Math.max(0, ...(trend?.data ?? []).map((p) => p.cost));
    return max <= 0 ? 1 : max;
  }, [trend?.data]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Cost Management</div>
          <div className={styles.subTitle}>
            {summary ? `Generated: ${new Date(summary.generatedAt).toLocaleString()}` : loading ? "Loading..." : "No data"}
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.control}>
            <div className={styles.controlLabel}>Granularity</div>
            <select className={styles.select} value={granularity} onChange={(e) => setGranularity(e.target.value as "daily" | "monthly")}>
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}
      {summary?.note ? <div className={styles.note}>{summary.note}</div> : null}

      <div className={styles.grid}>
        {/* KPI strip */}
        <div className={styles.kpiCard}>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Current month</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.currentMonthTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Previous month</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.previousMonthTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Change</div>
              <div className={styles.kpiValue}>
                {summary ? (
                  <span className={`${styles.kpiChange} ${summary.changePercentage > 0 ? styles.kpiUp : styles.kpiDown}`}>
                    {fmtPct(summary.changePercentage)}
                  </span>
                ) : "-"}
              </div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Forecasted</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.forecastedTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Budget used</div>
              <div className={styles.kpiValue}>{summary?.budgetUsedPercentage != null ? `${summary.budgetUsedPercentage.toFixed(1)}%` : "-"}</div>
            </div>
          </div>
        </div>

        {/* Cost trend chart */}
        <div className={styles.cardWide}>
          <div className={styles.cardTitle}>Cost trend ({granularity})</div>
          {trend && trend.data.length > 0 ? (
            <div className={styles.trendWrap}>
              {trend.data.map((p) => {
                const h = Math.max(2, (p.cost / trendMax) * 100);
                return (
                  <div key={p.date} className={styles.trendBar} style={{ height: `${h}%` }}>
                    <div className={styles.trendBarLabel}>{fmtCurrency(p.cost, p.currency)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.cardBody}>
              <div className={styles.empty}>{loading ? "Loading trend data..." : "No trend data available."}</div>
            </div>
          )}
        </div>

        {/* Budgets */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>Budgets</div>
          <div className={styles.cardBody}>
            {budgets && budgets.budgets.length > 0 ? (
              budgets.budgets.map((b) => {
                const tone = budgetTone(b.usedPercentage);
                return (
                  <div key={b.budgetName} className={styles.budgetRow}>
                    <div className={styles.budgetHeader}>
                      <div className={styles.budgetName}>{b.budgetName}</div>
                      <div className={`${styles.budgetPct} ${styles[`budget${tone}`]}`}>{b.usedPercentage.toFixed(1)}%</div>
                    </div>
                    <div className={styles.budgetBar}>
                      <div className={styles[`budgetFill${tone}`]} style={{ width: `${Math.min(100, b.usedPercentage)}%` }} />
                    </div>
                    <div className={styles.budgetMeta}>
                      <span>{fmtCurrency(b.currentSpend, b.currency)} / {fmtCurrency(b.amount, b.currency)}</span>
                      <span>{b.timeGrain}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className={styles.empty}>{loading ? "Loading budgets..." : "No budgets configured."}</div>
            )}
          </div>
        </div>

        {/* Forecast comparison */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>Forecast vs Budget</div>
          <div className={styles.cardBody}>
            {budgets && budgets.budgets.length > 0 ? (
              budgets.budgets.map((b) => {
                const forecastPct = b.amount > 0 ? (b.forecastedSpend / b.amount) * 100 : 0;
                const tone = budgetTone(forecastPct);
                return (
                  <div key={b.budgetName} className={styles.budgetRow}>
                    <div className={styles.budgetHeader}>
                      <div className={styles.budgetName}>{b.budgetName}</div>
                      <div className={`${styles.budgetPct} ${styles[`budget${tone}`]}`}>{forecastPct.toFixed(1)}%</div>
                    </div>
                    <div className={styles.budgetBar}>
                      <div className={styles[`budgetFill${tone}`]} style={{ width: `${Math.min(100, forecastPct)}%` }} />
                    </div>
                    <div className={styles.budgetMeta}>
                      <span>Forecast: {fmtCurrency(b.forecastedSpend, b.currency)}</span>
                      <span>Budget: {fmtCurrency(b.amount, b.currency)}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className={styles.empty}>{loading ? "Loading..." : "No budgets configured."}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
