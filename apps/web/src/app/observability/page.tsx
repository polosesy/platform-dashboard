"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ObservabilityOverview,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
  KubernetesClustersResponse,
} from "@aud/types";
import styles from "./styles.module.css";
import { DataSourceBadges } from "./components/DataSourceBadges";
import { OverviewTab } from "./components/OverviewTab";
import { WorkloadsTab } from "./components/WorkloadsTab";
import { InfraTab } from "./components/InfraTab";
import { LogsTab } from "./components/LogsTab";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

type Tab = "overview" | "workloads" | "infra" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "workloads", label: "Workloads" },
  { id: "infra", label: "Infrastructure" },
  { id: "logs", label: "Logs" },
];

export default function ObservabilityPage() {
  const getApiToken = useApiToken();

  const [tab, setTab] = useState<Tab>("overview");
  const [clusters, setClusters] = useState<{ id: string; name: string }[]>([]);
  const [clusterId, setClusterId] = useState("");
  const [selectedWorkload, setSelectedWorkload] = useState<string | null>(null);

  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [workloadsResp, setWorkloadsResp] = useState<ObservabilityWorkloadsResponse | null>(null);
  const [nodesResp, setNodesResp] = useState<ObservabilityNodesResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Load cluster list from Kubernetes API (same source as /kubernetes page)
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
        if (list.length > 0) {
          setClusterId((prev) => prev || list[0]!.id);
        }
      })
      .catch(() => {
        // clusters API 실패 시 텍스트 입력으로 fallback
      })
      .finally(() => {
        if (!cancelled) setClustersLoading(false);
      });
    return () => { cancelled = true; };
  }, [getApiToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const base = apiBaseUrl();
      const cid = encodeURIComponent(clusterId);
      const cname = encodeURIComponent(
        clusters.find((c) => c.id === clusterId)?.name ?? clusterId,
      );
      const [ov, wl, nd] = await Promise.all([
        fetchJsonWithBearer<ObservabilityOverview>(
          `${base}/api/observability/overview?clusterId=${cid}&clusterName=${cname}`,
          token,
        ),
        fetchJsonWithBearer<ObservabilityWorkloadsResponse>(
          `${base}/api/observability/workloads?clusterId=${cid}`,
          token,
        ),
        fetchJsonWithBearer<ObservabilityNodesResponse>(
          `${base}/api/observability/nodes?clusterId=${cid}`,
          token,
        ),
      ]);
      setOverview(ov);
      setWorkloadsResp(wl);
      setNodesResp(nd);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, clusters, getApiToken]);

  // Auto-load when clusterId is set
  useEffect(() => {
    if (clusterId) load();
  }, [clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleWorkloadSelect(name: string, ns: string) {
    if (!name) {
      setSelectedWorkload(null);
      return;
    }
    setSelectedWorkload(`${ns}/${name}`);
    setTab("workloads");
  }

  const dsStatus =
    overview?.dataSourceStatus ??
    workloadsResp?.dataSourceStatus ??
    nodesResp?.dataSourceStatus ??
    null;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>Observability</h1>

        {/* Cluster selector */}
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
            onBlur={() => load()}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
        )}

        <button
          className={styles.refreshBtn}
          onClick={load}
          disabled={loading || !clusterId}
        >
          {loading ? "로딩 중..." : "새로고침"}
        </button>

        {lastRefresh && (
          <span style={{ fontSize: 11, color: "rgba(20,21,23,0.35)" }}>
            {lastRefresh.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Data source badges */}
      {dsStatus && <DataSourceBadges status={dsStatus} />}

      {/* Error */}
      {error && <div className={styles.errorMsg}>오류: {error}</div>}

      {/* Loading */}
      {loading && !overview && (
        <div className={styles.loadingRow}>
          <span className={styles.spinner} />
          <span>데이터를 불러오는 중...</span>
        </div>
      )}

      {/* No cluster selected */}
      {!loading && !clusterId && !clustersLoading && (
        <div className={styles.noDataBanner}>
          <strong>클러스터를 선택해 주세요</strong>
          상단에서 AKS 클러스터를 선택하면 워크로드 및 노드 데이터를 불러옵니다.
        </div>
      )}

      {/* Tabs */}
      {(overview || workloadsResp || nodesResp) && (
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

          {tab === "overview" && overview && (
            <OverviewTab data={overview} onWorkloadSelect={handleWorkloadSelect} />
          )}

          {tab === "workloads" && workloadsResp && (
            <WorkloadsTab
              workloads={workloadsResp.workloads}
              onWorkloadSelect={handleWorkloadSelect}
              selectedKey={selectedWorkload}
            />
          )}

          {tab === "infra" && nodesResp && (
            <InfraTab nodes={nodesResp.nodes} />
          )}

          {tab === "logs" && (
            <LogsTab
              clusterId={clusterId}
              workloads={workloadsResp?.workloads ?? []}
            />
          )}
        </>
      )}
    </div>
  );
}
