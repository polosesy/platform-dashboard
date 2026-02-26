import type { LiveAlert, AlertSeverity } from "@aud/types";
import { defaultTokens } from "../utils/designTokens";
import styles from "../styles.module.css";

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

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export function AlertSidebar({ alerts, onAlertClick }: AlertSidebarProps) {
  const sorted = [...alerts].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  return (
    <aside className={styles.alertSidebar}>
      <div className={styles.alertTitle}>
        Alerts
        {alerts.length > 0 && <span className={styles.alertBadge}>{alerts.length}</span>}
      </div>

      {sorted.length === 0 ? (
        <div className={styles.alertEmpty}>No active alerts.</div>
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
                <span className={styles.alertTime}>{timeAgo(alert.firedAt)}</span>
              </div>
              <div className={styles.alertName}>{alert.title}</div>
              <div className={styles.alertSummary}>{alert.summary}</div>
              {alert.rootCauseCandidates && alert.rootCauseCandidates.length > 0 && (
                <div className={styles.alertCauses}>
                  <span className={styles.alertCausesLabel}>Possible causes:</span>
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
