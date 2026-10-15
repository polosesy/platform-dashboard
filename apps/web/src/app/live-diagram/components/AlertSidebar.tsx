"use client";

import { useState } from "react";
import type { LiveAlert, AlertSeverity, FaultImpact } from "@aud/types";
import { defaultTokens } from "../utils/designTokens";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
import { Segmented } from "@/components/ui";
import { FaultTimeline } from "./FaultTimeline";

type AlertSidebarProps = {
  alerts: LiveAlert[];
  onAlertClick: (alert: LiveAlert) => void;
  /** Fault impacts in view — listed only while the "장애 영향" toggle is on */
  impacts: FaultImpact[];
  nodeLabel: (id: string) => string;
  onNodeClick: (id: string) => void;
};

function severityOrder(s: AlertSeverity): number {
  switch (s) {
    case "critical": return 0;
    case "warning": return 1;
    case "info": return 2;
  }
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;
function timeAgo(iso: string, t: TFn): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return t("common.secondsAgo", { n: Math.max(0, sec) });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("common.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("common.hoursAgo", { n: hr });
  return t("common.daysAgo", { n: Math.floor(hr / 24) });
}

export function AlertSidebar({ alerts, onAlertClick, impacts, nodeLabel, onNodeClick }: AlertSidebarProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"list" | "timeline">("list");
  const sorted = [...alerts].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  return (
    <aside className={styles.alertSidebar}>
      <div className={styles.alertTitle}>
        {t("live.alerts")}
        {alerts.length > 0 && <span className={styles.alertBadge}>{alerts.length}</span>}
        <span className={styles.alertTabs}>
          <Segmented
            label={t("live.alerts")}
            value={tab}
            onChange={setTab}
            items={[{ id: "list", label: t("ld.alert.list") }, { id: "timeline", label: t("live.timeline") }]}
          />
        </span>
      </div>

      <div className={styles.alertBody}>
        {/* What this tab shows — the two tabs read the same active alerts */}
        <p className={styles.alertHint}>{t(tab === "timeline" ? "ld.alert.timelineHint" : "ld.alert.listHint")}</p>
        {impacts.length > 0 && (
          <section className={styles.impactList} aria-label={t("ld.impact.title")}>
            <div className={styles.impactListTitle}>{t("ld.impact.title")}</div>
            {impacts.map((fi) => (
              <div key={fi.sourceNodeId} className={styles.impactItem}>
                <button type="button" className={styles.impactSource} onClick={() => onNodeClick(fi.sourceNodeId)}>
                  <span className={styles.impactBadge} data-impact="source">{t("ld.impact.sourceBadge")}</span>
                  <span className={styles.impactName}>{nodeLabel(fi.sourceNodeId)}</span>
                  <span className={styles.impactTrigger}>{t(fi.trigger === "alert" ? "ld.impact.byAlert" : "ld.impact.byMetric")}</span>
                </button>
                <div className={styles.impactCount}>{t("ld.impact.affected", { n: fi.affectedNodeIds.length })}</div>
                {fi.affectedNodeIds.length > 0 && (
                  <div className={styles.impactNeighbours}>
                    {fi.affectedNodeIds.map((id) => (
                      <button key={id} type="button" className={styles.impactNeighbour} onClick={() => onNodeClick(id)}>
                        {nodeLabel(id)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {tab === "timeline" ? (
          <FaultTimeline alerts={alerts} onAlertClick={onAlertClick} />
        ) : sorted.length === 0 ? (
          <div className={styles.alertEmpty}>{t("live.noAlerts")}</div>
        ) : (
          <div className={styles.alertList}>
            {sorted.map((alert) => (
              <button key={alert.id} className={styles.alertCard} onClick={() => onAlertClick(alert)} type="button">
                <div className={styles.alertHeader}>
                  <span className={styles.alertDot} style={{ background: defaultTokens.colors.alert[alert.severity] }} />
                  <span className={styles.alertSeverity}>{t(`ld.sev.${alert.severity}`)}</span>
                  <span className={styles.alertTime}>{timeAgo(alert.firedAt, t)}</span>
                </div>
                <div className={styles.alertName}>{alert.title}</div>
                <div className={styles.alertSummary}>{alert.summary}</div>
                {alert.rootCauseCandidates && alert.rootCauseCandidates.length > 0 && (
                  <div className={styles.alertCauses}>
                    <span className={styles.alertCausesLabel}>{t("ld.alert.causes")}:</span>
                    {alert.rootCauseCandidates.map((c) => (
                      <span key={c} className={styles.alertCause}>{c}</span>
                    ))}
                  </div>
                )}
                {alert.affectedNodeIds.length > 0 && (
                  <div className={styles.alertAffected}>
                    {t("ld.alert.affects")}: {alert.affectedNodeIds.map(nodeLabel).join(", ")}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
