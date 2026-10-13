"use client";

import type { HpaInfo, PdbInfo, VpaInfo, WorkloadPolicyCoverage } from "@aud/types";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
import { Badge, Empty } from "./shared";

type Props = {
  workloads: WorkloadPolicyCoverage[];
  vpas: VpaInfo[];
  hpas: HpaInfo[];
  pdbs: PdbInfo[];
  vpaInstalled: boolean;
  showSystem: boolean;
};

function fmtRecommendation(rec: Record<string, Record<string, string>>): string {
  const parts = Object.entries(rec).map(([c, r]) => `${c}: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return parts.join(" / ") || "-";
}

export function AutoscalingPanel({ workloads, vpas, hpas, pdbs, vpaInstalled, showSystem }: Props) {
  const { t } = useI18n();
  const visible = workloads.filter((w) => showSystem || !w.system);

  return (
    <div className={styles.page}>
      {!vpaInstalled && (
        <div className={styles.notice}>
          <b>{t("polc.as.noVpa")}</b> {t("polc.as.enable1")}<span className={styles.mono}>az aks update --enable-vpa</span>{t("polc.as.enable2")}{" "}
          {t("polc.as.order1")} <span className={styles.mono}>Off</span>{t("polc.as.order2")} <span className={styles.mono}>Initial</span> {t("polc.as.or")}{" "}
          <span className={styles.mono}>InPlaceOrRecreate</span>(AKS 1.34+). {t("polc.as.noHpaMix")}{" "}
          <a className={styles.refLink} href="https://learn.microsoft.com/azure/aks/vertical-pod-autoscaler" target="_blank" rel="noreferrer">
            {t("polc.as.vpaDocs")}
          </a>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>{t("polc.as.title", { n: visible.length })}</div>
          <div className={styles.panelHint}>{t("polc.as.hint")}</div>
        </div>
        {visible.length === 0 ? (
          <Empty>{t("polc.as.noWorkloads")}</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("ins.col.1")}</th>
                  <th>replicas</th>
                  <th>requests</th>
                  <th>memory limit</th>
                  <th>VPA</th>
                  <th>HPA</th>
                  <th>PDB</th>
                  <th>ServiceAccount</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((w) => (
                  <tr key={`${w.kind}/${w.namespace}/${w.name}`}>
                    <td>
                      <div className={styles.mono}>
                        {w.namespace}/{w.name}
                      </div>
                      <div className={styles.chips}>
                        <Badge tone="neutral">{w.kind}</Badge>
                        {w.system && <Badge tone="system">{t("polc.system")}</Badge>}
                      </div>
                    </td>
                    <td>{w.replicas}</td>
                    <td>
                      {w.containersWithoutRequests === 0 ? <Badge tone="ok">{t("polc.as.set")}</Badge> : <Badge tone="medium">{t("polc.as.missing")} {w.containersWithoutRequests}/{w.containers}</Badge>}
                    </td>
                    <td>
                      {w.containersWithoutMemoryLimit === 0 ? <Badge tone="ok">{t("polc.as.set")}</Badge> : <Badge tone="low">{t("polc.as.missing")} {w.containersWithoutMemoryLimit}/{w.containers}</Badge>}
                    </td>
                    <td>{w.vpa ? <Badge tone="ok">{w.vpa.updateMode}</Badge> : <span className={styles.muted}>-</span>}</td>
                    <td>{w.hpa ? <Badge tone="ok">{w.hpa.resourceMetrics.join(", ") || "custom"}</Badge> : <span className={styles.muted}>-</span>}</td>
                    <td>
                      {w.pdb ? (
                        <Badge tone="ok">{w.pdb}</Badge>
                      ) : w.replicas > 1 && w.kind !== "DaemonSet" ? (
                        <Badge tone="low">{t("polc.as.none")}</Badge>
                      ) : (
                        <span className={styles.muted}>-</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.mono}>{w.serviceAccount}</span>
                      {w.serviceAccount === "default" && w.automountToken && (
                        <div>
                          <Badge tone="low">{t("polc.as.automount")}</Badge>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.twoCol}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>VerticalPodAutoscaler ({vpas.length})</div>
          </div>
          {vpas.length === 0 ? (
            <Empty>{vpaInstalled ? t("polc.as.noVpas") : t("polc.as.noVpaCrd")}</Empty>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>VPA</th><th>{t("polc.as.target")}</th><th>updateMode</th><th>{t("polc.as.recommendation")}</th></tr>
                </thead>
                <tbody>
                  {vpas.map((v) => (
                    <tr key={`${v.namespace}/${v.name}`}>
                      <td className={styles.mono}>{v.namespace}/{v.name}</td>
                      <td className={styles.mono}>
                        {v.target.kind}/{v.target.name}
                        {!v.targetFound && <div><Badge tone="medium">{t("polc.as.noTarget")}</Badge></div>}
                      </td>
                      <td><Badge tone={v.updateMode === "Auto" ? "low" : "neutral"}>{v.updateMode}</Badge></td>
                      <td className={styles.mono}>{fmtRecommendation(v.recommendations)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>HorizontalPodAutoscaler ({hpas.length})</div>
          </div>
          {hpas.length === 0 ? (
            <Empty>{t("polc.as.noHpas")}</Empty>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>HPA</th><th>{t("polc.as.target")}</th><th>replicas</th><th>{t("polc.as.metrics")}</th></tr>
                </thead>
                <tbody>
                  {hpas.map((h) => (
                    <tr key={`${h.namespace}/${h.name}`}>
                      <td className={styles.mono}>{h.namespace}/{h.name}</td>
                      <td className={styles.mono}>
                        {h.target.kind}/{h.target.name}
                        {!h.targetFound && <div><Badge tone="medium">{t("polc.as.noTarget")}</Badge></div>}
                      </td>
                      <td>{h.currentReplicas ?? "-"} ({h.minReplicas}–{h.maxReplicas})</td>
                      <td className={styles.mono}>{h.metrics.join(", ") || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>PodDisruptionBudget ({pdbs.length})</div>
          <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/workloads/pods/disruptions/" target="_blank" rel="noreferrer">
            {t("polc.k8sDocs")}
          </a>
        </div>
        {pdbs.length === 0 ? (
          <Empty>{t("polc.as.noPdbs")}</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>PDB</th><th>minAvailable</th><th>maxUnavailable</th><th>{t("polc.as.allowed")}</th><th>{t("polc.as.targets")}</th></tr>
              </thead>
              <tbody>
                {pdbs.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`}>
                    <td className={styles.mono}>{p.namespace}/{p.name}</td>
                    <td>{p.minAvailable ?? "-"}</td>
                    <td>{p.maxUnavailable ?? "-"}</td>
                    <td>{p.disruptionsAllowed === 0 ? <Badge tone="medium">0</Badge> : (p.disruptionsAllowed ?? "-")}</td>
                    <td className={styles.mono}>{p.matchedWorkloads.join(", ") || <Badge tone="info">{t("polc.as.none")}</Badge>}</td>
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
