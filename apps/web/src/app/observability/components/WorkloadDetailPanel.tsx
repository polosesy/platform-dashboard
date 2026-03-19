"use client";

import type { WorkloadHealth, JvmMetrics } from "@aud/types";
import styles from "../styles.module.css";

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.metricRow}>
      <span className={styles.metricRowLabel}>{label}</span>
      <span className={styles.metricRowValue}>{value}</span>
    </div>
  );
}

function JvmSection({ jvm }: { jvm: JvmMetrics }) {
  const heapPct = jvm.heapUsedPct !== null ? Math.round(jvm.heapUsedPct) : null;
  const heapCls = heapPct !== null
    ? heapPct >= 85 ? styles.gaugeCrit : heapPct >= 70 ? styles.gaugeWarn : styles.gaugeOk
    : "";

  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>JVM 메트릭</p>
      {heapPct !== null && (
        <div style={{ marginBottom: 10 }}>
          <div className={styles.gaugeLabel} style={{ marginBottom: 4 }}>Heap 사용률</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className={styles.gaugeBar} style={{ width: 120 }}>
              <div className={`${styles.gaugeFill} ${heapCls}`} style={{ width: `${heapPct}%` }} />
            </div>
            <span className={styles.gaugeLabel}>{heapPct}% ({jvm.heapUsedMiB ?? "?"} / {jvm.heapMaxMiB ?? "?"}Mi)</span>
          </div>
        </div>
      )}
      {jvm.gcTimeMs !== null && <MetricRow label="GC 시간 (1분)" value={`${jvm.gcTimeMs}ms`} />}
      {jvm.gcCount !== null && <MetricRow label="GC 횟수 (1분)" value={jvm.gcCount} />}
      {jvm.threadCount !== null && (
        <MetricRow
          label="스레드"
          value={jvm.threadBlocked !== null ? `${jvm.threadCount} (차단: ${jvm.threadBlocked})` : jvm.threadCount}
        />
      )}
      {jvm.classesLoaded !== null && <MetricRow label="클래스 로드" value={jvm.classesLoaded.toLocaleString()} />}
    </div>
  );
}

export function WorkloadDetailPanel({
  wl,
  onClose,
}: {
  wl: WorkloadHealth;
  onClose: () => void;
}) {
  const { name, namespace, kind, pods, cpu, memory, apm, jvm } = wl;

  const errorPct = apm?.errorRate !== null && apm?.errorRate !== undefined
    ? Math.round(apm.errorRate * 100)
    : null;

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className={styles.detailKind}>{kind}</span>
          </div>
          <p className={styles.detailTitle}>{name}</p>
          <p className={styles.detailNs}>{namespace}</p>
        </div>
        <button className={styles.detailClose} onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className={styles.detailBody}>
        {/* Pod Summary */}
        <div className={styles.detailSection}>
          <p className={styles.detailSectionTitle}>파드 상태</p>
          <MetricRow label="전체" value={pods.total} />
          <MetricRow
            label="Running"
            value={<span style={{ color: "rgba(16,137,62,0.85)" }}>{pods.running}</span>}
          />
          {pods.pending > 0 && (
            <MetricRow
              label="Pending"
              value={<span style={{ color: "rgba(209,132,0,0.85)" }}>{pods.pending}</span>}
            />
          )}
          {pods.failed > 0 && (
            <MetricRow
              label="Failed"
              value={<span style={{ color: "rgba(196,43,28,0.85)" }}>{pods.failed}</span>}
            />
          )}
          {pods.restarts > 0 && (
            <MetricRow
              label="재시작 횟수"
              value={<span style={{ color: "rgba(196,43,28,0.75)" }}>{pods.restarts}</span>}
            />
          )}
        </div>

        {/* Resource Usage */}
        <div className={styles.detailSection}>
          <p className={styles.detailSectionTitle}>리소스 사용률</p>
          {cpu ? (
            <div style={{ marginBottom: 8 }}>
              <div className={styles.nodeMetricLabel}>CPU</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={styles.gaugeBar} style={{ width: 120 }}>
                  <div
                    className={`${styles.gaugeFill} ${cpu.usagePct >= 85 ? styles.gaugeCrit : cpu.usagePct >= 70 ? styles.gaugeWarn : styles.gaugeOk}`}
                    style={{ width: `${Math.min(100, cpu.usagePct)}%` }}
                  />
                </div>
                <span className={styles.gaugeLabel}>{Math.round(cpu.usagePct)}% / {cpu.usageRaw}m</span>
              </div>
            </div>
          ) : <MetricRow label="CPU" value="N/A" />}

          {memory ? (
            <div>
              <div className={styles.nodeMetricLabel}>메모리</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={styles.gaugeBar} style={{ width: 120 }}>
                  <div
                    className={`${styles.gaugeFill} ${memory.usagePct >= 85 ? styles.gaugeCrit : memory.usagePct >= 70 ? styles.gaugeWarn : styles.gaugeOk}`}
                    style={{ width: `${Math.min(100, memory.usagePct)}%` }}
                  />
                </div>
                <span className={styles.gaugeLabel}>{Math.round(memory.usagePct)}% / {memory.usageRaw}Mi</span>
              </div>
            </div>
          ) : <MetricRow label="메모리" value="N/A" />}
        </div>

        {/* APM Metrics */}
        {apm && apm.source !== "none" && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>APM 메트릭 ({apm.source})</p>
            {apm.requestsPerSec !== null && (
              <MetricRow label="요청/초" value={apm.requestsPerSec.toFixed(2)} />
            )}
            {errorPct !== null && (
              <MetricRow
                label="에러율"
                value={
                  <span style={{ color: errorPct >= 5 ? "rgba(196,43,28,0.85)" : errorPct >= 1 ? "rgba(160,100,0,0.85)" : "rgba(16,137,62,0.85)" }}>
                    {errorPct}%
                  </span>
                }
              />
            )}
            {apm.p50Ms !== null && <MetricRow label="p50 레이턴시" value={`${Math.round(apm.p50Ms)}ms`} />}
            {apm.p95Ms !== null && <MetricRow label="p95 레이턴시" value={`${Math.round(apm.p95Ms)}ms`} />}
            {apm.p99Ms !== null && <MetricRow label="p99 레이턴시" value={`${Math.round(apm.p99Ms)}ms`} />}
          </div>
        )}

        {/* JVM Metrics */}
        {jvm && <JvmSection jvm={jvm} />}

        {/* No APM data */}
        {(!apm || apm.source === "none") && !jvm && (
          <div className={styles.noDataBanner}>
            <strong>APM 데이터 없음</strong>
            App Insights가 구성되지 않았거나 이 워크로드에서 메트릭을 수집하지 않습니다.
          </div>
        )}
      </div>
    </div>
  );
}
