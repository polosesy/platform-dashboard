"use client";

import { useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { CostTrendPoint } from "@aud/types";
import { axisMoney, dateLabel, dateLong, labelIndices, stepIndex, trendSummary } from "@/lib/costTrendView";
import { useI18n } from "@/lib/i18n";

/**
 * Cost per day / month (renewal step 2, 2026-11-20 — dataviz method): bars from a zero baseline, a recessive y-axis
 * with round ticks, a few date labels, the average as one dashed reference line, and a hover / keyboard layer —
 * the whole column is the hit target, ←/→ · Home/End step through the bars, the tooltip says the date, the exact
 * amount and the gap to the average. The same numbers as a table: `table` (the panel's 표로 보기).
 */
export function CostTrendChart({ points, granularity, table, fmtMoney }: {
  points: CostTrendPoint[];
  granularity: "daily" | "monthly";
  table: boolean;
  fmtMoney: (n: number, currency: string) => string;
}) {
  const { t, locale } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const sum = useMemo(() => trendSummary(points), [points]);
  const labels = useMemo(() => labelIndices(points.length, granularity), [points.length, granularity]);
  const currency = points[0]?.currency ?? "USD";
  const n = points.length;
  const pct = (v: number) => `${(v / sum.top) * 100}%`;

  if (table) {
    return (
      <div className={styles.trendTableWrap} tabIndex={0} aria-label={t("cost.trend")}>
        <table className={styles.trendTable}>
          <thead>
            <tr><th scope="col">{t("cost.chart.colDate")}</th><th scope="col">{t("cost.chart.colCost")}</th></tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}><td>{dateLong(p.date, granularity, locale)}</td><td>{fmtMoney(p.cost, p.currency)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const cur = active === null ? null : points[active] ?? null;
  const vsAvg = cur && sum.average ? ((cur.cost - sum.average) / sum.average) * 100 : null;
  const peak = points[sum.maxIndex];
  // the tooltip sits beside the bar (never over the panel head or the bar itself): right of it, or left past 60 %
  const side = active !== null && (active + 0.5) / n > 0.6 ? "left" : "right";
  const left = active === null ? 0 : ((side === "right" ? active + 1 : active) / n) * 100;

  return (
    <div className={styles.chart}>
      <div className={styles.yAxis} aria-hidden="true">
        {sum.ticks.map((v) => <span key={v} style={{ bottom: pct(v) }}>{axisMoney(v, currency, locale)}</span>)}
      </div>
      <div
        className={styles.plot}
        role="group"
        tabIndex={0}
        aria-label={t("cost.chart.aria", {
          n, total: fmtMoney(sum.total, currency),
          peak: peak ? `${dateLong(peak.date, granularity, locale)} ${fmtMoney(peak.cost, currency)}` : "—",
        })}
        data-active={active === null ? undefined : ""}
        onKeyDown={(e) => {
          const next = stepIndex(active, e.key, n);
          if (next !== active) { e.preventDefault(); setActive(next); }
          if (e.key === "Escape") setActive(null);
        }}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {sum.ticks.map((v) => <span key={v} className={styles.gridLine} data-zero={v === 0 || undefined} style={{ bottom: pct(v) }} aria-hidden="true" />)}
        {sum.average !== null ? (
          <span className={styles.avgLine} style={{ bottom: pct(sum.average) }} aria-hidden="true">
            <span className={styles.avgLabel}>{t("cost.chart.avg", { amount: fmtMoney(sum.average, currency) })}</span>
          </span>
        ) : null}
        <div className={styles.bars}>
          {points.map((p, i) => (
            <div key={p.date} className={styles.col} data-active={active === i || undefined} onMouseEnter={() => setActive(i)} aria-hidden="true">
              <span className={styles.bar} style={{ height: `max(2px, ${pct(Math.max(0, p.cost))})` }} />
            </div>
          ))}
        </div>
        {cur ? (
          <div className={styles.tip} style={{ left: `${left}%` }} data-side={side} aria-hidden="true">
            <span className={styles.tipDate}>{dateLong(cur.date, granularity, locale)}</span>
            <strong className={styles.tipValue}>{fmtMoney(cur.cost, cur.currency)}</strong>
            {vsAvg !== null ? <span className={styles.tipMeta}>{t("cost.chart.vsAvg", { pct: `${vsAvg > 0 ? "+" : ""}${vsAvg.toFixed(1)}%` })}</span> : null}
          </div>
        ) : null}
      </div>
      <span aria-hidden="true" />
      <div className={styles.xAxis} aria-hidden="true">
        {labels.map((i) => <span key={i} style={{ left: `${((i + 0.5) / n) * 100}%` }}>{dateLabel(points[i]!.date, granularity, locale)}</span>)}
      </div>
      <div className={styles.srOnly} aria-live="polite">
        {cur ? `${dateLong(cur.date, granularity, locale)} ${fmtMoney(cur.cost, cur.currency)}` : ""}
      </div>
    </div>
  );
}
