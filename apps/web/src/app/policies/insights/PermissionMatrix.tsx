"use client";

import { Fragment } from "react";
import type { PolicyInsightsResponse, RbacMatrixRow } from "@aud/types";
import { flowNote, type InsightsNav } from "./model";
import { EvidenceChip } from "./Inspector";
import styles from "./insights.module.css";

/** Break long headers after "/" and "·" only — Korean words never split mid-syllable. */
function header(label: string) {
  const parts = label.split(/(?<=[/·])/);
  return parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <wbr />}</Fragment>);
}

const subjectLabel = (m: RbacMatrixRow) => m.subjects.map((s) => s.replace(/^ServiceAccount:[^/]+\//, "").replace(/^(User|Group):/, "")).join(" · ");

export function PermissionMatrix({ data, nav }: { data: PolicyInsightsResponse; nav: InsightsNav }) {
  const crit = data.riskDict.filter((r) => r.grade === "crit");
  const cols = [...crit, ...data.riskDict.filter((r) => r.grade !== "crit")];
  const M = data.matrix;
  const usage = (m: RbacMatrixRow) => {
    if (!m.workloadId) return m.subjects.some((s) => s.startsWith("User") || s.startsWith("Group")) ? "사용자·그룹 · 사용 흔적 미수집" : "-";
    const r = data.rows.find((x) => x.id === m.workloadId);
    const api = data.network.edges.filter((e) => e.from === m.workloadId && e.to === "apiserver").reduce((s, e) => s + e.count, 0);
    return `파드 ${r?.pods ?? "?"} · apiserver flow ${data.network.available ? (api || "관측 구간 0건") : "미수집"}`;
  };
  if (!M.length) return <div className={styles.notice}>위험 권한을 가진 사용자 영역 바인딩이 없습니다.</div>;
  return (
    <section className={styles.panel} aria-label="권한 탐색">
      <div className={styles.panelH}>
        <h3>권한 탐색 · 주체 × 위험 권한</h3>
        <span className={styles.sub}>시스템 바인딩 제외 · 히트맵 &lsquo;고권한 RBAC&rsquo;과 같은 위험 사전</span>
      </div>
      <div className={styles.panelB}>
        <div className={styles.tableWrap}>
          <table className={styles.matrix} aria-label="권한 탐색: 주체 × 위험 권한">
            <colgroup>
              <col style={{ width: 200 }} />
              <col style={{ width: 180 }} />
              {cols.map((c) => <col key={c.key} style={{ width: 72 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th />
                <th />
                <th data-grp="true" colSpan={crit.length}>● 장악 직결</th>
                <th data-grp="true" colSpan={cols.length - crit.length}>○ 경로 확대</th>
              </tr>
              <tr>
                <th scope="col">주체</th>
                <th scope="col">사용 흔적 <EvidenceChip ev="obs" text="관측" /></th>
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
                      <button className={`${styles.linkish} ${styles.mono}`} onClick={() => nav.openHeatRow(m.workloadId!)} aria-label={`${subjectLabel(m)} — 히트맵 행 상세 열기`}>{subjectLabel(m)}</button>
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
                          aria-label={`${subjectLabel(m)}: ${c.label} 있음 · RBAC 권한 · ${c.grade === "crit" ? "장악 직결" : "경로 확대"}${cond ? " · 조건부(미확인)" : ""}`}
                          title={`${m.binding} → ${m.role}\n${c.raw}\n원문: ${m.rules.join(" | ")}${cond ? "\n조건부: 약한 동사로만 성립 — 미검증" : ""}`}
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
          ● 장악 직결 · ○ 경로 확대 · <span className={styles.mdot} data-k="cond" style={{ verticalAlign: -1 }} /> 조건부(미확인). 주체 이름을 누르면 히트맵 행 상세(바인딩·규칙 원문)가 열립니다. 사용 흔적의 flow 수는 {flowNote(data.network.coverage)}.
        </div>
      </div>
    </section>
  );
}
