"use client";

import { useState, useEffect, useCallback } from "react";
import type { HubbleNetworkSummary } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

type Props = { clusterId: string };

export function NetworkTab({ clusterId }: Props) {
  const getApiToken = useApiToken();

  const [data, setData] = useState<HubbleNetworkSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const resp = await fetchJsonWithBearer<HubbleNetworkSummary>(
        `${apiBaseUrl()}/api/hubble/network-summary?clusterId=${encodeURIComponent(clusterId)}&timeWindow=5`,
        token,
      );
      setData(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, getApiToken]);

  useEffect(() => {
    fetch_();
    const iv = setInterval(fetch_, 30_000);
    return () => clearInterval(iv);
  }, [fetch_]);

  if (loading && !data) {
    return (
      <div className={styles.loadingRow}>
        <span className={styles.spinner} />
        <span>네트워크 데이터 로딩 중...</span>
      </div>
    );
  }

  if (error) return <div className={styles.errorMsg}>Network 오류: {error}</div>;
  if (!data) return null;

  const dropPct = data.totalFlows > 0 ? ((data.droppedFlows / data.totalFlows) * 100).toFixed(1) : "0";

  return (
    <div>
      {/* Summary Cards */}
      <div className={styles.summaryCards}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>전체 플로우</div>
          <div className={styles.summaryCardValue}>{data.totalFlows.toLocaleString()}</div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>Forwarded</div>
          <div className={styles.summaryCardValue} style={{ color: "rgba(16,137,62,0.85)" }}>
            {data.forwardedFlows.toLocaleString()}
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>Dropped</div>
          <div className={styles.summaryCardValue} style={{ color: data.droppedFlows > 0 ? "rgba(196,43,28,0.85)" : undefined }}>
            {data.droppedFlows.toLocaleString()}
          </div>
          <div className={styles.summaryCardSub}>{dropPct}%</div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>DNS 에러</div>
          <div className={styles.summaryCardValue}>{data.dnsErrors.length}</div>
        </div>
      </div>

      {/* Protocol Breakdown */}
      <h3 className={styles.sectionTitle}>프로토콜 분포</h3>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>플로우 수</th>
            <th>비율</th>
          </tr>
        </thead>
        <tbody>
          {data.protocolBreakdown.map((p) => (
            <tr key={p.protocol}>
              <td><span className={styles.protocolBadge}>{p.protocol}</span></td>
              <td>{p.count.toLocaleString()}</td>
              <td>{data.totalFlows > 0 ? ((p.count / data.totalFlows) * 100).toFixed(1) : "0"}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Namespace Traffic */}
      <h3 className={styles.sectionTitle}>네임스페이스별 트래픽</h3>
      <div className={styles.nsTrafficGrid}>
        {data.namespaceTraffic.slice(0, 12).map((ns) => (
          <div key={ns.namespace} className={styles.nsTrafficCard}>
            <div className={styles.nsTrafficName}>{ns.namespace}</div>
            <div className={styles.nsTrafficRow}>
              <span>Inbound</span>
              <span style={{ fontWeight: 600 }}>{ns.inbound.toLocaleString()}</span>
            </div>
            <div className={styles.nsTrafficRow}>
              <span>Outbound</span>
              <span style={{ fontWeight: 600 }}>{ns.outbound.toLocaleString()}</span>
            </div>
            {ns.dropped > 0 && (
              <div className={styles.nsTrafficRow}>
                <span style={{ color: "rgba(196,43,28,0.75)" }}>Dropped</span>
                <span style={{ fontWeight: 600, color: "rgba(196,43,28,0.85)" }}>{ns.dropped}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Top Dropped */}
      {data.topDropped.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Top Dropped 플로우</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Destination</th>
                <th>Count</th>
                <th>Drop Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.topDropped.map((d, i) => (
                <tr key={i}>
                  <td>{d.source}</td>
                  <td>{d.destination}</td>
                  <td style={{ fontWeight: 600, color: "rgba(196,43,28,0.85)" }}>{d.count}</td>
                  <td style={{ fontSize: 11, color: "rgba(20,21,23,0.55)" }}>{d.dropReason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* DNS Errors */}
      {data.dnsErrors.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>DNS 에러</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Query</th>
                <th>RCODE</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {data.dnsErrors.map((d, i) => (
                <tr key={i}>
                  <td className={styles.flowMono}>{d.query}</td>
                  <td>{d.rcode}</td>
                  <td style={{ fontWeight: 600 }}>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
