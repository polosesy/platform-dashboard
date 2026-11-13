"use client";

// AKS 모니터링 › SLO › RED (트레이스) — per service: requests (per second / minute), errors (server spans with status
// ERROR = 5xx), duration (p50 / p95 / p99 as the bucket that holds them) from the trace pipeline's spanmetrics
// (API services/workloadRed.ts). Server spans only, /actuator apart. No colour: RED has no target — the 서비스 SLO view
// judges. The counter's resets in the window are shown beside the numbers (they inflate rates when > 0).

import { Fragment, useState } from "react";
import Link from "next/link";
import type { WorkloadRedResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Chip, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, errorRateText, quantileText, rateText, redTotals } from "@/lib/redView";
import styles from "../styles.module.css";

export function RedView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const fit = fitWindow(range, RED_WINDOWS);
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-red:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadRedResponse>(apiUrl("/api/observability/red", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  useRangeRefresh("red", nonce, q.loading, q.reload, report);
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === fit.value && answersAt(q.data.at, atQ) ? q.data : null;

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.red.loading")} />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }
  if (!d.instrumented) return <EmptyState title={t("ob.red.notInstrumented")}>{t("ob.red.notInstrumentedHint")}</EmptyState>;

  const tot = redTotals(d.services);
  const win = t(`ob.hm.window.${fit.value}`);
  const rate = (n: number) => { const r = rateText(n); return t(r.key, { n: r.n }); };
  return (
    <>
      {d.gaps?.length ? <Notice tone="warning" title={t("ob.red.gapsTitle", { n: d.gaps.length })}>{t("ob.red.gapsHint")}</Notice> : null}
      <Panel title={t("ob.red.title")} sub={t("ob.red.sub", { w: win })}
        actions={<>
          {fit.differs ? <Chip level="info" glyph={false} title={t("ob.red.windowFitHint")}>{t("ob.red.windowFit", { w: win })}</Chip> : null}
          {d.resets === null ? <Chip level="unknown" title={t("ob.red.resetsHint")}>{t("ob.red.resetsUnknown")}</Chip>
            : d.resets > 0 ? <Chip level="warn" title={t("ob.red.resetsHint")}>{t("ob.red.resets", { n: d.resets })}</Chip>
            : <Chip level="ok" title={t("ob.red.resetsHint")}>{t("ob.red.resetsNone")}</Chip>}
        </>}
        footer={<span>{t("ob.red.foot", { at: new Date(d.at ?? d.generatedAt).toLocaleString(dateLocale(locale)), actuator: rate(tot.actuatorRate) })}</span>}>
        <p className={styles.sloText}>
          {t("ob.red.summary", { n: tot.services, req: tot.requests.toLocaleString(dateLocale(locale)), w: win, err: tot.errors.toLocaleString(dateLocale(locale)), sv: tot.withErrors })}
        </p>
        {d.services.length === 0 ? <EmptyState title={t("ob.red.empty", { w: win })} /> : (
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead>
                <tr>
                  <th>{t("ob.red.col.service")}</th>
                  <th className={styles.redNum}>{t("ob.red.col.rate")}</th>
                  <th className={styles.redNum}>{t("ob.red.col.errors")}</th>
                  <th className={styles.redNum} title={t("ob.red.durationHint")}>p50</th>
                  <th className={styles.redNum} title={t("ob.red.durationHint")}>p95</th>
                  <th className={styles.redNum} title={t("ob.red.durationHint")}>p99</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.services.map((s) => (
                  <Fragment key={s.service}>
                    <tr>
                      <td>
                        <span className={styles.sloCellMain}>{s.service}</span>
                        <span className={styles.sloCellSub}>
                          {s.workload
                            ? <Link href={`/observability?wl=${encodeURIComponent(`${s.workload.namespace}/${s.workload.name}`)}`} title={t("ob.red.workloadHint")}>{s.workload.namespace}/{s.workload.name} →</Link>
                            : t(s.sameName > 1 ? "ob.red.workloadMany" : "ob.red.workloadNone", { n: s.sameName })}
                          {s.lowTraffic ? <> · <span title={t("ob.red.lowHint")}>{t("ob.red.low")}</span></> : null}
                        </span>
                      </td>
                      <td className={styles.redNum}>
                        <span className={styles.sloCellMain}>{rate(s.rate)}</span>
                        <span className={styles.sloCellSub}>{t("ob.red.requestsIn", { n: s.requests.toLocaleString(dateLocale(locale)) })}</span>
                      </td>
                      <td className={styles.redNum}>
                        <span className={styles.sloCellMain}>{errorRateText(s.errorRate)}</span>
                        <span className={styles.sloCellSub}>{t("ob.red.errorsN", { n: s.errors.toLocaleString(dateLocale(locale)) })}</span>
                      </td>
                      <td className={styles.redNum}>{quantileText(s.p50, d.buckets)}</td>
                      <td className={styles.redNum}>{quantileText(s.p95, d.buckets)}</td>
                      <td className={styles.redNum}>{quantileText(s.p99, d.buckets)}</td>
                      <td>
                        {s.endpoints.length ? (
                          <LinkButton ariaExpanded={open === s.service} onClick={() => setOpen(open === s.service ? null : s.service)}>
                            {t(open === s.service ? "ob.red.hideEndpoints" : "ob.red.showEndpoints", { n: s.endpoints.length })}
                          </LinkButton>
                        ) : null}
                      </td>
                    </tr>
                    {open === s.service && s.endpoints.map((e) => (
                      <tr key={`${s.service}:${e.name}`} className={styles.redSubRow}>
                        <td><span className={styles.redEndpoint}>{e.name}</span></td>
                        <td className={styles.redNum}>{t("ob.red.requestsIn", { n: e.requests.toLocaleString(dateLocale(locale)) })}</td>
                        <td className={styles.redNum}>{t("ob.red.errorsN", { n: e.errors.toLocaleString(dateLocale(locale)) })}</td>
                        <td />
                        <td className={styles.redNum}>{quantileText(e.p95, d.buckets)}</td>
                        <td />
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
