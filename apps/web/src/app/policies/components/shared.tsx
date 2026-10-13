"use client";

import type { PolicyCategory, PolicySeverity, PsaLevel } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

type TFn = (key: string, vars?: Record<string, string | number>) => string;
export const POLICY_CATEGORIES: PolicyCategory[] = ["psa", "networkPolicy", "rbac", "autoscaling", "resources"];
export const categoryLabel = (t: TFn, c: PolicyCategory) => t(`polc.cat.${c}`);
export const severityLabel = (t: TFn, s: PolicySeverity) => t(`polc.sev.${s}`);

const SEVERITY_CLASS: Record<PolicySeverity, string> = {
  high: styles.sevHigh,
  medium: styles.sevMedium,
  low: styles.sevLow,
  info: styles.sevInfo,
};

export function SeverityBadge({ severity, count }: { severity: PolicySeverity; count?: number }) {
  const { t } = useI18n();
  return (
    <span className={`${styles.badge} ${SEVERITY_CLASS[severity]}`}>
      {severityLabel(t, severity)}
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
  const { t } = useI18n();
  if (!level) return <span className={`${styles.badge} ${styles.psaUnset}`}>{t("polc.psa.unset")}</span>;
  return (
    <span className={`${styles.badge} ${PSA_CLASS[level]}`} title={implicit ? t("polc.psa.implicitHint") : undefined}>
      {level}
      {implicit ? ` (${t("polc.psa.default")})` : ""}
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
