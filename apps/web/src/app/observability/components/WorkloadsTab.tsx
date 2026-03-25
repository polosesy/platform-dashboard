"use client";

import { useState, useMemo } from "react";
import type { WorkloadHealth, ResourceUsage } from "@aud/types";
import styles from "../styles.module.css";
import { WorkloadDetailPanel } from "./WorkloadDetailPanel";

// ── Gauge component ──
function ResourceGauge({ usage, unit }: { usage: ResourceUsage | null; unit: "cpu" | "mem" }) {
  if (!usage) return <span className={styles.apmBadge + " " + styles.apmNone}>N/A</span>;
  const pct = Math.min(100, Math.round(usage.usagePct));
  const cls = pct >= 85 ? styles.gaugeCrit : pct >= 70 ? styles.gaugeWarn : styles.gaugeOk;
  const label = unit === "cpu"
    ? `${usage.usageRaw}m`
    : `${usage.usageRaw}Mi`;
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeBar}>
        <div className={styles.gaugeFill + " " + cls} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.gaugeLabel}>{pct}% {label}</span>
    </div>
  );
}

// ── Pod mini bar ──
function PodBar({ pods }: { pods: WorkloadHealth["pods"] }) {
  const { total, running, pending, failed } = pods;
  if (total === 0) return <span className={styles.podBarLabel}>0</span>;
  const rPct = (running / total) * 100;
  const pPct = (pending / total) * 100;
  const fPct = (failed / total) * 100;
  return (
    <div className={styles.podBar}>
      {running > 0 && <div className={styles.podBarSegment + " " + styles.podRunning} style={{ width: `${Math.max(6, rPct)}px` }} title={`Running: ${running}`} />}
      {pending > 0 && <div className={styles.podBarSegment + " " + styles.podPending} style={{ width: `${Math.max(6, pPct)}px` }} title={`Pending: ${pending}`} />}
      {failed > 0  && <div className={styles.podBarSegment + " " + styles.podFailed}  style={{ width: `${Math.max(6, fPct)}px` }} title={`Failed: ${failed}`} />}
      <span className={styles.podBarLabel}>{running}/{total}</span>
    </div>
  );
}

// ── APM cells ──
function ErrorRateCell({ rate }: { rate: number | null }) {
  if (rate === null) return <span className={styles.apmBadge + " " + styles.apmNone}>—</span>;
  const pct = Math.round(rate * 100);
  const cls = pct >= 5 ? styles.apmCrit : pct >= 1 ? styles.apmWarn : styles.apmOk;
  return <span className={styles.apmBadge + " " + cls}>{pct}%</span>;
}

function LatencyCell({ p95 }: { p95: number | null }) {
  if (p95 === null) return <span className={styles.apmBadge + " " + styles.apmNone}>—</span>;
  const cls = p95 >= 2000 ? styles.apmCrit : p95 >= 500 ? styles.apmWarn : styles.apmOk;
  return <span className={styles.apmBadge + " " + cls}>{p95 >= 1000 ? `${(p95/1000).toFixed(1)}s` : `${Math.round(p95)}ms`}</span>;
}

// ── WorkloadRow (exported for OverviewTab) ──
export function WorkloadRow({
  wl,
  selected,
  onClick,
}: {
  wl: WorkloadHealth;
  selected: boolean;
  onClick: () => void;
}) {
  const rowCls = [styles.tableRow, selected ? styles.tableRowSelected : ""].join(" ");
  return (
    <tr className={rowCls} onClick={onClick}>
      <td style={{ fontWeight: 600 }}>{wl.name}</td>
      <td style={{ color: "rgba(20,21,23,0.5)", fontSize: 12 }}>{wl.namespace}</td>
      <td><PodBar pods={wl.pods} /></td>
      <td><ResourceGauge usage={wl.cpu} unit="cpu" /></td>
      <td><ResourceGauge usage={wl.memory} unit="mem" /></td>
      <td><ErrorRateCell rate={wl.apm?.errorRate ?? null} /></td>
      <td><LatencyCell p95={wl.apm?.p95Ms ?? null} /></td>
    </tr>
  );
}

// ── Main WorkloadsTab ──
export function WorkloadsTab({
  workloads,
  onWorkloadSelect,
  selectedKey,
  clusterId,
}: {
  workloads: WorkloadHealth[];
  onWorkloadSelect: (name: string, ns: string) => void;
  selectedKey: string | null;
  clusterId: string;
}) {
  const [search, setSearch] = useState("");
  const [nsFilter, setNsFilter] = useState("all");

  const namespaces = useMemo(
    () => ["all", ...Array.from(new Set(workloads.map((w) => w.namespace))).sort()],
    [workloads]
  );

  const filtered = useMemo(() => {
    return workloads.filter((w) => {
      if (nsFilter !== "all" && w.namespace !== nsFilter) return false;
      if (search && !w.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [workloads, nsFilter, search]);

  const selectedWl = useMemo(
    () => (selectedKey ? workloads.find((w) => `${w.namespace}/${w.name}` === selectedKey) ?? null : null),
    [workloads, selectedKey]
  );

  if (workloads.length === 0) {
    return (
      <div className={styles.noDataBanner}>
        <strong>워크로드 없음</strong>
        Container Insights가 연결되어 있지 않거나 클러스터에 워크로드가 없습니다.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Filter bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
          <input
            type="text"
            placeholder="워크로드 이름 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--fg)", fontSize: 13, minWidth: 200,
            }}
          />
          <select
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            style={{
              padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--fg)", fontSize: 13,
            }}
          >
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>{ns === "all" ? "전체 네임스페이스" : ns}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: "rgba(20,21,23,0.45)", marginLeft: "auto" }}>
            {filtered.length} / {workloads.length} 워크로드
          </span>
        </div>

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
            {filtered.map((wl) => (
              <WorkloadRow
                key={`${wl.namespace}/${wl.name}`}
                wl={wl}
                selected={selectedKey === `${wl.namespace}/${wl.name}`}
                onClick={() => onWorkloadSelect(wl.name, wl.namespace)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {selectedWl && (
        <WorkloadDetailPanel
          wl={selectedWl}
          clusterId={clusterId}
          onClose={() => onWorkloadSelect("", "")}
        />
      )}
    </div>
  );
}
