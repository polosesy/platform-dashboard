"use client";

import { useState, type ReactNode } from "react";
import type { HubbleStatusResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { ServiceMapTab } from "../../hubble/components/ServiceMapTab";
import { FlowsTab } from "../../hubble/components/FlowsTab";
import { NetworkTab } from "../../hubble/components/NetworkTab";
import { SecurityTab } from "../../hubble/components/SecurityTab";
import styles from "../../hubble/styles.module.css";
import { Button, ErrorNotice, LoadingState, Notice, Segmented, Toggle } from "@/components/ui";
import { EnableFlowLogsPanel, METRICS_WINDOWS, MetricsView, SourceBadge, useHubbleSource } from "../../hubble/components/MetricsViews";
import { useI18n } from "@/lib/i18n";
import { fitWindow, type TimeRange } from "@/lib/timeRange";

/**
 * `control` = the AKS 모니터링 page's time picker: its 새로 고침 / auto refresh take a new sample (the views' own
 * 실시간 · 새 표본 hide), the metrics view's window follows the range. Samples (exec, Hubble UI, flow logs) are the
 * agents' buffers now — a past range says so. The /hubble page renders without it (its own controls).
 */
type Props = { clusterId: string; control?: { range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void } };

type SubTab = "service-map" | "flows" | "network" | "security";

const SUB_TABS: SubTab[] = ["service-map", "flows", "network", "security"];

/**
 * Service Map / Flows / Network / Security for one cluster, from the source the API picks (/api/hubble/sources):
 * exec on the agents (status badges + the flow views) · ACNS flow logs or the cluster's Hubble UI (a live relay
 * sample — the same flow views) · Hubble metrics
 * (counts only: workload grid, network, security — no edges, no flow list) · none (why, and how to enable).
 */
export function HubbleTab({ clusterId, control }: Props) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<SubTab>("service-map");
  // One refresh rule for all four views: a sample when a view opens, "새 표본" on demand, "실시간" = every 30 s.
  // Off by default — every poll used to redraw the map and the tables (a Hubble UI sample takes seconds).
  const [ownLive, setLive] = useState(false);
  const [ownNonce, setNonce] = useState(0);
  const live = control ? false : ownLive;
  const nonce = control ? control.nonce : ownNonce;
  const fit = control ? fitWindow(control.range, METRICS_WINDOWS) : null;
  const metricsControl = control && fit ? { window: fit.value, differs: fit.differs !== null, nonce: control.nonce, report: control.report } : undefined;
  const sources = useHubbleSource(clusterId);
  const src = sources.data?.clusterId === clusterId ? sources.data : null;

  const tabs = (
    <div className={styles.subTabs}>
      <Segmented label={t("hub.views")} value={subTab} onChange={setSubTab} items={SUB_TABS.map((id) => ({ id, label: t(`hub.view.${id}`) }))} />
      {control ? null : (
        <span className={styles.refreshCtl}>
          <Toggle checked={live} onChange={setLive} title={t("hb.nm.liveHint")}>{t("hb.nm.live")}</Toggle>
          <Button size="sm" onClick={() => setNonce((n) => n + 1)}>{t("hb.nm.sample")}</Button>
        </span>
      )}
    </div>
  );
  const view = { clusterId, live, nonce };
  const pastNote = control?.range.to != null ? <Notice tone="info" title={t("hb.past.title")}>{t("hb.past.hint")}</Notice> : null;

  if (sources.error) return <ErrorNotice error={sources.error} />;
  if (!src) return <LoadingState label={t("hb.src.checking")} />;
  if (src.selected === "exec") return <>{pastNote}<ExecHubble view={view} subTab={subTab} tabs={tabs} badge={<SourceBadge sources={src} />} /></>;

  return (
    <div>
      {pastNote}
      <div className={styles.statusBadges}>
        <SourceBadge sources={src} />
        <Button size="sm" onClick={sources.reload} disabled={!clusterId}>{t("hub.checkStatus")}</Button>
      </div>
      {src.selected === "none" ? (
        <>
          <Notice tone="warning" title={t("hb.src.noneTitle")}>
            {t(`hb.src.execOff.${src.exec.reason ?? "deployment"}`)} {t(`hb.src.logs.${src.flowLogs.state}`)} {t(`hb.src.ui.${src.hubbleUi.state}`)}{src.hubbleUi.message ? ` (${src.hubbleUi.message})` : ""} {t(`hb.m.state.${src.metrics.state}`)}
          </Notice>
          <EnableFlowLogsPanel />
        </>
      ) : (
        <>
          <Notice tone="info">{t(src.selected === "flowLogs" ? "hb.src.flowLogsHint" : src.selected === "hubbleUi" ? "hb.src.hubbleUiHint" : "hb.src.metricsHint")}</Notice>
          {tabs}
          {src.selected === "flowLogs" || src.selected === "hubbleUi" ? (
            <>
              {subTab === "service-map" && <ServiceMapTab {...view} />}
              {subTab === "flows" && <FlowsTab {...view} />}
              {subTab === "network" && <NetworkTab {...view} />}
              {subTab === "security" && <SecurityTab {...view} />}
            </>
          ) : subTab === "flows" ? (
            <>
              <Notice tone="info" title={t("hb.m.noFlows")}>{t("hb.m.noFlowsHint")}</Notice>
              <EnableFlowLogsPanel />
            </>
          ) : (
            <MetricsView clusterId={clusterId} view={subTab} control={metricsControl} />
          )}
        </>
      )}
    </div>
  );
}

/** Exec on the cilium agents: relay status + the flow views (unchanged) */
function ExecHubble({ view, subTab, tabs, badge }: { view: { clusterId: string; live: boolean; nonce: number }; subTab: SubTab; tabs: ReactNode; badge: ReactNode }) {
  const { clusterId } = view;
  const { t, locale } = useI18n();
  const status = useApiQuery(clusterId ? `hubble-status:${clusterId}:${locale}` : null, (token) =>
    fetchJsonWithBearer<HubbleStatusResponse>(apiUrl("/api/hubble/status", { clusterId, lang: locale }), token),
  );
  // Ignore a previous cluster's status while the new one loads
  const hubbleStatus = status.data?.clusterId === clusterId ? status.data : null;

  return (
    <div>
      {/* Hubble Status */}
      <div className={styles.statusBadges}>
        {badge}
        {hubbleStatus ? (
          <>
            <span className={`${styles.statusBadge} ${hubbleStatus.available ? styles.statusOk : styles.statusOff}`}>
              Hubble: {hubbleStatus.available ? t("ob.hb.connected") : t("ob.hb.disconnected")}
            </span>
            {hubbleStatus.available && (
              <>
                <span
                  className={`${styles.statusBadge} ${hubbleStatus.nodeCount < hubbleStatus.nodesTotal ? styles.statusOff : styles.statusOk}`}
                  title={t("ob.hb.nodesHint")}
                >
                  {t("hb.node")}: {hubbleStatus.nodeCount}/{hubbleStatus.nodesTotal}
                </span>
                <span className={`${styles.statusBadge} ${styles.statusOk}`} title={t("ob.hb.bufferHint")}>
                  {t("ob.hb.buffer")}: {hubbleStatus.numFlows.toLocaleString()} / {hubbleStatus.maxFlows.toLocaleString()}
                </span>
              </>
            )}
          </>
        ) : (
          <span className={`${styles.statusBadge} ${styles.statusOff}`}>
            {status.loading ? t("ob.hb.checking") : t("ob.hb.noStatus")}
          </span>
        )}
        <Button size="sm" onClick={status.reload} disabled={!clusterId}>
          {t("hub.checkStatus")}
        </Button>
      </div>

      {status.error && <div className={styles.errorMsg}>{t("ob.hb.error")}: {status.error}</div>}

      {hubbleStatus?.message && hubbleStatus.message !== "connected" && (
        <div className={styles.errorMsg} style={{ marginBottom: 16 }}>
          {hubbleStatus.message}
        </div>
      )}

      {tabs}

      {subTab === "service-map" && <ServiceMapTab {...view} />}
      {subTab === "flows" && <FlowsTab {...view} />}
      {subTab === "network" && <NetworkTab {...view} />}
      {subTab === "security" && <SecurityTab {...view} />}
    </div>
  );
}
