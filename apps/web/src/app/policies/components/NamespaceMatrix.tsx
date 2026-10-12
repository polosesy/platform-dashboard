"use client";

import type { NamespacePolicySummary } from "@aud/types";
import styles from "../styles.module.css";
import { Badge, CoverageBar, Empty, PsaBadge, SeverityBadge } from "./shared";

/** One row per namespace: every policy dimension at a glance. */
export function NamespaceMatrix({ namespaces }: { namespaces: NamespacePolicySummary[] }) {
  if (namespaces.length === 0) return <Empty>표시할 네임스페이스가 없습니다.</Empty>;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>네임스페이스별 정책 현황</div>
        <div className={styles.panelHint}>격리 막대: 실행 중 파드(hostNetwork 제외) 중 NetworkPolicy에 선택된 비율</div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>네임스페이스</th>
              <th>파드 / 워크로드</th>
              <th>PSA enforce</th>
              <th>Ingress 격리</th>
              <th>Egress 격리</th>
              <th>NetPol</th>
              <th>RBAC (Role/RB)</th>
              <th>VPA / HPA / PDB</th>
              <th>Quota / LimitRange</th>
              <th>점검 결과</th>
            </tr>
          </thead>
          <tbody>
            {namespaces.map((n) => (
              <tr key={n.name}>
                <td>
                  <div className={styles.mono}>{n.name}</div>
                  {n.system && <Badge tone="system">시스템</Badge>}
                </td>
                <td>
                  {n.podCount} / {n.workloadCount}
                </td>
                <td>
                  <PsaBadge level={n.psaEffectiveEnforce} implicit={!n.psa.enforce} />
                </td>
                <td>
                  <CoverageBar covered={n.networkPolicy.ingressIsolatedPods} total={n.networkPolicy.eligiblePods} />
                  {n.networkPolicy.defaultDenyIngress && <Badge tone="ok">default-deny</Badge>}
                </td>
                <td>
                  <CoverageBar covered={n.networkPolicy.egressIsolatedPods} total={n.networkPolicy.eligiblePods} />
                  {n.networkPolicy.defaultDenyEgress && <Badge tone="ok">default-deny</Badge>}
                </td>
                <td>
                  {n.networkPolicy.k8sPolicies}
                  {n.networkPolicy.ciliumPolicies > 0 && <span className={styles.muted}> + Cilium {n.networkPolicy.ciliumPolicies}</span>}
                </td>
                <td>
                  {n.rbac.roles} / {n.rbac.roleBindings}
                </td>
                <td>
                  {n.autoscaling.vpa} / {n.autoscaling.hpa} / {n.autoscaling.pdb}
                </td>
                <td>
                  <Badge tone={n.quota.resourceQuotas > 0 ? "ok" : "neutral"}>Quota {n.quota.resourceQuotas}</Badge>{" "}
                  <Badge tone={n.quota.limitRanges > 0 ? "ok" : "neutral"}>LR {n.quota.limitRanges}</Badge>
                </td>
                <td>
                  <div className={styles.chips}>
                    {n.findings.high > 0 && <SeverityBadge severity="high" count={n.findings.high} />}
                    {n.findings.medium > 0 && <SeverityBadge severity="medium" count={n.findings.medium} />}
                    {n.findings.low > 0 && <SeverityBadge severity="low" count={n.findings.low} />}
                    {n.findings.high + n.findings.medium + n.findings.low === 0 && <Badge tone="ok">양호</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
