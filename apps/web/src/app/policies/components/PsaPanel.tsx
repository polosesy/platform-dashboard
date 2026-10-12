"use client";

import type { NamespacePolicySummary } from "@aud/types";
import styles from "../styles.module.css";
import { Badge, PsaBadge } from "./shared";

const RECOMMENDED_LABELS = `apiVersion: v1
kind: Namespace
metadata:
  name: <namespace>
  labels:
    # 1단계: 위반 가시화 (차단 없음)
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
    # 2단계: 워크로드 수정 후 강제
    pod-security.kubernetes.io/enforce: baseline     # 가능하면 restricted
    pod-security.kubernetes.io/enforce-version: v1.33`;

const LEVEL_GUIDE = [
  { level: "privileged" as const, text: "제한 없음. 노드 수준 권한 상승 가능 — CNI·스토리지 드라이버 등 시스템 구성요소 전용" },
  { level: "baseline" as const, text: "알려진 권한 상승 차단 (privileged, hostNetwork/PID/IPC, hostPath, 위험 capability 금지)" },
  { level: "restricted" as const, text: "강화 표준 (runAsNonRoot, seccomp RuntimeDefault, capability drop ALL, 권한 상승 금지)" },
];

export function PsaPanel({ namespaces }: { namespaces: NamespacePolicySummary[] }) {
  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>Pod Security Admission 라벨</div>
          <div className={styles.panelHint}>라벨이 없으면 기본값 privileged(제한 없음)가 적용됩니다</div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>네임스페이스</th>
                <th>enforce (차단)</th>
                <th>audit (감사 로그)</th>
                <th>warn (경고)</th>
                <th>enforce-version</th>
                <th>파드</th>
              </tr>
            </thead>
            <tbody>
              {namespaces.map((n) => (
                <tr key={n.name}>
                  <td>
                    <span className={styles.mono}>{n.name}</span> {n.system && <Badge tone="system">시스템</Badge>}
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
            <div className={styles.panelTitle}>Pod Security Standards 레벨</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/pod-security-standards/" target="_blank" rel="noreferrer">
              Kubernetes 문서
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
            <div className={styles.panelTitle}>권장 라벨 (단계적 적용)</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/security/pod-security-admission/" target="_blank" rel="noreferrer">
              Kubernetes 문서
            </a>
          </div>
          <pre className={styles.code}>{RECOMMENDED_LABELS}</pre>
        </div>
      </div>
    </div>
  );
}
