"use client";

import { useState, useEffect, useCallback } from "react";
import type { HubbleStatusResponse } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { ServiceMapTab } from "../../hubble/components/ServiceMapTab";
import { FlowsTab } from "../../hubble/components/FlowsTab";
import { NetworkTab } from "../../hubble/components/NetworkTab";
import { SecurityTab } from "../../hubble/components/SecurityTab";
import styles from "../../hubble/styles.module.css";

type Props = { clusterId: string };

type SubTab = "service-map" | "flows" | "network" | "security";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "service-map", label: "Service Map" },
  { id: "flows", label: "Flows" },
  { id: "network", label: "Network" },
  { id: "security", label: "Security" },
];

export function HubbleTab({ clusterId }: Props) {
  const getApiToken = useApiToken();
  const [subTab, setSubTab] = useState<SubTab>("service-map");
  const [hubbleStatus, setHubbleStatus] = useState<HubbleStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    if (!clusterId) return;
    try {
      const token = await getApiToken();
      const data = await fetchJsonWithBearer<HubbleStatusResponse>(
        `${apiBaseUrl()}/api/hubble/status?clusterId=${encodeURIComponent(clusterId)}`,
        token,
      );
      setHubbleStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clusterId, getApiToken]);

  useEffect(() => {
    if (clusterId) checkStatus();
  }, [clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {/* Hubble Status */}
      <div className={styles.statusBadges}>
        {hubbleStatus ? (
          <>
            <span className={`${styles.statusBadge} ${hubbleStatus.available ? styles.statusOk : styles.statusOff}`}>
              Hubble Relay: {hubbleStatus.available ? "연결됨" : "연결 안 됨"}
            </span>
            {hubbleStatus.available && (
              <>
                <span className={`${styles.statusBadge} ${styles.statusOk}`}>
                  노드: {hubbleStatus.nodeCount}
                </span>
                <span className={`${styles.statusBadge} ${styles.statusOk}`}>
                  플로우: {hubbleStatus.numFlows.toLocaleString()} / {hubbleStatus.maxFlows.toLocaleString()}
                </span>
              </>
            )}
          </>
        ) : (
          <span className={`${styles.statusBadge} ${styles.statusOff}`}>
            Hubble 상태 확인 중...
          </span>
        )}
        <button className={styles.refreshBtn} onClick={checkStatus} style={{ marginLeft: 8 }}>
          상태 확인
        </button>
      </div>

      {error && <div className={styles.errorMsg}>Hubble 오류: {error}</div>}

      {hubbleStatus?.message && !hubbleStatus.available && (
        <div className={styles.errorMsg} style={{ marginBottom: 16 }}>
          {hubbleStatus.message}
        </div>
      )}

      {/* Sub-tabs */}
      <div className={styles.tabs} style={{ marginBottom: 16 }}>
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            className={`${styles.tab} ${subTab === t.id ? styles.tabActive : ""}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "service-map" && <ServiceMapTab clusterId={clusterId} />}
      {subTab === "flows" && <FlowsTab clusterId={clusterId} />}
      {subTab === "network" && <NetworkTab clusterId={clusterId} />}
      {subTab === "security" && <SecurityTab clusterId={clusterId} />}
    </div>
  );
}
