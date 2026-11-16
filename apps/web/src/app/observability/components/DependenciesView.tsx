"use client";

// 서비스 (APM) › 의존성 — what each application calls outside the traced services (outbound HTTP), which JDBC pools it
// waits on and how far behind its Kafka consumers are, from the applications' own Micrometer metrics (API
// services/appDependencies.ts). Three tables, facts only: averages and maxima (the timers carry no histogram — no
// percentile), counts of failed requests, waiting threads, timeouts, records behind. ▲ marks a non-zero one.

import { useState } from "react";
import type { AppDependenciesResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Chip, CodeBlock, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, SearchInput } from "@/components/ui";
import { answersAt, atParam, fitWindow, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { RED_WINDOWS, countText, errorRateText, rateText } from "@/lib/redView";
import { depsRows, depsTotals, durationText } from "@/lib/depsView";
import styles from "../styles.module.css";

/** One read of the dependencies (shared by this view and the service-map panel — same key, same cache) */
export function useDependencies(clusterId: string, range: TimeRange) {
  const fit = fitWindow(range, RED_WINDOWS);
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-deps:${clusterId}:${fit.value}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<AppDependenciesResponse>(apiUrl("/api/observability/dependencies", { clusterId, window: String(fit.value), at: atQ }), token),
  );
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === fit.value && answersAt(q.data.at, atQ) ? q.data : null;
  return { q, d, fit };
}

export function DependenciesView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const { q, d, fit } = useDependencies(clusterId, range);
  useRangeRefresh("deps", nonce, q.loading, q.reload, report);
  const [search, setSearch] = useState("");
  const [showIdle, setShowIdle] = useState(false);

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.dep.loading")} />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }
  if (!d.instrumented) return <EmptyState title={t("ob.dep.notInstrumented")}>{t("ob.dep.notInstrumentedHint")}</EmptyState>;

  const lc = dateLocale(locale);
  const win = t(`ob.hm.window.${fit.value}`);
  const tot = depsTotals(d.apps);
  const rows = depsRows(d.apps, search);
  const rate = (n: number) => { const r = rateText(n); return t(r.key, { n: r.n }); };
  const n = (v: number | null) => (v === null ? "—" : countText(v, lc));
  const mark = (v: number | null) => (v !== null && v > 0 ? "▲ " : "");
  const appCell = (a: string, ns: string | null) => (
    <><span className={styles.sloCellMain}>{a}</span><span className={styles.sloCellSub}>{ns ?? t("ob.apm.noNamespace")}</span></>
  );

  return (
    <>
      {d.gaps?.length ? <Notice tone="warning" title={t("ob.dep.gaps", { n: d.gaps.length })}>{d.gaps.map((g) => g.query).join(", ")}</Notice> : null}
      <Panel title={t("ob.dep.title")} sub={t("ob.dep.sub", { w: win })}
        actions={<>
          {fit.differs ? <Chip level="info" glyph={false}>{t("ob.red.windowFit", { w: win })}</Chip> : null}
          <SearchInput label={t("ob.dep.search")} value={search} onChange={setSearch} placeholder={t("ob.dep.search")} />
        </>}
        footer={<span>{t("ob.dep.foot", { at: new Date(d.at ?? d.generatedAt).toLocaleString(lc) })}</span>}>
        <p className={styles.sloText}>{t("ob.dep.summary", { apps: tot.apps, targets: tot.targets, failed: countText(tot.failed, lc), ft: tot.failingTargets, pw: tot.poolsWaiting, to: countText(tot.timeouts, lc), lag: tot.lagging, w: win })}</p>

        <h4 className={styles.depHead}>{t("ob.dep.out.title")}</h4>
        {rows.out.length === 0 ? <p className={styles.sloCellSub}>{t("ob.dep.out.none", { w: win })}</p> : (
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead><tr>
                <th>{t("ob.dep.col.app")}</th><th>{t("ob.dep.col.target")}</th>
                <th className={styles.redNum}>{t("ob.red.col.rate")}</th><th className={styles.redNum}>{t("ob.dep.col.failed")}</th>
                <th className={styles.redNum} title={t("ob.dep.latencyHint")}>{t("ob.dep.col.avg")}</th><th className={styles.redNum} title={t("ob.dep.latencyHint")}>{t("ob.dep.col.max")}</th>
                <th>{t("ob.dep.col.status")}</th>
              </tr></thead>
              <tbody>
                {rows.out.map((o) => (
                  <tr key={`${o.application}>${o.target}`}>
                    <td>{appCell(o.application, o.namespace)}</td>
                    <td><span className={styles.sloCellMain}>{o.target || t("ob.dep.untagged")}</span><span className={styles.sloCellSub} title={t("ob.dep.conventionHint")}>{t(`ob.dep.conv.${o.convention}`)}</span></td>
                    <td className={styles.redNum}><span className={styles.sloCellMain}>{rate(o.rate)}</span><span className={styles.sloCellSub}>{t("ob.red.requestsIn", { n: countText(o.requests, lc) })}</span></td>
                    <td className={styles.redNum}><span className={styles.sloCellMain}>{mark(o.failed)}{errorRateText(o.errorRate)}</span><span className={styles.sloCellSub}>{t("ob.red.errorsN", { n: countText(o.failed, lc) })}</span></td>
                    <td className={styles.redNum}>{durationText(o.avg)}</td>
                    <td className={styles.redNum}>{durationText(o.max)}</td>
                    <td><span className={styles.sloCellSub}>{o.statuses.map((s) => `${s.status || "—"} ${countText(s.requests, lc)}`).join(" · ")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.idleOut.length ? (
          <p className={styles.sloCellSub}>
            <LinkButton ariaExpanded={showIdle} onClick={() => setShowIdle(!showIdle)}>{t(showIdle ? "ob.dep.idleHide" : "ob.dep.idleShow", { n: rows.idleOut.length, w: win })}</LinkButton>
            {showIdle ? ` ${rows.idleOut.map((o) => `${o.application} → ${o.target || t("ob.dep.untagged")}`).join(" · ")}` : null}
          </p>
        ) : null}

        <h4 className={styles.depHead}>{t("ob.dep.pool.title")}</h4>
        {rows.pools.length === 0 ? <p className={styles.sloCellSub}>{t("ob.dep.pool.none")}</p> : (
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead><tr>
                <th>{t("ob.dep.col.app")}</th><th>{t("ob.dep.col.pool")}</th>
                <th className={styles.redNum}>{t("ob.dep.col.active")}</th><th className={styles.redNum} title={t("ob.dep.pendingHint")}>{t("ob.dep.col.pending")}</th>
                <th className={styles.redNum}>{t("ob.dep.col.timeouts")}</th><th className={styles.redNum}>{t("ob.dep.col.acquire")}</th>
              </tr></thead>
              <tbody>
                {rows.pools.map((p) => (
                  <tr key={`${p.application}>${p.pool}`}>
                    <td>{appCell(p.application, p.namespace)}</td>
                    <td>{p.pool || "—"}</td>
                    <td className={styles.redNum}>{n(p.active)} / {n(p.max)}</td>
                    <td className={styles.redNum}><span className={styles.sloCellMain}>{mark(p.pendingPeak)}{t("ob.dep.peak", { n: n(p.pendingPeak) })}</span><span className={styles.sloCellSub}>{t("ob.dep.now", { n: n(p.pending) })}</span></td>
                    <td className={styles.redNum}>{mark(p.timeouts)}{n(p.timeouts)}</td>
                    <td className={styles.redNum}>{durationText(p.acquireAvg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 className={styles.depHead}>{t("ob.dep.kafka.title")}</h4>
        {rows.consumers.length === 0 ? <p className={styles.sloCellSub}>{t("ob.dep.kafka.none")}</p> : (
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead><tr>
                <th>{t("ob.dep.col.app")}</th><th>{t("ob.dep.col.topic")}</th>
                <th className={styles.redNum} title={t("ob.dep.lagHint")}>{t("ob.dep.col.lag")}</th>
              </tr></thead>
              <tbody>
                {rows.consumers.map((c) => (
                  <tr key={`${c.application}>${c.topic}`}>
                    <td>{appCell(c.application, c.namespace)}</td>
                    <td>{c.topic || "—"}</td>
                    <td className={styles.redNum}><span className={styles.sloCellMain}>{mark(c.lagPeak)}{t("ob.dep.peak", { n: n(c.lagPeak) })}</span><span className={styles.sloCellSub}>{t("ob.dep.now", { n: n(c.lag) })}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className={styles.sloCellSub}>
          <summary>{t("ob.apm.howMeasured")}</summary>
          {Object.entries(d.queries).map(([k, v]) => <CodeBlock key={k} label={k} code={v} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />)}
        </details>
      </Panel>
    </>
  );
}
