"use client";

// 서비스 (APM) › 오류 — error events per application from the apps' logging metrics (API services/appErrors.ts): the
// window's ERROR / FATAL / WARN, seven days by day, the first and last hour with an error, and what is new in 24 h.
// The metric has no exception class — which exception: the logs tab's insights (Loki), linked per workload.

import Link from "next/link";
import type { AppErrorsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Chip, CodeBlock, EmptyState, ErrorNotice, LoadingState, Notice, Panel } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, countText } from "@/lib/redView";
import { dailyBars, errorTotals } from "@/lib/apmMoreView";
import styles from "../styles.module.css";

export function ErrorsView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const fit = fitWindow(range, RED_WINDOWS);
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-errors:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<AppErrorsResponse>(apiUrl("/api/observability/app-errors", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  useRangeRefresh("errors", nonce, q.loading, q.reload, report);
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === fit.value && answersAt(q.data.at, atQ) ? q.data : null;

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.err.loading")} />;
  if (d.metricsState !== "ok") {
    return <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>{t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}</Notice>;
  }
  if (!d.metric) return <EmptyState title={t("ob.err.notInstrumented")}>{t("ob.err.notInstrumentedHint")}</EmptyState>;
  const lc = dateLocale(locale);
  const win = t(`ob.hm.window.${fit.value}`);
  const tot = errorTotals(d.apps);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(lc, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  return (
    <Panel title={t("ob.err.title")} sub={t("ob.err.sub", { w: win, m: d.metric })}
      actions={d.gaps?.length ? <Chip level="unknown">{t("ob.err.gaps", { q: d.gaps.map((g) => g.query).join(", ") })}</Chip> : undefined}
      footer={<span>{t("ob.err.foot", { at: new Date(d.at ?? d.generatedAt).toLocaleString(lc) })}</span>}>
      <p className={styles.sloText}>{t("ob.err.summary", { apps: tot.apps, with: tot.withErrors, e: countText(tot.errors, lc), w: countText(tot.warn, lc), n: tot.isNew, win })}</p>
      {d.apps.length === 0 ? <EmptyState title={t("ob.err.none")} /> : (
        <div className={styles.sloTableWrap}>
          <table className={styles.sloTable}>
            <thead><tr>
              <th>{t("ob.dep.col.app")}</th>
              <th className={styles.redNum}>{t("ob.err.col.errors")}</th><th className={styles.redNum}>WARN</th>
              <th title={t("ob.err.daysHint")}>{t("ob.err.col.days")}</th>
              <th>{t("ob.err.col.first")}</th><th>{t("ob.err.col.last")}</th><th />
            </tr></thead>
            <tbody>
              {d.apps.map((a) => {
                const errs = a.error === null ? null : (a.error ?? 0) + (a.fatal ?? 0);
                return (
                  <tr key={a.application}>
                    <td>
                      <span className={styles.sloCellMain}>{a.application}{a.newIn24h ? <> <Chip level="warn">{t("ob.err.new")}</Chip></> : null}</span>
                      <span className={styles.sloCellSub}>{a.namespace ?? t("ob.apm.noNamespace")}</span>
                    </td>
                    <td className={styles.redNum}>
                      <span className={styles.sloCellMain}>{errs === null ? "—" : `${errs > 0 ? "▲ " : ""}${countText(errs, lc)}`}</span>
                      {a.fatal ? <span className={styles.sloCellSub}>FATAL {countText(a.fatal, lc)}</span> : null}
                    </td>
                    <td className={styles.redNum}>{a.warn === null ? "—" : countText(a.warn, lc)}</td>
                    <td>
                      <span className={styles.errBars} aria-label={a.daily.map((x) => `${x.day} ${x.errors}`).join(", ")} title={a.daily.map((x) => `${x.day}: ${x.errors}`).join("\n")}>
                        {dailyBars(a).map((b) => <span key={b.day} className={styles.errBar} style={{ height: `${b.height}%` }} />)}
                      </span>
                    </td>
                    <td className={styles.sloCellSub}>{when(a.firstSeen)}</td>
                    <td className={styles.sloCellSub}>{when(a.lastSeen)}</td>
                    <td className={styles.redAction}>
                      {a.workload ? <Link href={`/observability?wl=${encodeURIComponent(`${a.workload.namespace}/${a.workload.name}`)}`} title={t("ob.err.toWorkloadHint")}>{t("ob.err.toWorkload")}</Link> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <details className={styles.sloCellSub}>
        <summary>{t("ob.apm.howMeasured")}</summary>
        {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
      </details>
    </Panel>
  );
}
