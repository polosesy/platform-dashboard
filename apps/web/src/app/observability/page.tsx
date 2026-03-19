"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ObservabilityOverview,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
} from "@aud/types";
import styles from "./styles.module.css";
import { DataSourceBadges } from "./components/DataSourceBadges";
import { OverviewTab } from "./components/OverviewTab";
import { WorkloadsTab } from "./components/WorkloadsTab";
import { InfraTab } from "./components/InfraTab";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Tab = "overview" | "workloads" | "infra";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "workloads", label: "Workloads" },
  { id: "infra", label: "Infrastructure" },
];

// ── Fetch helpers ──
async function fetchOverview(clusterId: string): Promise<ObservabilityOverview> {
  const res = await fetch(`${API_BASE}/api/observability/overview?clusterId=${encodeURIComponent(clusterId)}&clusterName=${encodeURIComponent(clusterId)}`);
  if (!res.ok) throw new Error(`overview fetch failed: ${res.status}`);
  return res.json();
}

async function fetchWorkloads(clusterId: string): Promise<ObservabilityWorkloadsResponse> {
  const res = await fetch(`${API_BASE}/api/observability/workloads?clusterId=${encodeURIComponent(clusterId)}`);
  if (!res.ok) throw new Error(`workloads fetch failed: ${res.status}`);
  return res.json();
}

async function fetchNodes(clusterId: string): Promise<ObservabilityNodesResponse> {
  const res = await fetch(`${API_BASE}/api/observability/nodes?clusterId=${encodeURIComponent(clusterId)}`);
  if (!res.ok) throw new Error(`nodes fetch failed: ${res.status}`);
  return res.json();
}

export default function ObservabilityPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [clusterId, setClusterId] = useState("default");
  const [selectedWorkload, setSelectedWorkload] = useState<string | null>(null);

  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [workloadsResp, setWorkloadsResp] = useState<ObservabilityWorkloadsResponse | null>(null);
  const [nodesResp, setNodesResp] = useState<ObservabilityNodesResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, wl, nd] = await Promise.all([
        fetchOverview(clusterId),
        fetchWorkloads(clusterId),
        fetchNodes(clusterId),
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
  }, [clusterId]);

  useEffect(() => { load(); }, [load]);

  function handleWorkloadSelect(name: string, ns: string) {
    if (!name) {
      setSelectedWorkload(null);
      return;
    }
    setSelectedWorkload(`${ns}/${name}`);
    setTab("workloads");
  }

  const dsStatus = overview?.dataSourceStatus
    ?? workloadsResp?.dataSourceStatus
    ?? nodesResp?.dataSourceStatus
    ?? null;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>Observability</h1>
        <input
          className={styles.clusterSelect}
          type="text"
          placeholder="클러스터 ID (예: my-aks-cluster)"
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          onBlur={() => load()}
          onKeyDown={(e) => e.key === "Enter" && load()}
        />
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
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

      {/* Loading placeholder */}
      {loading && !overview && (
        <div className={styles.loadingRow}>
          <span className={styles.spinner} />
          <span>데이터를 불러오는 중...</span>
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
        </>
      )}
    </div>
  );
}
