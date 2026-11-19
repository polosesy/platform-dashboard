"use client";

// 수집 상태 › 수집기 신호 (2026-11-19) — each collector's own metrics over the page's range (API
// services/collectorTrends.ts): the four questions (처리량 · 오류 · 포화 · 자원) with the facts behind each, then one
// small chart per signal group — lines in a fixed colour order, a limit as a dashed ceiling, a rule as a dotted line,
// hover = the values at that time; a series the workspace does not have = "미측정" (never a flat 0). Then the scrape
// jobs: targets, down now, the share of scrapes that answered over the range (with its line), the slowest scrape.

import { useMemo, useState } from "react";
import type { CollectorRow, CollectorSignal, CollectorsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { chartsOf, jobState, limitOnAxis, niceMax, valueText, type ChartDef } from "@/lib/collectorView";
import { Cell, Chip, EmptyState, ErrorNotice, Grid, LoadingState, Notice, Panel, Select, type ChipLevel } from "@/components/ui";
import { useWidth } from "./UptimeBars";
import styles from "../styles.module.css";

const STATE: Record<"ok" | "warn" | "unknown" | "danger", ChipLevel> = { ok: "ok", warn: "warn", danger: "danger", unknown: "unknown" };

export function CollectorSignals({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const minutes = String(Math.max(30, Math.min(7 * 1440, range.span)));
  const q = useApiQuery(clusterId ? `obs-collectors:${clusterId}:${minutes}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<CollectorsResponse>(apiUrl("/api/observability/collectors", { clusterId, minutes, at: atQ }), token),
  );
  useRangeRefresh("collectors", nonce, q.loading, q.reload, report);
  const d = q.data?.clusterId === clusterId ? q.data : null;
  const [pick, setPick] = useState("");
  const lc = dateLocale(locale);
  const fmt = (ms: number) => new Date(ms).toLocaleString(lc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  const body = q.error ? <ErrorNotice error={q.error} />
    : !d ? <LoadingState />
    : d.metricsState !== "ok" ? <Notice tone="warning" title={t(`hb.m.state.${d.metricsState}`)}>{d.message ?? ""}</Notice>
    : !d.collectors.length ? <EmptyState title={t("obs.col.none")}>{t("obs.col.noneHint")}</EmptyState>
    : (() => {
      const key = (c: CollectorRow) => `${c.namespace ?? ""}/${c.name}`;
      const c = d.collectors.find((x) => key(x) === pick) ?? d.collectors[0]!;
      return (
        <div className={styles.colWrap} data-collectors>
          {d.gaps?.length ? <Notice tone="warning">{t("obs.col.gaps", { n: d.gaps.length })}</Notice> : null}
          <div className={styles.colHead}>
            <Select label={t("obs.col.pick")} value={key(c)} onChange={setPick}
              options={d.collectors.map((x) => ({ value: key(x), label: `${x.name}${x.namespace ? ` · ${x.namespace}` : ""} — ${x.pipelines.map((p) => t(`obs.col.pipe.${p}`)).join(" · ")}` }))} />
            <span className={styles.colMeta}>{t("obs.col.meta", { pods: c.pods.length, step: Math.round(d.stepSeconds / 60) })}</span>
          </div>
          <Grid>
            {c.verdicts.map((v) => (
              <Cell span={3} key={v.id}>
                <div className={styles.colVerdict} data-state={v.state}>
                  <span className={styles.colVerdictHead}>{t(`obs.col.v.${v.id}`)}<Chip level={STATE[v.state]}>{t(`obs.col.state.${v.state}`)}</Chip></span>
                  <span className={styles.colVerdictWhy}>
                    {v.reasons.length ? v.reasons.slice(0, 3).map((r) => t(`obs.col.why.${r.key}`, { v: whyValue(r.key, r.value, c.signals) })).join(" · ")
                      : v.state === "unknown" ? t("obs.col.whyUnknown") : t(`obs.col.whyOk.${v.id}`)}
                  </span>
                </div>
              </Cell>
            ))}
          </Grid>
          <div className={styles.colCharts}>
            {chartsOf(c).map(({ group, chart }) => (
              <SignalChart key={`${group}:${chart.id}`} def={chart} group={group} c={c} d={d} fmt={fmt} />
            ))}
          </div>
          <details className={styles.colQueries}>
            <summary>{t("obs.col.queries")}</summary>
            <ul>{Object.keys(c.signals).map((id) => <li key={id}><b>{t(`obs.col.sig.${id}`)}</b><code>{d.queries[id]}</code></li>)}</ul>
          </details>
        </div>
      );
    })();

  return (
    <>
      <Panel title={t("obs.col.title")} sub={d ? t("obs.col.sub", { from: fmt(Date.parse(d.from)), to: fmt(Date.parse(d.to)) }) : undefined}>{body}</Panel>
      {d && d.metricsState === "ok" && d.scrape.length ? <ScrapeJobs d={d} fmt={fmt} /> : null}
    </>
  );
}

/** The value a reason quotes, in its signal's unit */
function whyValue(key: string, v: number | null, s: Record<string, CollectorSignal>): string {
  if (v === null) return "—";
  if (key === "queue" || key === "memNear" || key === "cpuNear") return valueText(v, "ratio");
  if (key === "restarts" || key === "oom" || key === "rwShards") return valueText(v, "count");
  const base = key.replace(/Zero$/, "");
  const unit = s[key]?.unit ?? s[base]?.unit ?? (key.endsWith("Zero") ? "perSecond" : "count");
  return valueText(v, unit);
}

const H = 132, PAD = { l: 52, r: 10, t: 10, b: 20 };

function SignalChart({ def, group, c, d, fmt }: { def: ChartDef; group: string; c: CollectorRow; d: CollectorsResponse; fmt: (ms: number) => string }) {
  const { t } = useI18n();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const lines = def.lines.map((id) => c.signals[id]).filter((s): s is CollectorSignal => !!s);
  const limit = def.limit ? c.signals[def.limit] ?? null : null;
  const measured = lines.filter((s) => s.series);
  const unit = lines[0]?.unit ?? "count";
  const from = Date.parse(d.from), to = Date.parse(d.to);
  const dataMax = Math.max(0, ...measured.map((s) => s.max ?? 0));
  const drawLimit = !!limit?.series && limitOnAxis(dataMax, limit.max);
  const top = useMemo(() => niceMax(Math.max(dataMax, drawLimit ? limit?.max ?? 0 : 0, def.threshold ?? 0), unit), [dataMax, drawLimit, limit, def.threshold, unit]);
  const iw = Math.max(40, w - PAD.l - PAD.r), ih = H - PAD.t - PAD.b;
  const x = (ms: number) => PAD.l + ((ms - from) / Math.max(1, to - from)) * iw;
  const y = (v: number) => PAD.t + ih - (Math.max(0, v) / top) * ih;
  const path = (pts: Array<[number, number]>) => pts.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const times = measured[0]?.series?.map((p) => p[0]) ?? [];
  const at = hover === null ? null : times[hover] ?? null;
  const valAt = (s: CollectorSignal | null) => (at === null || !s?.series ? null : s.series.find((p) => p[0] === at)?.[1] ?? null);
  const promql = [...def.lines, ...(def.limit ? [def.limit] : [])].map((id) => d.queries[id]).filter(Boolean).join("\n");
  const failed = lines.some((s) => s.failed);
  return (
    <figure className={styles.colChart} data-chart={def.id}>
      <figcaption className={styles.colChartHead}>
        <span title={promql}>{t(`obs.col.chart.${def.id}`)}</span>
        <span className={styles.colChartNow}>
          {measured.map((s, i) => <span key={s.id} data-i={i}>{valueText(s.now, s.unit)}</span>)}
          {limit?.series ? <span data-limit title={drawLimit ? undefined : t("obs.col.limitOffAxis")}>{t("obs.col.limitOf", { v: valueText(limit.now, limit.unit) })}{drawLimit ? "" : " ↑"}</span>
            : def.limit && group === "resources" && measured.length ? <span data-limit>{t("obs.col.noLimit")}</span> : null}
        </span>
      </figcaption>
      <div ref={ref} className={styles.colPlot} onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          if (!times.length) return;
          const box = e.currentTarget.getBoundingClientRect();
          const ms = from + ((e.clientX - box.left - PAD.l) / iw) * (to - from);
          let best = 0;
          for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! - ms) < Math.abs(times[best]! - ms)) best = i;
          setHover(best);
        }}>
        {failed ? <p className={styles.colEmpty}>{t("obs.col.failed")}</p>
          : !measured.length ? <p className={styles.colEmpty}>{t("obs.col.notMeasured")}</p>
          : w > 0 ? (
            <svg width={w} height={H} role="img" aria-label={t(`obs.col.chart.${def.id}`)}>
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line className={styles.colGrid} x1={PAD.l} x2={w - PAD.r} y1={y(top * f)} y2={y(top * f)} />
                  <text className={styles.colAxis} x={PAD.l - 6} y={y(top * f) + 4} textAnchor="end">{valueText(top * f, unit)}</text>
                </g>
              ))}
              {def.threshold !== undefined ? <line className={styles.colRule} x1={PAD.l} x2={w - PAD.r} y1={y(def.threshold)} y2={y(def.threshold)} /> : null}
              {drawLimit ? <path className={styles.colLimit} d={path(limit!.series!)} /> : null}
              {measured.map((s) => <path key={s.id} className={styles.colLine} data-i={lines.indexOf(s)} d={path(s.series!)} />)}
              {at !== null ? <line className={styles.colCross} x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + ih} /> : null}
              <text className={styles.colAxis} x={PAD.l} y={H - 4}>{fmt(from)}</text>
              <text className={styles.colAxis} x={w - PAD.r} y={H - 4} textAnchor="end">{fmt(to)}</text>
            </svg>
          ) : null}
        {at !== null ? (
          <div className={styles.sloTip} style={{ left: Math.min(Math.max(0, x(at) + 8), Math.max(0, w - 200)), top: 6 }} role="status">
            <strong className={styles.upTipHead}>{fmt(at)}</strong>
            {lines.map((s) => <span key={s.id} className={styles.colTipRow} data-i={lines.indexOf(s)}><i aria-hidden="true" />{t(`obs.col.sig.${s.id}`)} {s.series ? valueText(valAt(s), s.unit) : t("obs.col.notMeasuredShort")}</span>)}
            {limit?.series ? <span className={styles.colTipRow} data-limit><i aria-hidden="true" />{t(`obs.col.sig.${limit.id}`)} {valueText(valAt(limit), limit.unit)}</span> : null}
          </div>
        ) : null}
      </div>
      {lines.length > 1 || limit || def.threshold !== undefined ? (
        <ul className={styles.colLegend}>
          {lines.map((s, i) => <li key={s.id} data-i={i} data-none={!s.series || undefined}><i aria-hidden="true" />{t(`obs.col.sig.${s.id}`)}{s.series ? "" : ` (${t("obs.col.notMeasuredShort")})`}</li>)}
          {def.limit ? <li data-limit data-none={!limit?.series || undefined}><i aria-hidden="true" />{t(`obs.col.sig.${def.limit}`)}{limit?.series ? "" : ` (${t("obs.col.notMeasuredShort")})`}</li> : null}
          {def.threshold !== undefined ? <li data-rule><i aria-hidden="true" />{t(`obs.col.rule.${def.id}`, { v: valueText(def.threshold, unit) })}</li> : null}
        </ul>
      ) : null}
    </figure>
  );
}

function ScrapeJobs({ d, fmt }: { d: CollectorsResponse; fmt: (ms: number) => string }) {
  const { t } = useI18n();
  const from = Date.parse(d.from), to = Date.parse(d.to);
  return (
    <Panel title={t("obs.col.jobs")} sub={t("obs.col.jobsSub", { n: d.scrape.length, from: fmt(from), to: fmt(to) })} flush>
      <div className={styles.sloTableWrap}>
        <table className={styles.sloTable}>
          <thead>
            <tr>
              <th scope="col">{t("obs.col.job.job")}</th>
              <th scope="col">{t("obs.col.job.targets")}</th>
              <th scope="col">{t("obs.col.job.down")}</th>
              <th scope="col">{t("obs.col.job.up")}</th>
              <th scope="col">{t("obs.col.job.line")}</th>
              <th scope="col">{t("obs.col.job.slowest")}</th>
              <th scope="col">{t("obs.col.job.samples")}</th>
            </tr>
          </thead>
          <tbody>
            {d.scrape.map((j) => {
              const st = jobState(j);
              return (
                <tr key={j.job}>
                  <td><span className={styles.sloCellMain}>{j.job}</span></td>
                  <td>{j.targets}</td>
                  <td>{j.down ? <Chip level="danger">{j.down}</Chip> : 0}</td>
                  <td><Chip level={STATE[st]}>{j.upRatio === null ? "—" : valueText(j.upRatio, "ratio")}</Chip></td>
                  <td><UpLine series={j.series} from={from} to={to} /></td>
                  <td>{valueText(j.durationMax, "seconds")}</td>
                  <td>{valueText(j.samples, "count")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** The share of a job's targets up over the range — 0 to 100 %, a dip is a target down */
function UpLine({ series, from, to }: { series: Array<[number, number]> | null; from: number; to: number }) {
  if (!series?.length) return <span className={styles.colMeta}>—</span>;
  const W = 120, Hh = 22;
  const d = series.map(([ms, v], i) => `${i ? "L" : "M"}${(((ms - from) / Math.max(1, to - from)) * W).toFixed(1)},${(2 + (1 - Math.max(0, Math.min(1, v))) * (Hh - 4)).toFixed(1)}`).join("");
  return <svg width={W} height={Hh} className={styles.colUp} aria-hidden="true"><path d={d} /></svg>;
}
