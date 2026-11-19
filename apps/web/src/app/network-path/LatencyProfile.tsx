"use client";

// 네트워크 경로 › Analysis — the hop-to-hop latency profile (Datadog "Hop-to-hop latency graph"): one series, the average
// RTT per answering hop, so no legend (the title names it). Per hop the min–max over its probes as a thin bar; a silent
// stretch is a dashed line (the path goes on, nothing measured); the biggest added step is drawn heavier with its value.
// Hover a column: a crosshair and that hop's numbers.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { latencyProfile, msTicks, type PathView } from "@/lib/netPathView";
import s from "./styles.module.css";

export const ms = (v: number | null) => (v === null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

const PAD = { l: 52, r: 16, t: 28, b: 30 };
const CHART_H = 220;

export function LatencyProfile({ v, jump }: { v: PathView; jump: { ttl: number; ms: number } | null }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { points, top, ttls } = latencyProfile(v);
  const ticks = msTicks(top);
  const yTop = ticks[ticks.length - 1]!;
  const plotW = w - PAD.l - PAD.r, plotH = CHART_H - PAD.t - PAD.b;
  const col = plotW / Math.max(1, ttls);
  const x = (ttl: number) => PAD.l + (ttl - 0.5) * col;
  const y = (msv: number) => PAD.t + plotH - (msv / yTop) * plotH;
  const segs: { a: (typeof points)[number]; b: (typeof points)[number]; gap: boolean; big: boolean }[] = [];
  for (let i = 1; i < points.length; i++) segs.push({ a: points[i - 1]!, b: points[i]!, gap: points[i]!.ttl - points[i - 1]!.ttl > 1, big: jump?.ttl === points[i]!.ttl });
  const hp = hover === null ? null : v.hops.find((h) => h.ttl === hover) ?? null;
  const every = ttls > 24 ? 2 : 1;
  return (
    <figure className={s.chart} aria-label={t("np.chart.title")}>
      <figcaption className={s.chartHead}>
        <strong>{t("np.chart.title")}</strong>
        <span>{t("np.chart.sub")}</span>
      </figcaption>
      <div ref={box} className={s.chartBox} onMouseLeave={() => setHover(null)}>
        <svg width={w} height={CHART_H} data-chart="latency" role="img" aria-label={t("np.chart.aria", { n: points.length, top: ms(top) })}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line className={s.grid} x1={PAD.l} x2={w - PAD.r} y1={y(tk)} y2={y(tk)} />
              <text className={s.axis} x={PAD.l - 8} y={y(tk) + 4} textAnchor="end">{tk === 0 ? "0" : `${tk} ms`}</text>
            </g>
          ))}
          {v.hops.map((h) => (h.ttl % every === 0 || h.ttl === 1 || h.ttl === ttls ? (
            <text key={`x${h.ttl}`} className={s.axis} x={x(h.ttl)} y={CHART_H - 10} textAnchor="middle">{h.ttl}</text>
          ) : null))}
          {hp ? <line className={s.cross} x1={x(hp.ttl)} x2={x(hp.ttl)} y1={PAD.t - 8} y2={PAD.t + plotH} /> : null}
          {points.map((p) => <rect key={`r${p.ttl}`} className={s.range} x={x(p.ttl) - 3} width={6} y={y(p.max)} height={Math.max(2, y(p.min) - y(p.max))} rx={3} />)}
          {v.hops.filter((h) => h.verdict === "silent").map((h) => <text key={`s${h.ttl}`} className={s.silentMark} x={x(h.ttl)} y={PAD.t + plotH - 4} textAnchor="middle">*</text>)}
          {segs.map((g) => (
            <line key={`l${g.b.ttl}`} className={g.big ? s.lineBig : g.gap ? s.lineGap : s.line} x1={x(g.a.ttl)} y1={y(g.a.avg)} x2={x(g.b.ttl)} y2={y(g.b.avg)} />
          ))}
          {points.map((p) => (
            <circle key={`p${p.ttl}`} data-point data-verdict={p.verdict} className={s.point} cx={x(p.ttl)} cy={y(p.avg)} r={hover === p.ttl ? 6 : 4.5} />
          ))}
          {jump ? (() => {
            const p = points.find((q) => q.ttl === jump.ttl);
            if (!p) return null;
            const lx = Math.min(w - PAD.r - 60, Math.max(PAD.l + 4, x(p.ttl) - col / 2));
            return <text className={s.jumpLabel} x={lx} y={Math.max(PAD.t - 10, y(p.max) - 10)}>{`+${ms(jump.ms)}`}</text>;
          })() : null}
          {v.hops.map((h) => <rect key={`h${h.ttl}`} className={s.hit} x={PAD.l + (h.ttl - 1) * col} width={col} y={PAD.t - 8} height={plotH + 8} onMouseEnter={() => setHover(h.ttl)} />)}
        </svg>
        {hp ? (
          <div className={s.tip} style={{ left: Math.min(w - 220, Math.max(0, x(hp.ttl) + 12)), top: 8 }} role="status">
            <strong>{t("np.chart.hop", { n: hp.ttl })}</strong> <code>{hp.ip ?? "*"}</code>
            {hp.ip ? (
              <dl>
                <dt>{t("np.cell.rtt")}</dt><dd>{ms(hp.rttAvg)}</dd>
                <dt>{t("np.chart.range")}</dt><dd>{ms(hp.rttMin)} – {ms(hp.rttMax)}</dd>
                <dt>{t("np.cell.loss")}</dt><dd>{hp.lossPct}%</dd>
                <dt>{t("np.cell.added")}</dt><dd>{hp.addedMs === null ? "—" : `+${ms(hp.addedMs)}`}</dd>
              </dl>
            ) : <p>{t("np.why.silent")}</p>}
          </div>
        ) : null}
      </div>
    </figure>
  );
}
