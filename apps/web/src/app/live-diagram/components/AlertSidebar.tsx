import type { LiveAlert, AlertSeverity } from "@aud/types";
import { defaultTokens } from "../utils/designTokens";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";

type AlertSidebarProps = {
  alerts: LiveAlert[];
  onAlertClick: (alert: LiveAlert) => void;
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

export function AlertSidebar({ alerts, onAlertClick }: AlertSidebarProps) {
  const { t } = useI18n();
  const sorted = [...alerts].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  return (
    <aside className={styles.alertSidebar}>
      <div className={styles.alertTitle}>
        {t("live.alerts")}
        {alerts.length > 0 && <span className={styles.alertBadge}>{alerts.length}</span>}
      </div>

      {sorted.length === 0 ? (
        <div className={styles.alertEmpty}>{t("live.noAlerts")}</div>
      ) : (
        <div className={styles.alertList}>
          {sorted.map((alert) => (
            <button
              key={alert.id}
              className={styles.alertCard}
              onClick={() => onAlertClick(alert)}
              type="button"
            >
              <div className={styles.alertHeader}>
                <span
                  className={styles.alertDot}
                  style={{ background: defaultTokens.colors.alert[alert.severity] }}
                />
                <span className={styles.alertSeverity}>{alert.severity}</span>
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
                  Affects: {alert.affectedNodeIds.join(", ")}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
