"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { scaleTime, scaleLinear } from "d3-scale";
import { line, curveStepAfter } from "d3-shape";
import type { LiveAlert, AlertSeverity } from "@aud/types";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";

type FaultTimelineProps = {
  alerts: LiveAlert[];
  onAlertClick: (alert: LiveAlert) => void;
};

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  critical: rgba("danger", 0.9),
  warning: rgba("warning", 0.85),
  info: rgba("accent", 0.8),
};

const WIDTH = 280;
const TIMELINE_HEIGHT = 80;
const PADDING = { top: 8, right: 12, bottom: 20, left: 40 };

type TFn = (key: string, vars?: Record<string, string | number>) => string;
function timeAgo(iso: string, t: TFn): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return t("common.secondsAgo", { n: Math.max(0, sec) });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("common.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("common.hoursAgo", { n: hr });
  return t("common.daysAgo", { n: Math.floor(hr / 24) });
}

/**
 * Active alerts over time: a cumulative step line (the n-th alert to fire sits at height n, so the line only
 * goes up) and the list, newest first. Rendered inside the alert sidebar's "타임라인" tab.
 */
export function FaultTimeline({ alerts, onAlertClick }: FaultTimelineProps) {
  const { t } = useI18n();

  // Oldest first: the cumulative count is defined over time, not over severity
  const chrono = useMemo(
    () => [...alerts].sort((a, b) => new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime()),
    [alerts],
  );

  const { xScale, yScale } = useMemo(() => {
    const times = chrono.map((a) => new Date(a.firedAt).getTime());
    const min = times.length ? Math.min(...times) : 0; // no alerts → empty state, scale unused
    const max = times.length ? Math.max(...times) : 0;
    const pad = Math.max((max - min) * 0.1, 60_000);
    return {
      xScale: scaleTime().domain([new Date(min - pad), new Date(max + pad)]).range([PADDING.left, WIDTH - PADDING.right]),
      yScale: scaleLinear().domain([0, Math.max(1, chrono.length)]).range([TIMELINE_HEIGHT - PADDING.bottom, PADDING.top]),
    };
  }, [chrono]);

  const cumulativePath = useMemo(() => {
    const points: [Date, number][] = chrono.map((a, i) => [new Date(a.firedAt), i + 1]);
    return line<[Date, number]>().x((d) => xScale(d[0])).y((d) => yScale(d[1])).curve(curveStepAfter)(points) ?? "";
  }, [chrono, xScale, yScale]);

  if (alerts.length === 0) return <div className={styles.faultTimelineEmpty}>{t("live.noAlerts")}</div>;

  return (
    <div className={styles.faultTimelineBody}>
      <svg viewBox={`0 0 ${WIDTH} ${TIMELINE_HEIGHT}`} className={styles.faultTimelineSvg} preserveAspectRatio="xMidYMid meet" aria-label={t("ld.fault.chart")}>
        {xScale.ticks(4).map((tick) => (
          <line key={tick.getTime()} x1={xScale(tick)} y1={PADDING.top} x2={xScale(tick)} y2={TIMELINE_HEIGHT - PADDING.bottom} stroke={rgba("ink", 0.06)} strokeWidth={1} />
        ))}
        <path d={cumulativePath} fill="none" stroke={rgba("danger", 0.4)} strokeWidth={1.5} data-role="cumulative" />
        {chrono.map((alert, i) => (
          <circle
            key={alert.id}
            cx={xScale(new Date(alert.firedAt))}
            cy={yScale(i + 1)}
            r={alert.severity === "critical" ? 4 : 3}
            fill={SEVERITY_COLORS[alert.severity]}
            className={styles.faultTimelineDot}
            onClick={() => onAlertClick(alert)}
          />
        ))}
      </svg>

      <div className={styles.faultTimelineList}>
        {[...chrono].reverse().map((alert) => (
          <button key={alert.id} type="button" className={styles.faultTimelineItem} onClick={() => onAlertClick(alert)}>
            <span className={styles.faultTimelineSevDot} style={{ background: SEVERITY_COLORS[alert.severity] }} />
            <span className={styles.faultTimelineItemTitle}>{alert.title}</span>
            <span className={styles.faultTimelineItemTime}>{timeAgo(alert.firedAt, t)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
