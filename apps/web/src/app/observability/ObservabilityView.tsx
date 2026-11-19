"use client";

// 모니터링 — one cluster's state and signals. 2026-11-19: the seven tabs of one page became menu items of their own
// (navConfig group "monitoring") — measured: every view but the first took 2 clicks (menu + tab), no view had a URL (a
// reload went back to the first tab, back did not return to a tab, a tab could not be shared), the network tab was the
// same component as 네트워크 › Pod 트래픽 (dropped here), and profiles would have been an eighth tab. Each view is now a
// route (`/observability`, `/signals`, `/services`, `/profiles`, `/nodes`, `/logs`, `/collection`) sharing this frame:
// the cluster scope, one time range (`?range · to · refresh`, carried between these views by the menu — navHref) and
// the data-source chips.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ObservabilityNodesResponse, ObservabilityOverview, ObservabilitySourcesResponse } from "@aud/types";
import styles from "./styles.module.css";
import { DataSourceBadges } from "./components/DataSourceBadges";
import { InfraTab } from "./components/InfraTab";
import { LogsTab } from "./components/LogsTab";
import { EventsSection } from "./components/EventsSection";
import { StackTab } from "./components/StackTab";
import { CollectorSignals } from "./components/CollectorSignals";
import { SloTab } from "./components/SloTab";
import { RecommendedAlertsTab } from "./components/RecommendedAlertsTab";
import { NodeMaintenancePanel } from "./components/NodeMaintenancePanel";
import { WorkloadHeatmap } from "./components/WorkloadHeatmap";
import { ProfilesView } from "./components/ProfilesView";
import { apmHref, type ApmView } from "./components/SloTab";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useAksClusters } from "@/lib/useAksClusters";
import { EmptyState, ErrorNotice, LoadingState, PageHeader, Segmented, TimeRangeBar } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useTimeRange } from "@/lib/useTimeRange";
import { TRACE_ID } from "@/lib/traceView";

export type ObsView = "overview" | "signals" | "services" | "profiles" | "nodes" | "logs" | "collection";

export function ObservabilityPage({ view, apm }: { view: ObsView; apm?: ApmView }) {
  return (
    <Suspense fallback={<LoadingState />}>
      <ObservabilityView view={view} apm={apm ?? "map"} />
    </Suspense>
  );
}

function ObservabilityView({ view, apm }: { view: ObsView; apm: ApmView }) {
  const { t, locale } = useI18n();
  const searchParams = useSearchParams();
  const router = useRouter();
  // `?trace=<id>` (a copied trace link) lives in 서비스 (APM) — links made before the split pointed at /observability
  const traceRaw = searchParams.get("trace");
  const traceParam = traceRaw && TRACE_ID.test(traceRaw) ? traceRaw.toLowerCase() : null;
  // a trace link lives in the traces view (links made before 2026-11-19 pointed at /observability or /observability/services)
  useEffect(() => {
    if (traceParam && (view === "overview" || (view === "services" && apm !== "traces"))) router.replace(`${apmHref("traces")}${window.location.search}`);
  }, [view, apm, traceParam, router]);
  // an endpoint row's "traces →": the search's filters in the URL
  const seed = apm === "traces" && (searchParams.get("service") || searchParams.get("name"))
    ? { ...(searchParams.get("service") ? { service: searchParams.get("service")! } : {}), ...(searchParams.get("name") ? { name: searchParams.get("name")! } : {}), ...(searchParams.get("errors") === "1" ? { errorsOnly: true } : {}) }
    : undefined;
  // one range and one refresh for every view (Grafana's dashboard time)
  const time = useTimeRange();
  const { clusters, clusterId, loading: clustersLoading } = useAksClusters();
  const [wlView, setWlView] = useState<"tiles" | "table">("tiles");
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
  // the overview (data-source status) and the node cards — only where they are shown
  const needsNodes = view === "overview" || view === "nodes";
  const query = useApiQuery(clusterId && needsNodes ? `observability:${clusterId}` : null, async (token) => {
    const [overview, nodes] = await Promise.all([
      fetchJsonWithBearer<ObservabilityOverview>(apiUrl("/api/observability/overview", { clusterId, clusterName }), token),
      fetchJsonWithBearer<ObservabilityNodesResponse>(apiUrl("/api/observability/nodes", { clusterId }), token),
    ]);
    return { clusterId, overview, nodes, fetchedAt: new Date() };
  });
  const sourcesQ = useApiQuery(clusterId ? `obs-sources:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<ObservabilitySourcesResponse>(apiUrl("/api/observability/sources", { clusterId }), token),
  );
  const sources = sourcesQ.data?.clusterId === clusterId ? sourcesQ.data : null;
  const current = query.data?.clusterId === clusterId ? query.data : undefined;
  const nodesResp = current?.nodes ?? null;
  const { reload } = query;
  const { nonce, report } = time;
  const nodesView = view === "nodes";
  const reloadSources = sourcesQ.reload;
  useEffect(() => { if (nonce && nodesView) reload(); }, [nonce, nodesView, reload]);
  useEffect(() => { if (nonce) reloadSources(); }, [nonce, reloadSources]);
  useEffect(() => report("nodes", nodesView && query.loading), [nodesView, query.loading, report]);
  const dsStatus = current?.overview?.dataSourceStatus ?? nodesResp?.dataSourceStatus ?? null;
  const lastRefresh = current?.fetchedAt ?? null;
  const signedOut = query.error === t("auth.state.signin") || sourcesQ.error === t("auth.state.signin");

  return (
    <div className={styles.page}>
      <PageHeader
        meta={lastRefresh || dsStatus || sources ? (
          <span className={styles.metaRow}>
            {lastRefresh ? <span>{t("common.updated")} {lastRefresh.toLocaleTimeString(dateLocale(locale))}</span> : null}
            <DataSourceBadges status={dsStatus} sources={sources} />
          </span>
        ) : null}
        actions={<TimeRangeBar state={time} />}
      />
      <ErrorNotice error={query.error} />
      {!clusterId && !clustersLoading ? <EmptyState title={t("hub.pickCluster")}>{t("obs.pickClusterHint")}</EmptyState> : null}

      {/* not while signed out: every view would repeat the same sign-in notice (one notice per screen) */}
      {clusterId && !signedOut ? (
        <>
          {view === "overview" ? (
            <>
              <Segmented label={t("ob.hm.view")} value={wlView} onChange={setWlView}
                items={[{ id: "tiles", label: t("ob.hm.view.heatmap") }, { id: "table", label: t("ob.hm.view.table") }]} />
              <WorkloadHeatmap key={`heat:${clusterId}`} clusterId={clusterId} layout={wlView} range={time.range} nonce={time.nonce} report={time.report} />
              <EventsSection key={`events:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />
            </>
          ) : null}
          {view === "signals" ? <RecommendedAlertsTab key={`signals:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} /> : null}
          {view === "services" ? <SloTab key={`slo:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} linkedTrace={traceParam} apm={apm} seed={seed} /> : null}
          {view === "profiles" ? <ProfilesView key={`prof:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} /> : null}
          {view === "nodes" ? (
            <>
              <NodeMaintenancePanel key={`maint:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />
              {nodesResp ? <InfraTab nodes={nodesResp.nodes} past={time.range.to !== null} /> : query.loading ? <LoadingState /> : null}
            </>
          ) : null}
          {view === "logs" ? <LogsTab key={`logs:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} /> : null}
          {view === "collection" ? (
            <>
              {/* the collectors' own signals over the range (2026-11-19), then the pipeline's components now */}
              <CollectorSignals key={`collectors:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />
              <StackTab key={`stack:${clusterId}`} clusterId={clusterId} range={time.range} nonce={time.nonce} report={time.report} />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
