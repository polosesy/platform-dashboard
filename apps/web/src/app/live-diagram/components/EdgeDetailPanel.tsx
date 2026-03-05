"use client";

import { useState } from "react";
import type {
  EdgeNetworkDetail,
  NsgInfo,
  NsgRuleEntry,
  UdrInfo,
  NetworkFlowRecord,
  FlowSummary,
  DiagramEdgeSpec,
  LiveEdge,
} from "@aud/types";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

type EdgeDetailPanelProps = {
  detail: EdgeNetworkDetail | null;
  loading: boolean;
  edgeSpec: DiagramEdgeSpec | null;
  liveEdge?: LiveEdge;
  onClose: () => void;
};

function fmtRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.max(0, Math.floor(diff / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtThroughput(bps: number | undefined): string {
  if (bps == null) return "-";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes == null) return "-";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// ── Collapsible section wrapper ──
function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.detailSection}>
      <button
        type="button"
        className={styles.detailSectionToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.toggleChevron}>{open ? "▼" : "▶"}</span>
        {" "}{title}
      </button>
      {open && children}
    </div>
  );
}

// ── NSG Rules display ──
function NsgSection({ nsg, label }: { nsg: NsgInfo; label: string }) {
  const { t } = useI18n();
  return (
    <div className={styles.edgeSubSection}>
      <div className={styles.edgeSubSectionLabel}>{label}</div>
      {nsg.effectiveRules.length === 0 ? (
        <div className={styles.edgeEmptyNote}>{t("detail.edge.noNsg")}</div>
      ) : (
        nsg.effectiveRules.slice(0, 8).map((rule: NsgRuleEntry, i: number) => (
          <div
            key={i}
            className={`${styles.nsgRuleItem} ${rule.access === "Allow" ? styles.nsgRuleAllow : styles.nsgRuleDeny}`}
          >
            <span className={styles.nsgRuleAccess}>
              {rule.access === "Allow" ? t("detail.edge.allow") : t("detail.edge.deny")}
            </span>
            <span className={styles.nsgRuleDir}>{rule.direction[0]}</span>
            <span className={styles.nsgRuleProto}>{rule.protocol}</span>
            <span className={styles.nsgRulePort}>{rule.destinationPortRange}</span>
            <span className={styles.nsgRuleSrc} title={rule.sourceAddressPrefix}>
              {rule.sourceAddressPrefix.length > 20 ? rule.sourceAddressPrefix.slice(0, 18) + "…" : rule.sourceAddressPrefix}
            </span>
            <span className={styles.nsgRulePriority}>{rule.priority}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ── UDR Routes display ──
function UdrSection({ udr }: { udr: UdrInfo }) {
  const { t } = useI18n();
  return (
    <div className={styles.edgeSubSection}>
      <div className={styles.edgeSubSectionLabel}>{udr.name}</div>
      {udr.routes.length === 0 ? (
        <div className={styles.edgeEmptyNote}>{t("detail.edge.noUdr")}</div>
      ) : (
        udr.routes.map((route, i) => (
          <div key={i} className={styles.udrRouteItem}>
            <span className={styles.udrRoutePrefix}>{route.addressPrefix}</span>
            <span className={styles.udrRouteArrow}>→</span>
            <span className={styles.udrRouteHop}>
              {route.nextHopType}
              {route.nextHopIpAddress && ` (${route.nextHopIpAddress})`}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Flow records list ──
function FlowList({
  flows,
  emptyText,
}: {
  flows: NetworkFlowRecord[];
  emptyText: string;
}) {
  const { t } = useI18n();
  if (flows.length === 0) {
    return <div className={styles.edgeEmptyNote}>{emptyText}</div>;
  }
  return (
    <div className={styles.flowList}>
      {flows.map((flow, i) => {
        const isExternal = flow.isExternalSrc || flow.isExternalDest;
        return (
          <div
            key={i}
            className={`${styles.flowRecord} ${isExternal ? styles.flowRecordExternal : ""}`}
          >
            <div className={styles.flowRecordTop}>
              {isExternal && (
                <span className={styles.internetIcon} title={t("detail.edge.internet")}>
                  🌐
                </span>
              )}
              <span className={styles.flowIp}>
                {flow.srcIp}:{flow.srcPort}
              </span>
              <span className={styles.flowArrow}>→</span>
              <span className={styles.flowIp}>
                {flow.destIp}:{flow.destPort}
              </span>
              <span className={styles.flowProtoBadge}>{flow.protocol}</span>
              <span
                className={`${styles.flowActionBadge} ${flow.action === "Allow" ? styles.flowActionAllow : styles.flowActionDeny}`}
              >
                {flow.action === "Allow" ? t("detail.edge.allow") : t("detail.edge.deny")}
              </span>
            </div>
            {(flow.bytesSrcToDest != null || flow.bytesDestToSrc != null) && (
              <div className={styles.flowBytes}>
                <span>↓ {fmtBytes(flow.bytesSrcToDest)}</span>
                <span>↑ {fmtBytes(flow.bytesDestToSrc)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Port Summary ──
function PortSummary({ summary }: { summary: FlowSummary }) {
  return (
    <div className={styles.portSummaryGrid}>
      {summary.topPorts.map((p, i) => (
        <div key={i} className={styles.portSummaryRow}>
          <span className={styles.portSummaryPort}>{p.port}/{p.protocol}</span>
          <span className={styles.portSummaryCount}>{p.flowCount} flows</span>
        </div>
      ))}
      {summary.externalSourceCount > 0 && (
        <div className={styles.portSummaryExternal}>
          🌐 {summary.externalSourceCount} external source{summary.externalSourceCount !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

export function EdgeDetailPanel({
  detail,
  loading,
  edgeSpec,
  liveEdge,
  onClose,
}: EdgeDetailPanelProps) {
  const { t } = useI18n();

  const sourceLabel = detail?.sourceNodeLabel ?? edgeSpec?.source ?? "Source";
  const targetLabel = detail?.targetNodeLabel ?? edgeSpec?.target ?? "Target";
  const protocol = detail?.protocol ?? edgeSpec?.protocol;
  const edgeKind = detail?.edgeKind ?? edgeSpec?.edgeKind;

  // Prefer live edge metrics over detail metrics
  const metrics = liveEdge?.metrics ?? detail?.liveMetrics;
  const status = liveEdge?.status ?? "idle";

  const STATUS_COLORS: Record<string, string> = {
    normal: "rgba(16,137,62,0.75)",
    degraded: "rgba(209,132,0,0.75)",
    down: "rgba(216,59,1,0.75)",
    idle: "rgba(20,21,23,0.25)",
  };

  return (
    <aside className={styles.detailPanel}>
      {/* Header */}
      <div className={styles.detailHeader}>
        <span className={styles.edgeHeaderArrow}>→</span>
        <div className={styles.edgeHeaderTitle} title={`${sourceLabel} → ${targetLabel}`}>
          {sourceLabel} → {targetLabel}
        </div>
        {protocol && (
          <span className={styles.edgeProtocolBadge}>{protocol}</span>
        )}
        <div
          className={styles.detailHealthDot}
          style={{ background: STATUS_COLORS[status] ?? STATUS_COLORS.idle }}
          title={status}
        />
        <button
          type="button"
          className={styles.detailCloseBtn}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className={styles.detailBody}>
        {loading && !detail && (
          <div className={styles.edgeLoadingNote}>{t("live.loading")}</div>
        )}

        {detail && (
          <>
            {/* Refresh info */}
            <div className={styles.edgeRefreshInfo}>
              {t("detail.edge.lastUpdated")} {fmtRelativeTime(detail.generatedAt)} · ⟳ 1min
            </div>

            {/* Overview */}
            <Section title={t("detail.edge.overview")} defaultOpen={true}>
              <div className={styles.essentialsList}>
                {edgeKind && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>Kind</span>
                    <span className={styles.essentialsValue}>{edgeKind}</span>
                  </div>
                )}
                <div className={styles.essentialsRow}>
                  <span className={styles.essentialsLabel}>Status</span>
                  <span className={styles.essentialsValue} style={{ color: STATUS_COLORS[status] }}>
                    {status}
                  </span>
                </div>
                {metrics?.throughputBps != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>Throughput</span>
                    <span className={styles.essentialsValue}>{fmtThroughput(metrics.throughputBps)}</span>
                  </div>
                )}
                {metrics?.latencyMs != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>Latency</span>
                    <span className={styles.essentialsValue}>{metrics.latencyMs.toFixed(0)}ms</span>
                  </div>
                )}
                {metrics?.errorRate != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>Error Rate</span>
                    <span className={styles.essentialsValue}>{metrics.errorRate.toFixed(1)}%</span>
                  </div>
                )}
              </div>
            </Section>

            {/* Endpoints (NIC info) */}
            <Section title={t("detail.edge.endpoints")} defaultOpen={true}>
              <div className={styles.edgeEndpointGroup}>
                <div className={styles.edgeEndpointLabel}>
                  {t("detail.outbound")}: {detail.sourceNodeLabel}
                </div>
                {detail.sourceNics.map((nic, i) => (
                  <div key={i} className={styles.detailRow}>
                    <span className={styles.essentialsLabel}>{nic.name}</span>
                    <span className={styles.essentialsValueMono}>
                      {nic.privateIp ?? "-"}
                      {nic.publicIp && ` / ${nic.publicIp}`}
                    </span>
                  </div>
                ))}
                {detail.sourceNics.length === 0 && (
                  <div className={styles.edgeEmptyNote}>—</div>
                )}
              </div>
              <div className={styles.edgeEndpointGroup}>
                <div className={styles.edgeEndpointLabel}>
                  {t("detail.inbound")}: {detail.targetNodeLabel}
                </div>
                {detail.targetNics.map((nic, i) => (
                  <div key={i} className={styles.detailRow}>
                    <span className={styles.essentialsLabel}>{nic.name}</span>
                    <span className={styles.essentialsValueMono}>
                      {nic.privateIp ?? "-"}
                      {nic.publicIp && ` / ${nic.publicIp}`}
                    </span>
                  </div>
                ))}
                {detail.targetNics.length === 0 && (
                  <div className={styles.edgeEmptyNote}>—</div>
                )}
              </div>
            </Section>

            {/* NSG Rules */}
            {(detail.sourceNsg || detail.targetNsg) && (
              <Section title={t("detail.edge.nsg")} defaultOpen={false}>
                {detail.sourceNsg && (
                  <NsgSection nsg={detail.sourceNsg} label={`${detail.sourceNodeLabel} NSG`} />
                )}
                {detail.targetNsg && (
                  <NsgSection nsg={detail.targetNsg} label={`${detail.targetNodeLabel} NSG`} />
                )}
              </Section>
            )}

            {/* UDR Routes */}
            {detail.udr && (
              <Section title={t("detail.edge.udr")} defaultOpen={false}>
                <UdrSection udr={detail.udr} />
              </Section>
            )}

            {/* Inbound Flows */}
            <Section
              title={`${t("detail.edge.inboundFlows")} (${detail.inboundSummary.flowCount})`}
              defaultOpen={true}
            >
              <FlowList flows={detail.inboundFlows} emptyText={t("detail.edge.noFlows")} />
              {detail.inboundSummary.topPorts.length > 0 && (
                <PortSummary summary={detail.inboundSummary} />
              )}
            </Section>

            {/* Outbound Flows */}
            <Section
              title={`${t("detail.edge.outboundFlows")} (${detail.outboundSummary.flowCount})`}
              defaultOpen={true}
            >
              <FlowList flows={detail.outboundFlows} emptyText={t("detail.edge.noFlows")} />
              {detail.outboundSummary.topPorts.length > 0 && (
                <PortSummary summary={detail.outboundSummary} />
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
