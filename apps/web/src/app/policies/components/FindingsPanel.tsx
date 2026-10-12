"use client";

import { useMemo, useState } from "react";
import type { PolicyCategory, PolicyFinding, PolicySeverity } from "@aud/types";
import styles from "../styles.module.css";
import { Badge, CATEGORY_LABEL, Empty, SEVERITY_LABEL, SeverityBadge } from "./shared";

type Props = {
  findings: PolicyFinding[];
  category: PolicyCategory | "all";
  onCategoryChange: (c: PolicyCategory | "all") => void;
};

const SEVERITIES: PolicySeverity[] = ["high", "medium", "low", "info"];

export function FindingsPanel({ findings, category, onCategoryChange }: Props) {
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
          점검 결과 <span className={styles.muted}>({filtered.length}/{findings.length})</span>
        </div>
        <div className={styles.controls}>
          <select className={styles.select} value={category} onChange={(e) => onCategoryChange(e.target.value as PolicyCategory | "all")}>
            <option value="all">전체 영역</option>
            {(Object.keys(CATEGORY_LABEL) as PolicyCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select className={styles.select} value={severity} onChange={(e) => setSeverity(e.target.value as PolicySeverity | "all")}>
            <option value="all">전체 심각도</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
          <input
            className={styles.search}
            placeholder="규칙·리소스·네임스페이스 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {filtered.length === 0 ? (
        <Empty>조건에 맞는 점검 결과가 없습니다.</Empty>
      ) : (
        <div className={styles.findingList}>
          {filtered.map((f) => (
            <div key={f.id} className={styles.finding}>
              <div className={styles.findingHead}>
                <SeverityBadge severity={f.severity} />
                <span className={styles.findingTitle}>{f.title}</span>
                <span className={styles.findingRule}>{f.ruleId}</span>
                <Badge tone="neutral">{CATEGORY_LABEL[f.category]}</Badge>
                {f.system && <Badge tone="system" title="Kubernetes/AKS가 관리하는 객체 — 점수에서 제외">시스템</Badge>}
              </div>
              {f.resource && (
                <div className={styles.findingResource}>
                  {f.resource.kind} {f.resource.namespace ? `${f.resource.namespace}/` : ""}
                  {f.resource.name}
                </div>
              )}
              <div className={styles.findingDetail}>{f.detail}</div>
              <div className={styles.findingFix}>권장: {f.recommendation}</div>
              <a className={styles.refLink} href={f.reference} target="_blank" rel="noreferrer">
                근거 문서
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
