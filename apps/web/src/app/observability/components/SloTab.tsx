"use client";

// AKS 모니터링 › SLO — per service: availability (not 5xx) and latency (within a bucket boundary) SLIs from Micrometer
// HTTP metrics over the SLO window, the error budget as requests ("allowed n failures, m used"), the SRE Workbook's
// burn-rate alerts, the URIs that spent the budget, and what to do (API services/workloadSlo.ts). Problems first;
// a target the team did not set is marked default; low traffic / no data are not judged. The window is fixed (the
// page's time range sets only its end — said beside it).
//
// Two views (design principles v1 — one notice per screen, the explanations live in their own view):
//   서비스 SLO   — 4 stat cards (3 columns each) · section bar · service cards 2 per row (6 columns — on the stat edges)
//   목표 설정 가이드 — 4 steps · what is measured · the window's measured values (a starting point) · where to write the
//                     targets (on-prem file / Helm values) with a draft filled from the measured tiers · the fields ·
//                     workloads without HTTP metrics

import { useMemo, useState } from "react";
import type { SloService, SloSli, WorkloadSloResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import {
  Button, Cell, Chip, CodeBlock, EmptyState, ErrorNotice, Grid, LoadingState, Notice, Panel, Segmented, Select, Stat, type ChipLevel,
} from "@/components/ui";
import { atParam, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import {
  SLO_GLYPH, alertLevel, budgetBar, budgetOf, burnText, exploreUrl, filterServices, msText, pctText, serviceLevel, sliLabelParams, sliLevel,
  sloConfigDraft, sloCounts, targetText, type SloLevel,
} from "@/lib/sloView";
import styles from "../styles.module.css";

const CHIP: Record<SloLevel, ChipLevel> = { danger: "danger", warn: "warn", ok: "ok", neutral: "neutral", unknown: "unknown" };

const MICROMETER_HINT = `management.metrics.distribution.percentiles-histogram.http.server.requests=true
management.metrics.distribution.slo.http.server.requests=100ms,300ms,500ms,1s,3s
management.metrics.tags.application=\${spring.application.name}`;

type View = "services" | "guide";

export function SloTab({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const atQ = atParam(range);
  const q = useApiQuery(clusterId ? `obs-slo:${clusterId}:${atQ ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadSloResponse>(apiUrl("/api/observability/slo", { clusterId, at: atQ }), token),
  );
  useRangeRefresh("slo", nonce, q.loading, q.reload, report);
  const [view, setView] = useState<View>("services");
  const dAt = q.data?.at ? String(Math.floor(Date.parse(q.data.at) / 1000)) : undefined;
  const d = q.data?.clusterId === clusterId && dAt === atQ ? q.data : null;

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
        <div className={styles.sloEmptyCode}>
          <CodeBlock code={MICROMETER_HINT} label={t("ob.slo.g.micrometerLabel")} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
        </div>
      </EmptyState>
    );
  }

  const when = new Date(d.at ?? d.generatedAt).toLocaleString(dateLocale(locale));
  // One notice at most: a data gap (the numbers are partial) outranks the default-target note (the colours are capped)
  const notice = d.gaps?.length
    ? <Notice tone="warning" title={t("ob.slo.gapsTitle", { n: d.gaps.length })}>{t("ob.slo.gapsHint")}</Notice>
    : !d.configured && view === "services"
      ? (
        <Notice tone="warning" title={t("ob.slo.defaultTitle")}
          action={<Button size="sm" onClick={() => setView("guide")}>{t("ob.slo.openGuide")}</Button>}>
          {t("ob.slo.defaultShort")}
        </Notice>
      )
      : null;

  return (
    <div className={styles.slo}>
      <div className={styles.sloTop}>
        <Segmented label={t("ob.slo.view")} value={view} onChange={setView}
          items={[{ id: "services", label: t("ob.slo.view.services") }, { id: "guide", label: t("ob.slo.view.guide") }]} />
        <span className={styles.sloMeta}>
          {t(d.at ? "ob.slo.metaAt" : "ob.slo.metaNow", { days: d.windowDays, at: when })}
          <Chip level="info" glyph={false} title={t("ob.slo.windowFixedHint")}>{t("ob.slo.windowFixed", { days: d.windowDays })}</Chip>
        </span>
      </div>
      {notice}
      {view === "services" ? <ServicesView d={d} onGuide={() => setView("guide")} /> : <SloGuide d={d} />}
    </div>
  );
}

/* ── 서비스 SLO ── */

function ServicesView({ d, onGuide }: { d: WorkloadSloResponse; onGuide: () => void }) {
  const { t } = useI18n();
  const [show, setShow] = useState<"problems" | "all">("problems");
  const [ns, setNs] = useState("");
  const namespaces = useMemo(() => [...new Set(d.services.map((s) => s.namespace))].sort(), [d]);
  const counts = sloCounts(d.services);
  const shown = filterServices(d.services, show, ns);
  const promUid = d.grafana?.datasources.prometheus;
  const notJudged = counts.neutral + counts.unknown;

  return (
    <Grid>
      <Cell span={3}><Stat label={t("ob.slo.stat.services")} value={d.services.length} hint={t("ob.slo.stat.servicesHint", { n: d.uninstrumented.length })} /></Cell>
      <Cell span={3}><Stat label={<><span aria-hidden="true">{SLO_GLYPH.danger}</span> {t("ob.slo.stat.danger")}</>} value={counts.danger} tone={counts.danger ? "high" : undefined} hint={t("ob.slo.stat.dangerHint")} /></Cell>
      <Cell span={3}><Stat label={<><span aria-hidden="true">{SLO_GLYPH.warn}</span> {t("ob.slo.stat.warn")}</>} value={counts.warn} tone={counts.warn ? "medium" : undefined} hint={t("ob.slo.stat.warnHint")} /></Cell>
      <Cell span={3}><Stat label={<><span aria-hidden="true">{SLO_GLYPH.ok}</span> {t("ob.slo.stat.ok")}</>} value={counts.ok} tone="success" hint={t("ob.slo.stat.notJudged", { n: notJudged })} /></Cell>

      <Cell span={12}>
        <div className={styles.sloBar12}>
          <h2 className={styles.sloSection}>
            {t("ob.slo.view.services")}
            <span className={styles.sloSectionSub}>{t("ob.slo.sectionSub", { shown: shown.length, n: d.services.length })}</span>
          </h2>
          <div className={styles.sloControls}>
            {namespaces.length > 1 && (
              <Select label={t("hb.namespace")} hideLabel value={ns} onChange={setNs}
                options={[{ value: "", label: t("hb.allNamespaces") }, ...namespaces.map((n) => ({ value: n, label: n }))]} />
            )}
            <Segmented label={t("ob.slo.show")} value={show} onChange={setShow}
              items={[{ id: "problems", label: t("ob.slo.show.problems", { n: counts.danger + counts.warn }) }, { id: "all", label: t("ob.slo.show.all", { n: d.services.length }) }]} />
          </div>
        </div>
      </Cell>

      {shown.length === 0 ? (
        <Cell span={12}>
          <EmptyState title={show === "problems" ? t("ob.slo.noProblems") : t("ob.slo.none")}>
            {show === "problems" ? t("ob.slo.noProblemsHint") : null}
          </EmptyState>
        </Cell>
      ) : shown.map((s) => (
        <Cell span={6} key={`${s.namespace}/${s.application}`}>
          <SloCard s={s} days={d.windowDays} grafana={d.grafana} promUid={promUid} />
        </Cell>
      ))}

      <Cell span={12}>
        <div className={styles.sloFootLine}>
          <span>{t("ob.slo.footLine", { judged: d.services.length - notJudged, notJudged, uninst: d.uninstrumented.length })}</span>
          <button type="button" className={styles.sloLinkBtn} onClick={onGuide}>{t("ob.slo.openGuide")} →</button>
        </div>
      </Cell>
    </Grid>
  );
}

function SloCard({ s, days, grafana, promUid }: { s: SloService; days: number; grafana: WorkloadSloResponse["grafana"]; promUid: string | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const level = serviceLevel(s);
  const name = s.application || t("ob.slo.noAppName");
  const short = s.coverage && s.coverage.hours < s.coverage.windowHours * 0.9 ? t("ob.slo.coverage", { days: Math.round(s.coverage.hours / 2.4) / 10 }) : null;
  const requests = Math.max(0, ...s.slis.map((x) => x.events ?? 0));
  return (
    <Panel as="article" level={level === "danger" || level === "warn" ? level : undefined}
      title={<span title={name}>{name}</span>}
      sub={[s.namespace, s.workload ? null : t("ob.slo.noWorkload"), short].filter(Boolean).join(" · ")}
      actions={<Chip level={CHIP[level]}>{t(`ob.slo.state.${s.state}`)}</Chip>}
      footer={
        <>
          <Button size="sm" variant="ghost" ariaPressed={open} onClick={() => setOpen(!open)}>{open ? t("ob.slo.hideDetail") : t("ob.slo.detail")}</Button>
          <span className={styles.sloFootNote}>{requests > 0 ? t("ob.slo.cardFoot", { n: requests.toLocaleString(), days }) : "—"}</span>
        </>
      }>
      <div className={styles.sloSlis}>
        {s.slis.map((x) => <SliBlock key={x.kind} s={x} grafana={grafana} promUid={promUid} days={days} />)}
      </div>
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
      {open && <div className={styles.sloDetails}>{s.slis.map((x) => <SliDetail key={x.kind} s={x} />)}</div>}
    </Panel>
  );
}

function SliBlock({ s, grafana, promUid, days }: { s: SloSli; grafana: WorkloadSloResponse["grafana"]; promUid: string | undefined; days: number }) {
  const { t } = useI18n();
  const level = sliLevel(s);
  const bar = budgetBar(s);
  const b = budgetOf(s);
  return (
    <section className={styles.sloSli} data-level={level}>
      <div className={styles.sloSliHead}>
        <span className={styles.sloSliName} title={t(`ob.slo.kindHint.${s.kind}`)}><span aria-hidden="true">{SLO_GLYPH[level]}</span> {t(`ob.slo.kind.${s.kind}`, sliLabelParams(s))}</span>
        {grafana && promUid && <a className={styles.sloExplore} href={exploreUrl(grafana.endpoint, promUid, s.expr, days)} target="_blank" rel="noreferrer" title={s.expr} aria-label={t("ob.slo.openExplore")}>↗</a>}
      </div>
      <div className={styles.sloVal}>{pctText(s.sli)}</div>
      <div className={styles.sloTarget}>
        {t("ob.slo.targetIs", { v: targetText(s.target) })}
        {s.targetSource === "default" ? ` (${t("ob.slo.default")})` : ""}
        {s.achievable !== null && s.achievable !== s.target ? ` · ${t("ob.slo.achievable", { v: targetText(s.achievable) })}` : ""}
      </div>
      <div className={styles.sloMeter} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar ? Math.round(bar.fill) : undefined} aria-label={t("ob.slo.budget")}>
        {bar && <span className={styles.sloMeterFill} style={{ width: `${bar.fill}%` }} data-over={bar.over || undefined} />}
        <span className={styles.sloMeterTick} aria-hidden="true" />
      </div>
      <div className={styles.sloBudget}>
        {s.state === "queryFailed" ? t("ob.slo.queryFailed")
          : s.state === "noData" ? t("ob.slo.noDataShort")
          : b ? (b.left >= 0 ? t("ob.slo.budgetText", { allowed: b.allowed, used: b.used, pct: b.usedPct }) : t("ob.slo.budgetOver", { allowed: b.allowed, used: b.used, pct: b.usedPct }))
          : "—"}
      </div>
      <div className={styles.sloChips}>
        {s.alerts.map((a) => {
          const lv = alertLevel(a);
          const long = s.burn.find((x) => x.window === a.long);
          return (
            <Chip key={a.id} level={lv === "ok" ? "plain" : CHIP[lv]} title={t(`ob.slo.alertHint.${a.id}`, { factor: a.factor })}>
              {t(`ob.slo.alert.${a.id}`)} {burnText(long?.rate ?? null)}
            </Chip>
          );
        })}
      </div>
    </section>
  );
}

function SliDetail({ s }: { s: SloSli }) {
  const { t } = useI18n();
  return (
    <div className={styles.sloDetail}>
      <h3>{t(`ob.slo.kind.${s.kind}`, sliLabelParams(s))}</h3>
      <table className={styles.stackTable}>
        <thead><tr><th>{t("ob.slo.window")}</th><th>{t("ob.slo.requests")}</th><th>{t("ob.slo.burnRate")}</th></tr></thead>
        <tbody>
          {s.burn.map((x) => (
            <tr key={x.window}><td>{x.window}</td><td>{x.events?.toLocaleString() ?? "—"}</td><td>{burnText(x.rate)}</td></tr>
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
                <tr key={`${u.method} ${u.uri}`}><td className={styles.sloUri} title={u.uri}>{u.method.toUpperCase()} {u.uri}</td><td>{u.bad.toLocaleString()}</td><td>{u.events.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <code className={styles.sloExpr}>{s.expr}</code>
    </div>
  );
}

/* ── 목표 설정 가이드 ── */

function SloGuide({ d }: { d: WorkloadSloResponse }) {
  const { t } = useI18n();
  const draft = useMemo(() => sloConfigDraft(d), [d]);
  const sli = (s: SloService, kind: SloSli["kind"]) => s.slis.find((x) => x.kind === kind);
  const copy = { copyLabel: t("ob.slo.copy"), copiedLabel: t("ob.slo.copied") };
  const steps = [1, 2, 3, 4] as const;

  return (
    <Grid>
      {steps.map((n) => (
        <Cell span={3} key={n}>
          <Panel title={t(`ob.slo.g.step${n}.t`)}>
            <p className={styles.sloText}>{t(`ob.slo.g.step${n}.d`, { days: d.windowDays })}</p>
          </Panel>
        </Cell>
      ))}

      <Cell span={6}>
        <Panel title={t("ob.slo.g.measureTitle")} footer={<span>{t("ob.slo.g.measureFoot")}</span>}>
          <dl className={styles.sloDefs}>
            <dt>SLI</dt>
            <dd>{t("ob.slo.explain.sli")}</dd>
            <dt>SLO</dt>
            <dd>{t("ob.slo.explain.slo")}</dd>
            <dt>{t("ob.slo.g.av.t")}</dt>
            <dd>{t("ob.slo.g.av.d")}</dd>
            <dt>{t("ob.slo.g.lat.t")}</dt>
            <dd>
              {t("ob.slo.g.lat.d")}
              <span className={styles.sloBuckets}>
                <span className={styles.stackMuted}>{t("ob.slo.g.buckets")}</span>
                {d.buckets.length
                  ? d.buckets.map((b) => <Chip key={b} level="plain" glyph={false}>{msText(b * 1000)}</Chip>)
                  : <span className={styles.stackMuted}>{t("ob.slo.g.noBuckets")}</span>}
              </span>
            </dd>
            <dt>{t("ob.slo.budget")}</dt>
            <dd>{t("ob.slo.explain.budget")}</dd>
            <dt>{t("ob.slo.burn")}</dt>
            <dd>{t("ob.slo.explain.burn")}</dd>
          </dl>
        </Panel>
      </Cell>

      <Cell span={6}>
        <Panel title={t("ob.slo.g.actualTitle", { days: d.windowDays })} flush footer={<span>{t("ob.slo.g.actualFoot")}</span>}>
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead>
                <tr>
                  <th scope="col">{t("ob.slo.g.col.service")}</th>
                  <th scope="col">{t("ob.slo.g.col.av")}</th>
                  <th scope="col">{t("ob.slo.g.col.lat")}</th>
                  <th scope="col">{t("ob.slo.g.col.source")}</th>
                </tr>
              </thead>
              <tbody>
                {d.services.map((s) => {
                  const av = sli(s, "availability");
                  const lat = sli(s, "latency");
                  const configured = s.slis.some((x) => x.targetSource === "config");
                  return (
                    <tr key={`${s.namespace}/${s.application}`}>
                      <td><span className={styles.sloCellMain}>{s.application || t("ob.slo.noAppName")}</span><span className={styles.sloCellSub}>{s.namespace}</span></td>
                      <td><span className={styles.sloCellMain}>{pctText(av?.sli ?? null)}</span><span className={styles.sloCellSub}>{av?.achievable != null ? t("ob.slo.g.met", { v: targetText(av.achievable) }) : t("ob.slo.g.metNone")}</span></td>
                      <td><span className={styles.sloCellMain}>{pctText(lat?.sli ?? null)}</span><span className={styles.sloCellSub}>{lat ? `${t("ob.slo.g.within", sliLabelParams(lat))} · ${lat.achievable != null ? t("ob.slo.g.met", { v: targetText(lat.achievable) }) : t("ob.slo.g.metNone")}` : "—"}</span></td>
                      <td><Chip level={configured ? "info" : "plain"} glyph={false}>{t(configured ? "ob.slo.g.source.config" : "ob.slo.g.source.default")}</Chip></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </Cell>

      <Cell span={12}>
        <Panel title={t("ob.slo.g.whereTitle")} footer={<span>{t("ob.slo.g.whereFoot")}</span>}>
          <div className={styles.sloWhere}>
            <ol className={styles.sloWhereList}>
              <li><strong>{t("ob.slo.g.where.find.t")}</strong><span>{t("ob.slo.g.where.find.d")}</span></li>
              <li><strong>{t("ob.slo.g.where.onprem.t")}</strong><span>{t("ob.slo.g.where.onprem.d")}</span><code className={styles.sloCmd}>sudo ~/aud-runtime/audctl restart</code></li>
              <li><strong>{t("ob.slo.g.where.aks.t")}</strong><span>{t("ob.slo.g.where.aks.d")}</span></li>
              <li><strong>{t("ob.slo.g.where.check.t")}</strong><span>{t("ob.slo.g.where.check.d")}</span></li>
            </ol>
            <CodeBlock code={draft} label={t("ob.slo.g.draftLabel", { days: d.windowDays })} {...copy} />
          </div>
        </Panel>
      </Cell>

      <Cell span={12}>
        <Panel title={t("ob.slo.g.fieldsTitle")} flush>
          <div className={styles.sloTableWrap}>
            <table className={styles.sloTable}>
              <thead><tr><th scope="col">{t("ob.slo.g.field")}</th><th scope="col">{t("ob.slo.g.fieldMeaning")}</th><th scope="col">{t("ob.slo.g.fieldExample")}</th></tr></thead>
              <tbody>
                {(["windowDays", "availability", "latency", "services", "excludeUris", "exclude"] as const).map((f) => (
                  <tr key={f}>
                    <td><code className={styles.sloCode}>{f}</code></td>
                    <td>{t(`ob.slo.g.f.${f}`)}</td>
                    <td><code className={styles.sloCode}>{FIELD_EXAMPLE[f]}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </Cell>

      {d.uninstrumented.length > 0 && (
        <Cell span={12}>
          <Panel title={t("ob.slo.g.uninstTitle")} sub={String(d.uninstrumented.length)}>
            <div className={styles.sloWhere}>
              <div className={styles.sloUninst}>
                <p className={styles.sloText}>{t("ob.slo.uninstrumentedHint")}</p>
                <div className={styles.sloChips}>
                  {d.uninstrumented.map((w) => <Chip key={`${w.namespace}/${w.name}`} level="neutral" title={w.kind}>{w.namespace}/{w.name}</Chip>)}
                </div>
              </div>
              <CodeBlock code={MICROMETER_HINT} label={t("ob.slo.g.micrometerLabel")} {...copy} />
            </div>
          </Panel>
        </Cell>
      )}
    </Grid>
  );
}

const FIELD_EXAMPLE = {
  windowDays: "30",
  availability: "0.999",
  latency: `{ "thresholdMs": 1000, "target": 0.99 }`,
  services: `"shop/orders-api": { "availability": 0.995 }`,
  excludeUris: `["/public/{id}/webhooks"]`,
  exclude: `"ops/report-batch": { "exclude": true }`,
} as const;
