"use client";

// One small time-series chart (2026-11-19) — shared by 수집 상태 › 수집기 신호 and APM › 메트릭. Lines in a fixed colour
// order (series1 · 2 · 3 — colour = position, never rank), a limit as a dashed ceiling (left off the axis when it is
// over LIMIT_ON_AXIS × the data — said in numbers instead), a rule as a dotted line; hover = the values at that time;
// a series the workspace does not have = "미측정" in the legend (never a flat 0), a query that did not answer = "조회 실패".
// A percentile with `cap`: a point at the cap reads "> cap" (over the histogram's largest bound).
// Shared crosshair: charts inside one <CrosshairGroup> follow the pointer together (lib/crosshair.ts) — the chart under
// the pointer shows the tooltip, the others draw the line + dots and read their own values at that time in the caption
// (each snaps to its own point within 1.5 steps, else "—"). Keyboard: focus a plot, ← → move, Esc leaves.

import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CollectorSignal } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { limitOnAxis, niceMax, valueText } from "@/lib/collectorView";
import { createCrosshair, snapTime, stepOf, timeAtX, type CrosshairStore } from "@/lib/crosshair";
import { useWidth } from "./UptimeBars";
import styles from "../styles.module.css";

const H = 132, PAD = { l: 52, r: 10, t: 10, b: 20 };

export type ChartLine = { signal: CollectorSignal | undefined; label: string };

const CrosshairContext = createContext<CrosshairStore | null>(null);

/** Charts inside share one crosshair (same time axis) */
export function CrosshairGroup({ children }: { children: ReactNode }) {
  const [store] = useState(createCrosshair);
  return <CrosshairContext.Provider value={store}>{children}</CrosshairContext.Provider>;
}

function useCrosshair() {
  const shared = useContext(CrosshairContext);
  const [own] = useState(createCrosshair); // a chart outside a group keeps its crosshair to itself
  const store = shared ?? own;
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { store, state, grouped: !!shared };
}

export function MetricChart({ id, title, promql, lines, limit, limitLabel, threshold, ruleLabel, from, to, fmt, noLimitText, unit: unitIn, textOf }: {
  id: string;
  title: string;
  promql?: string;
  lines: ChartLine[];
  limit?: CollectorSignal | null;
  limitLabel?: string;
  threshold?: number;
  ruleLabel?: string;
  from: number;
  to: number;
  fmt: (ms: number) => string;
  /** said beside the values when a limit was asked for and the workspace has none (a pod with no limit) */
  noLimitText?: string;
  unit?: CollectorSignal["unit"];
  /** a value's text (default: its unit) — e.g. "> 120 s" at a percentile's cap */
  textOf?: (s: CollectorSignal, v: number | null) => ReactNode;
}) {
  const { t } = useI18n();
  const [ref, w] = useWidth<HTMLDivElement>();
  const { store, state: cross, grouped } = useCrosshair();
  const present = lines.filter((l): l is { signal: CollectorSignal; label: string } => !!l.signal);
  const measured = present.filter((l) => l.signal.series);
  const unit = unitIn ?? present[0]?.signal.unit ?? "count";
  // a percentile over the histogram's largest bound reads "> cap" — by its time (overAt), never by its value
  const text = (s: CollectorSignal, v: number | null, t?: number | null) => (textOf ? textOf(s, v)
    : s.cap !== undefined && t != null && s.overAt?.includes(t) ? `> ${valueText(s.cap, s.unit)}` : valueText(v, s.unit));
  const lastT = (s: CollectorSignal) => s.series?.[s.series.length - 1]?.[0] ?? null;
  const dataMax = Math.max(0, ...measured.map((l) => l.signal.max ?? 0));
  const drawLimit = !!limit?.series && limitOnAxis(dataMax, limit.max);
  const top = useMemo(() => niceMax(Math.max(dataMax, drawLimit ? limit?.max ?? 0 : 0, threshold ?? 0), unit), [dataMax, drawLimit, limit, threshold, unit]);
  const iw = Math.max(40, w - PAD.l - PAD.r), ih = H - PAD.t - PAD.b;
  const x = (ms: number) => PAD.l + ((ms - from) / Math.max(1, to - from)) * iw;
  const y = (v: number) => PAD.t + ih - (Math.min(Math.max(0, v), top) / top) * ih;
  const path = (pts: Array<[number, number]>) => pts.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("");
  // hover on the union of the lines' times (a percentile has points only where there were requests)
  const times = useMemo(() => [...new Set(measured.flatMap((l) => l.signal.series!.map((p) => p[0])))].sort((a, b) => a - b), [measured]);
  const step = useMemo(() => stepOf(times), [times]);
  const mine = cross?.source === id;
  const inRange = cross !== null && cross.ms >= from && cross.ms <= to;
  const at = inRange ? snapTime(times, cross!.ms, step) : null;
  const valAt = (s: CollectorSignal | null | undefined) => (at === null || !s?.series ? null : s.series.find((p) => p[0] === at)?.[1] ?? null);
  const crossX = !inRange ? null : x(at ?? cross!.ms);
  const synced = inRange && !mine && grouped && measured.length > 0; // another chart of the group has the pointer
  const point = (ms: number) => store.set({ ms, source: id });
  const move = (dir: -1 | 1) => {
    if (!times.length) return;
    const i = at === null ? (dir > 0 ? -1 : times.length) : times.indexOf(at);
    point(times[Math.min(times.length - 1, Math.max(0, i + dir))]!);
  };
  const failed = present.some((l) => l.signal.failed);
  return (
    <figure className={styles.colChart} data-chart={id}>
      <figcaption className={styles.colChartHead}>
        <span title={promql}>{title}</span>
        <span className={styles.colChartNow}>
          {synced ? <span data-at>{fmt(at ?? cross!.ms)}</span> : null}
          {present.map((l, i) => (!l.signal.series ? null : synced
            ? <span key={l.signal.id} data-i={i}>{valAt(l.signal) === null ? "—" : text(l.signal, valAt(l.signal), at)}</span>
            : <span key={l.signal.id} data-i={i}>{text(l.signal, l.signal.now, lastT(l.signal))}</span>))}
          {limit?.series ? <span data-limit title={drawLimit ? undefined : t("obs.col.limitOffAxis")}>{t("obs.col.limitOf", { v: valueText(limit.now, limit.unit) })}{drawLimit ? "" : " ↑"}</span>
            : noLimitText && measured.length ? <span data-limit>{noLimitText}</span> : null}
        </span>
      </figcaption>
      <div ref={ref} className={styles.colPlot} tabIndex={measured.length ? 0 : undefined} aria-label={measured.length ? t("obs.col.plotKeys", { title }) : undefined}
        onPointerLeave={() => { if (store.get()?.source === id) store.set(null); }}
        onPointerMove={(e) => {
          if (!times.length) return;
          const box = e.currentTarget.getBoundingClientRect();
          point(timeAtX(e.clientX, box.left + PAD.l, iw, from, to));
        }}
        onBlur={() => { if (store.get()?.source === id) store.set(null); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); move(e.key === "ArrowLeft" ? -1 : 1); }
          else if (e.key === "Escape" && store.get()?.source === id) store.set(null);
        }}>
        {failed ? <p className={styles.colEmpty}>{t("obs.col.failed")}</p>
          : !measured.length ? <p className={styles.colEmpty}>{t("obs.col.notMeasured")}</p>
          : w > 0 ? (
            <svg width={w} height={H} role="img" aria-label={title}>
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line className={styles.colGrid} x1={PAD.l} x2={w - PAD.r} y1={y(top * f)} y2={y(top * f)} />
                  <text className={styles.colAxis} x={PAD.l - 6} y={y(top * f) + 4} textAnchor="end">{valueText(top * f, unit)}</text>
                </g>
              ))}
              {threshold !== undefined ? <line className={styles.colRule} x1={PAD.l} x2={w - PAD.r} y1={y(threshold)} y2={y(threshold)} /> : null}
              {drawLimit ? <path className={styles.colLimit} d={path(limit!.series!)} /> : null}
              {measured.map((l) => <path key={l.signal.id} className={styles.colLine} data-i={present.indexOf(l)} d={path(l.signal.series!)} />)}
              {crossX !== null ? <line className={styles.colCross} data-mine={mine || undefined} x1={crossX} x2={crossX} y1={PAD.t} y2={PAD.t + ih} /> : null}
              {at !== null ? measured.map((l) => { const v = valAt(l.signal); return v === null ? null : <circle key={l.signal.id} className={styles.colDot} data-i={present.indexOf(l)} cx={x(at)} cy={y(v)} r={4} />; }) : null}
              <text className={styles.colAxis} x={PAD.l} y={H - 4}>{fmt(from)}</text>
              <text className={styles.colAxis} x={w - PAD.r} y={H - 4} textAnchor="end">{fmt(to)}</text>
            </svg>
          ) : null}
        {mine && crossX !== null ? (
          <div className={styles.sloTip} style={{ left: Math.min(Math.max(0, crossX + 8), Math.max(0, w - 200)), top: 6 }} role="status">
            <strong className={styles.upTipHead}>{fmt(at ?? cross!.ms)}</strong>
            {present.map((l, i) => <span key={l.signal.id} className={styles.colTipRow} data-i={i}><i aria-hidden="true" />{l.label} {l.signal.series ? (valAt(l.signal) === null ? "—" : text(l.signal, valAt(l.signal), at)) : t("obs.col.notMeasuredShort")}</span>)}
            {limit?.series ? <span className={styles.colTipRow} data-limit><i aria-hidden="true" />{limitLabel} {valueText(valAt(limit), limit.unit)}</span> : null}
          </div>
        ) : null}
      </div>
      {present.length > 1 || limit !== undefined || threshold !== undefined ? (
        <ul className={styles.colLegend}>
          {lines.map((l, i) => <li key={l.label} data-i={i} data-none={!l.signal?.series || undefined}><i aria-hidden="true" />{l.label}{l.signal?.series ? "" : ` (${t("obs.col.notMeasuredShort")})`}</li>)}
          {limit !== undefined ? <li data-limit data-none={!limit?.series || undefined}><i aria-hidden="true" />{limitLabel}{limit?.series ? "" : ` (${t("obs.col.notMeasuredShort")})`}</li> : null}
          {threshold !== undefined && ruleLabel ? <li data-rule><i aria-hidden="true" />{ruleLabel}</li> : null}
        </ul>
      ) : null}
    </figure>
  );
}
