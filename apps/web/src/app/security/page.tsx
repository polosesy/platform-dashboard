"use client";

import { useEffect, useState } from "react";
import styles from "./styles.module.css";
import type { SecureScoreSummary, SecurityAlertsResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

const SEV_COLORS: Record<string, string> = {
  High: "rgba(216, 59, 1, 0.90)",
  Medium: "rgba(209, 132, 0, 0.90)",
  Low: "rgba(0, 120, 212, 0.80)",
  Informational: "rgba(20, 21, 23, 0.40)",
};

function gaugeColor(pct: number): string {
  if (pct >= 70) return "rgba(16, 137, 62, 0.80)";
  if (pct >= 40) return "rgba(209, 132, 0, 0.80)";
  return "rgba(216, 59, 1, 0.80)";
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function SecurityPage() {
  const getApiToken = useApiToken();
  const [score, setScore] = useState<SecureScoreSummary | null>(null);
  const [alerts, setAlerts] = useState<SecurityAlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getApiToken()
      .then(async (token) => {
        const base = apiBaseUrl();
        const [s, a] = await Promise.all([
          fetchJsonWithBearer<SecureScoreSummary>(`${base}/api/security/score`, token),
          fetchJsonWithBearer<SecurityAlertsResponse>(`${base}/api/security/alerts`, token),
        ]);
        if (cancelled) return;
        setScore(s);
        setAlerts(a);
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

  // SVG gauge calculation
  const R = 58;
  const C = 2 * Math.PI * R;
  const pct = score?.percentage ?? 0;
  const offset = C - (pct / 100) * C;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Security</div>
          <div className={styles.subTitle}>
            {score ? `Generated: ${new Date(score.generatedAt).toLocaleString()}` : loading ? "Loading..." : "No data"}
          </div>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}
      {score?.note ? <div className={styles.note}>{score.note}</div> : null}

      <div className={styles.grid}>
        {/* Secure Score Gauge */}
        <div className={styles.gaugeCard}>
          <div className={styles.gaugeRing}>
            <svg className={styles.gaugeSvg} width="140" height="140" viewBox="0 0 140 140">
              <circle className={styles.gaugeTrack} cx="70" cy="70" r={R} strokeWidth="12" />
              <circle
                className={styles.gaugeFill}
                cx="70" cy="70" r={R}
                strokeWidth="12"
                stroke={gaugeColor(pct)}
                strokeDasharray={C}
                strokeDashoffset={offset}
                strokeLinecap="round"
              />
            </svg>
            <div className={styles.gaugeLabel}>
              <div className={styles.gaugeScore}>{score?.currentScore ?? "-"}</div>
              <div className={styles.gaugeMax}>/ {score?.maxScore ?? 100}</div>
            </div>
          </div>
          <div className={styles.gaugeTitle}>Secure Score</div>
          <div className={styles.gaugePct}>{pct.toFixed(1)}%</div>
        </div>

        {/* Severity Summary */}
        <div className={styles.severityCard}>
          <div className={styles.severityHeader}>
            <div className={styles.severityTitle}>Active Alerts</div>
            {alerts && <span className={`${styles.severityBadge} ${styles.sevHigh}`}>{alerts.totalActive} active</span>}
          </div>
          <div className={styles.severityStrip}>
            <div className={styles.sevItem}>
              <div className={styles.sevCount} style={{ color: SEV_COLORS.High }}>{alerts?.bySeverity.high ?? 0}</div>
              <div className={styles.sevLabel}>High</div>
            </div>
            <div className={styles.sevItem}>
              <div className={styles.sevCount} style={{ color: SEV_COLORS.Medium }}>{alerts?.bySeverity.medium ?? 0}</div>
              <div className={styles.sevLabel}>Medium</div>
            </div>
            <div className={styles.sevItem}>
              <div className={styles.sevCount} style={{ color: SEV_COLORS.Low }}>{alerts?.bySeverity.low ?? 0}</div>
              <div className={styles.sevLabel}>Low</div>
            </div>
            <div className={styles.sevItem}>
              <div className={styles.sevCount} style={{ color: SEV_COLORS.Informational }}>{alerts?.bySeverity.informational ?? 0}</div>
              <div className={styles.sevLabel}>Info</div>
            </div>
          </div>
        </div>

        {/* Control Scores */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>Security Controls</div>
          <div className={styles.cardBody}>
            {score && score.controlScores.length > 0 ? (
              score.controlScores.map((c) => {
                const controlPct = c.maxScore > 0 ? (c.currentScore / c.maxScore) * 100 : 0;
                return (
                  <div key={c.controlName} className={styles.controlRow}>
                    <div>
                      <div className={styles.controlName}>{c.controlName}</div>
                      <div className={styles.controlBar}>
                        <div className={styles.controlFill} style={{ width: `${controlPct}%` }} />
                      </div>
                    </div>
                    <div className={styles.controlScore}>{c.currentScore}/{c.maxScore}</div>
                    <div className={styles.controlResources}>{c.unhealthyResourceCount} issue{c.unhealthyResourceCount !== 1 ? "s" : ""}</div>
                  </div>
                );
              })
            ) : (
              <div className={styles.empty}>{loading ? "Loading controls..." : "No control data."}</div>
            )}
          </div>
        </div>

        {/* Alert List */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>Recent Alerts</div>
          <div className={styles.cardBody}>
            {alerts && alerts.alerts.length > 0 ? (
              alerts.alerts.map((a) => (
                <div key={a.id} className={styles.alertRow}>
                  <div className={styles.alertTop}>
                    <div className={styles.alertDot} style={{ background: SEV_COLORS[a.severity] ?? SEV_COLORS.Low }} />
                    <div className={styles.alertName}>{a.alertName}</div>
                    <div className={styles.alertTime}>{timeAgo(a.detectedAt)}</div>
                  </div>
                  <div className={styles.alertDesc}>{a.description}</div>
                  <div className={styles.alertMeta}>
                    <span className={styles.alertEntity}>{a.compromisedEntity}</span>
                    {a.tactics.map((t) => (
                      <span key={t} className={styles.tacticPill}>{t}</span>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className={styles.empty}>{loading ? "Loading alerts..." : "No security alerts."}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
