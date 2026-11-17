"use client";

// 리소스 보안 카드 (API /api/security/resource-card, security-roadmap 5.3 ④) — every security fact about one Azure
// resource: Defender recommendations (own + child images / containers), active alerts, exposure, what it can do (its
// managed identities' roles), who can act on it (role assignments covering it), and the combination / attack path it is
// in. A section not read says so ("읽지 못함") — never "none". Used by 통합 위험 and the infrastructure diagram.

import { useState } from "react";
import type { ResourceSecurityCard as Card } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Chip, ErrorNotice, LinkButton, LoadingState } from "@/components/ui";
import type { ChipLevel } from "@/components/ui";
import s from "./ResourceSecurityCard.module.css";

const SEV_TONE = { High: "high", Medium: "medium", Low: "low" } as const;
const CLASS_CHIP: Record<string, ChipLevel> = { privileged: "danger", data: "warn", keys: "warn", other: "neutral" };
const SHOW = 10;

export function ResourceSecurityCard({ resourceId }: { resourceId: string }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(`resource-card:${resourceId.toLowerCase()}`, (token) =>
    fetchJsonWithBearer<Card>(apiUrl("/api/security/resource-card", { resourceId }), token));
  const [allRecs, setAllRecs] = useState(false);
  const d = q.data?.resourceId === resourceId.toLowerCase() ? q.data : null;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("rsc.loading")} />;
  const unread = <span className={s.dim}>{t("rsc.unread")}</span>;
  const e = d.exposure.factor;
  const recs = allRecs ? d.recommendations.items : d.recommendations.items.slice(0, SHOW);
  const when = (iso: string) => (iso ? new Date(iso).toLocaleString(dateLocale(locale)) : "—");
  return (
    <section className={s.card} aria-label={t("rsc.title", { name: d.resource.name })}>
      <header className={s.head}>
        <strong>{d.resource.name}</strong>
        <span className={s.dim}>{d.resource.type} · {d.resource.resourceGroup}</span>
        <a href={d.resource.portalUrl} target="_blank" rel="noreferrer noopener">{t("azr.portal")}</a>
      </header>
      {!d.resource.found ? <p className={s.dim}>{t("rsc.notFound")}</p> : null}
      <div className={s.facts}>
        <Chip level={e?.state === "yes" ? "warn" : e?.state === "no" ? "ok" : "unknown"}>
          {t("azr.factor.exposure")}: {d.exposure.section === "na" ? t("azr.state.na") : e ? (e.state === "yes" ? (e.limited ? t("azr.exposure.limited") : t("azr.exposure.any")) : t(`azr.state.${e.state}`)) : t("rsc.unreadShort")}
        </Chip>
        <Chip level={d.recommendations.counts.high ? "danger" : "ok"}>{t("rsc.chip.high", { n: d.recommendations.counts.high })}</Chip>
        <Chip level={d.alerts.items.length ? "danger" : "ok"}>{t("rsc.chip.alerts", { n: d.alerts.items.length })}</Chip>
        <Chip level={d.identity.roles.some((r) => r.class !== "other") ? "warn" : "neutral"}>{t("rsc.chip.identity", { n: d.identity.principals })}</Chip>
        {d.combo ? <Chip level="danger">{t(`rsc.combo.${d.combo.kind}`)}</Chip> : null}
        {d.path ? <Chip level="warn">{t(`rsc.path.${d.path.ends}`)}</Chip> : null}
      </div>

      <h4 className={s.h}>{t("rsc.recs")}</h4>
      {d.recommendations.state !== "ok" ? unread : (
        <>
          <p className={s.dim}>{t("rsc.recCounts", { u: d.recommendations.counts.unhealthy, h: d.recommendations.counts.high, m: d.recommendations.counts.medium, l: d.recommendations.counts.low, ok: d.recommendations.counts.healthy, na: d.recommendations.counts.notApplicable })}</p>
          {recs.length ? (
            <ul className={s.list}>
              {recs.map((r) => (
                <li key={`${r.severity}:${r.name}`}>
                  <Badge tone={SEV_TONE[r.severity]}>{t(`rsc.sev.${r.severity}`)}</Badge> {r.name}
                  {!r.onSelf || r.entities > 1 ? <span className={s.dim}> · {t("rsc.entities", { n: r.entities })}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className={s.dim}>{t("rsc.noRecs")}</p>}
          {d.recommendations.items.length > SHOW ? <LinkButton onClick={() => setAllRecs(!allRecs)}>{allRecs ? t("rsc.less") : t("rsc.more", { n: d.recommendations.items.length })}</LinkButton> : null}
        </>
      )}

      <h4 className={s.h}>{t("rsc.alerts")}</h4>
      {d.alerts.state !== "ok" ? unread : d.alerts.items.length ? (
        <ul className={s.list}>{d.alerts.items.map((a, i) => <li key={i}><Badge tone={a.severity === "High" ? "high" : a.severity === "Medium" ? "medium" : "low"}>{a.severity}</Badge> {a.title} <span className={s.dim}>· {a.status} · {when(a.at)}</span></li>)}</ul>
      ) : <p className={s.dim}>{t("rsc.noAlerts")}</p>}

      <h4 className={s.h}>{t("rsc.exposure")}</h4>
      {d.exposure.section === "failed" ? unread : d.exposure.section === "na" ? <p className={s.dim}>{t("rsc.exposureNa")}</p>
        : <p className={s.dim}>{e?.detail ?? (e?.reason ? t("azr.unknownWhy", { r: e.reason }) : "—")}</p>}

      <h4 className={s.h}>{t("rsc.canDo")}</h4>
      {d.identity.state === "failed" ? unread : d.identity.state === "na" ? <p className={s.dim}>{t("rsc.noIdentity")}</p> : d.identity.roles.length ? (
        <ul className={s.list}>{d.identity.roles.map((r, i) => <li key={i}><Chip level={CLASS_CHIP[r.class]!} glyph={false}>{t(`rsc.class.${r.class}`)}</Chip> {r.roleName} @ {t(`azr.scope.${r.scope}`)}{r.scopeName ? ` ${r.scopeName}` : ""}</li>)}</ul>
      ) : <p className={s.dim}>{t("rsc.noRoles", { n: d.identity.principals })}</p>}

      <h4 className={s.h}>{t("rsc.whoCan")}</h4>
      {d.access.state !== "ok" ? unread : d.access.byClass.length ? (
        <>
          <p className={s.dim}>{d.access.byClass.map((c) => t("rsc.byClass", { c: t(`rsc.class.${c.class}`), a: c.assignments, p: c.principals })).join(" · ")}</p>
          <ul className={s.list}>{d.access.items.map((r, i) => <li key={i}><Chip level={CLASS_CHIP[r.class]!} glyph={false}>{t(`rsc.class.${r.class}`)}</Chip> {r.roleName} · {r.principalType} …{r.principalTail} @ {t(`azr.scope.${r.scope}`)}</li>)}</ul>
        </>
      ) : <p className={s.dim}>{t("rsc.noAccess")}</p>}
      <p className={s.foot}>{t("rsc.foot", { at: when(d.generatedAt) })}</p>
    </section>
  );
}
