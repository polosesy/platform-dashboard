"use client";

import Link from "next/link";
import type { PostureDomain } from "@aud/types";
import { EmptyState, LoadingState, Panel, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "./SecurityContext";
import { DOMAINS, PostureNotices, SecurityHeader, SeverityBadge, useGap, useLabel } from "./components";
import s from "./security.module.css";

/** 보안 개요 — Wiz-style posture overview: score, open findings by severity, areas, threats, coverage. */
export default function SecurityOverviewPage() {
  const { t } = useI18n();
  const label = useLabel();
  const { posture } = useSecurity();
  const recGap = useGap("recommendations");
  const complianceGap = useGap("compliance");
  const plansGap = useGap("plans");
  const alertsGap = useGap("alerts");
  const scoreGap = useGap("score");
  const controlsGap = useGap("controls");

  const recs = posture?.recommendations ?? [];
  // Findings = sum of unhealthy over recommendations (a resource once per recommendation); resources = distinct ids
  const findings = (sev: string) => recs.filter((r) => r.severity === sev).reduce((n, r) => n + r.unhealthy, 0);
  const resources = (sev: "High" | "Medium" | "Low") => posture?.affected?.[sev] ?? null;
  const kinds = (sev: string) => recs.filter((r) => r.severity === sev).length;
  const failedControls = (posture?.compliance ?? []).reduce((n, c) => n + c.failed, 0);
  const paidPlans = (posture?.plans ?? []).filter((p) => p.tier === "Standard").length;
  const notCollected = t("sec.collectFailed");

  const byDomain = DOMAINS.map((d) => {
    const rs = recs.filter((r) => r.domain === d);
    const sum = (sev?: string) => rs.filter((r) => !sev || r.severity === sev).reduce((n, r) => n + r.unhealthy, 0);
    return { d, kinds: rs.length, total: sum(), high: sum("High"), medium: sum("Medium"), low: sum("Low") };
  }).filter((x) => x.kinds > 0);
  const href = (d: PostureDomain) => (d === "identity" ? "/security/identity" : `/security/findings?domain=${d}`);

  const top = recs.slice(0, 6);
  // Secure score, its controls and compliance standards are subscription-level resources: a connection that reads
  // only some resource groups sees none of them (no rows — not an error, not zero)
  const controls = (posture?.controls ?? []).filter((c) => c.maxScore > 0);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />

      {!posture ? (
        <LoadingState />
      ) : (
        <>
          {/* KPI standard: the value line is a number or "—"; why there is no number goes on the hint line */}
          <div className={s.stats}>
            <div className={s.statLink}>
              <Stat
                label={t("sec.score")}
                value={posture.score && !scoreGap ? `${posture.score.percentage}%` : "—"}
                hint={scoreGap ? notCollected : posture.score ? `${posture.score.current} / ${posture.score.max}` : t("sec.scoreNotVisible")}
                tone={posture.score && !scoreGap ? (posture.score.percentage < 40 ? "high" : posture.score.percentage < 70 ? "medium" : "success") : undefined}
              />
            </div>
            {(["High", "Medium", "Low"] as const).map((sev) => {
              const n = resources(sev);
              return (
                <Link key={sev} href="/security/findings" className={s.statLink}>
                  <Stat
                    label={t(`sec.affected${sev}`)}
                    value={recGap ? "—" : (n ?? findings(sev)).toLocaleString()}
                    hint={recGap ? notCollected : n === null
                      ? t("sec.recTypes", { n: kinds(sev) })
                      : t("sec.affectedHint", { n: kinds(sev), f: findings(sev).toLocaleString() })}
                    tone={sev === "High" ? "high" : sev === "Medium" ? "medium" : undefined}
                  />
                </Link>
              );
            })}
            <Link href="/security/threats" className={s.statLink}>
              <Stat label={t("sec.activeThreats")} value={alertsGap ? "—" : posture.alerts.length} hint={alertsGap ? notCollected : t("sec.alertsHint")} />
            </Link>
            <Link href="/security/compliance" className={s.statLink}>
              <Stat
                label={t("sec.failedControls")}
                value={complianceGap || !posture.compliance.length ? "—" : failedControls}
                hint={complianceGap ? notCollected : posture.compliance.length ? t("sec.standards", { n: posture.compliance.length }) : t("sec.noStandardsVisible")}
              />
            </Link>
            <Link href="/security/compliance" className={s.statLink}>
              <Stat label={t("sec.coverage")} value={plansGap ? "—" : `${paidPlans} / ${posture.plans.length}`} hint={plansGap ? notCollected : t("sec.coverageHint", { n: posture.plans.length })} />
            </Link>
          </div>

          <Panel title={t("sec.byDomain")} sub={t("sec.byDomainHint")}>
            {recGap ? (
              <div className={s.dim}>{notCollected}</div>
            ) : (
              <div className={s.domains}>
                {byDomain.map((x) => (
                  <Link key={x.d} href={href(x.d)} className={s.domainCard}>
                    <span className={s.domainName}>{label("sec.domain", x.d)}</span>
                    <span className={s.domainNums}>
                      <span className={s.domainBig}>{x.total.toLocaleString()}</span>
                      <span className={s.domainSub}>{t("sec.recTypes", { n: x.kinds })}</span>
                    </span>
                    <span className={s.domainBar} aria-hidden="true">
                      <span className={s.barHigh} style={{ width: `${(x.high / Math.max(1, x.total)) * 100}%` }} />
                      <span className={s.barMedium} style={{ width: `${(x.medium / Math.max(1, x.total)) * 100}%` }} />
                      <span className={s.barLow} style={{ width: `${(x.low / Math.max(1, x.total)) * 100}%` }} />
                    </span>
                    <span className={s.domainSub}>
                      {t("sec.sev.High")} {x.high} · {t("sec.sev.Medium")} {x.medium} · {t("sec.sev.Low")} {x.low}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <div className={s.split}>
            <Panel title={t("sec.topActions")} actions={<Link href="/security/findings" className={s.linkMore}>{t("sec.viewAll")}</Link>}>
              <ul className={s.list}>
                {top.map((r) => (
                  <li key={r.key} className={s.listItem}>
                    <SeverityBadge severity={r.severity} />
                    <span className={s.listTitle} title={r.title}>{r.title}</span>
                    <span className={s.num}>{t("sec.unhealthyOf", { u: r.unhealthy, t: r.unhealthy + r.healthy })}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t("sec.controls")} sub={t("sec.controlsHint")}>
              {controlsGap
                ? <EmptyState title={notCollected}>{t("sec.controlsFailedHint")}</EmptyState>
                : controls.length === 0 && <EmptyState title={t("sec.controlsEmpty")}>{t("sec.controlsEmptyHint")}</EmptyState>}
              {controls.map((c) => (
                <div key={c.controlName} className={s.control}>
                  <span>{c.controlName}</span>
                  <span className={s.num}>{c.currentScore} / {c.maxScore} · {t("sec.issues", { n: c.unhealthyResourceCount })}</span>
                  <span className={s.track} aria-hidden="true">
                    <span className={s.fill} style={{ display: "block", width: `${(c.currentScore / c.maxScore) * 100}%` }} />
                  </span>
                </div>
              ))}
            </Panel>
          </div>

          <Panel title={t("sec.clusterCardTitle")}>
            <div className={s.cluster}>
              <span>{t("sec.clusterCardBody")}</span>
              <Link href="/policies" className={s.linkMore}>{t("sec.goCluster")} →</Link>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
