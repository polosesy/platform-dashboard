"use client";

import { useMemo, useState } from "react";
import type { RbacBindingInfo, RbacRoleInfo } from "@aud/types";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
import { Badge, Empty } from "./shared";

function subjectText(b: RbacBindingInfo): string {
  return b.subjects.map((s) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ""}${s.name}`).join(", ") || "-";
}

export function RbacPanel({ roles, bindings, showSystem }: { roles: RbacRoleInfo[]; bindings: RbacBindingInfo[]; showSystem: boolean }) {
  const { t } = useI18n();
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
          {t("polc.rbac.clusterAdmins", { n: clusterAdmins.length })}: {clusterAdmins.map((b) => `${b.name} → ${subjectText(b)}`).join(" / ")}
        </div>
      )}
      <div className={styles.controls}>
        <label className={styles.toggle}>
          <input type="checkbox" checked={riskyOnly} onChange={(e) => setRiskyOnly(e.target.checked)} />
          {t("polc.rbac.riskyOnly")}
        </label>
        <input className={styles.search} placeholder={t("polc.rbac.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/rbac-good-practices/" target="_blank" rel="noreferrer">
          RBAC Good Practices
        </a>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            {t("polc.rbac.bindings")} <span className={styles.muted}>({visibleBindings.length}/{bindings.length})</span>
          </div>
          <div className={styles.panelHint}>{t("polc.rbac.bindingsHint")}</div>
        </div>
        {visibleBindings.length === 0 ? (
          <Empty>{t("polc.rbac.noBindings")}</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("polc.rbac.binding")}</th>
                  <th>{t("polc.rbac.scope")}</th>
                  <th>{t("polc.rbac.role")}</th>
                  <th>{t("ins.perm.subject")}</th>
                  <th>{t("polc.rbac.risks")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleBindings.map((b) => (
                  <tr key={`${b.kind}/${b.namespace ?? ""}/${b.name}`}>
                    <td>
                      <div className={styles.mono}>{b.name}</div>
                      {b.system && <Badge tone="system">{t("polc.system")}</Badge>}
                    </td>
                    <td>{b.kind === "ClusterRoleBinding" ? <Badge tone="medium">{t("polc.rbac.cluster")}</Badge> : <span className={styles.mono}>{b.namespace}</span>}</td>
                    <td className={styles.mono}>
                      {b.roleRef.kind}/{b.roleRef.name}
                      {!b.roleFound && <div><Badge tone="info">{t("polc.rbac.noRole")}</Badge></div>}
                    </td>
                    <td className={styles.mono}>{subjectText(b)}</td>
                    <td>
                      <div className={styles.chips}>
                        {b.risks.length === 0 ? <span className={styles.muted}>-</span> : b.risks.map((r) => <Badge key={r} tone={r === "cluster-admin" || r === "익명 접근" || r === "anonymous access" ? "high" : "medium"}>{r}</Badge>)}
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
            {t("polc.rbac.roles")} <span className={styles.muted}>({visibleRoles.length}/{roles.length})</span>
          </div>
          <div className={styles.panelHint}>{t("polc.rbac.rolesHint")}</div>
        </div>
        {visibleRoles.length === 0 ? (
          <Empty>{t("polc.rbac.noRoles")}</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("polc.rbac.role")}</th>
                  <th>{t("polc.rbac.rules")}</th>
                  <th>{t("polc.rbac.bindingCount")}</th>
                  <th>{t("polc.rbac.risks")}</th>
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
                        {r.system && <Badge tone="system">{t("polc.system")}</Badge>}
                        {r.aggregated && <Badge tone="neutral">aggregated</Badge>}
                      </div>
                    </td>
                    <td>{r.ruleCount}</td>
                    <td>{r.bindingCount === 0 ? <span className={styles.muted}>{t("polc.rbac.unused")}</span> : r.bindingCount}</td>
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
