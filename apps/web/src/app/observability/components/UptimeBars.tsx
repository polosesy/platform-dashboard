"use client";

// SLO › 글로벌 업타임 막대 (2026-11-19, 2nd) — a status page's row (status.claude.com): one bar per bucket with a gap
// between, graded ok · minor · partial · major by the bucket's burn rate (API services/sloUptime.ts gradeOf), no data in
// grey; hover = the bucket's time, grade and counts; under the bars "start —— n % uptime —— now". On a narrow screen
// neighbouring buckets share a bar (lib/sloUptimeView mergeBuckets — counts summed, graded again), so a bar never drops
// under MIN_BAR px and the gaps stay. Used by the service detail and the key-services board.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SloUptimeBucket, SloUptimeGrade } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { mergeBuckets, mergeFactor, tipLeft, uptimeShare, type UptimeBar } from "@/lib/sloUptimeView";
import styles from "../styles.module.css";

export const GRADES: SloUptimeGrade[] = ["ok", "minor", "partial", "major", "noData"];

/** The width a bar row has — measured, so the merge follows the screen (and a resize) */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** The bars of one row at this width */
export function useBars(buckets: SloUptimeBucket[], minutes: number, target: number, width: number): UptimeBar[] {
  return useMemo(() => mergeBuckets(buckets, mergeFactor(buckets.length, width), minutes, target), [buckets, minutes, target, width]);
}

export function UptimeBars({ bars, minutes, from, to, fmt, label, tipOf }: {
  bars: UptimeBar[];
  minutes: number;
  from: string;
  to: string;
  fmt: (ms: number) => string;
  /** the row's accessible name */
  label: string;
  /** extra lines for a bar's tip (the board's overall row: the services graded below ok) */
  tipOf?: (i: number) => ReactNode;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const n = bars.length;
  useLayoutEffect(() => {
    if (hover === null || !barRef.current || !tipRef.current) return;
    const barW = barRef.current.clientWidth;
    setLeft(tipLeft(((hover + 0.5) / n) * barW, tipRef.current.offsetWidth, barW));
  }, [hover, n]);
  const hb = hover === null ? null : bars[hover] ?? null;
  const share = uptimeShare(bars);
  const span = (m: number) => (m >= 60 ? t("ob.slo.ud.hours", { n: Math.round((m / 60) * 10) / 10 }) : t("ob.slo.ud.minutes", { n: m }));
  return (
    <div className={styles.upRow}>
      <div ref={barRef} className={styles.upBars} data-uptime-bar role="img" aria-label={t("ob.slo.ud.barsAria", { name: label, p: share === null ? "—" : `${(share * 100).toFixed(2)}%` })}
        onPointerLeave={() => setHover(null)}>
        {bars.map((b, i) => (
          <span key={b.t} className={styles.upBar} data-grade={b.grade} data-hover={hover === i || undefined} onPointerEnter={() => setHover(i)} />
        ))}
        {hb ? (
          <div ref={tipRef} className={styles.sloTip} style={{ left, top: "calc(100% + 6px)", maxWidth: "100%" }} role="status">
            <strong className={styles.upTipHead}>{fmt(hb.from)} – {fmt(hb.t)} <span className={styles.upTipSpan}>({span(minutes * hb.buckets)})</span></strong>
            <span className={styles.upTipGrade} data-grade={hb.grade}><i aria-hidden="true" />{t(`ob.slo.ud.grade.${hb.grade}`)}</span>
            {hb.grade === "noData" ? null : (
              <span>{hb.sli === null ? t("ob.slo.ud.failedOf", { bad: Math.round(hb.bad).toLocaleString(), total: Math.round(hb.total).toLocaleString() })
                : t("ob.slo.ud.bucket", { sli: `${(hb.sli * 100).toFixed(2)}%`, bad: Math.round(hb.bad).toLocaleString(), total: Math.round(hb.total).toLocaleString() })}
                {hb.burn !== null && hb.grade !== "ok" ? ` · ${t("ob.slo.ud.burn", { v: hb.burn })}` : ""}</span>
            )}
            {tipOf?.(hover!)}
          </div>
        ) : null}
      </div>
      <div className={styles.upAxis}>
        <span>{fmt(Date.parse(from))}</span>
        <i aria-hidden="true" />
        <span className={styles.upShare}>{share === null ? t("ob.slo.ud.noJudged") : t("ob.slo.ud.share", { p: `${(share * 100).toFixed(2)}%` })}</span>
        <i aria-hidden="true" />
        <span>{fmt(Date.parse(to))}</span>
      </div>
    </div>
  );
}

/** The grades' key — colour + name + how many bars, and the rule they follow */
export function UptimeLegend({ counts }: { counts?: Record<SloUptimeGrade, number> }) {
  const { t } = useI18n();
  return (
    <div className={styles.upLegendWrap}>
      <ul className={styles.upLegend}>
        {GRADES.map((g) => (
          <li key={g}><span className={styles.upSwatch} data-grade={g} aria-hidden="true" />{t(`ob.slo.ud.grade.${g}`)}{counts ? <b>{counts[g]}</b> : null}</li>
        ))}
      </ul>
      <p className={styles.upRule}>{t("ob.slo.ud.gradeRule")}</p>
    </div>
  );
}
