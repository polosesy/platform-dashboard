"use client";

import { useMemo, useState } from "react";
import type { PostureAlert } from "@aud/types";
import { EmptyState, LoadingState, Notice, Panel, SearchInput, Segmented } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { groupAlerts, matchesAlert } from "@/lib/alertGroups";
import { useSecurity } from "../SecurityContext";
import { PostureNotices, SecurityHeader, SeverityBadge, relativeTime, useGap, useLabel } from "../components";
import s from "../security.module.css";

type SevFilter = "all" | PostureAlert["severity"];
const SEVS: PostureAlert["severity"][] = ["High", "Medium", "Low", "Informational"];

/**
 * 위협 탐지 — active Defender alerts for triage: the same detection on several containers is one row (×n), each row
 * says what / where / when without scrolling sideways; description, remediation and instances open below.
 */
export default function SecurityThreatsPage() {
  const { t, locale } = useI18n();
  const label = useLabel();
  const { posture } = useSecurity();
  const alertsGap = useGap("alerts");
  const freePlans = (posture?.plans ?? []).filter((p) => p.tier !== "Standard").map((p) => p.name);
  const [sev, setSev] = useState<SevFilter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const groups = useMemo(() => groupAlerts(posture?.alerts ?? []), [posture]);
  const shown = groups.filter((g) => (sev === "all" || g.severity === sev) && matchesAlert(g, q));
  const count = (v: SevFilter) => (v === "all" ? posture?.alerts.length ?? 0 : (posture?.alerts ?? []).filter((a) => a.severity === v).length);
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      {freePlans.length ? (
        <Notice tone="warning">
          {t("sec.freePlans")} {freePlans.join(", ")}
        </Notice>
      ) : null}
      {!posture ? (
        <LoadingState />
      ) : alertsGap ? (
        <EmptyState title={t("sec.collectFailed")} />
      ) : posture.alerts.length === 0 ? (
        <EmptyState title={t("sec.noAlerts")}>{freePlans.length ? t("sec.noAlertsCaveat") : null}</EmptyState>
      ) : (
        <Panel title={t("sec.alerts")} sub={t("sec.alert.groups", { n: posture.alerts.length, g: groups.length })}>
          <div className={s.alertBar}>
            <Segmented label={t("sec.col.severity")} value={sev} onChange={setSev}
              items={(["all", ...SEVS] as SevFilter[]).filter((v) => v === "all" || count(v) > 0).map((v) => ({
                id: v, label: `${v === "all" ? t("sec.alert.all") : t(`sec.sev.${v}`)} ${count(v)}`,
              }))} />
            <SearchInput label={t("sec.alert.search")} value={q} onChange={setQ} placeholder={t("sec.alert.searchHint")} />
          </div>
          {shown.length === 0 ? <EmptyState title={t("sec.alert.noMatch")} /> : (
            <ul className={s.rows}>
              {shown.map((g) => {
                const isOpen = open === g.key;
                const a0 = g.items[0]!;
                return (
                  <li key={g.key} className={s.row} data-open={isOpen || undefined}>
                    <button type="button" className={s.alertHead} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.key)}>
                      <SeverityBadge severity={g.severity} />
                      <span className={s.alertMain}>
                        <span className={s.alertTitle}>
                          {g.title}
                          {g.items.length > 1 ? <span className={s.alertTimes}>{t("sec.alert.times", { n: g.items.length })}</span> : null}
                        </span>
                        {a0.description ? <span className={s.alertDesc}>{a0.description}</span> : null}
                        <span className={s.alertMeta}>
                          {g.resources.slice(0, 3).map((r) => <span key={r} className={s.chip} title={r}>{r}</span>)}
                          {g.resources.length > 3 ? <span className={s.chip}>+{g.resources.length - 3}</span> : null}
                          {g.intents.map((i) => <span key={i} className={s.chipThreat}>{label("sec.intent", i)}</span>)}
                        </span>
                      </span>
                      <span className={s.alertWhen} title={when(g.lastAt)}>{relativeTime(g.lastAt, t)}</span>
                    </button>
                    {isOpen && (
                      <div className={s.alertBody}>
                        {a0.description ? <p className={s.alertFull}>{a0.description}</p> : null}
                        {a0.remediation?.length ? (
                          <>
                            <h4 className={s.alertH}>{t("sec.alert.remediation")}</h4>
                            <ol className={s.alertSteps}>{a0.remediation.map((r, i) => <li key={i}>{r}</li>)}</ol>
                          </>
                        ) : null}
                        <h4 className={s.alertH}>{t("sec.alert.instances", { n: g.items.length })}</h4>
                        <ul className={s.alertInstances}>
                          {g.items.map((a) => (
                            <li key={a.id}>
                              <span className={s.dim}>{when(a.detectedAt)}</span>{" "}
                              {a.k8s ? <strong>{[a.k8s.namespace, a.k8s.pod, a.k8s.container].filter(Boolean).join(" / ")}</strong> : null}
                              {a.resources.map((r, i) => <span key={i} className={s.alertRes}>{r.name} <span className={s.dim}>{r.type}{r.resourceGroup ? ` · ${r.resourceGroup}` : ""}</span></span>)}
                              {a.entity && !a.k8s ? <span className={s.alertRes}>{t("sec.alert.entity")}: {a.entity}</span> : null}
                              <span className={s.dim}> · {a.status}</span>
                              {a.portalUrl ? <a className={s.alertLink} href={a.portalUrl} target="_blank" rel="noreferrer">{t("sec.alert.portal")} ↗</a> : null}
                            </li>
                          ))}
                        </ul>
                        <p className={s.dim}>{t("sec.alert.span", { first: when(g.firstAt), last: when(g.lastAt) })}</p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
