"use client";

import { useMemo, useState } from "react";
import type { RbacBindingInfo, RbacRoleInfo } from "@aud/types";
import styles from "../styles.module.css";
import { Badge, Empty } from "./shared";

function subjectText(b: RbacBindingInfo): string {
  return b.subjects.map((s) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ""}${s.name}`).join(", ") || "(없음)";
}

export function RbacPanel({ roles, bindings, showSystem }: { roles: RbacRoleInfo[]; bindings: RbacBindingInfo[]; showSystem: boolean }) {
  const [riskyOnly, setRiskyOnly] = useState(true);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visibleBindings = useMemo(
    () =>
      bindings.filter(
        (b) =>
          (showSystem || !b.system) &&
          (!riskyOnly || b.risks.length > 0 || !b.roleFound) &&
          (!q || [b.name, b.namespace ?? "", b.roleRef.name, subjectText(b)].some((v) => v.toLowerCase().includes(q))),
      ),
    [bindings, showSystem, riskyOnly, q],
  );
  const visibleRoles = useMemo(
    () =>
      roles.filter(
        (r) =>
          (showSystem || !r.system) &&
          (!riskyOnly || r.risks.length > 0) &&
          (!q || [r.name, r.namespace ?? ""].some((v) => v.toLowerCase().includes(q))),
      ),
    [roles, showSystem, riskyOnly, q],
  );

  const clusterAdmins = bindings.filter((b) => b.risks.includes("cluster-admin"));

  return (
    <div className={styles.page}>
      {clusterAdmins.length > 0 && (
        <div className={styles.error}>
          cluster-admin 바인딩 {clusterAdmins.length}건: {clusterAdmins.map((b) => `${b.name} → ${subjectText(b)}`).join(" / ")}
        </div>
      )}
      <div className={styles.controls}>
        <label className={styles.toggle}>
          <input type="checkbox" checked={riskyOnly} onChange={(e) => setRiskyOnly(e.target.checked)} />
          위험 권한이 있는 항목만
        </label>
        <input className={styles.search} placeholder="이름·주체·역할 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/rbac-good-practices/" target="_blank" rel="noreferrer">
          RBAC Good Practices
        </a>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            바인딩 <span className={styles.muted}>({visibleBindings.length}/{bindings.length})</span>
          </div>
          <div className={styles.panelHint}>누가(주체) 어떤 역할을 어느 범위로 받았는지</div>
        </div>
        {visibleBindings.length === 0 ? (
          <Empty>조건에 맞는 바인딩이 없습니다.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>바인딩</th>
                  <th>범위</th>
                  <th>역할</th>
                  <th>주체</th>
                  <th>위험 권한</th>
                </tr>
              </thead>
              <tbody>
                {visibleBindings.map((b) => (
                  <tr key={`${b.kind}/${b.namespace ?? ""}/${b.name}`}>
                    <td>
                      <div className={styles.mono}>{b.name}</div>
                      {b.system && <Badge tone="system">시스템</Badge>}
                    </td>
                    <td>{b.kind === "ClusterRoleBinding" ? <Badge tone="medium">클러스터</Badge> : <span className={styles.mono}>{b.namespace}</span>}</td>
                    <td className={styles.mono}>
                      {b.roleRef.kind}/{b.roleRef.name}
                      {!b.roleFound && <div><Badge tone="info">역할 없음</Badge></div>}
                    </td>
                    <td className={styles.mono}>{subjectText(b)}</td>
                    <td>
                      <div className={styles.chips}>
                        {b.risks.length === 0 ? <span className={styles.muted}>-</span> : b.risks.map((r) => <Badge key={r} tone={r === "cluster-admin" || r === "익명 접근" ? "high" : "medium"}>{r}</Badge>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            역할 <span className={styles.muted}>({visibleRoles.length}/{roles.length})</span>
          </div>
          <div className={styles.panelHint}>규칙에 포함된 권한 상승 경로 (escalate·bind·impersonate·secrets·와일드카드 등)</div>
        </div>
        {visibleRoles.length === 0 ? (
          <Empty>조건에 맞는 역할이 없습니다.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>역할</th>
                  <th>규칙 수</th>
                  <th>바인딩 수</th>
                  <th>위험 권한</th>
                </tr>
              </thead>
              <tbody>
                {visibleRoles.map((r) => (
                  <tr key={`${r.kind}/${r.namespace ?? ""}/${r.name}`}>
                    <td>
                      <div className={styles.mono}>
                        {r.kind}/{r.namespace ? `${r.namespace}/` : ""}
                        {r.name}
                      </div>
                      <div className={styles.chips}>
                        {r.system && <Badge tone="system">시스템</Badge>}
                        {r.aggregated && <Badge tone="neutral">aggregated</Badge>}
                      </div>
                    </td>
                    <td>{r.ruleCount}</td>
                    <td>{r.bindingCount === 0 ? <span className={styles.muted}>미사용</span> : r.bindingCount}</td>
                    <td>
                      <div className={styles.chips}>
                        {r.risks.length === 0 ? <span className={styles.muted}>-</span> : r.risks.map((x) => <Badge key={x} tone="medium">{x}</Badge>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
