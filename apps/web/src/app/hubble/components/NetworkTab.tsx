"use client";

import { useState, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import type { HubbleNetworkSummary } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer, isPermanentApiError } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";
import { CoverageNote } from "./CoverageNote";
import { rgba } from "@/lib/palette";

type Props = { clusterId: string };

export function NetworkTab({ clusterId }: Props) {
  const { t, locale } = useI18n();
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
        `${apiBaseUrl()}/api/hubble/network-summary?clusterId=${encodeURIComponent(clusterId)}&timeWindow=5&lang=${locale}`,
        token,
      );
      setData(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return !isPermanentApiError(e);
    } finally {
      setLoading(false);
    }
  }, [clusterId, getApiToken, locale]);

  usePolling(fetch_, 30_000);

  if (loading && !data) {
    return (
      <div className={styles.loadingRow}>
        <span className={styles.spinner} />
        <span>{t("hb.net.loading")}</span>
      </div>
    );
  }

  if (error) return <div className={styles.errorMsg}>{t("hb.net.error")}: {error}</div>;
  if (!data) return null;

  const dropPct = data.totalFlows > 0 ? ((data.droppedFlows / data.totalFlows) * 100).toFixed(1) : "0";

  return (
    <div>
      <CoverageNote coverage={data.coverage} requestedMinutes={data.timeWindowMinutes} />

      {/* Summary Cards */}
      <div className={styles.summaryCards}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>{t("hb.totalFlows")}</div>
          <div className={styles.summaryCardValue}>{data.totalFlows.toLocaleString()}</div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>{t("hb.verdict.FORWARDED")}</div>
          <div className={styles.summaryCardValue} style={{ color: rgba("success", 0.85) }}>
            {data.forwardedFlows.toLocaleString()}
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>{t("hb.verdict.DROPPED")}</div>
          <div className={styles.summaryCardValue} style={{ color: data.droppedFlows > 0 ? rgba("danger", 0.85) : undefined }}>
            {data.droppedFlows.toLocaleString()}
          </div>
          <div className={styles.summaryCardSub}>{dropPct}%</div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryCardLabel}>{t("hb.dnsErrors")}</div>
          <div className={styles.summaryCardValue}>{data.dnsErrors.length}</div>
        </div>
      </div>

      {/* Protocol Breakdown */}
      <h3 className={styles.sectionTitle}>{t("hb.net.protocols")}</h3>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th>{t("hb.col.protocol")}</th>
            <th>{t("hb.net.flowCount")}</th>
            <th>{t("hb.net.share")}</th>
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
      <h3 className={styles.sectionTitle}>{t("hb.net.byNamespace")}</h3>
      <div className={styles.nsTrafficGrid}>
        {data.namespaceTraffic.slice(0, 12).map((ns) => (
          <div key={ns.namespace} className={styles.nsTrafficCard}>
            <div className={styles.nsTrafficName}>{ns.namespace}</div>
            <div className={styles.nsTrafficRow}>
              <span>{t("hb.net.in")}</span>
              <span style={{ fontWeight: 600 }}>{ns.inbound.toLocaleString()}</span>
            </div>
            <div className={styles.nsTrafficRow}>
              <span>{t("hb.net.out")}</span>
              <span style={{ fontWeight: 600 }}>{ns.outbound.toLocaleString()}</span>
            </div>
            {ns.dropped > 0 && (
              <div className={styles.nsTrafficRow}>
                <span style={{ color: rgba("danger", 0.75) }}>{t("hb.verdict.DROPPED")}</span>
                <span style={{ fontWeight: 600, color: rgba("danger", 0.85) }}>{ns.dropped}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Top Dropped */}
      {data.topDropped.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>{t("hb.net.topDropped")}</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{t("hb.col.source")}</th>
                <th>{t("hb.col.destination")}</th>
                <th>{t("hb.col.count")}</th>
                <th>{t("hb.fd.dropReason")}</th>
              </tr>
            </thead>
            <tbody>
              {data.topDropped.map((d, i) => (
                <tr key={i}>
                  <td>{d.source}</td>
                  <td>{d.destination}</td>
                  <td style={{ fontWeight: 600, color: rgba("danger", 0.85) }}>{d.count}</td>
                  <td style={{ fontSize: 11, color: rgba("ink", 0.55) }}>{d.dropReason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* DNS Errors */}
      {data.dnsErrors.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>{t("hb.dnsErrors")}</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{t("hb.net.query")}</th>
                <th>RCODE</th>
                <th>{t("hb.col.count")}</th>
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
