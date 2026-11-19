"use client";

// 네트워크 경로 › Analysis (Datadog "Hop-to-hop metric overview"): the end-to-end numbers of the picked runs, their
// series over every run of this device × target (latency · packet loss · jitter · hop count — one series per chart, one
// axis each, the picked range shaded), the hop-to-hop latency profile, the hop table (per address: traversals, latency,
// the TTL's loss, the latency it adds) — optionally against the previous range of the same length (common and unique
// hops, the difference) — and the runs themselves.

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetPathRun } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, EmptyState, LinkButton, Stat, Toggle } from "@/components/ui";
import { biggestJump, msTicks, pathView, samePath } from "@/lib/netPathView";
import {
  buildGraph, compareHops, edgeLabel, linkKind, mergedE2e, mergedHops, previousRange, routesOf, type GNode, type RunPoint,
} from "@/lib/netPathGraph";
import { LatencyProfile, ms } from "./LatencyProfile";
import s from "./styles.module.css";

type Metric = "latency" | "lossPct" | "jitter" | "hops";
const fmt: Record<Metric, (v: number | null) => string> = {
  latency: ms, jitter: ms, lossPct: (v) => (v === null ? "—" : `${v}%`), hops: (v) => (v === null ? "—" : String(v)),
};

export function AnalysisView({ all, picked, points, sel, canDelete, onDelete, onPick }: {
  all: NetPathRun[]; picked: NetPathRun[]; points: RunPoint[]; sel: [number, number];
  canDelete: boolean; onDelete: (id: string) => void; onPick: (from: number, to: number) => void;
}) {
  const { t, locale } = useI18n();
  const [compare, setCompare] = useState(false);
  const e2e = useMemo(() => mergedE2e(picked), [picked]);
  const merged = useMemo(() => mergedHops(picked), [picked]);
  const v = useMemo(() => pathView({ hops: merged, reached: picked.some((r) => r.reached), targetIp: picked[0]?.targetIp ?? null }), [merged, picked]);
  const jump = biggestJump(v);
  const g = useMemo(() => buildGraph(picked, { hideUnknown: false }), [picked]);
  const prevIds = useMemo(() => previousRange(points, sel[0], sel[1]), [points, sel]);
  const prev = useMemo(() => all.filter((r) => prevIds.includes(r.id)), [all, prevIds]);
  const gb = useMemo(() => (compare && prev.length ? buildGraph(prev, { hideUnknown: false }) : null), [compare, prev]);
  const rows = useMemo(() => (gb ? compareHops(g, gb) : compareHops(g, { ...g, nodes: [] }).map((r) => ({ ...r, only: null }))), [g, gb]);
  const reachable = picked.filter((r) => (r.e2e ? r.e2e.received > 0 : r.reached)).length;
  const routes = routesOf(picked);
  const lc = dateLocale(locale);
  const prevE2e = useMemo(() => (gb ? mergedE2e(prev) : null), [gb, prev]);
  const delta = (a: number | null | undefined, b: number | null | undefined, unit: string) => (a == null || b == null ? "" : ` (${a - b >= 0 ? "+" : ""}${Math.round((a - b) * 10) / 10}${unit})`);
  const edgesInto = useMemo(() => new Map(g.edges.map((e) => [e.to, e])), [g]);

  if (!picked.length) return <EmptyState title={t("np.an.none")} />;
  return (
    <div className={s.an}>
      <div className={s.anHead}>
        <Toggle checked={compare} onChange={setCompare} disabled={!prevIds.length} title={prevIds.length ? undefined : t("np.an.noPrev")}>
          {t("np.an.compare", { n: prevIds.length })}
        </Toggle>
        <span className={s.muted}>{t(e2e ? (e2e.protocol === "tcp" ? "np.an.basisTcp" : "np.an.basisIcmp") : "np.an.basisHop", { p: e2e?.port ?? 443, n: e2e?.sent ?? 0 })}</span>
      </div>
      <div className={s.stats}>
        <Stat label={t("np.an.latency")} value={ms(e2e ? e2e.rttAvg : v.end.rttAvg)} hint={e2e ? `${ms(e2e.rttMin)} – ${ms(e2e.rttMax)}${delta(e2e.rttAvg, prevE2e?.rttAvg, " ms")}` : t("np.an.icmpOnly")} />
        <Stat label={t("np.an.loss")} value={e2e ? `${e2e.lossPct}%` : v.end.lossPct === null ? "—" : `${v.end.lossPct}%`} hint={e2e ? t("np.an.lossHint", { r: e2e.received, s: e2e.sent }) + delta(e2e.lossPct, prevE2e?.lossPct, "%p") : t("np.an.icmpOnly")} />
        <Stat label={t("np.an.jitter")} value={ms(e2e?.jitter ?? null)} hint={e2e ? t("np.an.jitterHint") : t("np.an.noE2e")} />
        <Stat label={t("np.an.reach")} value={`${reachable}/${picked.length}`} hint={t("np.an.reachHint")} />
        <Stat label={t("np.stat.hops")} value={v.end.hops} hint={t("np.stat.hopsHint", { n: v.silent })} />
        <Stat label={t("np.an.routes")} value={routes} hint={routes > 1 ? t("np.an.routesMany", { n: g.passes }) : t("np.an.routesOne", { n: g.passes })} />
      </div>

      <section aria-label={t("np.an.seriesTitle")}>
        <h3 className={s.anH}>{t("np.an.seriesTitle")} <span>{t("np.an.seriesSub", { n: points.length })}</span></h3>
        <div className={s.anGrid}>
          {(["latency", "lossPct", "jitter", "hops"] as const).map((m) => <MiniSeries key={m} metric={m} points={points} sel={sel} onPick={onPick} />)}
        </div>
      </section>

      <LatencyProfile v={v} jump={jump} />

      <section aria-label={t("np.an.hopsTitle")}>
        <h3 className={s.anH}>{t("np.an.hopsTitle")} <span>{gb ? t("np.an.hopsCompare", { a: picked.length, b: prev.length }) : t("np.an.hopsSub", { n: g.passes })}</span></h3>
        <div className={s.tableWrap}>
          <table className={s.table} data-hop-table>
            <thead><tr>
              <th className={s.num}>TTL</th><th>{t("np.an.col.hop")}</th><th>AS</th>
              <th className={s.num}>{t("np.an.col.traversed")}</th><th className={s.num}>{t("np.cell.rtt")}</th><th className={s.num}>{t("np.chart.range")}</th>
              <th className={s.num}>{t("np.an.col.ttlLoss")}</th><th className={s.num}>{t("np.cell.added")}</th>
              {gb ? <><th className={s.num}>{t("np.an.col.prev")}</th><th className={s.num}>{t("np.an.col.delta")}</th><th>{t("np.an.col.change")}</th></> : null}
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const n = (r.a ?? r.b)! as GNode;
                const into = r.a ? edgesInto.get(r.a.id) : undefined;
                return (
                  <tr key={`${r.ttl}|${n.id}`} data-only={r.only ?? undefined} data-kind={n.kind}>
                    <td className={s.num}>{n.kind === "dest" ? `${n.ttl} ◎` : n.ttl}</td>
                    <td>{n.kind === "unknown" ? <span className={s.sub}>{t("np.pv.unknownHop", { n: n.ttl })}</span> : <><code>{n.ip ?? "—"}</code>{n.info?.name ? <span className={s.sub}>{n.info.name}</span> : null}</>}</td>
                    <td>{n.info?.asn ? <span title={n.info.asName ?? undefined}>AS{n.info.asn}</span> : <span className={s.sub}>{n.scope ? t(`np.scope.${n.scope}`) : "—"}</span>}</td>
                    <td className={s.num}>{r.a ? `${r.a.traversed}/${g.passes}` : "—"}</td>
                    <td className={s.num}>{ms(r.a?.rttAvg ?? null)}</td>
                    <td className={s.num}>{r.a && r.a.rttMin !== null ? `${ms(r.a.rttMin)} – ${ms(r.a.rttMax)}` : "—"}</td>
                    <td className={s.num} data-hot={(r.a?.verdict === "pathLoss" || r.a?.verdict === "destLoss") || undefined}>{r.a?.ttlLossPct == null ? "—" : `${r.a.ttlLossPct}%`}</td>
                    <td className={s.num}>{into ? edgeLabel(into) ?? "—" : "—"}</td>
                    {gb ? (
                      <>
                        <td className={s.num}>{ms(r.b?.rttAvg ?? null)}</td>
                        <td className={s.num}>{r.deltaMs === null ? "—" : r.deltaMs >= 0 ? `+${ms(r.deltaMs)}` : `−${ms(-r.deltaMs)}`}</td>
                        <td>{r.only === "a" ? <Badge tone="info">{t("np.an.new")}</Badge> : r.only === "b" ? <Badge tone="neutral">{t("np.an.gone")}</Badge> : <span className={s.sub}>{t("np.an.common")}</span>}</td>
                      </>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label={t("np.an.runsTitle")}>
        <h3 className={s.anH}>{t("np.an.runsTitle")} <span>{t("np.an.runsSub", { n: picked.length })}</span></h3>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr>
              <th>{t("np.col.when")}</th><th className={s.num}>{t("np.an.latency")}</th><th className={s.num}>{t("np.cell.loss")}</th><th className={s.num}>{t("np.an.jitter")}</th>
              <th className={s.num}>{t("np.col.hops")}</th><th>{t("np.col.path")}</th><th>{t("np.an.col.link")}</th>{canDelete ? <th /> : null}
            </tr></thead>
            <tbody>
              {[...picked].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map((r) => {
                const p = points.find((x) => x.id === r.id)!;
                const i = all.findIndex((x) => x.id === r.id);
                const before = all.slice(i + 1).find((x) => x.target === r.target && x.device === r.device);
                return (
                  <tr key={r.id}>
                    <td><LinkButton onClick={() => onPick(p.at, p.at)}>{new Date(r.startedAt).toLocaleString(lc)}</LinkButton></td>
                    <td className={s.num}>{p.reachable ? ms(p.latency) : t("np.unreached")}</td>
                    <td className={s.num}>{p.lossPct === null ? "—" : `${p.lossPct}%`}</td>
                    <td className={s.num}>{ms(p.jitter)}</td>
                    <td className={s.num}>{p.hops}</td>
                    <td><span className={s.sub}>{before ? (samePath(r, before) ? t("np.path.same") : t("np.path.changed")) : "—"}</span></td>
                    <td><span className={s.sub}>{r.link ? t("np.an.link", { k: t(`np.link.${linkKind(r.link.type) ?? "other"}`), m: r.link.mbps ?? "—" }) : "—"}</span></td>
                    {canDelete ? <td><Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>{t("np.delete")}</Button></td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const MH = 120, MP = { l: 44, r: 8, t: 10, b: 20 };

/** One metric over the runs (one series, one axis) — the picked range shaded; hover shows the run, click picks it */
function MiniSeries({ metric, points, sel, onPick }: { metric: Metric; points: RunPoint[]; sel: [number, number]; onPick: (from: number, to: number) => void }) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vals = points.map((p) => (metric === "hops" ? p.hops : p[metric]));
  const got = vals.filter((x): x is number => x !== null);
  const ticks = msTicks(Math.max(metric === "lossPct" ? 1 : 1, ...got));
  const top = ticks[ticks.length - 1]!;
  const t0 = points[0]?.at ?? 0, span = Math.max(1, (points[points.length - 1]?.at ?? 0) - t0);
  const plotW = w - MP.l - MP.r, plotH = MH - MP.t - MP.b;
  const x = (at: number) => (points.length === 1 ? MP.l + plotW / 2 : MP.l + ((at - t0) / span) * plotW);
  const y = (v: number) => MP.t + plotH - (v / top) * plotH;
  const path = points.map((p, i) => (vals[i] === null ? null : `${x(p.at)},${y(vals[i]!)}`));
  const segs: string[] = [];
  let cur: string[] = [];
  for (const pt of path) { if (pt) cur.push(pt); else if (cur.length) { segs.push(cur.join(" ")); cur = []; } }
  if (cur.length) segs.push(cur.join(" "));
  const sx0 = x(sel[0]) - 4, sx1 = x(sel[1]) + 4;
  const hp = hover === null ? null : points[hover] ?? null;
  const near = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.at) - (clientX - r.left)) < Math.abs(x(points[best]!.at) - (clientX - r.left))) best = i; });
    return best;
  };
  const label = t(`np.an.m.${metric}`);
  return (
    <figure className={s.mini}>
      <figcaption>{label}</figcaption>
      <div ref={box} className={s.chartBox} onMouseLeave={() => setHover(null)}>
        <svg width={w} height={MH} role="img" aria-label={t("np.an.miniAria", { m: label, n: got.length })} data-mini={metric}
          onMouseMove={(e) => setHover(near(e.clientX))} onClick={(e) => { const p = points[near(e.clientX)]; if (p) onPick(p.at, p.at); }}>
          <rect className={s.miniSel} x={sx0} width={Math.max(8, sx1 - sx0)} y={MP.t} height={plotH} />
          {ticks.filter((_, i) => i === 0 || i === ticks.length - 1 || ticks.length <= 4).map((tk) => (
            <g key={tk}>
              <line className={s.grid} x1={MP.l} x2={w - MP.r} y1={y(tk)} y2={y(tk)} />
              <text className={s.axis} x={MP.l - 6} y={y(tk) + 4} textAnchor="end">{fmt[metric](tk)}</text>
            </g>
          ))}
          {segs.map((pts, i) => <polyline key={i} className={s.miniLine} points={pts} />)}
          {points.map((p, i) => (vals[i] === null ? null : <circle key={p.id} className={s.miniDot} cx={x(p.at)} cy={y(vals[i]!)} r={hover === i ? 4.5 : points.length > 40 ? 0 : 2.5} />))}
          {hp ? <line className={s.cross} x1={x(hp.at)} x2={x(hp.at)} y1={MP.t} y2={MP.t + plotH} /> : null}
        </svg>
        {hp ? (
          <div className={s.tip} style={{ left: Math.min(w - 216, Math.max(0, x(hp.at) + 10)), top: 4 }} role="status">
            <strong>{new Date(hp.at).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</strong>
            <dl><dt>{label}</dt><dd>{fmt[metric](vals[hover!] ?? null)}</dd></dl>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
