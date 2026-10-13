"use client";

import type { NamespacePolicySummary, NetworkPolicyInfo } from "@aud/types";
import styles from "../styles.module.css";
import { useI18n } from "@/lib/i18n";
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
  podSelector: {}          # every pod in the namespace
  policyTypes: [Ingress, Egress]
---
# with default-deny egress, allow DNS
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
  const { t } = useI18n();
  const withPods = namespaces.filter((n) => n.networkPolicy.eligiblePods > 0);
  const totalPods = withPods.reduce((s, n) => s + n.networkPolicy.eligiblePods, 0);
  const ingress = withPods.reduce((s, n) => s + n.networkPolicy.ingressIsolatedPods, 0);
  const egress = withPods.reduce((s, n) => s + n.networkPolicy.egressIsolatedPods, 0);

  return (
    <div className={styles.page}>
      <div className={styles.twoCol}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>{t("polc.net.coverage")}</div>
            {ciliumInstalled && <Badge tone="neutral">{t("polc.net.cilium")}</Badge>}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <td>{t("polc.net.allIngress")}</td>
                  <td><CoverageBar covered={ingress} total={totalPods} /></td>
                </tr>
                <tr>
                  <td>{t("polc.net.allEgress")}</td>
                  <td><CoverageBar covered={egress} total={totalPods} /></td>
                </tr>
                {withPods.map((n) => (
                  <tr key={n.name}>
                    <td className={styles.mono}>{n.name}</td>
                    <td>
                      <CoverageBar covered={n.networkPolicy.ingressIsolatedPods} total={n.networkPolicy.eligiblePods} label={t("polc.net.in")} />
                      <CoverageBar covered={n.networkPolicy.egressIsolatedPods} total={n.networkPolicy.eligiblePods} label={t("polc.net.out")} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>{t("polc.net.defaultDeny")}</div>
            <a className={styles.refLink} href="https://kubernetes.io/docs/concepts/services-networking/network-policies/#default-policies" target="_blank" rel="noreferrer">
              {t("polc.k8sDocs")}
            </a>
          </div>
          <div className={styles.empty}>
            {t("polc.net.defaultDenyHint")}
          </div>
          <pre className={styles.code}>{DEFAULT_DENY_YAML}</pre>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>{t("polc.net.deployed", { n: policies.length })}</div>
        </div>
        {policies.length === 0 ? (
          <Empty>{t("polc.net.none")}</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t("polc.net.kind")}</th>
                  <th>{t("polc.net.nsName")}</th>
                  <th>{t("polc.net.selector")}</th>
                  <th>{t("polc.net.selected")}</th>
                  <th>{t("polc.net.direction")}</th>
                  <th>{t("polc.net.rules")}</th>
                  <th>{t("polc.net.notes")}</th>
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
                        {p.allowsAllIngress && <Badge tone="medium">{t("polc.net.allowsAllIn")}</Badge>}
                        {p.allowsAllEgress && <Badge tone="low">{t("polc.net.allowsAllOut")}</Badge>}
                        {p.selectedPods === 0 && <Badge tone="info">{t("polc.net.noPods")}</Badge>}
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
