"use client";

// AKS 모니터링 › 로그 › 로그 지표 — the namespace's logs as numbers before any line is read (the customer's
// "Error & Exception Explorer" as a panel): ERROR · WARN lines, workloads with errors, exception classes, ERROR lines
// over time, and workload × exception class — counted by the cluster's Loki (API services/lokiLogs.ts getLogInsights;
// operators, namespaces this connection may read logs of). A value Loki did not answer is '—' and named, never 0.
// A workload row filters the panel to it and opens one of its pods in the viewer below.

import { useState } from "react";
import type { LogInsightsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Cell, Chip, EmptyState, ErrorNotice, FilterChip, Grid, LinkButton, LoadingState, Notice, Panel, Stat } from "@/components/ui";
import { WORKLOAD_LOG_WINDOWS, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { peakBucket, shareOf, timelineBars } from "@/lib/logInsightsView";
import styles from "../styles.module.css";

export function LogInsights({ clusterId, namespace, range, nonce, onPickWorkload }: {
  clusterId: string; namespace: string; range: TimeRange; nonce: number;
  /** A workload was picked — the viewer opens one of its pods */
  onPickWorkload?: (workload: string) => void;
}) {
  const { t, locale } = useI18n();
  const [workload, setWorkload] = useState("");
  const win = fitWindow(range, WORKLOAD_LOG_WINDOWS);
  const at = atParam(range);
  const q = useApiQuery(clusterId && namespace ? `log-insights:${clusterId}:${namespace}:${workload}:${win.value}:${at ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<LogInsightsResponse>(apiUrl("/api/observability/log-insights", { clusterId, namespace, workload: workload || undefined, minutes: String(win.value), at }), token),
  );
  useRangeRefresh("logInsights", nonce, q.loading, q.reload);
  const d = q.data ?? null;
  const title = t("ob.li.title");
  const sub = t("ob.li.sub", { ns: namespace, n: win.value });

  if (q.error) return <Panel title={title} sub={sub}><ErrorNotice error={q.error} /></Panel>;
  if (!d) return <Panel title={title} sub={sub}><LoadingState label={t("ob.li.loading")} /></Panel>;
  if (d.state !== "ok") {
    return (
      <Panel title={title} sub={sub}>
        <Notice tone={d.state === "notConfigured" ? "info" : "warning"} title={t(`ob.li.state.${d.state}`)}>
          {t(`ob.li.stateHint.${d.state}`)}{d.message ? ` (${d.message})` : ""}
        </Notice>
      </Panel>
    );
  }

  const time = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(locale), { hour: "2-digit", minute: "2-digit", second: d.windowMinutes <= 15 ? "2-digit" : undefined });
  const bars = timelineBars(d.timeline);
  const peak = peakBucket(bars);
  const num = (v: number | null) => (v === null ? "—" : v.toLocaleString());
  const pick = (w: string) => {
    const next = workload === w ? "" : w;
    setWorkload(next);
    if (next) onPickWorkload?.(next);
  };
  const withErrors = d.services.filter((s) => s.errors > 0).length;

  return (
    <div className={styles.li}>
      <Grid>
        <Cell span={12}>
          <div className={styles.liHead}>
            <h2 className={styles.sloSection}>{title}<span className={styles.sloSectionSub}>{sub}</span></h2>
            <span className={styles.liHeadEnd}>
              {workload ? <FilterChip pressed onClick={() => setWorkload("")} title={t("ob.li.clearWorkload")}>{workload}</FilterChip> : null}
              {win.differs ? <Chip level="info" glyph={false} title={t("ob.li.windowHint")}>{t("ob.li.window", { n: win.value })}</Chip> : null}
              {d.gaps.length ? <Chip level="warn" title={d.gaps.map((g) => t(`ob.li.gap.${g}`)).join(" · ")}>{t("ob.li.gaps", { n: d.gaps.length })}</Chip> : null}
            </span>
          </div>
        </Cell>

        <Cell span={3}><Stat label={<><span aria-hidden="true">■</span> {t("ob.li.errors")}</>} value={num(d.errors)} tone={d.errors ? "high" : d.errors === 0 ? "success" : undefined} hint={t("ob.li.errorsHint")} /></Cell>
        <Cell span={3}><Stat label={<><span aria-hidden="true">▲</span> {t("ob.li.warns")}</>} value={num(d.warns)} tone={d.warns ? "medium" : undefined} hint={t("ob.li.warnsHint")} /></Cell>
        <Cell span={3}><Stat label={t("ob.li.services")} value={d.errors === null ? "—" : withErrors} tone={withErrors ? "medium" : undefined} hint={t("ob.li.servicesHint", { n: d.services.length })} /></Cell>
        <Cell span={3}><Stat label={t("ob.li.classes")} value={num(d.exceptionClasses)} tone={d.exceptionClasses ? "medium" : undefined} hint={t("ob.li.classesHint")} /></Cell>

        <Cell span={6}>
          <Panel title={t("ob.li.timeline")} sub={peak ? t("ob.li.peak", { at: time(peak.start), n: peak.count }) : undefined}
            footer={<span>{t("ob.li.timelineFoot", { s: d.timeline?.stepSeconds ?? 0 })}</span>}>
            {!d.timeline ? <p className={styles.stackMuted}>{t("ob.li.notRead")}</p>
              : !peak ? <EmptyState title={t("ob.li.noErrors")}>{t("ob.li.noErrorsHint", { n: d.windowMinutes })}</EmptyState>
              : (
                <>
                  <div className={styles.liBars} role="img" aria-label={t("ob.li.timelineAria", { n: d.errors ?? 0 })}>
                    {bars.map((b) => (
                      <span key={b.start} className={styles.liBar} title={t("ob.li.barTitle", { from: time(b.start), to: time(b.end), n: b.count })}>
                        <span style={{ height: `${b.height}%` }} data-on={b.count > 0 || undefined} />
                      </span>
                    ))}
                  </div>
                  <div className={styles.liAxis}><span>{time(bars[0]!.start)}</span><span>{time(bars[bars.length - 1]!.end)}</span></div>
                </>
              )}
            {d.services.length > 0 && (
              <ul className={styles.liRows}>
                {d.services.slice(0, 8).map((s) => (
                  <li key={s.workload}>
                    <LinkButton onClick={() => pick(s.workload)} title={t("ob.li.pickHint")}>{s.workload}</LinkButton>
                    <span className={styles.liShare} aria-hidden="true"><span style={{ width: `${shareOf(s.errors, d.errors)}%` }} /></span>
                    <span className={styles.liNum}>{t("ob.li.rowCounts", { e: s.errors.toLocaleString(), w: s.warns.toLocaleString() })}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Cell>

        <Cell span={6}>
          <Panel title={t("ob.li.exceptions")} sub={d.exceptions ? String(d.exceptions.length) : undefined} flush footer={<span>{t("ob.li.exceptionsFoot")}</span>}>
            {!d.exceptions ? <p className={styles.liPad}>{t("ob.li.notRead")}</p>
              : d.exceptions.length === 0 ? <p className={styles.liPad}>{t("ob.li.noExceptions")}</p>
              : (
                <div className={styles.liTableWrap}>
                  <table className={styles.sloTable}>
                    <thead>
                      <tr><th scope="col">{t("ob.li.col.workload")}</th><th scope="col">{t("ob.li.col.class")}</th><th scope="col">{t("ob.li.col.count")}</th></tr>
                    </thead>
                    <tbody>
                      {d.exceptions.map((x) => (
                        <tr key={`${x.workload}/${x.cls}`}>
                          <td><LinkButton onClick={() => pick(x.workload)} title={t("ob.li.pickHint")}>{x.workload}</LinkButton></td>
                          <td className={styles.liClass} title={x.cls}>{x.cls}</td>
                          <td className={styles.liNum}>{x.count.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Panel>
        </Cell>
      </Grid>
    </div>
  );
}
