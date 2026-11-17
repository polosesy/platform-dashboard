"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { PostureDomain } from "@aud/types";
import { EmptyState, LoadingState, Panel, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "./SecurityContext";
import { DOMAINS, PostureNotices, SecurityHeader, SeverityBadge, useGap, useLabel } from "./components";
import { ScopePicker, TeamSummaryPanel, bucketName, useTeamScope } from "./TeamScope";
import s from "./security.module.css";

/**
 * 보안 개요 — Wiz-style posture overview: score, open findings by severity, areas, threats, coverage. With a team chosen
 * (security-roadmap 5.7 ⑤) the numbers that split by resource group are that team's (owner rules — the issue list's
 * `teamOf`); the score, controls, compliance and plans are subscription-level and say so.
 */
export default function SecurityOverviewPage() {
  const { t } = useI18n();
  const label = useLabel();
  const { posture, subscriptionId } = useSecurity();
  const recGap = useGap("recommendations");
  const complianceGap = useGap("compliance");
  const plansGap = useGap("plans");
  const alertsGap = useGap("alerts");
  const scoreGap = useGap("score");
  const controlsGap = useGap("controls");

  const recs = useMemo(() => posture?.recommendations ?? [], [posture]);
  const team = useTeamScope(subscriptionId, !!posture && posture.source !== "mock", recs);
  const b = team.bucket; // null = the whole subscription
  const teamNote = b ? t("sec.team.subscriptionWide") : null;
  // Findings = sum of unhealthy over recommendations (a resource once per recommendation); resources = distinct ids
  const findings = (sev: string) => recs.filter((r) => r.severity === sev).reduce((n, r) => n + r.unhealthy, 0);
  const resources = (sev: "High" | "Medium" | "Low") => posture?.affected?.[sev] ?? null;
  const kinds = (sev: string) => recs.filter((r) => r.severity === sev).length;
  const failedControls = (posture?.compliance ?? []).reduce((n, c) => n + c.failed, 0);
  const paidPlans = (posture?.plans ?? []).filter((p) => p.tier === "Standard").length;
  const notCollected = t("sec.collectFailed");

  const byDomainAll = DOMAINS.map((d) => {
    const rs = recs.filter((r) => r.domain === d);
    const sum = (sev?: string) => rs.filter((r) => !sev || r.severity === sev).reduce((n, r) => n + r.unhealthy, 0);
    return { d, kinds: rs.length, total: sum(), high: sum("High"), medium: sum("Medium"), low: sum("Low") };
  }).filter((x) => x.kinds > 0);
  const byDomain = b ? DOMAINS.map((d) => b.byDomain.find((x) => x.d === d)).filter((x): x is NonNullable<typeof x> => !!x && x.kinds > 0) : byDomainAll;
  const href = (d: PostureDomain) => (d === "identity" ? "/security/identity" : `/security/findings?domain=${d}`);

  const top = b ? b.top.slice(0, 6).map((x) => ({ key: x.key, title: x.title, severity: x.severity, text: t("sec.team.findingsN", { n: x.n.toLocaleString() }) }))
    : recs.slice(0, 6).map((r) => ({ key: r.key, title: r.title, severity: r.severity, text: t("sec.unhealthyOf", { u: r.unhealthy, t: r.unhealthy + r.healthy }) }));
  // Secure score, its controls and compliance standards are subscription-level resources: a connection that reads
  // only some resource groups sees none of them (no rows — not an error, not zero)
  const controls = (posture?.controls ?? []).filter((c) => c.maxScore > 0);

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      {posture && posture.source !== "mock" ? (
        <div className={s.scopeBar}>
          <ScopePicker view={team.view} scope={team.scope} pick={team.pick} />
          {b ? <span className={s.dim}>{t("sec.team.scopeHint", { name: bucketName(t, b.id), g: b.groups.length })}</span> : null}
        </div>
      ) : null}

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
                hint={teamNote ?? (scoreGap ? notCollected : posture.score ? `${posture.score.current} / ${posture.score.max}` : t("sec.scoreNotVisible"))}
                tone={posture.score && !scoreGap ? (posture.score.percentage < 40 ? "high" : posture.score.percentage < 70 ? "medium" : "success") : undefined}
              />
            </div>
            {(["High", "Medium", "Low"] as const).map((sev) => {
              const n = b ? b.affected?.[sev] ?? null : resources(sev);
              const teamGap = !!b && (!b.affected || !b.findings);
              return (
                <Link key={sev} href="/security/findings" className={s.statLink}>
                  <Stat
                    label={t(`sec.affected${sev}`)}
                    value={(b ? teamGap || !b.rgRules : recGap) || n === null ? "—" : n.toLocaleString()}
                    hint={b ? (teamGap ? notCollected : !b.rgRules ? t("sec.team.nsOnly") : t("sec.team.affectedHint", { f: (b.findings?.[sev] ?? 0).toLocaleString() }))
                      : recGap ? notCollected : n === null
                      ? t("sec.affectedUnread", { n: kinds(sev), f: findings(sev).toLocaleString() })
                      : t("sec.affectedHint", { n: kinds(sev), f: findings(sev).toLocaleString() })}
                    tone={sev === "High" ? "high" : sev === "Medium" ? "medium" : undefined}
                  />
                </Link>
              );
            })}
            <Link href="/security/threats" className={s.statLink}>
              {b ? (
                <Stat label={t("sec.activeThreats")} value={!b.alerts || !b.rgRules ? "—" : b.alerts.total}
                  hint={!b.alerts ? notCollected : !b.rgRules ? t("sec.team.nsOnly") : t("sec.team.alertsHint")} />
              ) : (
                <Stat label={t("sec.activeThreats")} value={alertsGap ? "—" : `${posture.alerts.length}${posture.alertsTruncated ? "+" : ""}`}
                  hint={alertsGap ? notCollected : posture.alertsTruncated ? t("sec.alertsTruncated", { n: posture.alerts.length }) : t("sec.alertsHint")} />
              )}
            </Link>
            <Link href="/security/compliance" className={s.statLink}>
              <Stat
                label={t("sec.failedControls")}
                value={complianceGap || !posture.compliance.length ? "—" : failedControls}
                hint={teamNote ?? (complianceGap ? notCollected : posture.compliance.length ? t("sec.standards", { n: posture.compliance.length }) : t("sec.noStandardsVisible"))}
              />
            </Link>
            <Link href="/security/compliance" className={s.statLink}>
              <Stat label={t("sec.coverage")} value={plansGap || !posture.plans.length ? "—" : `${paidPlans} / ${posture.plans.length}`}
                hint={teamNote ?? (plansGap ? notCollected : posture.plans.length ? t("sec.coverageHint", { n: posture.plans.length })
                  : posture.resourcePlans?.length ? t("sec.plansResourceOnly", { n: posture.resourcePlans.length }) : t("sec.plansNotVisible"))} />
            </Link>
          </div>

          <Panel title={t("sec.byDomain")} sub={b ? t("sec.team.panelSub", { name: bucketName(t, b.id) }) : t("sec.byDomainHint")}>
            {(b ? !b.findings : recGap) ? (
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
            <Panel title={t("sec.topActions")} sub={b ? t("sec.team.panelSub", { name: bucketName(t, b.id) }) : undefined} actions={<Link href="/security/findings" className={s.linkMore}>{t("sec.viewAll")}</Link>}>
              <ul className={s.list}>
                {top.map((r) => (
                  <li key={r.key} className={s.listItem}>
                    <SeverityBadge severity={r.severity} />
                    <span className={s.listTitle} title={r.title}>{r.title}</span>
                    <span className={s.num}>{r.text}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t("sec.controls")} sub={teamNote ?? t("sec.controlsHint")}>
              {controlsGap
                ? <EmptyState title={notCollected}>{t("sec.controlsFailedHint")}</EmptyState>
                : controls.length === 0 && <EmptyState title={t("sec.controlsEmpty")}>{t("sec.controlsEmptyHint")}</EmptyState>}
              {controls.map((c) => (
                <div key={c.controlName} className={s.control}>
                  <span>{c.controlName}</span>
                  <span className={s.num}>{c.currentScore} / {c.maxScore} · {t("sec.unhealthyResources", { n: c.unhealthyResourceCount })}</span>
                  <span className={s.track} aria-hidden="true">
                    <span className={s.fill} style={{ display: "block", width: `${(c.currentScore / c.maxScore) * 100}%` }} />
                  </span>
                </div>
              ))}
            </Panel>
          </div>

          {posture.source !== "mock" ? <TeamSummaryPanel q={team.q} view={team.view} data={team.data} scope={team.scope} pick={team.pick} /> : null}

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
