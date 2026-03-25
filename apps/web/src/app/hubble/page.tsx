"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  KubernetesClustersResponse,
  HubbleStatusResponse,
} from "@aud/types";
import styles from "./styles.module.css";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { ServiceMapTab } from "./components/ServiceMapTab";
import { FlowsTab } from "./components/FlowsTab";
import { NetworkTab } from "./components/NetworkTab";
import { SecurityTab } from "./components/SecurityTab";

type Tab = "service-map" | "flows" | "network" | "security";

const TABS: { id: Tab; label: string }[] = [
  { id: "service-map", label: "Service Map" },
  { id: "flows", label: "Flows" },
  { id: "network", label: "Network" },
  { id: "security", label: "Security" },
];

export default function HubblePage() {
  const getApiToken = useApiToken();

  const [tab, setTab] = useState<Tab>("service-map");
  const [clusters, setClusters] = useState<{ id: string; name: string }[]>([]);
  const [clusterId, setClusterId] = useState("");
  const [clustersLoading, setClustersLoading] = useState(true);
  const [hubbleStatus, setHubbleStatus] = useState<HubbleStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load cluster list
  useEffect(() => {
    let cancelled = false;
    setClustersLoading(true);
    getApiToken()
      .then((token) =>
        fetchJsonWithBearer<KubernetesClustersResponse>(
          `${apiBaseUrl()}/api/kubernetes/clusters`,
          token,
        ),
      )
      .then((data) => {
        if (cancelled) return;
        const list = data.clusters.map((c) => ({ id: c.id, name: c.name }));
        setClusters(list);
        if (list.length > 0) setClusterId((prev) => prev || list[0]!.id);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setClustersLoading(false); });
    return () => { cancelled = true; };
  }, [getApiToken]);

  // Check Hubble status
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
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>Hubble Network Observability</h1>

        {clusters.length > 0 ? (
          <select
            className={styles.clusterSelect}
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
          >
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : (
          <input
            className={styles.clusterSelect}
            type="text"
            placeholder={clustersLoading ? "클러스터 로딩 중..." : "클러스터 ID 입력"}
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
          />
        )}

        <button className={styles.refreshBtn} onClick={checkStatus} disabled={!clusterId}>
          새로고침
        </button>
      </div>

      {/* Hubble Status */}
      {hubbleStatus && (
        <div className={styles.statusBadges}>
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
        </div>
      )}

      {error && <div className={styles.errorMsg}>오류: {error}</div>}

      {!clusterId && !clustersLoading && (
        <div className={styles.noDataBanner}>
          <strong>클러스터를 선택해 주세요</strong>
          상단에서 AKS 클러스터를 선택하면 Hubble 네트워크 데이터를 조회합니다.
        </div>
      )}

      {/* Tabs */}
      {clusterId && (
        <>
          <div className={styles.tabs}>
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "service-map" && <ServiceMapTab clusterId={clusterId} />}
          {tab === "flows" && <FlowsTab clusterId={clusterId} />}
          {tab === "network" && <NetworkTab clusterId={clusterId} />}
          {tab === "security" && <SecurityTab clusterId={clusterId} />}
        </>
      )}
    </div>
  );
}
