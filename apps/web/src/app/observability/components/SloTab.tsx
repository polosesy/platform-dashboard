"use client";

// AKS 모니터링 › SLO — per service: availability (not 5xx) and latency (within a bucket boundary) SLIs from Micrometer
// HTTP metrics over the SLO window, the error budget as requests ("allowed n failures, m used"), the SRE Workbook's
// burn-rate alerts, the URIs that spent the budget, and what to do (API services/workloadSlo.ts). Problems first;
// a target the team did not set is marked default; low traffic / no data are not judged. The window is fixed (the
// page's time range sets only its end — said beside it).

import { useMemo, useState } from "react";
import type { SloService, SloSli, WorkloadSloResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, EmptyState, ErrorNotice, LoadingState, Notice, Segmented, Select, Stat, type BadgeTone } from "@/components/ui";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import {
  SLO_GLYPH, alertLevel, budgetBar, budgetOf, burnText, exploreUrl, filterServices, pctText, serviceLevel, sliLabelParams, sliLevel, sloCounts, targetText,
  type SloLevel,
} from "@/lib/sloView";
import styles from "../styles.module.css";

const TONE: Record<SloLevel, BadgeTone> = { danger: "high", warn: "medium", ok: "success", neutral: "neutral", unknown: "neutral" };

const CONFIG_EXAMPLE = `"aks": { "observability": { "slo": {
  "windowDays": 30,
  "availability": 0.999,
  "latency": { "thresholdMs": 1000, "target": 0.99 },
  "services": {
    "<namespace>/<application>": { "excludeUris": ["/public/*/webhooks/**"] }
  }
} } }`;

const MICROMETER_HINT = `management.metrics.distribution.percentiles-histogram.http.server.requests=true
management.metrics.distribution.slo.http.server.requests=100ms,300ms,500ms,1s,3s
management.metrics.tags.application=\${spring.application.name}`;

export function SloTab({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-slo:${clusterId}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadSloResponse>(apiUrl("/api/observability/slo", { clusterId, at: atQ }), token),
  );
  useRangeRefresh("slo", nonce, q.loading, q.reload, report);
  const [show, setShow] = useState<"problems" | "all">("problems");
  const [ns, setNs] = useState("");
  const dAt = q.data?.at ? String(Math.floor(Date.parse(q.data.at) / 1000)) : undefined;
  const d = q.data?.clusterId === clusterId && dAt === atQ ? q.data : null;
  const namespaces = useMemo(() => [...new Set((d?.services ?? []).map((s) => s.namespace))].sort(), [d]);

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("ob.slo.loading")} />;
  if (d.metricsState !== "ok") {
    return (
      <Notice tone={d.metricsState === "noWorkspace" ? "info" : "warning"} title={t(`hb.m.state.${d.metricsState}`)}>
        {t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}
      </Notice>
    );
  }
  if (!d.instrumented) {
    return (
      <EmptyState title={t("ob.slo.notInstrumented")}>
        {t("ob.slo.notInstrumentedHint")}
        <pre className={styles.sloPre}>{MICROMETER_HINT}</pre>
      </EmptyState>
    );
  }

  const counts = sloCounts(d.services);
  const shown = filterServices(d.services, show, ns);
  const promUid = d.grafana?.datasources.prometheus;
  const when = new Date(d.at ?? d.generatedAt).toLocaleString(dateLocale(locale));

  return (
    <div className={styles.slo}>
      <div className={styles.stackHead}>
        <Notice tone="info">{t(d.at ? "ob.slo.basisAt" : "ob.slo.basis", { days: d.windowDays, at: when })}</Notice>
        <Badge tone="info" title={t("ob.slo.windowFixedHint")}>{t("ob.slo.windowFixed", { days: d.windowDays })}</Badge>
      </div>
      {!d.configured && (
        <Notice tone="warning" title={t("ob.slo.defaultTitle")}>
          {t("ob.slo.defaultHint", { av: targetText(d.defaults.availability), lt: targetText(d.defaults.latency.target), ms: d.defaults.latency.thresholdMs })}
          <details className={styles.sloDetails}>
            <summary>{t("ob.slo.howToSet")}</summary>
            <pre className={styles.sloPre}>{CONFIG_EXAMPLE}</pre>
          </details>
        </Notice>
      )}
      {d.gaps?.length ? <Notice tone="warning" title={t("ob.slo.gapsTitle", { n: d.gaps.length })}>{t("ob.slo.gapsHint")}</Notice> : null}

      <div className={styles.stackStats}>
        <Stat label={t("ob.slo.stat.services")} value={d.services.length} hint={t("ob.slo.stat.servicesHint", { n: d.uninstrumented.length })} />
        <Stat label={t("ob.slo.stat.danger")} value={counts.danger} tone={counts.danger ? "high" : "success"} hint={t("ob.slo.stat.dangerHint")} />
        <Stat label={t("ob.slo.stat.warn")} value={counts.warn} tone={counts.warn ? "medium" : "success"} hint={t("ob.slo.stat.warnHint")} />
        <Stat label={t("ob.slo.stat.ok")} value={counts.ok} tone="success" hint={t("ob.slo.stat.notJudged", { n: counts.neutral + counts.unknown })} />
      </div>

      <details className={styles.sloExplain}>
        <summary>{t("ob.slo.explainTitle")}</summary>
        <dl>
          <dt>SLI</dt><dd>{t("ob.slo.explain.sli")}</dd>
          <dt>SLO</dt><dd>{t("ob.slo.explain.slo")}</dd>
          <dt>{t("ob.slo.budget")}</dt><dd>{t("ob.slo.explain.budget")}</dd>
          <dt>{t("ob.slo.burn")}</dt><dd>{t("ob.slo.explain.burn")}</dd>
        </dl>
      </details>

      <div className={styles.sloFilters}>
        <Segmented label={t("ob.slo.show")} value={show} onChange={setShow}
          items={[{ id: "problems", label: t("ob.slo.show.problems", { n: counts.danger + counts.warn }) }, { id: "all", label: t("ob.slo.show.all", { n: d.services.length }) }]} />
        {namespaces.length > 1 && (
          <Select label={t("hb.namespace")} hideLabel value={ns} onChange={setNs}
            options={[{ value: "", label: t("hb.allNamespaces") }, ...namespaces.map((n) => ({ value: n, label: n }))]} />
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState title={show === "problems" ? t("ob.slo.noProblems") : t("ob.slo.none")}>
          {show === "problems" ? t("ob.slo.noProblemsHint") : null}
        </EmptyState>
      ) : (
        <div className={styles.sloGrid}>
          {shown.map((s) => <SloCard key={`${s.namespace}/${s.application}`} s={s} days={d.windowDays} grafana={d.grafana} promUid={promUid} />)}
        </div>
      )}

      {d.uninstrumented.length > 0 && (
        <details className={styles.sloDetails}>
          <summary>{t("ob.slo.uninstrumented", { n: d.uninstrumented.length })}</summary>
          <p className={styles.stackMuted}>{t("ob.slo.uninstrumentedHint")}</p>
          <ul className={styles.stackList}>
            {d.uninstrumented.map((w) => <li key={`${w.namespace}/${w.name}`}>{w.namespace}/{w.name} <span className={styles.stackMuted}>({w.kind})</span></li>)}
          </ul>
          <pre className={styles.sloPre}>{MICROMETER_HINT}</pre>
        </details>
      )}
    </div>
  );
}

function SloCard({ s, days, grafana, promUid }: { s: SloService; days: number; grafana: WorkloadSloResponse["grafana"]; promUid: string | undefined }) {
  const { t } = useI18n();
  const level = serviceLevel(s);
  return (
    <article className={styles.sloCard} data-level={level}>
      <header className={styles.stackCardHead}>
        <div className={styles.stackCardName}>
          <strong title={s.application}>{SLO_GLYPH[level]} {s.application || t("ob.slo.noAppName")}</strong>
          <span className={styles.stackMuted}>
            {s.namespace}{s.workload ? "" : ` · ${t("ob.slo.noWorkload")}`}
            {s.coverage && s.coverage.hours < s.coverage.windowHours * 0.9 ? ` · ${t("ob.slo.coverage", { days: Math.round(s.coverage.hours / 2.4) / 10 })}` : ""}
          </span>
        </div>
        <Badge tone={TONE[level]}>{t(`ob.slo.state.${s.state}`)}</Badge>
      </header>
      {s.slis.map((x) => <SliRow key={x.kind} s={x} grafana={grafana} promUid={promUid} days={days} />)}
      {s.advice.length > 0 && (
        <div className={styles.sloAdvice}>
          <span className={styles.sloAdviceTitle}>{t("ob.slo.advice")}</span>
          <ul>
            {s.advice.map((a, i) => (
              <li key={`${a.id}-${a.sli ?? ""}-${i}`}>{t(`ob.slo.adv.${a.id}`, { ...(a.params ?? {}), sli: a.sli ? t(`ob.slo.kindShort.${a.sli}`) : "" })}</li>
            ))}
          </ul>
        </div>
      )}
      <details className={styles.sloDetails}>
        <summary>{t("ob.slo.detail")}</summary>
        {s.slis.map((x) => <SliDetail key={x.kind} s={x} />)}
      </details>
    </article>
  );
}

function SliRow({ s, grafana, promUid, days }: { s: SloSli; grafana: WorkloadSloResponse["grafana"]; promUid: string | undefined; days: number }) {
  const { t } = useI18n();
  const level = sliLevel(s);
  const bar = budgetBar(s);
  const b = budgetOf(s);
  return (
    <div className={styles.sloSli} data-level={level}>
      <div className={styles.sloSliHead}>
        <span className={styles.sloSliName} title={t(`ob.slo.kindHint.${s.kind}`)}>{SLO_GLYPH[level]} {t(`ob.slo.kind.${s.kind}`, sliLabelParams(s))}</span>
        <span className={styles.sloVal}>
          {pctText(s.sli)}
          {grafana && promUid && <a className={styles.stackLink} href={exploreUrl(grafana.endpoint, promUid, s.expr, days)} target="_blank" rel="noreferrer" title={s.expr}>↗</a>}
        </span>
      </div>
      <div className={styles.sloTarget}>
        {t("ob.slo.targetIs", { v: targetText(s.target) })}
        {s.targetSource === "default" ? <span className={styles.stackMuted}> ({t("ob.slo.default")})</span> : null}
        {s.achievable !== null && s.achievable !== s.target ? <span className={styles.stackMuted}> · {t("ob.slo.achievable", { v: targetText(s.achievable) })}</span> : null}
      </div>
      {bar && (
        <div className={styles.sloBar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.fill)} aria-label={t("ob.slo.budget")}>
          <span style={{ width: `${bar.fill}%` }} data-over={bar.over || undefined} />
        </div>
      )}
      <div className={styles.sloFoot}>
        <span>
          {s.state === "queryFailed" ? t("ob.slo.queryFailed")
            : s.state === "noData" ? t("ob.slo.noDataShort")
            : b ? (b.left >= 0 ? t("ob.slo.budgetText", { allowed: b.allowed, used: b.used, pct: b.usedPct }) : t("ob.slo.budgetOver", { allowed: b.allowed, used: b.used, pct: b.usedPct }))
            : "—"}
        </span>
        <span className={styles.sloChips}>
          {s.alerts.map((a) => {
            const lv = alertLevel(a);
            const long = s.burn.find((x) => x.window === a.long);
            return (
              <span key={a.id} className={styles.sloChip} data-level={lv} title={t(`ob.slo.alertHint.${a.id}`, { factor: a.factor })}>
                {SLO_GLYPH[lv]} {t(`ob.slo.alert.${a.id}`)} {burnText(long?.rate ?? null)}
              </span>
            );
          })}
        </span>
      </div>
    </div>
  );
}

function SliDetail({ s }: { s: SloSli }) {
  const { t } = useI18n();
  return (
    <div className={styles.sloDetail}>
      <h4>{t(`ob.slo.kind.${s.kind}`, sliLabelParams(s))}</h4>
      <table className={styles.stackTable}>
        <thead><tr><th>{t("ob.slo.window")}</th><th>{t("ob.slo.requests")}</th><th>{t("ob.slo.burnRate")}</th></tr></thead>
        <tbody>
          {s.burn.map((x) => (
            <tr key={x.window}><td>{x.window}</td><td>{x.events ?? "—"}</td><td>{burnText(x.rate)}</td></tr>
          ))}
        </tbody>
      </table>
      {s.topBad.length > 0 && (
        <>
          <p className={styles.stackMuted}>{t(`ob.slo.topBad.${s.kind}`)}</p>
          <table className={styles.stackTable}>
            <thead><tr><th>URI</th><th>{t("ob.slo.bad")}</th><th>{t("ob.slo.requests")}</th></tr></thead>
            <tbody>
              {s.topBad.map((u) => (
                <tr key={`${u.method} ${u.uri}`}><td className={styles.sloUri} title={u.uri}>{u.method.toUpperCase()} {u.uri}</td><td>{u.bad}</td><td>{u.events}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <code className={styles.sloExpr}>{s.expr}</code>
    </div>
  );
}
