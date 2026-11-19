"use client";

// 노출 관리 (CTEM, 2026-11-19) — Wiz Exposure Management's five stages on this platform's own data:
// 범위(Scoping) · 발견(Discovery) · 우선순위(Prioritization) · 검증(Validation) · 조치(Remediation).
// Scoping / discovery / controls = GET /api/security/exposure (Resource Graph — services/exposure.ts, its KQL shown);
// prioritization / validation / remediation = the issue list (useIssueSources → buildIssueQueue — the 통합 위험 page's
// own queue) counted by lib/exposureView.ts. A number that could not be read is "—" with the reason, never 0;
// sources Wiz reads that we have no connection to are listed as such.

import Link from "next/link";
import { useMemo } from "react";
import type { ExposureResponse } from "@aud/types";
import { Chip, EmptyState, ErrorNotice, LoadingState, Notice, Select } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { byPath, funnelHeights, SLA_DAYS, stages, REMEDIATION_WINDOW_DAYS, EXCEPTION_WINDOW_DAYS } from "@/lib/exposureView";
import { PostureNotices, SecurityHeader } from "../components";
import { useIssueSources } from "../useIssueSources";
import s from "./exposure.module.css";

const FINDING_HREF: Record<string, string> = {
  vulnImages: "/security/findings", vulnContainers: "/security/advisories", vulnHosts: "/security/findings", cloudConfig: "/security/findings",
  containerConfig: "/policies", identity: "/security/identity", secrets: "/security/findings", endOfLife: "/security/findings", threats: "/security/threats",
};

export default function ExposurePage() {
  const { t, locale } = useI18n();
  const src = useIssueSources();
  const { sub, ready, sample, queue, states, sightings, sources, clusters, clusterId, setClusterId } = src;
  const q = useApiQuery(ready && !sample ? `exposure:${sub ?? "all"}` : null, (token) =>
    fetchJsonWithBearer<ExposureResponse>(apiUrl("/api/security/exposure", { subscriptionId: sub }), token),
  );
  const d = q.data && (!sub || q.data.subscriptionIds.includes(sub.toLowerCase())) ? q.data : null;
  const st = useMemo(() => stages(queue, states, sightings?.map ?? null, new Date()), [queue, states, sightings]);
  const nf = new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US");
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : nf.format(v));
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

  const srcList = Object.values(sources);
  const srcOk = srcList.filter((x) => x === "ok").length, srcOn = srcList.filter((x) => x !== "off").length;
  const srcBusy = srcList.some((x) => x === "loading");
  const findingsTotal = d ? d.findings.reduce((a, f) => a + (f.count ?? 0), 0) : null;
  const assetTotal = d ? d.assets.filter((a) => a.id !== "subscriptions").reduce((a, x) => a + (x.total ?? 0), 0) : null;
  const coverable = d ? d.assets.filter((a) => a.id !== "subscriptions" && a.covered !== null && a.coverable !== null) : [];
  const [hFind, hPri, hVal] = funnelHeights([findingsTotal, srcBusy ? null : st.prioritized.length, srcBusy ? null : st.validated.length]);

  if (sample) return (<div className={s.page}><SecurityHeader /><PostureNotices /><EmptyState title={t("exp.sampleTitle")}>{t("exp.sample")}</EmptyState></div>);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      <div className={s.toolbar}>
        {clusters.length > 1 ? (
          <Select label={t("risk.cluster")} value={clusterId} onChange={setClusterId} options={clusters.map((c) => ({ value: c.id, label: `${c.name} (${c.resourceGroup})` }))} />
        ) : null}
        <span className={s.meta}>{t("exp.scope")}</span>
        <Chip level={srcBusy ? "info" : srcOk === srcOn ? "ok" : "warn"} title={t("exp.sourcesHint")}>{srcBusy ? t("exp.sourcesLoading") : t("exp.sources", { ok: srcOk, n: srcOn })}</Chip>
      </div>
      {q.error ? <ErrorNotice error={q.error} /> : null}
      {d?.gaps.length ? <Notice tone="warning" title={t("exp.gaps", { n: d.gaps.length })}>{d.gaps.map((g) => t(`exp.gap.${g.section}`)).join(" · ")}</Notice> : null}

      <section className={s.board} aria-label={t("nav.item.securityExposure")}>
        {/* ① Scoping */}
        <div className={s.col} data-stage="scoping">
          <StageHead n={1} id="scoping" value={num(assetTotal)} label={t("exp.scoping.value")}
            sub={d ? t("exp.scoping.covered", { c: nf.format(coverable.reduce((a, x) => a + (x.covered ?? 0), 0)), n: nf.format(coverable.reduce((a, x) => a + (x.coverable ?? 0), 0)) }) : null} />
          <div className={s.band} aria-hidden="true" />
          {!d ? (q.loading ? <LoadingState /> : null) : (
            <ul className={s.rows}>
              {d.assets.map((a) => (
                <li key={a.id} title={a.plans.length ? t("exp.planHint", { plans: a.plans.join(", ") }) : t("exp.noPlanHint")}>
                  <span>{t(`exp.asset.${a.id}`)}</span>
                  <span className={s.count}>{num(a.total)}{a.covered !== null && a.coverable ? <small className={s.cov}>{t("exp.cov", { c: a.covered, n: a.coverable })}</small> : null}</span>
                </li>
              ))}
              {d.notConnected.map((x) => <li key={x} className={s.off}><span>{t(`exp.nc.${x}`)}</span><span className={s.count}>{t("exp.notConnected")}</span></li>)}
            </ul>
          )}
        </div>

        {/* ② Discovery */}
        <div className={s.col} data-stage="discovery">
          <StageHead n={2} id="discovery" value={num(findingsTotal)} label={t("exp.discovery.value")} sub={d ? t("exp.discovery.sub") : null} />
          <Band from={hFind} to={hPri} />
          {!d ? (q.loading ? <LoadingState /> : null) : (
            <ul className={s.rows}>
              {d.findings.map((f) => (
                <li key={f.id}>
                  <Link href={FINDING_HREF[f.id] ?? "/security/findings"} title={f.note ? t(`exp.note.${f.note}`) : f.bySeverity ? Object.entries(f.bySeverity).map(([k, v]) => `${k} ${nf.format(v)}`).join(" · ") : undefined}>{t(`exp.find.${f.id}`)}</Link>
                  <span className={s.count}>{num(f.count)}{f.resources !== null && f.count ? <small className={s.cov}>{t("exp.onRes", { n: nf.format(f.resources) })}</small> : null}{f.note ? <small className={s.cov}>{t(`exp.noteShort.${f.note}`)}</small> : null}</span>
                </li>
              ))}
            </ul>
          )}
          {d?.defenderRisk ? (
            <div className={s.subBlock}>
              <h3 className={s.subHead}>{t("exp.defenderRisk")}</h3>
              <p className={s.note}>{t("exp.defenderRiskLine", { h: nf.format(d.defenderRisk.high), m: nf.format(d.defenderRisk.medium), l: nf.format(d.defenderRisk.low) })}</p>
            </div>
          ) : null}
        </div>

        {/* ③ Prioritization */}
        <div className={s.col} data-stage="prioritization">
          <StageHead n={3} id="prioritization" value={srcBusy ? "…" : num(st.prioritized.length)} label={t("exp.prioritization.value")} sub={t("exp.prioritization.sub")} />
          <Band from={hPri} to={hVal} />
          <h3 className={s.subHead}>{t("exp.byPath")}</h3>
          <ul className={s.rows}>
            {byPath(st.prioritized).map((p) => (
              <li key={p.type} className={p.n ? undefined : s.zero}>
                <Link href="/security/risk">{t(`exp.path.${p.type}`)}</Link>
                <span className={s.count}>{nf.format(p.n)}{p.critical ? <small className={s.crit}>{t("exp.critical", { n: p.critical })}</small> : null}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ④ Validation */}
        <div className={s.col} data-stage="validation">
          <StageHead n={4} id="validation" value={srcBusy ? "…" : num(st.validated.length)} label={t("exp.validation.value")} sub={t("exp.validation.sub")} />
          <Band from={hVal} to={hVal} hot />
          <ul className={s.rows}>
            {byPath(st.validated).filter((p) => p.n).map((p) => (
              <li key={p.type}><Link href="/security/risk">{t(`exp.path.${p.type}`)}</Link><span className={s.count}>{nf.format(p.n)}</span></li>
            ))}
            {!st.validated.length && !srcBusy ? <li className={s.zero}><span>{t("exp.validation.none")}</span></li> : null}
          </ul>
          <h3 className={s.subHead}>{t("exp.controls")}</h3>
          {!d ? (q.loading ? <LoadingState /> : null) : (
            <ul className={s.rows}>
              {d.controls.map((c) => (
                <li key={c.id} title={t(`exp.ctlHint.${c.id}`)}>
                  <span>{t(`exp.ctl.${c.id}`)}</span>
                  <span className={s.count}>{num(c.count)}{c.of !== undefined && c.of !== null ? <small className={s.cov}>/ {nf.format(c.of)}</small> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ⑤ Remediation */}
        <div className={s.col} data-stage="remediation">
          <StageHead n={5} id="remediation" value={num(st.remediation.resolved)} label={t("exp.remediation.value", { d: REMEDIATION_WINDOW_DAYS })} sub={t("exp.remediation.sub", { n: nf.format(st.remediation.notDetected) })} />
          <div className={s.band} aria-hidden="true" />
          <Meter label={t("exp.assign")} value={st.remediation.assignmentRate} text={pct(st.remediation.assignmentRate)}
            hint={t("exp.assignHint", { a: st.remediation.assigned, n: st.prioritized.length })} />
          <Meter label={t("exp.sla", { c: SLA_DAYS.critical, h: SLA_DAYS.high })} value={st.remediation.sla.rate} text={pct(st.remediation.sla.rate)} warn
            hint={st.remediation.sla.within + st.remediation.sla.overdue
              ? t("exp.slaHint", { w: st.remediation.sla.within, o: st.remediation.sla.overdue, u: st.remediation.sla.unknown })
              : t("exp.slaNone", { u: st.remediation.sla.unknown })} />
          <ul className={s.rows}>
            <li><span>{t("exp.inProgress")}</span><span className={s.count}>{nf.format(st.remediation.inProgress)}</span></li>
            <li><span>{t("exp.exceptions", { d: EXCEPTION_WINDOW_DAYS })}</span><span className={s.count}>{nf.format(st.remediation.exceptions)}</span></li>
            <li><span>{t("exp.notDetected")}</span><span className={s.count}>{nf.format(st.remediation.notDetected)}</span></li>
          </ul>
          {st.remediation.sla.overdueItems.length ? (
            <div className={s.subBlock}>
              <h3 className={s.subHead}>{t("exp.overdue")}</h3>
              <ul className={s.overdue}>
                {st.remediation.sla.overdueItems.slice(0, 5).map(({ item, days, limit }) => (
                  <li key={item.key}><Link href={item.href} title={item.title}>{item.title}</Link><small>{t("exp.overdueDays", { d: days, l: limit })}</small></li>
                ))}
              </ul>
            </div>
          ) : null}
          {sightings && !sightings.durable ? <p className={s.note}>{t("exp.sightingsMemory")}</p> : null}
        </div>
      </section>

      <details className={s.how}>
        <summary>{t("exp.how")}</summary>
        <ul>
          {(["scoping", "discovery", "prioritization", "validation", "remediation"] as const).map((k) => <li key={k}><b>{t(`exp.stage.${k}`)}</b> {t(`exp.howText.${k}`)}</li>)}
        </ul>
        {d ? (
          <ul className={s.kql}>{Object.entries(d.queries).map(([k, v]) => <li key={k}><b>{k}</b><code>{v}</code></li>)}</ul>
        ) : null}
      </details>
    </div>
  );
}

function StageHead({ n, id, value, label, sub }: { n: number; id: string; value: string; label: string; sub: string | null }) {
  const { t } = useI18n();
  return (
    <div className={s.head}>
      <h2 className={s.stage} title={t(`exp.howText.${id}`)}><span className={s.step} aria-hidden="true">{n}</span>{t(`exp.stage.${id}`)}</h2>
      <div className={s.value}>{value}</div>
      <div className={s.label}>{label}</div>
      <div className={s.sub}>{sub ?? " "}</div>
    </div>
  );
}

/** One segment of the funnel band (log-scale heights 0..1 at its left and right edge) */
function Band({ from, to, hot }: { from: number | null; to: number | null; hot?: boolean }) {
  if (from === null || to === null) return <div className={s.band} aria-hidden="true" />;
  const H = 56, y = (h: number) => Math.max(1, h * H);
  const a = y(from), b = y(to);
  return (
    <div className={s.band} aria-hidden="true">
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none">
        <path className={hot ? s.bandHot : s.bandFill} d={`M0,${(H - a) / 2} L100,${(H - b) / 2} L100,${(H + b) / 2} L0,${(H + a) / 2} Z`} />
      </svg>
    </div>
  );
}

function Meter({ label, value, text, hint, warn }: { label: string; value: number | null; text: string; hint: string; warn?: boolean }) {
  return (
    <div className={s.meter}>
      <div className={s.meterHead}><span>{label}</span><b>{text}</b></div>
      <div className={s.meterTrack} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)} aria-label={label}>
        {value !== null ? <span className={s.meterFill} data-warn={warn && value < 1 ? "" : undefined} style={{ width: `${Math.round(value * 100)}%` }} /> : null}
      </div>
      <small className={s.meterHint}>{hint}</small>
    </div>
  );
}
