"use client";

import type { NodeResourceSummary } from "@aud/types";
import styles from "../styles.module.css";

function GaugeBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span style={{ fontSize: 11, color: "rgba(20,21,23,0.35)" }}>N/A</span>;
  const clamped = Math.min(100, Math.round(pct));
  const cls = clamped >= 85 ? styles.gaugeCrit : clamped >= 70 ? styles.gaugeWarn : styles.gaugeOk;
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeBar}>
        <div className={`${styles.gaugeFill} ${cls}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={styles.gaugeLabel}>{clamped}%</span>
    </div>
  );
}

function NodeStatusBadge({ status }: { status: NodeResourceSummary["status"] }) {
  const cls =
    status === "Ready" ? styles.nodeReady :
    status === "NotReady" ? styles.nodeNotReady :
    styles.nodeUnknown;
  return <span className={`${styles.nodeStatusBadge} ${cls}`}>{status}</span>;
}

function PressureIndicators({ conditions }: { conditions: NodeResourceSummary["conditions"] }) {
  const pressures = conditions.filter(
    (c) => c.type !== "Ready" && c.status === "True"
  );
  if (pressures.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
      {pressures.map((c) => (
        <span
          key={c.type}
          style={{
            fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
            background: "rgba(196,43,28,0.08)", color: "rgba(196,43,28,0.80)",
            border: "1px solid rgba(196,43,28,0.15)",
          }}
        >
          {c.type}
        </span>
      ))}
    </div>
  );
}

export function InfraTab({ nodes }: { nodes: NodeResourceSummary[] }) {
  if (nodes.length === 0) {
    return (
      <div className={styles.noDataBanner}>
        <strong>노드 데이터 없음</strong>
        Container Insights가 연결되어 있지 않거나 노드를 수집하지 않습니다.
      </div>
    );
  }

  const ready = nodes.filter((n) => n.status === "Ready").length;
  const notReady = nodes.filter((n) => n.status === "NotReady").length;

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 20, fontSize: 13, color: "rgba(20,21,23,0.6)" }}>
        <span>전체 <strong style={{ color: "var(--fg)" }}>{nodes.length}</strong> 노드</span>
        <span style={{ color: "rgba(16,137,62,0.85)" }}>Ready: <strong>{ready}</strong></span>
        {notReady > 0 && <span style={{ color: "rgba(196,43,28,0.85)" }}>NotReady: <strong>{notReady}</strong></span>}
      </div>

      <div className={styles.nodeGrid}>
        {nodes.map((node) => (
          <div key={node.name} className={styles.nodeCard}>
            <div className={styles.nodeCardHeader}>
              <span className={styles.nodeName}>{node.name}</span>
              <NodeStatusBadge status={node.status} />
            </div>

            <div className={styles.nodeMetrics}>
              <div>
                <div className={styles.nodeMetricLabel}>CPU</div>
                <GaugeBar pct={node.cpuUsagePct} />
              </div>
              <div>
                <div className={styles.nodeMetricLabel}>메모리</div>
                <GaugeBar pct={node.memoryUsagePct} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 10, fontSize: 11, color: "rgba(20,21,23,0.45)" }}>
              <span>파드 {node.podCount}개</span>
              {node.cpuCapacityMillicores && <span>CPU {node.cpuCapacityMillicores}m</span>}
              {node.memoryCapacityMiB && <span>Mem {Math.round(node.memoryCapacityMiB / 1024)}Gi</span>}
            </div>

            <PressureIndicators conditions={node.conditions} />
          </div>
        ))}
      </div>
    </div>
  );
}
