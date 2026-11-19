"use client";

// APM › 메트릭 (2026-11-19) — the metrics pillar for one service (traces and logs have their own views): golden
// signals (requests by status class, the 5xx share, latency p50 / p95 / p99 as bucket bounds), runtime (JVM heap, GC,
// threads, process CPU), dependencies (DB pool, outbound HTTP, executor queue) and the service's pods (CPU, memory vs
// request / limit) — every chart on the page's time range, so a jump in one reads against the others at the same time.
// API services/apmMetrics.ts; charts lib/apmMetricsView.ts; one chart = MetricChart.

import { useState } from "react";
import type { ApmMetricSection, ApmMetricsResponse, CollectorSignal } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { APM_CHARTS, APM_SECTIONS, pickService, sectionMeasured } from "@/lib/apmMetricsView";
import { valueText } from "@/lib/collectorView";
import { EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, Select } from "@/components/ui";
import { MetricChart } from "./MetricChart";
import styles from "../styles.module.css";

export function ApmMetricsView({ clusterId, range, nonce, report, onTraces }: {
  clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void;
  /** open the traces view on this service */
  onTraces: (service: string) => void;
}) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const minutes = String(Math.max(30, Math.min(7 * 1440, range.span)));
  const [key, setKey] = useState("");
  // the list first (no service named) — then the chosen one, or the busiest
  const list = useApiQuery(clusterId ? `apm-metrics-list:${clusterId}:${minutes}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<ApmMetricsResponse>(apiUrl("/api/observability/apm-metrics", { clusterId, minutes, at: atQ }), token),
  );
  const services = list.data?.clusterId === clusterId ? list.data.services : [];
  const svc = pickService(services, key);
  const q = useApiQuery(clusterId && svc ? `apm-metrics:${clusterId}:${svc.namespace}/${svc.application}:${minutes}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<ApmMetricsResponse>(apiUrl("/api/observability/apm-metrics", { clusterId, minutes, at: atQ, namespace: svc!.namespace, application: svc!.application }), token),
  );
  useRangeRefresh("apm-metrics", nonce, list.loading || q.loading, () => { list.reload(); q.reload(); }, report);
  const d = q.data?.service && svc && q.data.service.namespace === svc.namespace && q.data.service.application === svc.application ? q.data : null;
  const lc = dateLocale(locale);
  const fmt = (ms: number) => new Date(ms).toLocaleString(lc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  if (list.error) return <ErrorNotice error={list.error} />;
  if (!list.data) return <LoadingState />;
  if (list.data.metricsState !== "ok") return <Notice tone="warning" title={t(`hb.m.state.${list.data.metricsState}`)}>{list.data.message ?? ""}</Notice>;
  if (!services.length) return <EmptyState title={t("ob.am.none")}>{t("ob.am.noneHint")}</EmptyState>;

  const s = d?.service;
  return (
    <div className={styles.colWrap} data-apm-metrics>
      <div className={styles.colHead}>
        <Select label={t("ob.am.service")} value={svc ? `${svc.namespace}/${svc.application}` : ""} onChange={setKey}
          options={services.map((x) => ({ value: `${x.namespace}/${x.application}`, label: `${x.application} · ${x.namespace} — ${valueText(x.rps, "perSecond")}` }))} />
        {s ? <span className={styles.colMeta}>{t("ob.am.meta", { pods: s.pods, step: Math.round(d!.stepSeconds / 60) })}</span> : null}
        {svc ? <LinkButton onClick={() => onTraces(svc.application)}>{t("ob.am.traces")}</LinkButton> : null}
      </div>
      {q.error ? <ErrorNotice error={q.error} /> : !d || !s ? <LoadingState /> : (
        <>
          {d.gaps?.length ? <Notice tone="warning">{t("obs.col.gaps", { n: d.gaps.length })}</Notice> : null}
          {APM_SECTIONS.map((sec) => (
            <Panel key={sec} title={t(`ob.am.sec.${sec}`)} sub={t(`ob.am.secSub.${sec}`)}>
              {!sectionMeasured(s, sec) ? <p className={styles.colMeta}>{t(`ob.am.secNone.${sec}`)}</p> : (
                <div className={styles.colCharts}>
                  {APM_CHARTS[sec].map((c) => (
                    <MetricChart key={c.id} id={c.id} title={t(`ob.am.chart.${c.id}`)} from={Date.parse(d.from)} to={Date.parse(d.to)} fmt={fmt}
                      promql={[...c.lines, ...(c.limit ? [c.limit] : [])].map((id) => d.queries[id === "p50" || id === "p95" || id === "p99" ? "latency" : id]).filter(Boolean).join("\n")}
                      lines={c.lines.map((id) => ({ signal: signalOf(s.sections, sec, id), label: t(`ob.am.sig.${id}`) }))}
                      limit={c.limit ? signalOf(s.sections, sec, c.limit) ?? null : undefined} limitLabel={c.limit ? t(`ob.am.sig.${c.limit}`) : undefined}
                      noLimitText={c.limit && sec === "pods" ? t("obs.col.noLimit") : undefined} />
                  ))}
                </div>
              )}
              {sec === "golden" && s.buckets.length ? <p className={styles.colMeta}>{t("ob.am.bucketNote", { n: s.buckets.length, top: valueText(s.buckets[s.buckets.length - 1]!, "seconds") })}</p> : null}
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}

const signalOf = (sections: Record<ApmMetricSection, Record<string, CollectorSignal>>, sec: ApmMetricSection, id: string): CollectorSignal | undefined => sections[sec][id];
