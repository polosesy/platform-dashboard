"use client";

import type { ObservabilityDataSourceStatus } from "@aud/types";
import styles from "../styles.module.css";

export function DataSourceBadges({ status }: { status: ObservabilityDataSourceStatus }) {
  const badges = [
    { label: "Container Insights", ok: status.containerInsights },
    { label: "Prometheus", ok: status.prometheus },
    { label: "App Insights", ok: status.appInsights },
  ];
  return (
    <div className={styles.dsBadges}>
      <span style={{ fontSize: 11, color: "rgba(20,21,23,0.4)", marginRight: 4 }}>데이터 소스:</span>
      {badges.map((b) => (
        <span key={b.label} className={`${styles.dsBadge} ${b.ok ? styles.dsBadgeOk : styles.dsBadgeOff}`}>
          {b.ok ? "✓" : "–"} {b.label}
        </span>
      ))}
    </div>
  );
}
