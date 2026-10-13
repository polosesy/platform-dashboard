"use client";

import { EmptyState, LoadingState, Notice, Panel } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useSecurity } from "../SecurityContext";
import { PostureNotices, SecurityHeader, SeverityBadge, relativeTime, useGap, useLabel } from "../components";
import s from "../security.module.css";

/** 위협 탐지 — active Defender alerts and which plans leave detection off. */
export default function SecurityThreatsPage() {
  const { t, locale } = useI18n();
  const label = useLabel();
  const { posture } = useSecurity();
  const alertsGap = useGap("alerts");
  const freePlans = (posture?.plans ?? []).filter((p) => p.tier !== "Standard").map((p) => p.name);

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
        <Panel title={t("sec.alerts")} sub={String(posture.alerts.length)} flush>
          <div className={`${s.tableWrap} ${s.tableFlush}`}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">{t("sec.col.severity")}</th>
                  <th scope="col">{t("sec.col.finding")}</th>
                  <th scope="col">{t("sec.col.intent")}</th>
                  <th scope="col">{t("sec.col.target")}</th>
                  <th scope="col">{t("sec.col.detected")}</th>
                </tr>
              </thead>
              <tbody>
                {posture.alerts.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td>
                      <div className={s.alertTitle}>{a.title}</div>
                      {a.description ? <div className={s.alertDesc}>{a.description}</div> : null}
                    </td>
                    <td>{(a.intent ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => <div key={x}>{label("sec.intent", x)}</div>)}</td>
                    <td>
                      {a.resources.map((r, i) => (
                        <div key={`${r.name}-${i}`}>
                          <span className={s.sampleName}>{r.name}</span> <span className={s.dim}>{r.type}{r.resourceGroup ? ` · ${r.resourceGroup}` : ""}</span>
                        </div>
                      ))}
                    </td>
                    <td title={a.detectedAt ? new Date(a.detectedAt).toLocaleString(dateLocale(locale)) : undefined} style={{ whiteSpace: "nowrap" }}>
                      {a.detectedAt ? relativeTime(a.detectedAt, t) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
