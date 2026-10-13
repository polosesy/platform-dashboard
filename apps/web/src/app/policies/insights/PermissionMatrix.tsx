"use client";

import { Fragment } from "react";
import type { PolicyInsightsResponse, RbacMatrixRow } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import type { InsightsNav } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import { EvidenceChip } from "./Inspector";
import styles from "./insights.module.css";

/** Break long headers after "/" and "·" only — Korean words never split mid-syllable. */
function header(label: string) {
  const parts = label.split(/(?<=[/·])/);
  return parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <wbr />}</Fragment>);
}

const subjectLabel = (m: RbacMatrixRow) => m.subjects.map((s) => s.replace(/^ServiceAccount:[^/]+\//, "").replace(/^(User|Group):/, "")).join(" · ");

export function PermissionMatrix({ data, nav }: { data: PolicyInsightsResponse; nav: InsightsNav }) {
  const { t } = useI18n();
  const { flowNote } = useInsightLabels();
  const crit = data.riskDict.filter((r) => r.grade === "crit");
  const cols = [...crit, ...data.riskDict.filter((r) => r.grade !== "crit")];
  const M = data.matrix;
  const usage = (m: RbacMatrixRow) => {
    if (!m.workloadId) return m.subjects.some((s) => s.startsWith("User") || s.startsWith("Group")) ? t("ins.perm.userGroup") : "-";
    const r = data.rows.find((x) => x.id === m.workloadId);
    const api = data.network.edges.filter((e) => e.from === m.workloadId && e.to === "apiserver").reduce((s, e) => s + e.count, 0);
    return t("ins.perm.usage", { pods: r?.pods ?? "?", flows: data.network.available ? (api || t("ins.perm.noneInWindow")) : t("ins.notCollected") });
  };
  if (!M.length) return <div className={styles.notice}>{t("ins.perm.none")}</div>;
  return (
    <section className={styles.panel} aria-label={t("ins.perm.aria")}>
      <div className={styles.panelH}>
        <h3>{t("ins.perm.title")}</h3>
        <span className={styles.sub}>{t("ins.perm.sub")}</span>
      </div>
      <div className={styles.panelB}>
        <div className={styles.tableWrap}>
          <table className={styles.matrix} aria-label={t("ins.perm.title")}>
            <colgroup>
              <col style={{ width: 200 }} />
              <col style={{ width: 180 }} />
              {cols.map((c) => <col key={c.key} style={{ width: 72 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th />
                <th />
                <th data-grp="true" colSpan={crit.length}>● {t("ins.weight.crit")}</th>
                <th data-grp="true" colSpan={cols.length - crit.length}>○ {t("ins.weight.warn")}</th>
              </tr>
              <tr>
                <th scope="col">{t("ins.perm.subject")}</th>
                <th scope="col">{t("ins.perm.usageCol")} <EvidenceChip ev="obs" text={t("ins.evShort.obs")} /></th>
                {cols.map((c) => (
                  <th key={c.key} scope="col" data-risk="true" aria-describedby={`rd-${c.key}`}>
                    {header(c.label)}
                    <span className={styles.tot}>{M.filter((m) => m.keys.includes(c.key)).length}/{M.length}</span>
                    <span className={styles.sr} id={`rd-${c.key}`}>{c.raw}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {M.map((m) => (
                <tr key={`${m.kind}/${m.namespace ?? ""}/${m.binding}`}>
                  <td>
                    {m.workloadId ? (
                      <button className={`${styles.linkish} ${styles.mono}`} onClick={() => nav.openHeatRow(m.workloadId!)} aria-label={t("ins.perm.openRow", { name: subjectLabel(m) })}>{subjectLabel(m)}</button>
                    ) : (
                      <span className={styles.mono}>{subjectLabel(m)}</span>
                    )}
                    <div className={styles.muted} style={{ fontSize: 11 }}>{m.kind} {m.namespace ? `${m.namespace}/` : ""}{m.binding}</div>
                  </td>
                  <td className={styles.muted}>{usage(m)}</td>
                  {cols.map((c) => {
                    if (!m.keys.includes(c.key)) return <td key={c.key} data-c="true" />;
                    const cond = m.conditional.includes(c.key);
                    return (
                      <td key={c.key} data-c="true">
                        <span
                          className={styles.mdot}
                          data-k={cond ? "cond" : c.grade}
                          role="img"
                          aria-label={`${subjectLabel(m)}: ${t("ins.perm.has", { label: c.label })} · ${t("ins.ev.perm")} · ${c.grade === "crit" ? t("ins.weight.crit") : t("ins.weight.warn")}${cond ? ` · ${t("ins.perm.conditional")}` : ""}`}
                          title={`${m.binding} → ${m.role}\n${c.raw}\n${t("ins.perm.raw")}: ${m.rules.join(" | ")}${cond ? `\n${t("ins.perm.condHint")}` : ""}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.note}>
          ● {t("ins.weight.crit")} · ○ {t("ins.weight.warn")} · <span className={styles.mdot} data-k="cond" style={{ verticalAlign: -1 }} /> {t("ins.perm.conditional")}. {t("ins.perm.note", { flows: flowNote(data.network.coverage) })}
        </div>
      </div>
    </section>
  );
}
