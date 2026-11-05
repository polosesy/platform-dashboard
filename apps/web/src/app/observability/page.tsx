"use client";

import { Suspense, useEffect, useState } from "react";
import type {
  ObservabilityOverview,
  ObservabilitySourcesResponse,
  ObservabilityNodesResponse,
} from "@aud/types";
import styles from "./styles.module.css";
import { DataSourceBadges } from "./components/DataSourceBadges";
import { InfraTab } from "./components/InfraTab";
import { LogsTab } from "./components/LogsTab";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { HubbleTab } from "./components/HubbleTab";
import { StackTab } from "./components/StackTab";
import { NodeMaintenancePanel } from "./components/NodeMaintenancePanel";
import { WorkloadHeatmap } from "./components/WorkloadHeatmap";
import { EmptyState, ErrorNotice, LoadingState, PageHeader, Segmented, Select, Tabs, TimeRangeBar } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useTimeRange } from "@/lib/useTimeRange";

// Five places, heatmap first (Datadog's Kubernetes overview): the cluster at a glance + every workload as a tile, then
// nodes, logs, the network (Hubble) and whether the collection pipeline itself is healthy
type Tab = "overview" | "infra" | "logs" | "hubble" | "stack";

const TABS: Tab[] = ["overview", "infra", "logs", "hubble", "stack"];

export default function ObservabilityPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ObservabilityView />
    </Suspense>
  );
}

function ObservabilityView() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  // ?range · ?to · ?refresh — one range and one refresh for every tab (Grafana's dashboard time); each tab says
  // when it reads another span (heatmap ≤ 24 h, maintenance ≥ 1 day, logs ≤ 24 h, the stack's 10 minutes, Hubble now)
  const time = useTimeRange();
  const { clusters, clusterId, setClusterId, loading: clustersLoading } = useAksClusters();
  // Free-text cluster ID (used when the cluster list is unavailable) — committed on blur / Enter
  const [clusterDraft, setClusterDraft] = useState<string | null>(null);
  // 워크로드: the heatmap's cells as tiles or as a sortable table — one source (the Azure Monitor workspace). The old
  // Container Insights list is gone: empty whenever the DCR collects only Perf · Syslog, and its pod states repeated
  // the AKS 클러스터 browser
  const [wlView, setWlView] = useState<"tiles" | "table">("tiles");

  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
  const query = useApiQuery(clusterId ? `observability:${clusterId}` : null, async (token) => {
    const [overview, nodes] = await Promise.all([
      fetchJsonWithBearer<ObservabilityOverview>(apiUrl("/api/observability/overview", { clusterId, clusterName }), token),
      fetchJsonWithBearer<ObservabilityNodesResponse>(apiUrl("/api/observability/nodes", { clusterId }), token),
    ]);
    return { clusterId, overview, nodes, fetchedAt: new Date() };
  });
  // Loki · Tempo · Pyroscope · Grafana: read / link only / blocked (light, separate from the overview)
  const sourcesQ = useApiQuery(clusterId ? `obs-sources:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<ObservabilitySourcesResponse>(apiUrl("/api/observability/sources", { clusterId }), token),
  );
  const sources = sourcesQ.data?.clusterId === clusterId ? sourcesQ.data : null;
  // Only show data belonging to the selected cluster
  const current = query.data?.clusterId === clusterId ? query.data : undefined;
  const overview = current?.overview ?? null;
  const nodesResp = current?.nodes ?? null;
  const loading = query.loading;
  const error = query.error;
  const lastRefresh = current?.fetchedAt ?? null;
  // The node tab's cards are this query: refresh it with the picker there (the heatmap and maintenance reload themselves)
  const { reload } = query;
  const { nonce, report } = time;
  const nodesTab = tab === "infra";
  const reloadSources = sourcesQ.reload;
  useEffect(() => { if (nonce && nodesTab) reload(); }, [nonce, nodesTab, reload]);
  useEffect(() => { if (nonce) reloadSources(); }, [nonce, reloadSources]);
  useEffect(() => report("nodes", nodesTab && loading), [nodesTab, loading, report]);

  const commitClusterDraft = () => {
    if (clusterDraft !== null) setClusterId(clusterDraft.trim());
    setClusterDraft(null);
  };

  const dsStatus =
    overview?.dataSourceStatus ??
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
            <TimeRangeBar state={time} />
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
      {clusterId && (overview || nodesResp || tab === "hubble" || tab === "stack" || tab === "overview") && (
        <>
          <Tabs label={t("nav.item.aksMonitoring")} idPrefix="obs-tab" value={tab} onChange={setTab} items={TABS.map((id) => ({ id, label: t(`obs.tab.${id}`) }))} />

          {tab === "overview" && (
            <Segmented label={t("ob.hm.view")} value={wlView} onChange={setWlView}
              items={[{ id: "tiles", label: t("ob.hm.view.heatmap") }, { id: "table", label: t("ob.hm.view.table") }]} />
          )}

          {tab === "overview" && <WorkloadHeatmap clusterId={clusterId} layout={wlView} range={time.range} nonce={time.nonce} report={time.report} />}

          {tab === "infra" && <NodeMaintenancePanel clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />}
          {tab === "infra" && nodesResp && (
            <InfraTab nodes={nodesResp.nodes} past={time.range.to !== null} />
          )}

          {tab === "logs" && (
            <LogsTab clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />
          )}

          {tab === "hubble" && (
            <HubbleTab clusterId={clusterId} control={{ range: time.range, nonce: time.nonce, report: time.report }} />
          )}

          {tab === "stack" && <StackTab clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />}
        </>
      )}
    </div>
  );
}
