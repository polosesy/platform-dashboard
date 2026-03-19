"use client";

import type { ObservabilityOverview } from "@aud/types";
import styles from "../styles.module.css";
import { WorkloadRow } from "./WorkloadsTab";

export function OverviewTab({
  data,
  onWorkloadSelect,
}: {
  data: ObservabilityOverview;
  onWorkloadSelect: (name: string, ns: string) => void;
}) {
  const { nodeSummary, podSummary, topAlertingWorkloads } = data;

  const summaryCards = [
    { label: "전체 노드", value: nodeSummary.total, sub: `Ready ${nodeSummary.ready} / NotReady ${nodeSummary.notReady}` },
    { label: "전체 파드", value: podSummary.total, sub: undefined },
    { label: "Running", value: podSummary.running, sub: `${podSummary.total > 0 ? Math.round((podSummary.running / podSummary.total) * 100) : 0}%` },
    { label: "Pending", value: podSummary.pending, sub: undefined },
    { label: "Failed", value: podSummary.failed, sub: undefined },
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
                  c.label === "Failed" && c.value > 0 ? "rgba(196,43,28,0.85)"
                  : c.label === "Pending" && c.value > 0 ? "rgba(209,132,0,0.85)"
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
          <p className={styles.sectionTitle}>주의 워크로드 Top {topAlertingWorkloads.length}</p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>워크로드</th>
                <th>네임스페이스</th>
                <th>파드 상태</th>
                <th>CPU</th>
                <th>메모리</th>
                <th>에러율</th>
                <th>p95 레이턴시</th>
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
          <strong>주의 워크로드 없음</strong>
          모든 워크로드가 정상 상태이거나 데이터를 수집 중입니다.
        </div>
      )}
    </div>
  );
}
