"use client";

import type { NamespacePolicySummary } from "@aud/types";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
import { Badge, PsaBadge } from "./shared";

const RECOMMENDED_LABELS = `apiVersion: v1
kind: Namespace
metadata:
  name: <namespace>
  labels:
    # step 1: make violations visible (no blocking)
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
    # step 2: enforce after fixing the workloads
    pod-security.kubernetes.io/enforce: baseline     # restricted where possible
    pod-security.kubernetes.io/enforce-version: v1.33`;

const LEVELS = ["privileged", "baseline", "restricted"] as const;

export function PsaPanel({ namespaces }: { namespaces: NamespacePolicySummary[] }) {
  const { t } = useI18n();
  const LEVEL_GUIDE = LEVELS.map((level) => ({ level, text: t(`polc.psa.level.${level}`) }));
  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>{t("polc.psa.labels")}</div>
          <div className={styles.panelHint}>{t("polc.psa.labelsHint")}</div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("polc.namespace")}</th>
                <th>enforce ({t("polc.psa.block")})</th>
                <th>audit ({t("polc.psa.audit")})</th>
                <th>warn ({t("polc.psa.warn")})</th>
                <th>enforce-version</th>
                <th>{t("polc.pods")}</th>
              </tr>
            </thead>
            <tbody>
              {namespaces.map((n) => (
                <tr key={n.name}>
                  <td>
                    <span className={styles.mono}>{n.name}</span> {n.system && <Badge tone="system">{t("polc.system")}</Badge>}
                  </td>
                  <td><PsaBadge level={n.psaEffectiveEnforce} implicit={!n.psa.enforce} /></td>
                  <td><PsaBadge level={n.psa.audit} /></td>
                  <td><PsaBadge level={n.psa.warn} /></td>
                  <td className={styles.mono}>{n.psa.enforceVersion ?? <span className={styles.muted}>-</span>}</td>
                  <td>{n.podCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.twoCol}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>{t("polc.psa.levels")}</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/pod-security-standards/" target="_blank" rel="noreferrer">
              {t("polc.k8sDocs")}
            </a>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                {LEVEL_GUIDE.map((g) => (
                  <tr key={g.level}>
                    <td><PsaBadge level={g.level} /></td>
                    <td>{g.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>{t("polc.psa.recommended")}</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/pod-security-admission/" target="_blank" rel="noreferrer">
              {t("polc.k8sDocs")}
            </a>
          </div>
          <pre className={styles.code}>{RECOMMENDED_LABELS}</pre>
        </div>
      </div>
    </div>
  );
}
