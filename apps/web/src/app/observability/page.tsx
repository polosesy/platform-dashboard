"use client";

import { useState } from "react";
import type {
  ObservabilityOverview,
  ObservabilitySourcesResponse,
  ObservabilityWorkloadsResponse,
  ObservabilityNodesResponse,
} from "@aud/types";
import styles from "./styles.module.css";
import { DataSourceBadges } from "./components/DataSourceBadges";
import { WorkloadsTab } from "./components/WorkloadsTab";
import { InfraTab } from "./components/InfraTab";
import { LogsTab } from "./components/LogsTab";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { HubbleTab } from "./components/HubbleTab";
import { StackTab } from "./components/StackTab";
import { WorkloadHeatmap } from "./components/WorkloadHeatmap";
import { Button, EmptyState, ErrorNotice, LoadingState, PageHeader, Segmented, Select, Tabs } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";

// Five places, heatmap first (Datadog's Kubernetes overview): the cluster at a glance + every workload as a tile, then
// nodes, logs, the network (Hubble) and whether the collection pipeline itself is healthy
type Tab = "overview" | "infra" | "logs" | "hubble" | "stack";

const TABS: Tab[] = ["overview", "infra", "logs", "hubble", "stack"];

export default function ObservabilityPage() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const { clusters, clusterId, setClusterId, loading: clustersLoading } = useAksClusters();
  // Free-text cluster ID (used when the cluster list is unavailable) — committed on blur / Enter
  const [clusterDraft, setClusterDraft] = useState<string | null>(null);
  const [selectedWorkload, setSelectedWorkload] = useState<string | null>(null);
  // 워크로드: heatmap (Azure Monitor workspace — every workload) or the list (Container Insights)
  const [wlView, setWlView] = useState<"heatmap" | "list">("heatmap");

  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
  const query = useApiQuery(clusterId ? `observability:${clusterId}` : null, async (token) => {
    const [overview, workloads, nodes] = await Promise.all([
      fetchJsonWithBearer<ObservabilityOverview>(apiUrl("/api/observability/overview", { clusterId, clusterName }), token),
      fetchJsonWithBearer<ObservabilityWorkloadsResponse>(apiUrl("/api/observability/workloads", { clusterId }), token),
      fetchJsonWithBearer<ObservabilityNodesResponse>(apiUrl("/api/observability/nodes", { clusterId }), token),
    ]);
    return { clusterId, overview, workloads, nodes, fetchedAt: new Date() };
  });
  // Loki · Tempo · Pyroscope · Grafana: read / link only / blocked (light, separate from the overview)
  const sourcesQ = useApiQuery(clusterId ? `obs-sources:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<ObservabilitySourcesResponse>(apiUrl("/api/observability/sources", { clusterId }), token),
  );
  const sources = sourcesQ.data?.clusterId === clusterId ? sourcesQ.data : null;
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
    setTab("overview");
    setWlView("list");
  }

  const dsStatus =
    overview?.dataSourceStatus ??
    workloadsResp?.dataSourceStatus ??
    nodesResp?.dataSourceStatus ??
    null;

  return (
    <div className={styles.page}>
      <PageHeader
        meta={
          lastRefresh || dsStatus || sources ? (
            <span className={styles.metaRow}>
              {lastRefresh ? <span>{t("common.updated")} {lastRefresh.toLocaleTimeString(dateLocale(locale))}</span> : null}
              <DataSourceBadges status={dsStatus} sources={sources} />
            </span>
          ) : null
        }
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
            <Button onClick={() => { query.reload(); sourcesQ.reload(); }} disabled={loading || !clusterId}>
              {loading ? t("common.loading") : t("common.refresh")}
            </Button>
          </>
        }
      />


      {/* Error */}
      <ErrorNotice error={error} />

      {/* Loading */}
      {loading && !overview ? <LoadingState /> : null}

      {/* No cluster selected */}
      {!loading && !clusterId && !clustersLoading && (
        <EmptyState title={t("hub.pickCluster")}>{t("obs.pickClusterHint")}</EmptyState>
      )}

      {/* Tabs */}
      {clusterId && (overview || workloadsResp || nodesResp || tab === "hubble" || tab === "stack" || tab === "overview") && (
        <>
          <Tabs label={t("nav.item.aksMonitoring")} idPrefix="obs-tab" value={tab} onChange={setTab} items={TABS.map((id) => ({ id, label: t(`obs.tab.${id}`) }))} />

          {tab === "overview" && (
            <Segmented label={t("ob.hm.view")} value={wlView} onChange={setWlView}
              items={[{ id: "heatmap", label: t("ob.hm.view.heatmap") }, { id: "list", label: t("ob.hm.view.list") }]} />
          )}

          {tab === "overview" && wlView === "heatmap" && <WorkloadHeatmap clusterId={clusterId} />}

          {tab === "overview" && wlView === "list" && workloadsResp && (
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

          {tab === "stack" && <StackTab clusterId={clusterId} />}
        </>
      )}
    </div>
  );
}
