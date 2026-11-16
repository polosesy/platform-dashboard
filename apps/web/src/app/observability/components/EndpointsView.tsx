"use client";

// 서비스 (APM) › 엔드포인트 — every server endpoint of every service in one table (AppDynamics business transactions,
// Datadog resources), from the same RED read (spanmetrics, server spans, /actuator apart): requests, errors (span status
// ERROR = 5xx or an exception), p95 as the bucket that holds it. Sort by errors / requests / p95; no colour (no target).

import { useState } from "react";
import Link from "next/link";
import type { WorkloadRedResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { EmptyState, ErrorNotice, LoadingState, Notice, Panel, SearchInput, Segmented } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, countText, endpointLabel, endpointRows, errorRateText, quantileText, type EndpointSort } from "@/lib/redView";
import styles from "../styles.module.css";

const SHOW = 300;

export function EndpointsView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const fit = fitWindow(range, RED_WINDOWS);
  const atQ = atParam(range);
  // The RED read (same key as the RED view — one request, one cache)
  const q = useApiQuery(clusterId ? `obs-red:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadRedResponse>(apiUrl("/api/observability/red", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  useRangeRefresh("endpoints", nonce, q.loading, q.reload, report);
  const [sort, setSort] = useState<EndpointSort>("errors");
  const [search, setSearch] = useState("");
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === fit.value && answersAt(q.data.at, atQ) ? q.data : null;

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.red.loading")} />;
  if (d.metricsState !== "ok") {
    return <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>{t(`hb.m.stateHint.${d.metricsState}`)}</Notice>;
  }
  if (!d.instrumented) return <EmptyState title={t("ob.red.notInstrumented")}>{t("ob.red.notInstrumentedHint")}</EmptyState>;
  const lc = dateLocale(locale);
  const win = t(`ob.hm.window.${fit.value}`);
  const rows = endpointRows(d.services, sort, search);
  const withErrors = rows.filter((r) => r.errors > 0).length;
  return (
    <Panel title={t("ob.ep.title")} sub={t("ob.ep.sub", { w: win })}
      actions={<>
        <Segmented label={t("ob.ep.sort")} value={sort} onChange={setSort}
          items={[{ id: "errors", label: t("ob.ep.sort.errors") }, { id: "requests", label: t("ob.ep.sort.requests") }, { id: "p95", label: t("ob.ep.sort.p95") }]} />
        <SearchInput label={t("ob.ep.search")} value={search} onChange={setSearch} placeholder={t("ob.ep.search")} />
      </>}
      footer={<span>{t("ob.ep.foot")}</span>}>
      <p className={styles.sloText}>{t("ob.ep.summary", { n: rows.length, e: withErrors, w: win })}</p>
      {rows.length === 0 ? <EmptyState title={t("ob.red.empty", { w: win })} /> : (
        <div className={styles.sloTableWrap}>
          <table className={styles.sloTable}>
            <thead><tr>
              <th>{t("ob.ep.col.endpoint")}</th><th>{t("ob.red.col.service")}</th>
              <th className={styles.redNum}>{t("ob.ep.col.requests")}</th><th className={styles.redNum}>{t("ob.red.col.errors")}</th>
              <th className={styles.redNum} title={t("ob.red.durationHint")}>p95</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, SHOW).map((r) => (
                <tr key={`${r.service}|${r.name}`}>
                  <td><span className={styles.redEndpoint} title={r.name}>{endpointLabel(r.name)}</span></td>
                  <td>
                    <span className={styles.sloCellMain}>{r.service}</span>
                    {r.workload ? <span className={styles.sloCellSub}><Link href={`/observability?wl=${encodeURIComponent(`${r.workload.namespace}/${r.workload.name}`)}`}>{r.workload.namespace}/{r.workload.name} →</Link></span> : null}
                  </td>
                  <td className={styles.redNum}>{countText(r.requests, lc)}</td>
                  <td className={styles.redNum}><span className={styles.sloCellMain}>{r.errors > 0 ? "▲ " : ""}{errorRateText(r.errorRate)}</span><span className={styles.sloCellSub}>{t("ob.red.errorsN", { n: countText(r.errors, lc) })}</span></td>
                  <td className={styles.redNum}>{quantileText(r.p95, d.buckets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > SHOW ? <p className={styles.sloCellSub}>{t("ob.ep.more", { n: rows.length - SHOW })}</p> : null}
    </Panel>
  );
}
