"use client";

import type { HpaInfo, PdbInfo, VpaInfo, WorkloadPolicyCoverage } from "@aud/types";
import styles from "../styles.module.css";
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
  const visible = workloads.filter((w) => showSystem || !w.system);

  return (
    <div className={styles.page}>
      {!vpaInstalled && (
        <div className={styles.notice}>
          <b>Vertical Pod Autoscaler가 설치되어 있지 않습니다.</b> AKS Standard에서는 <span className={styles.mono}>az aks update --enable-vpa</span>로 활성화할 수 있습니다.
          권장 순서: updateMode <span className={styles.mono}>Off</span>(추천값만 수집) → 추천값 검토 → <span className={styles.mono}>Initial</span> 또는{" "}
          <span className={styles.mono}>InPlaceOrRecreate</span>(AKS 1.34+). CPU/메모리 기반 HPA와 같은 워크로드에 함께 쓰지 마세요.{" "}
          <a className={styles.refLink} href="https://learn.microsoft.com/azure/aks/vertical-pod-autoscaler" target="_blank" rel="noreferrer">
            AKS VPA 문서
          </a>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>워크로드별 리소스·가용성 정책 ({visible.length})</div>
          <div className={styles.panelHint}>requests 누락 · memory limit 누락 · VPA/HPA/PDB 적용 · ServiceAccount</div>
        </div>
        {visible.length === 0 ? (
          <Empty>표시할 워크로드가 없습니다.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>워크로드</th>
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
                        {w.system && <Badge tone="system">시스템</Badge>}
                      </div>
                    </td>
                    <td>{w.replicas}</td>
                    <td>
                      {w.containersWithoutRequests === 0 ? <Badge tone="ok">설정됨</Badge> : <Badge tone="medium">누락 {w.containersWithoutRequests}/{w.containers}</Badge>}
                    </td>
                    <td>
                      {w.containersWithoutMemoryLimit === 0 ? <Badge tone="ok">설정됨</Badge> : <Badge tone="low">누락 {w.containersWithoutMemoryLimit}/{w.containers}</Badge>}
                    </td>
                    <td>{w.vpa ? <Badge tone="ok">{w.vpa.updateMode}</Badge> : <span className={styles.muted}>-</span>}</td>
                    <td>{w.hpa ? <Badge tone="ok">{w.hpa.resourceMetrics.join(", ") || "custom"}</Badge> : <span className={styles.muted}>-</span>}</td>
                    <td>
                      {w.pdb ? (
                        <Badge tone="ok">{w.pdb}</Badge>
                      ) : w.replicas > 1 && w.kind !== "DaemonSet" ? (
                        <Badge tone="low">없음</Badge>
                      ) : (
                        <span className={styles.muted}>-</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.mono}>{w.serviceAccount}</span>
                      {w.serviceAccount === "default" && w.automountToken && (
                        <div>
                          <Badge tone="low">토큰 자동 마운트</Badge>
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
            <Empty>{vpaInstalled ? "배포된 VPA가 없습니다." : "VPA CRD 미설치"}</Empty>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>VPA</th><th>대상</th><th>updateMode</th><th>추천값 (target)</th></tr>
                </thead>
                <tbody>
                  {vpas.map((v) => (
                    <tr key={`${v.namespace}/${v.name}`}>
                      <td className={styles.mono}>{v.namespace}/{v.name}</td>
                      <td className={styles.mono}>
                        {v.target.kind}/{v.target.name}
                        {!v.targetFound && <div><Badge tone="medium">대상 없음</Badge></div>}
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
            <Empty>배포된 HPA가 없습니다.</Empty>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>HPA</th><th>대상</th><th>replicas</th><th>지표</th></tr>
                </thead>
                <tbody>
                  {hpas.map((h) => (
                    <tr key={`${h.namespace}/${h.name}`}>
                      <td className={styles.mono}>{h.namespace}/{h.name}</td>
                      <td className={styles.mono}>
                        {h.target.kind}/{h.target.name}
                        {!h.targetFound && <div><Badge tone="medium">대상 없음</Badge></div>}
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
            Kubernetes 문서
          </a>
        </div>
        {pdbs.length === 0 ? (
          <Empty>배포된 PDB가 없습니다.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>PDB</th><th>minAvailable</th><th>maxUnavailable</th><th>허용 중단</th><th>대상 워크로드</th></tr>
              </thead>
              <tbody>
                {pdbs.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`}>
                    <td className={styles.mono}>{p.namespace}/{p.name}</td>
                    <td>{p.minAvailable ?? "-"}</td>
                    <td>{p.maxUnavailable ?? "-"}</td>
                    <td>{p.disruptionsAllowed === 0 ? <Badge tone="medium">0</Badge> : (p.disruptionsAllowed ?? "-")}</td>
                    <td className={styles.mono}>{p.matchedWorkloads.join(", ") || <Badge tone="info">없음</Badge>}</td>
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
