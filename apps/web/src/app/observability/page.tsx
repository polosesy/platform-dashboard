"use client";

import { useState } from "react";
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
import { LogsTab } from "./components/LogsTab";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { HubbleTab } from "./components/HubbleTab";
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeader, Select, Tabs } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

type Tab = "overview" | "workloads" | "infra" | "logs" | "hubble";

const TABS: Tab[] = ["overview", "workloads", "infra", "logs", "hubble"];

export default function ObservabilityPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const { clusters, clusterId, setClusterId, loading: clustersLoading } = useAksClusters();
  // Free-text cluster ID (used when the cluster list is unavailable) — committed on blur / Enter
  const [clusterDraft, setClusterDraft] = useState<string | null>(null);
  const [selectedWorkload, setSelectedWorkload] = useState<string | null>(null);

  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
  const query = useApiQuery(clusterId ? `observability:${clusterId}` : null, async (token) => {
    const [overview, workloads, nodes] = await Promise.all([
      fetchJsonWithBearer<ObservabilityOverview>(apiUrl("/api/observability/overview", { clusterId, clusterName }), token),
      fetchJsonWithBearer<ObservabilityWorkloadsResponse>(apiUrl("/api/observability/workloads", { clusterId }), token),
      fetchJsonWithBearer<ObservabilityNodesResponse>(apiUrl("/api/observability/nodes", { clusterId }), token),
    ]);
    return { clusterId, overview, workloads, nodes, fetchedAt: new Date() };
  });
  // Only show data belonging to the selected cluster
  const current = query.data?.clusterId === clusterId ? query.data : undefined;
  const overview = current?.overview ?? null;
  const workloadsResp = current?.workloads ?? null;
  const nodesResp = current?.nodes ?? null;
  const loading = query.loading;
  const error = query.error;
  const lastRefresh = current?.fetchedAt ?? null;

  const commitClusterDraft = () => {
    if (clusterDraft !== null) setClusterId(clusterDraft.trim());
    setClusterDraft(null);
  };

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
      <PageHeader
        meta={lastRefresh ? <span>{t("common.updated")} {lastRefresh.toLocaleTimeString()}</span> : null}
        actions={
          <>
            {clusters.length > 0 ? (
              <Select label={t("common.cluster")} value={clusterId} onChange={setClusterId} options={clusters.map((c) => ({ value: c.id, label: c.name }))} />
            ) : (
              <label className={styles.clusterField}>
                <span>{t("common.cluster")}</span>
                <input
                  type="text"
                  placeholder={clustersLoading ? t("common.loading") : t("hub.clusterIdPlaceholder")}
                  value={clusterDraft ?? clusterId}
                  onChange={(e) => setClusterDraft(e.target.value)}
                  onBlur={commitClusterDraft}
                  onKeyDown={(e) => e.key === "Enter" && commitClusterDraft()}
                />
              </label>
            )}
            <Button onClick={query.reload} disabled={loading || !clusterId}>
              {loading ? t("common.loading") : t("common.refresh")}
            </Button>
          </>
        }
      />

      {/* Data source badges */}
      {dsStatus && <DataSourceBadges status={dsStatus} />}

      {/* Error */}
      <ErrorNotice error={error} />

      {/* Loading */}
      {loading && !overview ? <LoadingState /> : null}

      {/* No cluster selected */}
      {!loading && !clusterId && !clustersLoading && (
        <EmptyState title={t("hub.pickCluster")}>{t("obs.pickClusterHint")}</EmptyState>
      )}

      {/* Tabs */}
      {clusterId && (overview || workloadsResp || nodesResp || tab === "hubble") && (
        <>
          <Tabs label={t("nav.item.aksMonitoring")} idPrefix="obs-tab" value={tab} onChange={setTab} items={TABS.map((id) => ({ id, label: t(`obs.tab.${id}`) }))} />

          {tab === "overview" && overview && (
            <OverviewTab data={overview} onWorkloadSelect={handleWorkloadSelect} />
          )}

          {tab === "workloads" && workloadsResp && (
            <WorkloadsTab
              workloads={workloadsResp.workloads}
              onWorkloadSelect={handleWorkloadSelect}
              selectedKey={selectedWorkload}
              clusterId={clusterId}
            />
          )}

          {tab === "infra" && nodesResp && (
            <InfraTab nodes={nodesResp.nodes} />
          )}

          {tab === "logs" && (
            <LogsTab
              clusterId={clusterId}
            />
          )}

          {tab === "hubble" && (
            <HubbleTab clusterId={clusterId} />
          )}
        </>
      )}
    </div>
  );
}
