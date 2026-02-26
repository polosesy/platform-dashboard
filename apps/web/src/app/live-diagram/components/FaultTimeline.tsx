"use client";

import { useMemo, useRef, useEffect } from "react";
import { scaleTime, scaleLinear } from "d3-scale";
import { line, curveStepAfter } from "d3-shape";
import type { LiveAlert, AlertSeverity } from "@aud/types";
import styles from "../styles.module.css";

type FaultTimelineProps = {
  alerts: LiveAlert[];
  onAlertClick: (alert: LiveAlert) => void;
};

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  critical: "rgba(216,59,1,0.90)",
  warning: "rgba(209,132,0,0.85)",
  info: "rgba(0,120,212,0.80)",
};

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const TIMELINE_HEIGHT = 80;
const PADDING = { top: 8, right: 12, bottom: 20, left: 40 };

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function FaultTimeline({ alerts, onAlertClick }: FaultTimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const sorted = useMemo(
    () =>
      [...alerts].sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          new Date(b.firedAt).getTime() - new Date(a.firedAt).getTime(),
      ),
    [alerts],
  );

  const timeExtent = useMemo(() => {
    if (sorted.length === 0) return [new Date(), new Date()] as const;
    const times = sorted.map((a) => new Date(a.firedAt).getTime());
    const min = Math.min(...times);
    const max = Math.max(...times);
    const pad = Math.max((max - min) * 0.1, 60000);
    return [new Date(min - pad), new Date(max + pad)] as const;
  }, [sorted]);

  const xScale = useMemo(
    () =>
      scaleTime()
        .domain(timeExtent)
        .range([PADDING.left, 280 - PADDING.right]),
    [timeExtent],
  );

  // Cumulative severity line for sparkline header
  const cumulativePath = useMemo(() => {
    if (sorted.length === 0) return "";
    const yScale = scaleLinear()
      .domain([0, sorted.length])
      .range([TIMELINE_HEIGHT - PADDING.bottom, PADDING.top]);
    const lineGen = line<[Date, number]>()
      .x((d) => xScale(d[0]))
      .y((d) => yScale(d[1]))
      .curve(curveStepAfter);
    const points: [Date, number][] = sorted
      .map((a, i) => [new Date(a.firedAt), i + 1] as [Date, number])
      .sort((a, b) => a[0].getTime() - b[0].getTime());
    return lineGen(points) ?? "";
  }, [sorted, xScale]);

  useEffect(() => {
    // D3 could drive transitions here, but since the SVG is declaratively
    // rendered by React, we keep it simple.
  }, [sorted]);

  if (alerts.length === 0) {
    return (
      <div className={styles.faultTimeline}>
        <div className={styles.faultTimelineTitle}>Fault Timeline</div>
        <div className={styles.faultTimelineEmpty}>No active faults</div>
      </div>
    );
  }

  return (
    <div className={styles.faultTimeline}>
      <div className={styles.faultTimelineTitle}>
        Fault Timeline
        <span className={styles.faultTimelineBadge}>{alerts.length}</span>
      </div>

      {/* Mini cumulative chart */}
      <svg
        ref={svgRef}
        viewBox={`0 0 280 ${TIMELINE_HEIGHT}`}
        className={styles.faultTimelineSvg}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Grid lines */}
        {xScale.ticks(4).map((tick) => (
          <line
            key={tick.getTime()}
            x1={xScale(tick)}
            y1={PADDING.top}
            x2={xScale(tick)}
            y2={TIMELINE_HEIGHT - PADDING.bottom}
            stroke="rgba(20,21,23,0.06)"
            strokeWidth={1}
          />
        ))}

        {/* Cumulative line */}
        <path d={cumulativePath} fill="none" stroke="rgba(216,59,1,0.40)" strokeWidth={1.5} />

        {/* Alert dots */}
        {sorted.map((alert, i) => {
          const cx = xScale(new Date(alert.firedAt));
          const yScale = scaleLinear()
            .domain([0, sorted.length])
            .range([TIMELINE_HEIGHT - PADDING.bottom, PADDING.top]);
          const cy = yScale(i + 1);
          return (
            <circle
              key={alert.id}
              cx={cx}
              cy={cy}
              r={alert.severity === "critical" ? 4 : 3}
              fill={SEVERITY_COLORS[alert.severity]}
              className={styles.faultTimelineDot}
              onClick={() => onAlertClick(alert)}
            />
          );
        })}
      </svg>

      {/* Alert list */}
      <div className={styles.faultTimelineList}>
        {sorted.map((alert) => (
          <button
            key={alert.id}
            type="button"
            className={styles.faultTimelineItem}
            onClick={() => onAlertClick(alert)}
          >
            <span
              className={styles.faultTimelineSevDot}
              style={{ background: SEVERITY_COLORS[alert.severity] }}
            />
            <span className={styles.faultTimelineItemTitle}>{alert.title}</span>
            <span className={styles.faultTimelineItemTime}>{timeAgo(alert.firedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
