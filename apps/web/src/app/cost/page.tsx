"use client";

import { useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { CostSummary, CostTrendResponse, BudgetsResponse } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { budgetCard } from "@/lib/costView";
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
        // budgets fail on their own (e.g. 403 without Cost Management Reader on budgets) — the card says why, the page stays
        fetchJsonWithBearer<BudgetsResponse>(apiUrl("/api/cost/budgets", { subscriptionId: sub }), token)
          .then((b) => ({ ok: b, failed: null }), (e: unknown) => ({ ok: null, failed: { ...(e instanceof ApiError ? { status: e.status } : {}) } })),
      ]);
      return { summary, trend, budgets: budgets.ok, budgetsFailed: budgets.failed };
    },
  );
  const summary = data?.summary ?? null;
  const trend = data?.trend ?? null;
  const budgets = data?.budgets ?? null;
  const card = budgetCard(budgets?.budgets, data?.budgetsFailed ?? null, loading);

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
            hint={!summary ? undefined : summary.changePercentage === null ? t("cost.vsSamePeriodNone")
              : t("cost.vsSamePeriod", { pct: fmtPct(summary.changePercentage), days: summary.comparedDays ?? 0, amount: fmtCurrency(summary.previousPeriodTotal ?? 0, summary.currency) })} />
        </Cell>
        <Cell span={3}>
          <Stat label={t("cost.previousMonth")} value={summary ? fmtCurrency(summary.previousMonthTotal, summary.currency) : "—"} hint={summary ? t("cost.previousMonthHint") : undefined} />
        </Cell>
        <Cell span={3}>
          {/* This platform's own arithmetic (daily average × days of the month) — said so: it is not Azure's forecast */}
          <Stat label={t("cost.projected")} value={summary ? fmtCurrency(summary.forecastedTotal, summary.currency) : "—"}
            hint={!summary ? undefined : [t("cost.projectedHint"), summary.previousMonthTotal > 0 ? t("cost.vsPreviousFull", { pct: fmtPct(((summary.forecastedTotal - summary.previousMonthTotal) / summary.previousMonthTotal) * 100) }) : null].filter(Boolean).join(" · ")} />
        </Cell>
        <Cell span={3}>
          {/* The most-used budget; otherwise why there is no number (no budget · not read · no spend value) — never 0% */}
          <Stat label={t("cost.budgetUsed")} value={card.state === "ok" ? `${card.pct.toFixed(1)}%` : "—"}
            tone={card.state === "ok" ? STAT_TONE[budgetTone(card.pct)] : undefined}
            hint={card.state === "ok" ? t(card.budgets > 1 ? "cost.budgetCard.topOf" : "cost.budgetCard.one", { name: card.name, n: card.budgets })
              : card.state === "loading" ? undefined
              : card.state === "failed" ? t(card.status === 403 ? "cost.budgetCard.forbidden" : "cost.budgetCard.failed")
              : card.state === "none" ? t("cost.budgetCard.none")
              : t("cost.budgetCard.noSpend", { n: card.budgets })} />
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
                  left={`${b.currentSpend === null ? t("cost.spendNone") : fmtCurrency(b.currentSpend, b.currency)} / ${fmtCurrency(b.amount, b.currency)}`} right={b.timeGrain} />
              ))
            ) : loading ? <LoadingState /> : <EmptyState title={card.state === "failed" ? t(card.status === 403 ? "cost.budgetCard.forbidden" : "cost.budgetCard.failed") : t("cost.noBudgets")} />}
          </Panel>
        </Cell>

        <Cell span={6}>
          <Panel title={t("cost.forecastVsBudget")}>
            {budgets && budgets.budgets.length > 0 ? (
              budgets.budgets.map((b) => (
                <BudgetRow key={b.budgetName} name={b.budgetName} pct={b.amount > 0 && b.forecastedSpend !== null ? (b.forecastedSpend / b.amount) * 100 : null}
                  left={b.forecastedSpend === null ? t("cost.forecastNone") : `${t("cost.forecastAzure")}: ${fmtCurrency(b.forecastedSpend, b.currency)}`} right={`${t("cost.budget")}: ${fmtCurrency(b.amount, b.currency)}`} />
              ))
            ) : loading ? <LoadingState /> : <EmptyState title={card.state === "failed" ? t(card.status === 403 ? "cost.budgetCard.forbidden" : "cost.budgetCard.failed") : t("cost.noBudgets")} />}
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
function BudgetRow({ name, pct, left, right }: { name: string; pct: number | null; left: string; right: string }) {
  // null = Azure gave no value to divide: a dash and an empty bar — no colour, no "0 %"
  const tone = pct === null ? null : budgetTone(pct);
  return (
    <div className={styles.budgetRow}>
      <div className={styles.budgetHeader}>
        <div className={styles.budgetName}>{name}</div>
        {pct === null || tone === null ? <div className={styles.budgetPct}>—</div> : (
          <div className={`${styles.budgetPct} ${styles[`budget${tone}`]}`}>
            <span aria-hidden="true">{tone === "Danger" ? "■" : tone === "Warn" ? "▲" : "●"}</span> {pct.toFixed(1)}%
          </div>
        )}
      </div>
      <div className={styles.budgetBar}>
        {pct === null || tone === null ? null : <div className={styles[`budgetFill${tone}`]} style={{ width: `${Math.min(100, pct)}%` }} />}
      </div>
      <div className={styles.budgetMeta}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}
