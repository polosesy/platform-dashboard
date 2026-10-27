"use client";

import { useState, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import type { HubbleSecuritySummary } from "@aud/types";
import { apiUrl, fetchJsonWithBearer, isPermanentApiError } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";
import { CoverageNote } from "./CoverageNote";
import { EnforceReadiness } from "./EnforceReadiness";
import { rgba } from "@/lib/palette";

type Props = { clusterId: string };

export function SecurityTab({ clusterId }: Props) {
  const { t, locale } = useI18n();
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
        apiUrl("/api/hubble/security-summary", { clusterId, timeWindow: 5, lang: locale }),
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
        <span>{t("hb.sec.loading")}</span>
      </div>
    );
  }

  if (error) return <div className={styles.errorMsg}>{t("hb.sec.error")}: {error}</div>;
  if (!data) return null;

  const total = data.policyVerdicts.allowed + data.policyVerdicts.denied + data.policyVerdicts.audit;

  return (
    <div>
      <CoverageNote coverage={data.coverage} requestedMinutes={data.timeWindowMinutes} />

      {data.enforceReadiness && <EnforceReadiness data={data.enforceReadiness} />}

      {/* Policy Verdict Summary */}
      <div className={styles.verdictSummary}>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: rgba("success", 0.85) }}>
            {data.policyVerdicts.allowed.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>{t("hb.allowed")}</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: rgba("danger", 0.85) }}>
            {data.policyVerdicts.denied.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>{t("hb.denied")}</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue} style={{ color: rgba("warning", 0.85) }}>
            {data.policyVerdicts.audit.toLocaleString()}
          </div>
          <div className={styles.verdictBoxLabel}>{t("hb.verdict.AUDIT")}</div>
        </div>
        <div className={styles.verdictBox}>
          <div className={styles.verdictBoxValue}>{total.toLocaleString()}</div>
          <div className={styles.verdictBoxLabel}>{t("hb.total")}</div>
        </div>
        {total > 0 && (
          <div className={styles.verdictBox}>
            <div className={styles.verdictBoxValue} style={{
              color: data.policyVerdicts.denied > total * 0.05 ? rgba("danger", 0.85) : rgba("success", 0.85),
            }}>
              {((data.policyVerdicts.denied / total) * 100).toFixed(1)}%
            </div>
            <div className={styles.verdictBoxLabel}>{t("hb.denyRate")}</div>
          </div>
        )}
      </div>

      {/* Top Denied Flows */}
      {data.topDenied.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>{t("hb.sec.topDenied")}</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{t("hb.col.source")}</th>
                <th>{t("hb.col.destination")}</th>
                <th>{t("hb.col.port")}</th>
                <th>{t("hb.col.protocol")}</th>
                <th>{t("hb.col.count")}</th>
                <th>{t("hb.col.direction")}</th>
              </tr>
            </thead>
            <tbody>
              {data.topDenied.map((d, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{d.source}</td>
                  <td style={{ fontWeight: 600 }}>{d.destination}</td>
                  <td className={styles.flowMono}>{d.port}</td>
                  <td><span className={styles.protocolBadge}>{d.protocol}</span></td>
                  <td style={{ fontWeight: 700, color: rgba("danger", 0.85) }}>{d.count}</td>
                  <td style={{ fontSize: 11, color: rgba("ink", 0.5) }}>{d.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.topDenied.length === 0 && (
        <div className={styles.noDataBanner}>
          <strong>{t("hb.sec.noDenied")}</strong>
          {t("hb.sec.noDeniedHint")}
        </div>
      )}

      {/* Identity-based Flow Matrix */}
      {data.identityFlows.length > 0 && (
        <>
          <h3 className={styles.sectionTitle}>{t("hb.sec.matrix")}</h3>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>{t("hb.fd.srcIdentity")}</th>
                <th>{t("hb.sec.srcLabel")}</th>
                <th>{t("hb.fd.dstIdentity")}</th>
                <th>{t("hb.sec.dstLabel")}</th>
                <th>{t("hb.allowed")}</th>
                <th>{t("hb.denied")}</th>
              </tr>
            </thead>
            <tbody>
              {data.identityFlows.map((f, i) => (
                <tr key={i}>
                  <td className={styles.flowMono}>{f.sourceIdentity}</td>
                  <td>{f.sourceLabel}</td>
                  <td className={styles.flowMono}>{f.destIdentity}</td>
                  <td>{f.destLabel}</td>
                  <td style={{ color: rgba("success", 0.85), fontWeight: 600 }}>{f.allowed}</td>
                  <td style={{ color: f.denied > 0 ? rgba("danger", 0.85) : undefined, fontWeight: 600 }}>
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
