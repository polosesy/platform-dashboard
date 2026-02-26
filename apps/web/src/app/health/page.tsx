"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { HealthSummary, ResourceHealthStatus } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

const STATE_COLORS: Record<ResourceHealthStatus["availabilityState"], string> = {
  Available: "rgba(16, 137, 62, 0.80)",
  Degraded: "rgba(209, 132, 0, 0.80)",
  Unavailable: "rgba(216, 59, 1, 0.80)",
  Unknown: "rgba(20, 21, 23, 0.30)",
};

const STATE_STYLE: Record<ResourceHealthStatus["availabilityState"], string> = {
  Available: styles.stateAvailable ?? "",
  Degraded: styles.stateDegraded ?? "",
  Unavailable: styles.stateUnavailable ?? "",
  Unknown: styles.stateUnknown ?? "",
};

type FilterState = "all" | ResourceHealthStatus["availabilityState"];

export default function HealthPage() {
  const getApiToken = useApiToken();
  const [data, setData] = useState<HealthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterState>("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getApiToken()
      .then(async (token) => {
        const resp = await fetchJsonWithBearer<HealthSummary>(`${apiBaseUrl()}/api/health/summary`, token);
        if (cancelled) return;
        setData(resp);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [getApiToken]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.resources;
    return data.resources.filter((r) => r.availabilityState === filter);
  }, [data, filter]);

  const total = data ? data.available + data.degraded + data.unavailable + data.unknown : 0;

  // Donut segments
  const segments = useMemo(() => {
    if (!data || total === 0) return [];
    const R = 58;
    const C = 2 * Math.PI * R;
    const parts = [
      { state: "Available" as const, count: data.available, color: STATE_COLORS.Available },
      { state: "Degraded" as const, count: data.degraded, color: STATE_COLORS.Degraded },
      { state: "Unavailable" as const, count: data.unavailable, color: STATE_COLORS.Unavailable },
      { state: "Unknown" as const, count: data.unknown, color: STATE_COLORS.Unknown },
    ].filter((p) => p.count > 0);

    let accumulated = 0;
    return parts.map((p) => {
      const frac = p.count / total;
      const dashLen = frac * C;
      const dashOffset = -accumulated * C;
      accumulated += frac;
      return { ...p, dashLen, dashOffset, circumference: C, R };
    });
  }, [data, total]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Resource Health</div>
          <div className={styles.subTitle}>
            {data ? `Generated: ${new Date(data.generatedAt).toLocaleString()}` : loading ? "Loading..." : "No data"}
          </div>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}
      {data?.note ? <div className={styles.note}>{data.note}</div> : null}

      <div className={styles.grid}>
        {/* Summary strip */}
        <div className={styles.summaryStrip}>
          {([
            { label: "Available", count: data?.available ?? 0, color: STATE_COLORS.Available },
            { label: "Degraded", count: data?.degraded ?? 0, color: STATE_COLORS.Degraded },
            { label: "Unavailable", count: data?.unavailable ?? 0, color: STATE_COLORS.Unavailable },
            { label: "Unknown", count: data?.unknown ?? 0, color: STATE_COLORS.Unknown },
          ] as const).map((s) => (
            <div key={s.label} className={styles.statCard}>
              <div className={styles.statDot} style={{ background: s.color }} />
              <div className={styles.statCount} style={{ color: s.color }}>{s.count}</div>
              <div className={styles.statLabel}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Donut chart */}
        <div className={styles.donutCard}>
          <div className={styles.donutWrap}>
            <svg className={styles.donutSvg} width="140" height="140" viewBox="0 0 140 140">
              <circle fill="none" stroke="rgba(20,21,23,0.06)" strokeWidth="12" cx="70" cy="70" r="58" />
              {segments.map((seg) => (
                <circle
                  key={seg.state}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="12"
                  cx="70" cy="70" r={seg.R}
                  strokeDasharray={`${seg.dashLen} ${seg.circumference - seg.dashLen}`}
                  strokeDashoffset={seg.dashOffset}
                  strokeLinecap="butt"
                />
              ))}
            </svg>
            <div className={styles.donutCenter}>
              <div className={styles.donutTotal}>{total}</div>
              <div className={styles.donutLabel}>resources</div>
            </div>
          </div>
          <div className={styles.donutTitle}>Health Distribution</div>
          <div className={styles.donutLegend}>
            {segments.map((seg) => (
              <div key={seg.state} className={styles.legendItem}>
                <div className={styles.legendDot} style={{ background: seg.color }} />
                {seg.count}
              </div>
            ))}
          </div>
        </div>

        {/* Resource table */}
        <div className={styles.tableCard}>
          <div className={styles.cardTitle}>
            Resources
            <div className={styles.filterGroup}>
              {(["all", "Available", "Degraded", "Unavailable", "Unknown"] as FilterState[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`${styles.filterBtn} ${filter === f ? styles.filterActive : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? `All (${total})` : f}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.tableBody}>
            {filtered.length > 0 ? (
              filtered.map((r) => (
                <div key={r.resourceId} className={styles.resourceRow}>
                  <div className={styles.resDot} style={{ background: STATE_COLORS[r.availabilityState] }} />
                  <div className={styles.resInfo}>
                    <div className={styles.resName}>{r.resourceName}</div>
                    <div className={styles.resType}>{r.resourceType}</div>
                  </div>
                  <div className={styles.resGroup}>{r.resourceGroup}</div>
                  <div className={`${styles.resState} ${STATE_STYLE[r.availabilityState]}`}>
                    {r.availabilityState}
                  </div>
                  {r.summary && <div className={styles.resSummary}>{r.summary}</div>}
                </div>
              ))
            ) : (
              <div className={styles.empty}>{loading ? "Loading..." : "No resources match filter."}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
