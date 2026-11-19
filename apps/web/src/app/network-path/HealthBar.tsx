"use client";

// 네트워크 경로 — the health bar (Datadog's latency / reachability strip under the path): one mark per run of this
// device × target on a time axis — the reachability row coloured by a fact (■ not reachable · ▲ loss · ● fine), the
// latency row a bar as tall as the run's end-to-end latency. Pick the runs the path and the analysis aggregate: click a
// run, drag across runs, Shift+click to extend; ← / → move, Shift+← / → extend, Home / End.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { dateLocale, useI18n } from "@/lib/i18n";
import { pointLevel, type RunPoint } from "@/lib/netPathGraph";
import { ms } from "./LatencyProfile";
import s from "./styles.module.css";

const PAD_X = 12;
const H = 76;
const LAT_TOP = 6, LAT_H = 28, REACH_Y = 40, REACH_H = 10, AXIS_Y = H - 8;

export function HealthBar({ points, sel, onSel }: { points: RunPoint[]; sel: [number, number]; onSel: (from: number, to: number) => void }) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!points.length) return null;
  const t0 = points[0]!.at, t1 = points[points.length - 1]!.at;
  const span = Math.max(1, t1 - t0);
  const x = (at: number) => (points.length === 1 ? w / 2 : PAD_X + ((at - t0) / span) * (w - 2 * PAD_X));
  // a mark's width: the gap to its neighbours, 3–14 px
  const mark = Math.max(3, Math.min(14, points.length > 1 ? ((w - 2 * PAD_X) / points.length) * 0.6 : 14));
  const top = Math.max(1, ...points.map((p) => p.latency ?? 0));
  const nearest = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = clientX - r.left;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.at) - px) < Math.abs(x(points[best]!.at) - px)) best = i; });
    return best;
  };
  const idx = (at: number) => points.findIndex((p) => p.at === at);
  const i0 = Math.max(0, idx(sel[0])), i1 = Math.max(i0, idx(sel[1]));
  const pick = (a: number, b: number) => { const lo = Math.min(a, b), hi = Math.max(a, b); onSel(points[lo]!.at, points[hi]!.at); };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    const i = nearest(e.clientX);
    if (e.shiftKey) { pick(i0 === i1 ? i0 : i < i0 ? i1 : i0, i); return; }
    drag.current = i;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pick(i, i);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const i = nearest(e.clientX);
    setHover(i);
    if (drag.current !== null) pick(drag.current, i);
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const last = points.length - 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = e.key === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) pick(i0, Math.min(last, Math.max(0, i1 + d)));
      else { const i = Math.min(last, Math.max(0, i0 + d)); pick(i, i); }
      e.preventDefault();
    } else if (e.key === "Home") { pick(0, e.shiftKey ? i1 : 0); e.preventDefault(); }
    else if (e.key === "End") { pick(e.shiftKey ? i0 : last, last); e.preventDefault(); }
  };
  const fmt = (at: number) => new Date(at).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const ticks = points.length === 1 ? [t0] : [t0, t0 + span / 2, t1];
  const hp = hover === null ? null : points[hover] ?? null;
  const selLeft = x(points[i0]!.at) - mark / 2 - 3, selRight = x(points[i1]!.at) + mark / 2 + 3;
  const desc = i0 === i1 ? t("np.hb.selOne", { at: fmt(points[i0]!.at) }) : t("np.hb.selRange", { n: i1 - i0 + 1, a: fmt(points[i0]!.at), b: fmt(points[i1]!.at) });
  return (
    <div className={s.hb}>
      {/* the latency bars' scale: the tallest bar is this value (one run = a full bar — say how much it is) */}
      <div className={s.hbLabels} aria-hidden="true">
        <span>{t("np.hb.latency")}<small>{t("np.hb.top", { v: ms(top) })}</small></span>
        <span>{t("np.hb.reach")}</span>
      </div>
      <div ref={box} className={s.hbBox} onPointerLeave={() => setHover(null)}>
        <svg width={w} height={H} role="slider" tabIndex={0} aria-label={t("np.hb.aria")} aria-valuemin={1} aria-valuemax={points.length} aria-valuenow={i1 + 1} aria-valuetext={desc}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onKeyDown={key} data-health-bar>
          <rect className={s.hbSel} x={selLeft} width={Math.max(6, selRight - selLeft)} y={1} height={REACH_Y + REACH_H + 4} rx={4} />
          {points.map((p, i) => {
            const cx = x(p.at);
            const lh = p.latency === null ? 0 : Math.max(2, (p.latency / top) * LAT_H);
            const on = i >= i0 && i <= i1;
            return (
              <g key={p.id} data-run={p.id} data-on={on || undefined}>
                {p.latency === null
                  ? <line className={s.hbNoLat} x1={cx} x2={cx} y1={LAT_TOP + LAT_H - 6} y2={LAT_TOP + LAT_H} />
                  : <rect className={s.hbLat} x={cx - mark / 2} width={mark} y={LAT_TOP + LAT_H - lh} height={lh} rx={Math.min(3, mark / 2)} />}
                <rect className={s.hbReach} data-level={pointLevel(p)} x={cx - mark / 2} width={mark} y={REACH_Y} height={REACH_H} rx={2} />
              </g>
            );
          })}
          <line className={s.hbHandle} x1={selLeft} x2={selLeft} y1={1} y2={REACH_Y + REACH_H + 5} />
          <line className={s.hbHandle} x1={selRight} x2={selRight} y1={1} y2={REACH_Y + REACH_H + 5} />
          {ticks.map((tk, i) => (
            <text key={i} className={s.axis} x={points.length === 1 ? w / 2 : x(tk)} y={AXIS_Y} textAnchor={points.length === 1 ? "middle" : i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>{fmt(tk)}</text>
          ))}
        </svg>
        {hp ? (
          // below the bar: above it the tooltip was cut by the box (only its shadow showed — 2026-11-19)
          <div className={s.tip} style={{ left: Math.min(w - 216, Math.max(0, x(hp.at) + 10)), top: H + 2 }} role="status">
            <strong>{fmt(hp.at)}</strong>
            <dl>
              <dt>{t("np.hb.latency")}</dt><dd>{ms(hp.latency)}</dd>
              <dt>{t("np.cell.loss")}</dt><dd>{hp.lossPct === null ? "—" : `${hp.lossPct}%`}</dd>
              <dt>{t("np.an.jitter")}</dt><dd>{ms(hp.jitter)}</dd>
              <dt>{t("np.col.hops")}</dt><dd>{hp.hops}</dd>
            </dl>
            <p>{t(hp.reachable ? `np.hb.ok.${hp.basis}` : `np.hb.no.${hp.basis}`)}</p>
          </div>
        ) : null}
      </div>
      <p className={s.hbDesc} aria-live="polite">{desc}</p>
      {points.length === 1 ? <p className={s.hbDesc}>{t("np.hb.single")}</p> : null}
    </div>
  );
}
