"use client";

import type { PolicyCategory, PolicySeverity, PsaLevel } from "@aud/types";
import styles from "../styles.module.css";

export const CATEGORY_LABEL: Record<PolicyCategory, string> = {
  psa: "Pod Security",
  networkPolicy: "네트워크 정책",
  rbac: "RBAC",
  autoscaling: "오토스케일링·가용성",
  resources: "리소스 관리",
};

export const SEVERITY_LABEL: Record<PolicySeverity, string> = {
  high: "높음",
  medium: "중간",
  low: "낮음",
  info: "정보",
};

const SEVERITY_CLASS: Record<PolicySeverity, string> = {
  high: styles.sevHigh,
  medium: styles.sevMedium,
  low: styles.sevLow,
  info: styles.sevInfo,
};

export function SeverityBadge({ severity, count }: { severity: PolicySeverity; count?: number }) {
  return (
    <span className={`${styles.badge} ${SEVERITY_CLASS[severity]}`}>
      {SEVERITY_LABEL[severity]}
      {count !== undefined ? ` ${count}` : ""}
    </span>
  );
}

const PSA_CLASS: Record<PsaLevel, string> = {
  restricted: styles.psaRestricted,
  baseline: styles.psaBaseline,
  privileged: styles.psaPrivileged,
};

export function PsaBadge({ level, implicit }: { level?: PsaLevel; implicit?: boolean }) {
  if (!level) return <span className={`${styles.badge} ${styles.psaUnset}`}>미설정</span>;
  return (
    <span className={`${styles.badge} ${PSA_CLASS[level]}`} title={implicit ? "라벨 없음 — PSA 기본값" : undefined}>
      {level}
      {implicit ? " (기본값)" : ""}
    </span>
  );
}

export function Badge({ tone, children, title }: { tone: "ok" | "neutral" | "system" | PolicySeverity; children: React.ReactNode; title?: string }) {
  const cls = tone === "ok" ? styles.ok : tone === "neutral" ? styles.neutral : tone === "system" ? styles.system : SEVERITY_CLASS[tone];
  return (
    <span className={`${styles.badge} ${cls}`} title={title}>
      {children}
    </span>
  );
}

/** Covered / total as a green bar on a red track. */
export function CoverageBar({ covered, total, label }: { covered: number; total: number; label?: string }) {
  if (total === 0) return <span className={styles.muted}>-</span>;
  const pct = Math.round((covered / total) * 100);
  return (
    <div title={`${covered}/${total}`}>
      <div className={styles.bar}>
        <div className={styles.barFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.barLabel}>
        {label ? `${label} ` : ""}
        {covered}/{total} ({pct}%)
      </div>
    </div>
  );
}

export function scoreClass(score: number): string {
  return score >= 80 ? styles.scoreGood : score >= 50 ? styles.scoreWarn : styles.scoreBad;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
