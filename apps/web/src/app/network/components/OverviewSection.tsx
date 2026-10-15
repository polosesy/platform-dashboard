"use client";

import type { NetOverview } from "@aud/types";
import { Panel, Stat } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { formatBytes } from "@/lib/format";
import styles from "../styles.module.css";

const fmtInt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);

/** Totals, bytes over time (bars) with denied flows (line), and the Traffic Analytics flow-type breakdown */
export function OverviewSection({ overview, binMinutes, lastRow }: { overview: NetOverview; binMinutes: number; lastRow: string | null }) {
  const { t, locale } = useI18n();
  const { totals } = overview;
  const maxType = Math.max(1, ...overview.byFlowType.map((f) => f.bytes));
  return (
    <div className={styles.stack}>
      <div className={styles.stats}>
        <Stat label={t("net.bytes")} value={formatBytes(totals.bytes)} />
        <Stat label={t("net.allowed")} value={fmtInt(totals.allowedFlows)} />
        <Stat label={t("net.denied")} value={fmtInt(totals.deniedFlows)} tone={totals.deniedFlows > 0 ? "medium" : undefined} />
        <Stat label={t("net.records")} value={fmtInt(totals.records)} hint={lastRow ? t("net.lastIngested", { time: new Date(lastRow).toLocaleString(dateLocale(locale)) }) : t("net.recordsHint")} />
      </div>
      <Panel title={t("net.series")} sub={t("net.seriesHint", { bin: binMinutes })}>
        <TrafficSeries series={overview.series} locale={locale} />
      </Panel>
      <Panel title={t("net.flowType")} flush>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("net.flowType")}</th>
              <th className={styles.num}>{t("net.bytes")}</th>
              <th className={styles.num}>{t("net.allowed")}</th>
              <th className={styles.num}>{t("net.deniedShort")}</th>
              <th className={styles.num} title={t("net.recordsHint")}>{t("net.records")}</th>
            </tr>
          </thead>
          <tbody>
            {overview.byFlowType.map((f) => (
              <tr key={f.flowType}>
                <td>
                  <div className={styles.barCell}>
                    <span className={f.flowType === "MaliciousFlow" ? styles.dangerText : undefined}>{flowTypeLabel(t, f.flowType)}</span>
                    <span className={styles.bar} style={{ width: `${Math.max(2, (f.bytes / maxType) * 100)}%` }} />
                  </div>
                </td>
                <td className={styles.num}>{formatBytes(f.bytes)}</td>
                <td className={styles.num}>{fmtInt(f.allowedFlows)}</td>
                <td className={styles.num}>{fmtInt(f.deniedFlows)}</td>
                <td className={styles.num}>{fmtInt(f.records)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

const KNOWN = new Set(["IntraVNet", "InterVNet", "S2S", "P2S", "AzurePublic", "ExternalPublic", "MaliciousFlow", "UnknownPrivate", "Unknown"]);
export const flowTypeLabel = (t: (k: string) => string, ft: string) => (KNOWN.has(ft) ? t(`net.ft.${ft}`) : ft);

/** Inline SVG: bars = bytes per bin, line = denied flows (own scale) — colors from tokens via CSS classes */
function TrafficSeries({ series, locale }: { series: NetOverview["series"]; locale: string }) {
  if (!series.length) return null;
  const W = 720, H = 160, PAD = 4;
  const maxB = Math.max(1, ...series.map((s) => s.bytes));
  const maxD = Math.max(1, ...series.map((s) => s.deniedFlows));
  const step = (W - PAD * 2) / series.length;
  const bw = Math.max(2, step * 0.7);
  const y = (v: number, max: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = series.map((s, i) => `${i ? "L" : "M"}${(PAD + step * i + step / 2).toFixed(1)},${y(s.deniedFlows, maxD).toFixed(1)}`).join(" ");
  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale as "ko" | "en"), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={styles.series}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.seriesSvg} role="img" aria-hidden="true">
        {series.map((s, i) => (
          <rect key={s.t} className={styles.seriesBar} x={PAD + step * i + (step - bw) / 2} y={y(s.bytes, maxB)} width={bw} height={H - PAD - y(s.bytes, maxB)}>
            <title>{`${fmt(s.t)} · ${formatBytes(s.bytes)} · ${s.deniedFlows}`}</title>
          </rect>
        ))}
        {series.some((s) => s.deniedFlows > 0) ? <path className={styles.seriesLine} d={line} /> : null}
      </svg>
      <div className={styles.seriesAxis}>
        <span>{fmt(series[0]!.t)}</span>
        <span>{fmt(series[series.length - 1]!.t)}</span>
      </div>
    </div>
  );
}
