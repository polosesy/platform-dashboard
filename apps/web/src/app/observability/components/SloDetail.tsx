"use client";

// SLO › 서비스 상세 — Datadog's suite SLO page for one service (docs.datadoghq.com/synthetics/test_suites): the SLO over
// its window and the error budget left; the SLI per bucket against the target; the global uptime bar (one segment per
// bucket — ok · error (the bucket's SLI under the target) · no data); the primary contributors (the endpoints whose
// failed requests spent the budget, with their share). API services/sloUptime.ts; numbers: lib/sloUptimeView.ts.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SloUptimeResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { budgetLeft, sliTicks, topShare, uptimeSegments, tickDecimals, tipLeft } from "@/lib/sloUptimeView";
import { Button, Chip, ErrorNotice, LoadingState, Notice, Panel } from "@/components/ui";
import styles from "../styles.module.css";

const pct = (v: number | null, d = 3) => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);

export function SloDetail({ clusterId, namespace, application, range, onClose, onSettings }: {
  clusterId: string; namespace: string; application: string; range: TimeRange; onClose: () => void; onSettings: () => void;
}) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const q = useApiQuery(`obs-slo-uptime:${clusterId}:${namespace}/${application}:${atQ ?? "now"}`, (token) =>
    fetchJsonWithBearer<SloUptimeResponse>(apiUrl("/api/observability/slo/uptime", { clusterId, namespace, application, at: atQ }), token),
  );
  const d = q.data?.namespace === namespace && q.data?.application === application ? q.data : null;
  const lc = dateLocale(locale);
  const fmt = (ms: number) => new Date(ms).toLocaleString(lc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const name = application || t("ob.slo.noAppName");
  return (
    <Panel title={<span>{name} <span className={styles.sloUdNs}>{namespace}</span></span>} sub={t("ob.slo.ud.sub")}
      actions={<><Button size="sm" variant="ghost" onClick={onSettings}>{t("ob.slo.ud.settings")}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t("ob.slo.ud.close")}</Button></>}>
      {q.error ? <ErrorNotice error={q.error} /> : !d ? <LoadingState /> : d.metricsState !== "ok" ? (
        <Notice tone="warning" title={t(`hb.m.state.${d.metricsState}`)}>{d.message ?? ""}</Notice>
      ) : (
        <div className={styles.sloUd} data-slo-detail>
          <div className={styles.sloUdTop}>
            <section className={styles.sloUdCard} aria-label={t("ob.slo.ud.slo")}>
              <h3>{t("ob.slo.ud.slo")} <Chip level="neutral" glyph={false} title={t(`ob.slo.ud.windowSrc.${d.windowSource}`)}>{t("ob.slo.ud.window", { n: d.windowDays })}</Chip></h3>
              <div className={styles.sloUdHead}>
                <span className={styles.sloUdSli} data-level={d.totals.sli === null ? "none" : d.totals.sli >= d.target ? "ok" : "danger"}>{pct(d.totals.sli)}</span>
                <span className={styles.sloUdBudget}>
                  <span>{t("ob.slo.ud.budgetLeft")}</span>
                  <span className={styles.sloUdBar} aria-hidden="true"><span style={{ width: `${(budgetLeft(d.totals) ?? 0) * 100}%` }} data-low={(budgetLeft(d.totals) ?? 1) < 0.25 || undefined} /></span>
                  <strong>{budgetLeft(d.totals) === null ? "—" : `${Math.round(budgetLeft(d.totals)! * 100)}%`}</strong>
                </span>
              </div>
              <p className={styles.sloText}>{t("ob.slo.ud.target", { target: pct(d.target, 2), src: t(`ob.slo.set.src.${d.targetSource}`), bad: d.totals.bad.toLocaleString(), total: d.totals.total.toLocaleString(), allowed: Math.round(d.totals.allowed).toLocaleString() })}</p>
              <SliChart d={d} fmt={fmt} />
            </section>
            <section className={styles.sloUdCard} aria-label={t("ob.slo.ud.contrib")}>
              <h3>{t("ob.slo.ud.contrib")}</h3>
              <div className={styles.sloUdStats}>
                <div><span>{t("ob.slo.ud.endpoints")}</span><strong>{d.only.length ? d.only.length : t("ob.slo.ud.allEndpoints")}</strong></div>
                <div><span>{t("ob.slo.ud.consumedBy")}</span><strong>{t("ob.slo.ud.consumedByN", { n: d.consumedBy })}</strong></div>
              </div>
              {d.contributors.length ? (
                <>
                  <p className={styles.sloUdCaption}>{t("ob.slo.ud.top", { n: Math.min(3, d.contributors.length), p: Math.round(topShare(d.contributors, 3) * 1000) / 10 })}</p>
                  <ul className={styles.sloContrib}>
                    {d.contributors.map((c) => (
                      <li key={`${c.method} ${c.uri}`}>
                        <span className={styles.sloContribShare}>{(c.share * 100).toFixed(1)}%</span>
                        <span className={styles.sloContribName} title={`${c.method} ${c.uri}`}><code>{c.method} {c.uri}</code></span>
                        <span className={styles.sloContribN}>{t("ob.slo.ud.failedOf", { bad: c.bad.toLocaleString(), total: c.total.toLocaleString() })}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : <p className={styles.sloText}>{t("ob.slo.ud.noFailed")}</p>}
              <p className={styles.sloUdCaption}>
                {d.only.length ? t("ob.slo.ud.onlyList", { list: d.only.join(", ") }) : t("ob.slo.ud.onlyNone")}
                {d.excluded.length ? ` · ${t("ob.slo.ud.excludedList", { list: d.excluded.join(", ") })}` : ""}
                {d.reset ? ` · ${t("ob.slo.ud.resetFrom", { at: fmt(Date.parse(d.reset.at)) })}` : ""}
              </p>
            </section>
          </div>
          <UptimeBar d={d} fmt={fmt} />
        </div>
      )}
    </Panel>
  );
}

/** The SLI per bucket against the target (one series, one axis, the target as a reference line) */
function SliChart({ d, fmt }: { d: SloUptimeResponse; fmt: (ms: number) => string }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 150, pad = { l: 48, r: 8, t: 8, b: 20 };
  const { lo, ticks } = sliTicks(d.buckets, d.target);
  const dec = tickDecimals(ticks);
  const n = d.buckets.length;
  const x = (i: number) => pad.l + ((i + 0.5) / Math.max(1, n)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (1 - lo)) * (H - pad.t - pad.b);
  const pts = d.buckets.map((b, i) => (b.sli === null ? null : `${x(i).toFixed(1)},${y(Math.max(lo, b.sli)).toFixed(1)}`));
  const segs: string[] = []; let cur: string[] = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur.join(" ")); cur = []; } }
  if (cur.length) segs.push(cur.join(" "));
  const hb = hover === null ? null : d.buckets[hover] ?? null;
  return (
    <figure className={styles.sloChart} aria-label={t("ob.slo.ud.chart")}>
      <div ref={box} className={styles.sloChartBox} onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => { const r = box.current!.getBoundingClientRect(); const i = Math.floor(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * n); setHover(i >= 0 && i < n ? i : null); }}>
        <svg width={w} height={H} role="img" aria-label={t("ob.slo.ud.chart")} data-sli-chart>
          {ticks.map((tk) => (
            <g key={tk}>
              <line className={styles.sloChartGrid} x1={pad.l} x2={w - pad.r} y1={y(tk)} y2={y(tk)} />
              <text className={styles.sloChartAxis} x={pad.l - 6} y={y(tk) + 4} textAnchor="end">{`${(tk * 100).toFixed(dec)}%`}</text>
            </g>
          ))}
          <line className={styles.sloChartTarget} x1={pad.l} x2={w - pad.r} y1={y(d.target)} y2={y(d.target)} />
          <text className={styles.sloChartAxis} x={w - pad.r} y={y(d.target) - 4 < pad.t + 12 ? y(d.target) + 14 : y(d.target) - 4} textAnchor="end">{t("ob.slo.ud.targetLine", { v: `${(d.target * 100).toFixed(2)}%` })}</text>
          {segs.map((s, i) => <polyline key={i} className={styles.sloChartLine} points={s} />)}
          {hb && hover !== null ? <line className={styles.sloChartCross} x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} /> : null}
          <text className={styles.sloChartAxis} x={pad.l} y={H - 4}>{fmt(Date.parse(d.from))}</text>
          <text className={styles.sloChartAxis} x={w - pad.r} y={H - 4} textAnchor="end">{fmt(Date.parse(d.to))}</text>
        </svg>
        {hb ? <div className={styles.sloTip} style={{ left: Math.min(w - 220, Math.max(0, x(hover!) + 8)), top: 4 }} role="status">{bucketText(t, hb, d.bucketMinutes, fmt)}</div> : null}
      </div>
    </figure>
  );
}

const bucketText = (t: (k: string, v?: Record<string, string | number>) => string, b: SloUptimeResponse["buckets"][number], minutes: number, fmt: (ms: number) => string) =>
  `${fmt(b.t - minutes * 60_000)} – ${fmt(b.t)} · ${b.state === "noData" ? t("ob.slo.ud.noData") : t("ob.slo.ud.bucket", { sli: `${((b.sli ?? 0) * 100).toFixed(2)}%`, bad: Math.round(b.bad), total: Math.round(b.total) })}`;

/** Datadog's Global Uptime: one segment per bucket — ok · error · no data — over the window */
function UptimeBar({ d, fmt }: { d: SloUptimeResponse; fmt: (ms: number) => string }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const segs = uptimeSegments(d.buckets);
  const hb = hover === null ? null : d.buckets[hover] ?? null;
  const n = d.buckets.length;
  const barRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  // the tip stays inside the bar (a narrow screen clipped it): centred on the segment, pushed in at either end
  useLayoutEffect(() => {
    if (hover === null || !barRef.current || !tipRef.current) return;
    const barW = barRef.current.clientWidth;
    setLeft(tipLeft(((hover + 0.5) / n) * barW, tipRef.current.offsetWidth, barW));
  }, [hover, n]);
  return (
    <section className={styles.sloUptime} aria-label={t("ob.slo.ud.uptime")}>
      <div className={styles.sloUptimeHead}>
        <h3>{t("ob.slo.ud.uptime")}</h3>
        <span>{t("ob.slo.ud.uptimeSum", { p: d.totals.uptime === null ? "—" : `${(d.totals.uptime * 100).toFixed(1)}%`, ok: segs.ok, err: segs.error, none: segs.noData, m: d.bucketMinutes >= 60 ? t("ob.slo.ud.hours", { n: d.bucketMinutes / 60 }) : t("ob.slo.ud.minutes", { n: d.bucketMinutes }) })}</span>
      </div>
      <div className={styles.sloUptimeRow}>
        <span className={styles.sloUptimeLabel}>{t("ob.slo.ud.global")}</span>
        <div ref={barRef} className={styles.sloUptimeBar} data-uptime-bar onPointerLeave={() => setHover(null)}>
          {d.buckets.map((b, i) => (
            <span key={b.t} className={styles.sloUptimeSeg} data-state={b.state} style={{ width: `${100 / n}%` }} onPointerEnter={() => setHover(i)} />
          ))}
          {hb ? <div ref={tipRef} className={styles.sloTip} style={{ left, top: 34, maxWidth: "100%" }} role="status">{bucketText(t, hb, d.bucketMinutes, fmt)}</div> : null}
        </div>
      </div>
      <div className={styles.sloUptimeAxis}><span>{fmt(Date.parse(d.from))}</span><span>{fmt(Date.parse(d.to))}</span></div>
      <ul className={styles.sloUptimeLegend}>
        {(["noData", "ok", "error"] as const).map((k) => <li key={k}><span className={styles.sloUptimeSeg} data-state={k} aria-hidden="true" />{t(`ob.slo.ud.state.${k}`)}</li>)}
        <li>{t("ob.slo.ud.rule")}</li>
      </ul>
    </section>
  );
}
