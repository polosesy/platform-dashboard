"use client";

// 수집 상태 › 수집기 신호 (2026-11-19) — each collector's own metrics over the page's range (API
// services/collectorTrends.ts): the four questions (처리량 · 오류 · 포화 · 자원) with the facts behind each, then one
// small chart per signal group — lines in a fixed colour order, a limit as a dashed ceiling, a rule as a dotted line,
// hover = the values at that time; a series the workspace does not have = "미측정" (never a flat 0). Then the scrape
// jobs: targets, down now, the share of scrapes that answered over the range (with its line), the slowest scrape.

import { useState } from "react";
import type { CollectorRow, CollectorSignal, CollectorsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { chartsOf, jobState, valueText, type ChartDef } from "@/lib/collectorView";
import { Cell, Chip, EmptyState, ErrorNotice, Grid, LoadingState, Notice, Panel, Select, type ChipLevel } from "@/components/ui";
import { MetricChart } from "./MetricChart";
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

function SignalChart({ def, group, c, d, fmt }: { def: ChartDef; group: string; c: CollectorRow; d: CollectorsResponse; fmt: (ms: number) => string }) {
  const { t } = useI18n();
  const ids = [...def.lines, ...(def.limit ? [def.limit] : [])];
  return (
    <MetricChart id={def.id} title={t(`obs.col.chart.${def.id}`)} promql={ids.map((id) => d.queries[id]).filter(Boolean).join("\n")}
      lines={def.lines.map((id) => ({ signal: c.signals[id], label: t(`obs.col.sig.${id}`) })).filter((l) => l.signal)}
      limit={def.limit ? c.signals[def.limit] ?? null : undefined} limitLabel={def.limit ? t(`obs.col.sig.${def.limit}`) : undefined}
      threshold={def.threshold} ruleLabel={def.threshold !== undefined ? t(`obs.col.rule.${def.id}`, { v: valueText(def.threshold, c.signals[def.lines[0]!]?.unit ?? "count") }) : undefined}
      noLimitText={def.limit && group === "resources" ? t("obs.col.noLimit") : undefined}
      from={Date.parse(d.from)} to={Date.parse(d.to)} fmt={fmt} />
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
