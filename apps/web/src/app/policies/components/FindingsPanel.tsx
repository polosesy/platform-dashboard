"use client";

import { useMemo, useState } from "react";
import type { PolicyCategory, PolicyFinding, PolicySeverity } from "@aud/types";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
import { Badge, Empty, POLICY_CATEGORIES, SeverityBadge, categoryLabel, severityLabel } from "./shared";

type Props = {
  findings: PolicyFinding[];
  category: PolicyCategory | "all";
  onCategoryChange: (c: PolicyCategory | "all") => void;
};

const SEVERITIES: PolicySeverity[] = ["high", "medium", "low", "info"];

export function FindingsPanel({ findings, category, onCategoryChange }: Props) {
  const { t } = useI18n();
  const [severity, setSeverity] = useState<PolicySeverity | "all">("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) =>
        (category === "all" || f.category === category) &&
        (severity === "all" || f.severity === severity) &&
        (!q ||
          [f.title, f.detail, f.ruleId, f.namespace ?? "", f.resource?.name ?? ""].some((v) => v.toLowerCase().includes(q))),
    );
  }, [findings, category, severity, query]);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>
          {t("pol.panel.findings")} <span className={styles.muted}>({filtered.length}/{findings.length})</span>
        </div>
        <div className={styles.controls}>
          <select className={styles.select} value={category} onChange={(e) => onCategoryChange(e.target.value as PolicyCategory | "all")}>
            <option value="all">{t("polc.allAreas")}</option>
            {POLICY_CATEGORIES.map((c: PolicyCategory) => (
              <option key={c} value={c}>
                {categoryLabel(t, c)}
              </option>
            ))}
          </select>
          <select className={styles.select} value={severity} onChange={(e) => setSeverity(e.target.value as PolicySeverity | "all")}>
            <option value="all">{t("polc.allSeverities")}</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {severityLabel(t, s)}
              </option>
            ))}
          </select>
          <input
            className={styles.search}
            placeholder={t("polc.findingsSearch")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {filtered.length === 0 ? (
        <Empty>{t("polc.noFindings")}</Empty>
      ) : (
        <div className={styles.findingList}>
          {filtered.map((f) => (
            <div key={f.id} className={styles.finding}>
              <div className={styles.findingHead}>
                <SeverityBadge severity={f.severity} />
                <span className={styles.findingTitle}>{f.title}</span>
                <span className={styles.findingRule}>{f.ruleId}</span>
                <Badge tone="neutral">{categoryLabel(t, f.category)}</Badge>
                {f.system && <Badge tone="system" title={t("polc.systemHint")}>{t("polc.system")}</Badge>}
              </div>
              {f.resource && (
                <div className={styles.findingResource}>
                  {f.resource.kind} {f.resource.namespace ? `${f.resource.namespace}/` : ""}
                  {f.resource.name}
                </div>
              )}
              <div className={styles.findingDetail}>{f.detail}</div>
              <div className={styles.findingFix}>{t("polc.recommendation")}: {f.recommendation}</div>
              <a className={styles.refLink} href={f.reference} target="_blank" rel="noreferrer">
                {t("polc.reference")}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
