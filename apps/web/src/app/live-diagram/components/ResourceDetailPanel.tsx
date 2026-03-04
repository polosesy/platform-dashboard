import { useState, useCallback } from "react";
import type {
  DiagramNodeSpec,
  DiagramEdgeSpec,
  LiveNode,
  LiveEdge,
  LiveAlert,
  AlertRuleInfo,
  HealthStatus,
  PowerState,
  SparklineData,
  SubResource,
} from "@aud/types";
import { nodeColor, defaultTokens } from "../utils/designTokens";
import { getAzureIconUrl } from "../utils/azureIcons";
import { fmtMetric } from "./LiveNode";
import { D3Sparkline } from "./D3Sparkline";
import { useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

type ConnectedEdge = {
  edgeSpec: DiagramEdgeSpec;
  liveEdge?: LiveEdge;
  peerLabel: string;
  direction: "inbound" | "outbound";
};

type ResourceDetailPanelProps = {
  nodeSpec: DiagramNodeSpec | null;
  liveNode: LiveNode | null;
  alerts: LiveAlert[];
  alertRules: AlertRuleInfo[];
  connectedEdges: ConnectedEdge[];
  onClose: () => void;
};

const healthLabel: Record<HealthStatus, string> = {
  ok: "Healthy",
  warning: "Warning",
  critical: "Critical",
  unknown: "Unknown",
};

/** Map internal resource kind to display name */
export const RESOURCE_KIND_DISPLAY: Record<string, string> = {
  vnet: "Virtual Network",
  subnet: "Subnet",
  nic: "Network Interface",
  vm: "Virtual Machine",
  vmss: "VM Scale Set",
  aks: "Azure Kubernetes Service",
  containerApp: "Container App",
  appGateway: "Application Gateway",
  lb: "Load Balancer",
  frontDoor: "Front Door",
  trafficManager: "Traffic Manager",
  privateEndpoint: "Private Endpoint",
  storage: "Storage Account",
  sql: "SQL Database",
  cosmosDb: "Cosmos DB",
  redis: "Azure Cache for Redis",
  postgres: "PostgreSQL",
  keyVault: "Key Vault",
  appInsights: "Application Insights",
  logAnalytics: "Log Analytics Workspace",
  firewall: "Azure Firewall",
  functionApp: "Function App",
  appService: "App Service",
  serviceBus: "Service Bus",
  eventHub: "Event Hub",
};

const POWER_STATE_LABEL: Record<PowerState, string> = {
  running: "Running",
  stopped: "Stopped",
  deallocated: "Deallocated",
  starting: "Starting",
  stopping: "Stopping",
  unknown: "Unknown",
};

/** Resource kinds that have no meaningful operational state */
const HIDE_STATUS_KINDS = new Set([
  "vnet", "subnet", "nic", "dns", "privateEndpoint",
]);

function truncateId(id: string, maxLen = 60): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "...";
}

/** Value display with copy-to-clipboard on hover */
function CopyableValue({
  value,
  className,
  title,
  style,
  children,
}: {
  value: string;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);

  return (
    <span className={`${styles.copyableWrap} ${className ?? ""}`} title={title} style={style}>
      <span className={styles.copyableText}>{children ?? value}</span>
      <button
        type="button"
        className={styles.copyBtn}
        onClick={handleCopy}
        aria-label="Copy to clipboard"
      >
        {copied ? "\u2713" : "\u2398"}
      </button>
    </span>
  );
}

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

const SEVERITY_LABELS: Record<number, string> = {
  0: "Sev0 (Critical)",
  1: "Sev1 (Error)",
  2: "Sev2 (Warning)",
  3: "Sev3 (Informational)",
  4: "Sev4 (Verbose)",
};

const SEVERITY_COLORS: Record<number, string> = {
  0: "#e74c3c",
  1: "#e67e22",
  2: "#f1c40f",
  3: "#3498db",
  4: "#95a5a6",
};

export function ResourceDetailPanel({
  nodeSpec,
  liveNode,
  alerts,
  alertRules,
  connectedEdges,
  onClose,
}: ResourceDetailPanelProps) {
  const { t } = useI18n();
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [alertRulesOpen, setAlertRulesOpen] = useState(true);
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  if (!nodeSpec) return null;

  const health: HealthStatus = liveNode?.health ?? "unknown";
  const powerState: PowerState | undefined = liveNode?.powerState;
  const colors = nodeColor(health);
  const metrics = liveNode?.metrics ?? {};
  const sparklines = liveNode?.sparklines;

  const metricEntries = Object.entries(metrics).filter(
    ([, v]) => v != null,
  );

  const sparklineEntries: [string, SparklineData][] = sparklines
    ? Object.entries(sparklines).filter(([, s]) => s.values.length >= 2)
    : [];

  const tags = nodeSpec.tags;
  const tagEntries = tags ? Object.entries(tags) : [];

  const kindDisplay = nodeSpec.resourceKind
    ? RESOURCE_KIND_DISPLAY[nodeSpec.resourceKind] ?? nodeSpec.resourceKind
    : undefined;

  return (
    <aside className={styles.detailPanel}>
      {/* Header */}
      <div className={styles.detailHeader}>
        <img
          src={getAzureIconUrl(nodeSpec.icon)}
          alt={nodeSpec.icon}
          className={styles.detailHeaderIcon}
        />
        <span className={styles.detailHeaderName}>{nodeSpec.label}</span>
        <div
          className={styles.detailHealthDot}
          style={{ background: colors.ringStroke }}
          title={healthLabel[health]}
        />
        <button
          className={styles.detailCloseBtn}
          onClick={onClose}
          type="button"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      {/* Body */}
      <div className={styles.detailBody}>
        {/* ── Essentials (Azure Portal style) ── */}
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>{t("detail.essentials")}</div>
          <div className={styles.essentialsList}>
            {kindDisplay && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.kind")}</span>
                <CopyableValue value={kindDisplay} className={styles.essentialsValue}>
                  {kindDisplay}
                </CopyableValue>
              </div>
            )}
            {!HIDE_STATUS_KINDS.has(nodeSpec.resourceKind ?? "") && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.status")}</span>
                <span className={styles.essentialsValue}>
                  {powerState && powerState !== "unknown" ? (
                    <span className={styles.powerStateBadgeDetail} data-state={powerState}>
                      {POWER_STATE_LABEL[powerState]}
                    </span>
                  ) : (
                    <span style={{ color: colors.ringStroke }}>
                      {healthLabel[health]}
                      {liveNode ? ` (${(liveNode.healthScore * 100).toFixed(0)}%)` : ""}
                    </span>
                  )}
                </span>
              </div>
            )}
            {nodeSpec.location && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.location")}</span>
                <CopyableValue value={nodeSpec.location} className={styles.essentialsValue}>
                  {nodeSpec.location}
                </CopyableValue>
              </div>
            )}
            {nodeSpec.resourceGroup && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.resourceGroup")}</span>
                <CopyableValue value={nodeSpec.resourceGroup} className={styles.essentialsValue}>
                  {nodeSpec.resourceGroup}
                </CopyableValue>
              </div>
            )}
            {nodeSpec.endpoint && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.endpoint")}</span>
                <CopyableValue value={nodeSpec.endpoint} className={styles.essentialsValueMono}>
                  {nodeSpec.endpoint}
                </CopyableValue>
              </div>
            )}
            {nodeSpec.azureResourceId && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.azureId")}</span>
                <CopyableValue
                  value={nodeSpec.azureResourceId}
                  className={styles.essentialsValueMono}
                  title={nodeSpec.azureResourceId}
                >
                  {truncateId(nodeSpec.azureResourceId)}
                </CopyableValue>
              </div>
            )}
          </div>
        </div>

        {/* Sub-Resources (NICs in VM, Frontend IPs in AppGW) */}
        {nodeSpec.subResources && nodeSpec.subResources.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>Sub-Resources</div>
            {nodeSpec.subResources.map((sr: SubResource) => (
              <div key={sr.id} className={styles.subResourceDetailCard}>
                <img
                  src={getAzureIconUrl(sr.kind === "nic" ? "nic" : "appGateway")}
                  alt={sr.kind}
                  width={16}
                  height={16}
                  style={{ opacity: 0.7, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <CopyableValue value={sr.label} className={styles.essentialsValue}>
                    {sr.label}
                  </CopyableValue>
                  <div className={styles.essentialsValueMono} style={{ fontSize: 11 }}>
                    {RESOURCE_KIND_DISPLAY[sr.kind] ?? sr.kind}
                  </div>
                  {sr.endpoint && (
                    <CopyableValue value={sr.endpoint} className={styles.essentialsValueMono}>
                      {sr.endpoint}
                    </CopyableValue>
                  )}
                  {sr.azureResourceId && (
                    <CopyableValue
                      value={sr.azureResourceId}
                      className={styles.essentialsValueMono}
                      title={sr.azureResourceId}
                      style={{ fontSize: 10 }}
                    >
                      {truncateId(sr.azureResourceId, 50)}
                    </CopyableValue>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tags */}
        {tagEntries.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("detail.tags")}</div>
            <div className={styles.detailTags}>
              {tagEntries.map(([k, v]) => (
                <span key={k} className={styles.detailTag}>
                  {k}: {v}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Metrics */}
        {metricEntries.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("detail.metrics")}</div>
            <div className={styles.detailMetricGrid}>
              {metricEntries.map(([key, val]) => (
                <div key={key} className={styles.detailMetricCard}>
                  <span className={styles.detailMetricKey}>{key}</span>
                  <span className={styles.detailMetricVal}>{fmtMetric(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sparklines */}
        {sparklineEntries.length > 0 && (
          <div className={styles.detailSection}>
            {sparklineEntries.map(([key, data]) => (
              <div key={key}>
                <span className={styles.detailMetricKey}>{data.metric || key}</span>
                <div className={styles.detailSparklineWrap}>
                  <D3Sparkline
                    values={data.values}
                    width={280}
                    height={36}
                    color={colors.ringStroke}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Alerts (collapsible) */}
        <div className={styles.detailSection}>
          <button
            className={styles.detailSectionToggle}
            onClick={() => setAlertsOpen((prev) => !prev)}
            type="button"
          >
            <span>
              {t("detail.alerts")} ({alerts.length})
            </span>
            <span className={styles.toggleChevron}>
              {alertsOpen ? "\u25B2" : "\u25BC"}
            </span>
          </button>
          {alertsOpen && (
            alerts.length === 0 ? (
              <div className={styles.detailEmpty}>{t("detail.noAlerts")}</div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className={styles.detailAlertCard}>
                  <div className={styles.detailAlertHeader}>
                    <div
                      className={styles.detailHealthDot}
                      style={{ background: defaultTokens.colors.alert[alert.severity] }}
                    />
                    <span className={styles.detailAlertSeverity}>{alert.severity}</span>
                    <span className={styles.detailAlertTime}>
                      {fmtRelativeTime(alert.firedAt)}
                    </span>
                  </div>
                  <div className={styles.detailAlertTitle}>{alert.title}</div>
                  <div className={styles.detailAlertSummary}>{alert.summary}</div>
                  {alert.rootCauseCandidates && alert.rootCauseCandidates.length > 0 && (
                    <div className={styles.detailAlertCauses}>
                      <div className={styles.detailAlertCausesTitle}>{t("detail.alertCauses")}</div>
                      {alert.rootCauseCandidates.map((cause, i) => (
                        <div key={i} className={styles.detailAlertCause}>{cause}</div>
                      ))}
                    </div>
                  )}
                  {(alert.affectedNodeIds.length > 0 || alert.affectedEdgeIds.length > 0) && (
                    <div className={styles.detailAlertAffects}>
                      {t("detail.alertAffects")}:{" "}
                      {alert.affectedNodeIds.length > 0 && `${alert.affectedNodeIds.length} ${t("detail.alertNodes")}`}
                      {alert.affectedNodeIds.length > 0 && alert.affectedEdgeIds.length > 0 && " · "}
                      {alert.affectedEdgeIds.length > 0 && `${alert.affectedEdgeIds.length} ${t("detail.alertEdges")}`}
                    </div>
                  )}
                </div>
              ))
            )
          )}
        </div>

        {/* Alert Rules (collapsible) */}
        {alertRules.length > 0 && (
          <div className={styles.detailSection}>
            <button
              className={styles.detailSectionToggle}
              onClick={() => setAlertRulesOpen((prev) => !prev)}
              type="button"
            >
              <span>
                {t("detail.alertRules")} ({alertRules.length})
              </span>
              <span className={styles.toggleChevron}>
                {alertRulesOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {alertRulesOpen &&
              alertRules.map((rule) => (
                <div key={rule.id} className={styles.detailAlertRuleCard}>
                  <div className={styles.detailAlertRuleHeader}>
                    <div
                      className={styles.detailHealthDot}
                      style={{ background: SEVERITY_COLORS[rule.severity] ?? "#95a5a6" }}
                    />
                    <span className={styles.detailAlertRuleSeverity}>
                      {SEVERITY_LABELS[rule.severity] ?? `Sev${rule.severity}`}
                    </span>
                    <span className={styles.detailAlertRuleSignal}>{rule.signalType}</span>
                    {!rule.enabled && (
                      <span className={styles.detailAlertRuleDisabled}>{t("detail.disabled")}</span>
                    )}
                  </div>
                  <div className={styles.detailAlertRuleName}>{rule.name}</div>
                  {rule.condition && (
                    <div className={styles.detailAlertRuleCondition}>{rule.condition}</div>
                  )}
                  {rule.targetResourceType && (
                    <div className={styles.detailAlertRuleTarget}>
                      {rule.targetResourceType.split("/").pop()}
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* Connections (collapsible) */}
        {connectedEdges.length > 0 && (
          <div className={styles.detailSection}>
            <button
              className={styles.detailSectionToggle}
              onClick={() => setConnectionsOpen((prev) => !prev)}
              type="button"
            >
              <span>
                {t("detail.connections")} ({connectedEdges.length})
              </span>
              <span className={styles.toggleChevron}>
                {connectionsOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {connectionsOpen &&
              connectedEdges.map((ce) => {
                const m = ce.liveEdge?.metrics;
                const metricStr = m?.latencyMs != null
                  ? `${m.latencyMs.toFixed(0)}ms`
                  : m?.throughputBps != null
                    ? fmtThroughput(m.throughputBps)
                    : "";
                return (
                  <div key={ce.edgeSpec.id} className={styles.detailEdgeItem}>
                    <span className={styles.detailEdgeDir}>
                      {ce.direction === "inbound" ? t("detail.inbound") : t("detail.outbound")}
                    </span>
                    <span className={styles.detailEdgePeer}>{ce.peerLabel}</span>
                    {metricStr && (
                      <span className={styles.detailEdgeMetric}>{metricStr}</span>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </aside>
  );
}
