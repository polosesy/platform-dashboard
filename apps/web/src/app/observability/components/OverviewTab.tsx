"use client";

import type { ObservabilityOverview } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";
import { WorkloadRow } from "./WorkloadsTab";
import { rgba } from "@/lib/palette";

export function OverviewTab({
  data,
  onWorkloadSelect,
}: {
  data: ObservabilityOverview;
  onWorkloadSelect: (name: string, ns: string) => void;
}) {
  const { t } = useI18n();
  const { nodeSummary, podSummary, topAlertingWorkloads } = data;

  const summaryCards = [
    { label: t("ob.allNodes"), value: nodeSummary.total, sub: `Ready ${nodeSummary.ready} / NotReady ${nodeSummary.notReady}` },
    { label: t("ob.allPods"), value: podSummary.total, sub: undefined },
    { label: t("ob.running"), value: podSummary.running, sub: `${podSummary.total > 0 ? Math.round((podSummary.running / podSummary.total) * 100) : 0}%` },
    { label: t("ob.pending"), value: podSummary.pending, sub: undefined },
    { label: t("ob.failed"), value: podSummary.failed, sub: undefined },
  ];

  return (
    <div>
      {/* Summary Cards */}
      <div className={styles.summaryCards}>
        {summaryCards.map((c) => (
          <div key={c.label} className={styles.summaryCard}>
            <div className={styles.summaryCardLabel}>{c.label}</div>
            <div
              className={styles.summaryCardValue}
              style={{
                color:
                  c.label === "Failed" && c.value > 0 ? rgba("danger", 0.85)
                  : c.label === "Pending" && c.value > 0 ? rgba("warning", 0.85)
                  : undefined,
              }}
            >
              {c.value}
            </div>
            {c.sub && <div className={styles.summaryCardSub}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Top Alerting Workloads */}
      {topAlertingWorkloads.length > 0 && (
        <div>
          <p className={styles.sectionTitle}>{t("ob.topAlerting", { n: topAlertingWorkloads.length })}</p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("ins.col.1")}</th>
                <th>{t("hb.namespace")}</th>
                <th>{t("ob.podStatus")}</th>
                <th>CPU</th>
                <th>{t("ob.memory")}</th>
                <th>{t("ob.errorRate")}</th>
                <th>{t("ob.latency", { p: "p95" })}</th>
              </tr>
            </thead>
            <tbody>
              {topAlertingWorkloads.map((wl) => (
                <WorkloadRow
                  key={`${wl.namespace}/${wl.name}`}
                  wl={wl}
                  selected={false}
                  onClick={() => onWorkloadSelect(wl.name, wl.namespace)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {topAlertingWorkloads.length === 0 && (
        <div className={styles.noDataBanner}>
          <strong>{t("ob.noAlerting")}</strong>
          {t("ob.noAlertingHint")}
        </div>
      )}
    </div>
  );
}
