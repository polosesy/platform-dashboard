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
  PowerState,
} from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { formatBitsPerSec } from "@/lib/format";
import { isInferredEdge } from "@/lib/liveScope";
import { exposurePorts, exposureSources } from "@/lib/livePip";
import { Notice } from "@/components/ui";
import { localizeLabel } from "../utils/localizeLabel";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";

type EdgeDetailPanelProps = {
  detail: EdgeNetworkDetail | null;
  loading: boolean;
  edgeSpec: DiagramEdgeSpec | null;
  liveEdge?: LiveEdge;
  /** Example diagram — the detail values are samples, not this edge's traffic */
  sample?: boolean;
  /** Power state of the line's target (Internet → VM: a deallocated VM receives nothing — 0 is expected) */
  targetPower?: PowerState;
  onClose: () => void;
};

type TFn = (key: string, vars?: Record<string, string | number>) => string;
function fmtRelativeTime(iso: string, t: TFn): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return t("common.secondsAgo", { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("common.minutesAgo", { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("common.hoursAgo", { n: hrs });
  return t("common.daysAgo", { n: Math.floor(hrs / 24) });
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

/**
 * Internet → VM through its own public IP (catalog PIP-04): the NSG verdict (configuration) and what the public IP
 * measured. Ports come from the NSG only — the public IP metrics carry no usable port dimension.
 */
function PipExposureRows({ exposure, metrics, targetPower, t }: { exposure: NonNullable<DiagramEdgeSpec["exposure"]>; metrics?: LiveEdge["metrics"]; targetPower?: PowerState; t: TFn }) {
  const src = exposureSources(exposure);
  const stopped = targetPower === "deallocated" || targetPower === "stopped";
  return (
    <>
      <div className={styles.essentialsRow} data-testid="edge-exposure">
        <span className={styles.essentialsLabel}>{t("ld.pip.exposure")}</span>
        <span className={styles.essentialsValue}>
          {[
            t(`ld.pip.state.${exposure.state}`),
            exposure.nsgs.length ? `NSG: ${exposure.nsgs.map((n) => t(`ld.pip.nsg.${n}`)).join(" → ")}` : null,
            ...exposure.reasons.map((r) => t(`ld.pip.reason.${r}`)),
          ].filter(Boolean).join(" · ")}
        </span>
      </div>
      {exposure.ports.length ? (
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.pip.ports")}</span>
          <span className={styles.essentialsValue}>
            {exposurePorts(exposure).map((p, i) => (
              <span key={p.spec}>
                {i ? ", " : ""}
                <span style={p.tier === "critical" || p.tier === "high" ? { color: "var(--warning)", fontWeight: 600 } : undefined} title={p.tier ? t(`ld.pip.tier.${p.tier}`) : undefined}>{p.spec === "*" ? t("ld.pip.allPorts") : p.spec}</span>
              </span>
            ))}
          </span>
        </div>
      ) : null}
      <div className={styles.essentialsRow}>
        <span className={styles.essentialsLabel}>{t("ld.pip.sources")}</span>
        <span className={styles.essentialsValue}>{t(src.key, src.vars)}</span>
      </div>
      {metrics?.synInPerMin != null && (
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.edge.metric.synIn")}</span>
          <span className={styles.essentialsValue}>{t("ld.edge.perMin", { n: Math.round(metrics.synInPerMin) })}</span>
        </div>
      )}
      {metrics?.bytesInBps != null && (
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.edge.metric.bytesIn")}</span>
          <span className={styles.essentialsValue}>
            {formatBitsPerSec(metrics.bytesInBps)}
            {metrics.throughputBps == null ? ` — ${t("ld.edge.noParticles")}` : ""}
          </span>
        </div>
      )}
      {stopped && (
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.pip.power")}</span>
          <span className={styles.essentialsValue}>{t("ld.pip.stopped")}</span>
        </div>
      )}
    </>
  );
}

export function EdgeDetailPanel({
  detail,
  loading,
  edgeSpec,
  liveEdge,
  sample,
  targetPower,
  onClose,
}: EdgeDetailPanelProps) {
  const { t } = useI18n();
  const isMock = !!sample || detail?.note === "mock";
  const inferred = edgeSpec ? isInferredEdge(edgeSpec) : false;
  const measured = liveEdge?.metricsSource === "measured";
  const flowsUnknown = detail?.flowsCollected === false;

  const sourceLabel = localizeLabel(detail?.sourceNodeLabel ?? edgeSpec?.source ?? t("hb.col.source"), t);
  const targetLabel = localizeLabel(detail?.targetNodeLabel ?? edgeSpec?.target ?? t("hb.col.destination"), t);
  const protocol = detail?.protocol ?? edgeSpec?.protocol;
  const edgeKind = detail?.edgeKind ?? edgeSpec?.edgeKind;

  // Measured values only: live edge metrics when a real source reported them, sample detail only on the example
  const metrics: LiveEdge["metrics"] | undefined = measured ? liveEdge?.metrics : isMock ? detail?.liveMetrics : undefined;
  const status = measured ? (liveEdge?.status ?? "idle") : "idle";

  const STATUS_COLORS: Record<string, string> = {
    normal: rgba("ok", 0.75),
    degraded: rgba("warning", 0.75),
    down: rgba("danger", 0.75),
    idle: rgba("ink", 0.25),
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
          aria-label={t("hb.close")}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className={styles.detailBody}>
        {loading && !detail && (
          <div className={styles.edgeLoadingNote}>{t("live.loading")}</div>
        )}

        {isMock && (
          <Notice tone="warning" title={t("common.sampleData")}>{t("ld.sample.hint")}</Notice>
        )}

        {detail && (
          <>
            {/* Refresh info */}
            <div className={styles.edgeRefreshInfo}>
              {t("detail.edge.lastUpdated")} {fmtRelativeTime(detail.generatedAt, t)} · ⟳ {t("ld.edge.refreshEvery")}
            </div>

            {/* Overview */}
            <Section title={t("detail.edge.overview")} defaultOpen={true}>
              <div className={styles.essentialsList}>
                {edgeKind && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("hb.typeLabel")}</span>
                    <span className={styles.essentialsValue}>{edgeKind}</span>
                  </div>
                )}
                {inferred && (
                  <div className={styles.essentialsRow} data-testid="edge-evidence">
                    <span className={styles.essentialsLabel}>{t("ld.edge.evidence")}</span>
                    <span className={styles.essentialsValue}>
                      {t("ld.edge.inferred", { pct: Math.round((edgeSpec?.confidence ?? 0) * 100) })}
                      {edgeSpec?.inferenceReasons?.length
                        ? ` — ${edgeSpec.inferenceReasons.map((r) => t(`ld.reason.${r}`)).join(" · ")}`
                        : ""}
                    </span>
                  </div>
                )}
                {edgeSpec?.caveats?.length ? (
                  <div className={styles.essentialsRow} data-testid="edge-caveats">
                    <span className={styles.essentialsLabel}>{t("ld.edge.caveat")}</span>
                    <span className={styles.essentialsValue}>{edgeSpec.caveats.map((c) => t(c)).join(" · ")}</span>
                  </div>
                ) : null}
                {metrics ? (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("hb.status")}</span>
                    <span className={styles.essentialsValue} style={{ color: STATUS_COLORS[status] }}>
                      {t(`ld.edgeStatus.${status}`)}
                    </span>
                  </div>
                ) : (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.coverage.traffic")}</span>
                    <span className={styles.essentialsValue} title={t("ld.traffic.none")}>{t("ld.edge.unmeasured")}</span>
                  </div>
                )}
                {metrics?.throughputBps != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.throughput")}</span>
                    <span className={styles.essentialsValue}>{formatBitsPerSec(metrics.throughputBps)}</span>
                  </div>
                )}
                {metrics?.latencyMs != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.latency")}</span>
                    <span className={styles.essentialsValue}>{metrics.latencyMs.toFixed(0)}ms</span>
                  </div>
                )}
                {metrics?.errorRate != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ob.errorRate")}</span>
                    <span className={styles.essentialsValue}>{metrics.errorRate.toFixed(1)}%</span>
                  </div>
                )}
                {metrics?.responsesPerMin != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.metric.backendRequests")}</span>
                    <span className={styles.essentialsValue}>{t("ld.edge.perMin", { n: Math.round(metrics.responsesPerMin) })}</span>
                  </div>
                )}
                {metrics?.connectMs != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.metric.backendConnectMs")}</span>
                    <span className={styles.essentialsValue}>{metrics.connectMs < 1 ? "< 1 ms" : `${Math.round(metrics.connectMs)} ms`}</span>
                  </div>
                )}
                {metrics?.probePct != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.metric.probe")}</span>
                    <span className={styles.essentialsValue}>{`${Math.round(metrics.probePct)}%`}</span>
                  </div>
                )}
                {metrics?.gatewayTotalBps != null && (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.metric.gatewayTotal")}</span>
                    <span className={styles.essentialsValue}>
                      {formatBitsPerSec(metrics.gatewayTotalBps)}
                      {metrics.throughputBps == null && metrics.gatewayTotalBps > 0 ? ` — ${t("ld.edge.privateOnly")}` : ""}
                    </span>
                  </div>
                )}
                {edgeSpec?.exposure ? (
                  <PipExposureRows exposure={edgeSpec.exposure} metrics={metrics} targetPower={targetPower} t={t} />
                ) : null}
                {edgeSpec?.backend ? (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.edge.member")}</span>
                    <span className={styles.essentialsValue}>
                      {[edgeSpec.backend.pool, edgeSpec.backend.address ? `${edgeSpec.backend.address}${edgeSpec.backend.ports?.length ? `:${edgeSpec.backend.ports.join(",")}` : ""}` : null, t(`ld.edge.evidence.${edgeSpec.backend.evidence === "ipMatch" || edgeSpec.backend.evidence === "fqdnMatch" ? edgeSpec.backend.evidence : edgeSpec.backend.via === "vmssModel" ? "vmssModel" : "cfg"}`)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ) : null}
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

            {/* Inbound Flows — "미수집" when per-IP flow records are not collected (not "no flows") */}
            <Section
              title={flowsUnknown ? t("detail.edge.inboundFlows") : `${t("detail.edge.inboundFlows")} (${detail.inboundSummary.flowCount})`}
              defaultOpen={true}
            >
              <FlowList flows={detail.inboundFlows} emptyText={flowsUnknown ? t("ld.edge.flowsNotCollected") : t("detail.edge.noFlows")} />
              {detail.inboundSummary.topPorts.length > 0 && (
                <PortSummary summary={detail.inboundSummary} />
              )}
            </Section>

            {/* Outbound Flows */}
            <Section
              title={flowsUnknown ? t("detail.edge.outboundFlows") : `${t("detail.edge.outboundFlows")} (${detail.outboundSummary.flowCount})`}
              defaultOpen={true}
            >
              <FlowList flows={detail.outboundFlows} emptyText={flowsUnknown ? t("ld.edge.flowsNotCollected") : t("detail.edge.noFlows")} />
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
