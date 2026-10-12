"use client";

import type { NamespacePolicySummary, NetworkPolicyInfo } from "@aud/types";
import styles from "../styles.module.css";
import { Badge, CoverageBar, Empty } from "./shared";

const SOURCE_LABEL: Record<NetworkPolicyInfo["source"], string> = {
  kubernetes: "NetworkPolicy",
  cilium: "CiliumNetworkPolicy",
  "cilium-clusterwide": "CiliumClusterwideNetworkPolicy",
};

const DEFAULT_DENY_YAML = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: <namespace>
spec:
  podSelector: {}          # 네임스페이스의 모든 파드
  policyTypes: [Ingress, Egress]
---
# default-deny egress 사용 시 DNS 허용 필요
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: <namespace>
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: kube-system }
      podSelector:
        matchLabels: { k8s-app: kube-dns }
    ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }`;

export function NetworkPolicyPanel({
  policies,
  namespaces,
  ciliumInstalled,
}: {
  policies: NetworkPolicyInfo[];
  namespaces: NamespacePolicySummary[];
  ciliumInstalled: boolean;
}) {
  const withPods = namespaces.filter((n) => n.networkPolicy.eligiblePods > 0);
  const totalPods = withPods.reduce((s, n) => s + n.networkPolicy.eligiblePods, 0);
  const ingress = withPods.reduce((s, n) => s + n.networkPolicy.ingressIsolatedPods, 0);
  const egress = withPods.reduce((s, n) => s + n.networkPolicy.egressIsolatedPods, 0);

  return (
    <div className={styles.page}>
      <div className={styles.twoCol}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>파드 격리 커버리지</div>
            {ciliumInstalled && <Badge tone="neutral">Cilium 정책 포함</Badge>}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <td>전체 Ingress 격리</td>
                  <td><CoverageBar covered={ingress} total={totalPods} /></td>
                </tr>
                <tr>
                  <td>전체 Egress 격리</td>
                  <td><CoverageBar covered={egress} total={totalPods} /></td>
                </tr>
                {withPods.map((n) => (
                  <tr key={n.name}>
                    <td className={styles.mono}>{n.name}</td>
                    <td>
                      <CoverageBar covered={n.networkPolicy.ingressIsolatedPods} total={n.networkPolicy.eligiblePods} label="in" />
                      <CoverageBar covered={n.networkPolicy.egressIsolatedPods} total={n.networkPolicy.eligiblePods} label="out" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>권장 기본 정책 (default-deny)</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/services-networking/network-policies/#default-policies" target="_blank" rel="noreferrer">
              Kubernetes 문서
            </a>
          </div>
          <div className={styles.empty}>
            NetworkPolicy가 하나도 선택하지 않은 파드는 모든 트래픽이 허용됩니다. 네임스페이스마다 default-deny를 두고 필요한 흐름만 허용하는 것이 표준 권장안입니다.
          </div>
          <pre className={styles.code}>{DEFAULT_DENY_YAML}</pre>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>배포된 네트워크 정책 ({policies.length})</div>
        </div>
        {policies.length === 0 ? (
          <Empty>배포된 NetworkPolicy가 없습니다.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>종류</th>
                  <th>네임스페이스 / 이름</th>
                  <th>대상 셀렉터</th>
                  <th>선택된 파드</th>
                  <th>방향</th>
                  <th>규칙 (in / out)</th>
                  <th>특이사항</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={`${p.source}/${p.namespace}/${p.name}`}>
                    <td><Badge tone="neutral">{SOURCE_LABEL[p.source]}</Badge></td>
                    <td className={styles.mono}>
                      {p.namespace ? `${p.namespace}/` : "(cluster)/"}
                      {p.name}
                    </td>
                    <td className={styles.mono}>{p.podSelector}</td>
                    <td>{p.selectedPods}</td>
                    <td>{p.policyTypes.join(", ") || "-"}</td>
                    <td>
                      {p.ingressRules} / {p.egressRules}
                    </td>
                    <td>
                      <div className={styles.chips}>
                        {p.defaultDenyIngress && <Badge tone="ok">default-deny ingress</Badge>}
                        {p.defaultDenyEgress && <Badge tone="ok">default-deny egress</Badge>}
                        {p.allowsAllIngress && <Badge tone="medium">모든 수신 허용</Badge>}
                        {p.allowsAllEgress && <Badge tone="low">모든 송신 허용</Badge>}
                        {p.selectedPods === 0 && <Badge tone="info">선택 파드 없음</Badge>}
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
