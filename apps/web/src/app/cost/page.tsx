"use client";

import { useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { CostSummary, CostTrendResponse, BudgetsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { ErrorNotice, PageHeader, SampleDataNotice, Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { ReservationsPanel } from "./ReservationsPanel";

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
  const { t } = useI18n();
  const { subscriptions, subscriptionId, setSubscriptionId, loaded: subsLoaded } = useSubscriptions();
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");

  const { data, error, loading } = useApiQuery(
    subsLoaded ? `cost:${subscriptionId}:${granularity}` : null,
    async (token) => {
      const sub = subscriptionId || undefined;
      const [summary, trend, budgets] = await Promise.all([
        fetchJsonWithBearer<CostSummary>(apiUrl("/api/cost/summary", { subscriptionId: sub }), token),
        fetchJsonWithBearer<CostTrendResponse>(apiUrl("/api/cost/trend", { subscriptionId: sub, granularity }), token),
        fetchJsonWithBearer<BudgetsResponse>(apiUrl("/api/cost/budgets", { subscriptionId: sub }), token),
      ]);
      return { summary, trend, budgets };
    },
  );
  const summary = data?.summary ?? null;
  const trend = data?.trend ?? null;
  const budgets = data?.budgets ?? null;

  const trendMax = useMemo(() => {
    const max = Math.max(0, ...(trend?.data ?? []).map((p) => p.cost));
    return max <= 0 ? 1 : max;
  }, [trend?.data]);

  return (
    <div className={styles.page}>
      <PageHeader
        meta={summary ? <span>{t("common.updated")} {new Date(summary.generatedAt).toLocaleString()}</span> : loading ? <span>{t("common.loading")}</span> : null}
        actions={
          <>
            <SubscriptionSelect subscriptions={subscriptions} value={subscriptionId} onChange={setSubscriptionId} />
            <Segmented
              label={t("cost.granularity")}
              value={granularity}
              onChange={setGranularity}
              items={[{ id: "daily", label: t("cost.ri.daily") }, { id: "monthly", label: t("cost.ri.monthly") }]}
            />
          </>
        }
      />

      <ErrorNotice error={error} />
      <SampleDataNotice note={summary?.note} />

      <div className={styles.grid}>
        {/* KPI strip */}
        <div className={styles.kpiCard}>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("cost.currentMonth")}</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.currentMonthTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("cost.previousMonth")}</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.previousMonthTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("cost.change")}</div>
              <div className={styles.kpiValue}>
                {summary ? (
                  <span className={`${styles.kpiChange} ${summary.changePercentage > 0 ? styles.kpiUp : styles.kpiDown}`}>
                    {fmtPct(summary.changePercentage)}
                  </span>
                ) : "-"}
              </div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("cost.forecast")}</div>
              <div className={styles.kpiValue}>{summary ? fmtCurrency(summary.forecastedTotal, summary.currency) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("cost.budgetUsed")}</div>
              <div className={styles.kpiValue}>{summary?.budgetUsedPercentage != null ? `${summary.budgetUsedPercentage.toFixed(1)}%` : "-"}</div>
            </div>
          </div>
        </div>

        {/* Cost trend chart */}
        <div className={styles.cardWide}>
          <div className={styles.cardTitle}>{t("cost.trend")} · {t(`cost.ri.${granularity}`)}</div>
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
              <div className={styles.empty}>{loading ? t("common.loading") : t("cost.noTrend")}</div>
            </div>
          )}
        </div>

        {/* Budgets */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>{t("cost.budgets")}</div>
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
              <div className={styles.empty}>{loading ? t("common.loading") : t("cost.noBudgets")}</div>
            )}
          </div>
        </div>

        {/* Forecast comparison */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>{t("cost.forecastVsBudget")}</div>
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
                      <span>{t("cost.forecast")}: {fmtCurrency(b.forecastedSpend, b.currency)}</span>
                      <span>{t("cost.budget")}: {fmtCurrency(b.amount, b.currency)}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className={styles.empty}>{loading ? t("common.loading") : t("cost.noBudgets")}</div>
            )}
          </div>
        </div>
      </div>

      <ReservationsPanel subscriptionId={subscriptionId} subscriptions={subscriptions} />
    </div>
  );
}
