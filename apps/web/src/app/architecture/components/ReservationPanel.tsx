import type { ReservationUtilizationResponse } from "@aud/types";
import styles from "../styles.module.css";

type ReservationPanelProps = {
  riGrain: "daily" | "monthly";
  setRiGrain: (grain: "daily" | "monthly") => void;
  ri: ReservationUtilizationResponse | null;
};

export function ReservationPanel({ riGrain, setRiGrain, ri }: ReservationPanelProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Reservations</div>
      <div className={styles.row}>
        <div className={styles.key}>Grain</div>
        <div className={styles.value}>
          <select
            className={styles.selectInline}
            value={riGrain}
            onChange={(e) => setRiGrain(e.target.value as "daily" | "monthly")}
          >
            <option value="daily">daily</option>
            <option value="monthly">monthly</option>
          </select>
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.key}>Utilization</div>
        <div className={styles.value}>{ri ? `${ri.utilizedPercentage.toFixed(1)}%` : "-"}</div>
      </div>
      <div className={styles.row}>
        <div className={styles.key}>Hours</div>
        <div className={styles.value}>{ri ? `${Math.round(ri.usedHours)}/${Math.round(ri.reservedHours)}` : "-"}</div>
      </div>
      {ri?.note ? (
        <div className={styles.row}>
          <div className={styles.key}>Note</div>
          <div className={styles.value}>{ri.note}</div>
        </div>
      ) : null}

      {ri?.subscriptions?.length ? (
        <div className={styles.miniTable}>
          {ri.subscriptions
            .slice()
            .sort((a, b) => b.reservedHours - a.reservedHours)
            .slice(0, 6)
            .map((s) => (
              <div key={s.subscriptionId} className={styles.miniRow}>
                <div className={styles.miniPair}>{s.subscriptionId}</div>
                <div className={styles.miniVal}>{s.utilizedPercentage.toFixed(1)}%</div>
              </div>
            ))}
        </div>
      ) : (
        <div className={styles.inspectorEmpty}>No reservation data.</div>
      )}
    </div>
  );
}
