"use client";

import { useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { CostSummary, CostTrendResponse, BudgetsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { Cell, EmptyState, ErrorNotice, Grid, LoadingState, PageHeader, Panel, SampleDataNotice, Segmented, Stat } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
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
  const { t, locale } = useI18n();
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
        meta={summary ? <span>{t("common.updated")} {new Date(summary.generatedAt).toLocaleString(dateLocale(locale))}</span> : loading ? <span>{t("common.loading")}</span> : null}
        actions={
          <>
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

      {/* 12 columns: 4 cards × 3 · the trend 12 · budgets 6 + 6 · reservations 12 (design-system.md · 8) */}
      <Grid>
        <Cell span={3}>
          <Stat label={t("cost.currentMonth")} value={summary ? fmtCurrency(summary.currentMonthTotal, summary.currency) : "—"}
            hint={summary ? t("cost.vsPrevious", { pct: fmtPct(summary.changePercentage) }) : undefined} />
        </Cell>
        <Cell span={3}>
          <Stat label={t("cost.previousMonth")} value={summary ? fmtCurrency(summary.previousMonthTotal, summary.currency) : "—"} />
        </Cell>
        <Cell span={3}>
          <Stat label={t("cost.forecast")} value={summary ? fmtCurrency(summary.forecastedTotal, summary.currency) : "—"}
            hint={summary && summary.previousMonthTotal > 0 ? t("cost.vsPrevious", { pct: fmtPct(((summary.forecastedTotal - summary.previousMonthTotal) / summary.previousMonthTotal) * 100) }) : undefined} />
        </Cell>
        <Cell span={3}>
          <Stat label={t("cost.budgetUsed")} value={summary?.budgetUsedPercentage != null ? `${summary.budgetUsedPercentage.toFixed(1)}%` : "—"}
            tone={summary?.budgetUsedPercentage != null ? STAT_TONE[budgetTone(summary.budgetUsedPercentage)] : undefined} />
        </Cell>

        <Cell span={12}>
          <Panel title={t("cost.trend")} sub={t(`cost.ri.${granularity}`)}>
            {trend && trend.data.length > 0 ? (
              <div className={styles.trendWrap}>
                {trend.data.map((p) => {
                  const h = Math.max(2, (p.cost / trendMax) * 100);
                  return (
                    <div key={p.date} className={styles.trendBar} style={{ height: `${h}%` }} title={`${p.date} · ${fmtCurrency(p.cost, p.currency)}`}>
                      <div className={styles.trendBarLabel}>{fmtCurrency(p.cost, p.currency)}</div>
                    </div>
                  );
                })}
              </div>
            ) : loading ? <LoadingState /> : <EmptyState title={t("cost.noTrend")} />}
          </Panel>
        </Cell>

        <Cell span={6}>
          <Panel title={t("cost.budgets")} sub={budgets ? String(budgets.budgets.length) : undefined}>
            {budgets && budgets.budgets.length > 0 ? (
              budgets.budgets.map((b) => (
                <BudgetRow key={b.budgetName} name={b.budgetName} pct={b.usedPercentage}
                  left={`${fmtCurrency(b.currentSpend, b.currency)} / ${fmtCurrency(b.amount, b.currency)}`} right={b.timeGrain} />
              ))
            ) : loading ? <LoadingState /> : <EmptyState title={t("cost.noBudgets")} />}
          </Panel>
        </Cell>

        <Cell span={6}>
          <Panel title={t("cost.forecastVsBudget")}>
            {budgets && budgets.budgets.length > 0 ? (
              budgets.budgets.map((b) => (
                <BudgetRow key={b.budgetName} name={b.budgetName} pct={b.amount > 0 ? (b.forecastedSpend / b.amount) * 100 : 0}
                  left={`${t("cost.forecast")}: ${fmtCurrency(b.forecastedSpend, b.currency)}`} right={`${t("cost.budget")}: ${fmtCurrency(b.amount, b.currency)}`} />
              ))
            ) : loading ? <LoadingState /> : <EmptyState title={t("cost.noBudgets")} />}
          </Panel>
        </Cell>

        <Cell span={12}>
      <ReservationsPanel subscriptionId={subscriptionId} subscriptions={subscriptions} />
        </Cell>
      </Grid>
    </div>
  );
}

const STAT_TONE = { Safe: "success", Warn: "medium", Danger: "high" } as const;

/** One budget: name · percent (glyph + colour) · the bar · two facts — the same row in both budget panels */
function BudgetRow({ name, pct, left, right }: { name: string; pct: number; left: string; right: string }) {
  const tone = budgetTone(pct);
  return (
    <div className={styles.budgetRow}>
      <div className={styles.budgetHeader}>
        <div className={styles.budgetName}>{name}</div>
        <div className={`${styles.budgetPct} ${styles[`budget${tone}`]}`}>
          <span aria-hidden="true">{tone === "Danger" ? "■" : tone === "Warn" ? "▲" : "●"}</span> {pct.toFixed(1)}%
        </div>
      </div>
      <div className={styles.budgetBar}>
        <div className={styles[`budgetFill${tone}`]} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className={styles.budgetMeta}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}
