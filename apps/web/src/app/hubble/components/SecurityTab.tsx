"use client";

import { useState, useEffect, useCallback } from "react";
import type { HubbleSecuritySummary } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

type Props = { clusterId: string };

export function SecurityTab({ clusterId }: Props) {
  const getApiToken = useApiToken();

  const [data, setData] = useState<HubbleSecuritySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const resp = await fetchJsonWithBearer<HubbleSecuritySummary>(
        `${apiBaseUrl()}/api/hubble/security-summary?clusterId=${encodeURIComponent(clusterId)}&timeWindow=5`,
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
        <span>보안 데이터 로딩 중...</span>
      </div>
    );
  }

  if (error) return <div className={styles.errorMsg}>Security 오류: {error}</div>;
  if (!data) return null;

  const total = data.policyVerdicts.allowed + data.policyVerdicts.denied + data.policyVerdicts.audit;

  return (
    <div>
      {/* Policy Verdict Summary */}
      <div className={styles.verdictSummary}>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: "rgba(16,137,62,0.85)" }}>
            {data.policyVerdicts.allowed.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>Allowed</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: "rgba(196,43,28,0.85)" }}>
            {data.policyVerdicts.denied.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>Denied</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: "rgba(209,132,0,0.85)" }}>
            {data.policyVerdicts.audit.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>Audit</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue}>{total.toLocaleString()}</div>
          <div className={styles.verdictBoxLabel}>Total</div>
        </div>
        {total > 0 && (
          <div className={styles.verdictBox}>
            <div className={styles.verdictBoxValue} style={{
              color: data.policyVerdicts.denied > total * 0.05 ? "rgba(196,43,28,0.85)" : "rgba(16,137,62,0.85)",
            }}>
              {((data.policyVerdicts.denied / total) * 100).toFixed(1)}%
            </div>
            <div className={styles.verdictBoxLabel}>Deny Rate</div>
          </div>
        )}
      </div>

      {/* Top Denied Flows */}
      {data.topDenied.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Top Denied 플로우</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Destination</th>
                <th>Port</th>
                <th>Protocol</th>
                <th>Count</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {data.topDenied.map((d, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{d.source}</td>
                  <td style={{ fontWeight: 600 }}>{d.destination}</td>
                  <td className={styles.flowMono}>{d.port}</td>
                  <td><span className={styles.protocolBadge}>{d.protocol}</span></td>
                  <td style={{ fontWeight: 700, color: "rgba(196,43,28,0.85)" }}>{d.count}</td>
                  <td style={{ fontSize: 11, color: "rgba(20,21,23,0.5)" }}>{d.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.topDenied.length === 0 && (
        <div className={styles.noDataBanner}>
          <strong>차단된 플로우 없음</strong>
          현재 시간 범위에서 차단된 네트워크 플로우가 없습니다.
        </div>
      )}

      {/* Identity-based Flow Matrix */}
      {data.identityFlows.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>Identity 기반 플로우 매트릭스</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Source Identity</th>
                <th>Source Label</th>
                <th>Dest Identity</th>
                <th>Dest Label</th>
                <th>Allowed</th>
                <th>Denied</th>
              </tr>
            </thead>
            <tbody>
              {data.identityFlows.map((f, i) => (
                <tr key={i}>
                  <td className={styles.flowMono}>{f.sourceIdentity}</td>
                  <td>{f.sourceLabel}</td>
                  <td className={styles.flowMono}>{f.destIdentity}</td>
                  <td>{f.destLabel}</td>
                  <td style={{ color: "rgba(16,137,62,0.85)", fontWeight: 600 }}>{f.allowed}</td>
                  <td style={{ color: f.denied > 0 ? "rgba(196,43,28,0.85)" : undefined, fontWeight: 600 }}>
                    {f.denied}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
