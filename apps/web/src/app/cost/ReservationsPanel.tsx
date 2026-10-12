"use client";

import { useState } from "react";
import type { AzureSubscriptionOption, ReservationUtilizationResponse } from "@aud/types";
import { EmptyState, ErrorNotice, Panel, Segmented, Stat } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import styles from "./styles.module.css";

type Grain = "daily" | "monthly";

/** Reserved-instance utilization (moved here from the architecture inspector — it is a cost signal). */
export function ReservationsPanel({ subscriptionId, subscriptions }: { subscriptionId: string; subscriptions: AzureSubscriptionOption[] }) {
  const { t } = useI18n();
  const [grain, setGrain] = useState<Grain>("monthly");
  const { data, error, loading } = useApiQuery(subscriptionId ? `ri:${subscriptionId}:${grain}` : null, (token) =>
    fetchJsonWithBearer<ReservationUtilizationResponse>(apiUrl("/api/reservations/utilization", { grain, subscriptionId }), token),
  );
  const nameOf = (id: string) => subscriptions.find((s) => s.subscriptionId === id)?.name ?? `…${id.slice(-4)}`;

  return (
    <Panel
      title={t("cost.ri.title")}
      actions={
        <Segmented
          label={t("cost.ri.grain")}
          value={grain}
          onChange={setGrain}
          items={[{ id: "monthly", label: t("cost.ri.monthly") }, { id: "daily", label: t("cost.ri.daily") }]}
        />
      }
    >
      <ErrorNotice error={error} />
      {data ? (
        <div className={styles.riBody}>
          <div className={styles.riStats}>
            <Stat label={t("cost.ri.utilization")} value={`${data.utilizedPercentage.toFixed(1)}%`} />
            <Stat label={t("cost.ri.hours")} value={`${Math.round(data.usedHours).toLocaleString()} / ${Math.round(data.reservedHours).toLocaleString()}`} />
          </div>
          {data.note ? <div className={styles.riNote}>{data.note}</div> : null}
          {data.subscriptions.length ? (
            <ul className={styles.riList}>
              {[...data.subscriptions].sort((a, b) => b.reservedHours - a.reservedHours).slice(0, 6).map((s) => (
                <li key={s.subscriptionId}>
                  <span>{nameOf(s.subscriptionId)}</span>
                  <b>{s.utilizedPercentage.toFixed(1)}%</b>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("cost.ri.none")} />
          )}
        </div>
      ) : loading ? null : !error ? <EmptyState title={t("cost.ri.none")} /> : null}
    </Panel>
  );
}
