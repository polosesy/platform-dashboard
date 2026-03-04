import { useState } from "react";
import type {
  DiagramNodeSpec,
  DiagramEdgeSpec,
  LiveNode,
  LiveEdge,
  LiveAlert,
  HealthStatus,
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
const RESOURCE_KIND_DISPLAY: Record<string, string> = {
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

function truncateId(id: string, maxLen = 60): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "...";
}

function fmtThroughput(bps: number | undefined): string {
  if (bps == null) return "-";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

export function ResourceDetailPanel({
  nodeSpec,
  liveNode,
  alerts,
  connectedEdges,
  onClose,
}: ResourceDetailPanelProps) {
  const { t } = useI18n();
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  if (!nodeSpec) return null;

  const health: HealthStatus = liveNode?.health ?? "unknown";
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
          <div className={styles.essentialsGrid}>
            {/* Left column */}
            <div className={styles.essentialsCol}>
              {kindDisplay && (
                <div className={styles.essentialsItem}>
                  <span className={styles.essentialsLabel}>{t("detail.kind")}</span>
                  <span className={styles.essentialsValue}>{kindDisplay}</span>
                </div>
              )}
              <div className={styles.essentialsItem}>
                <span className={styles.essentialsLabel}>{t("detail.status")}</span>
                <span className={styles.essentialsValue} style={{ color: colors.ringStroke }}>
                  {healthLabel[health]}
                  {liveNode ? ` (${(liveNode.healthScore * 100).toFixed(0)}%)` : ""}
                </span>
              </div>
              {nodeSpec.location && (
                <div className={styles.essentialsItem}>
                  <span className={styles.essentialsLabel}>{t("detail.location")}</span>
                  <span className={styles.essentialsValue}>{nodeSpec.location}</span>
                </div>
              )}
            </div>
            {/* Right column */}
            <div className={styles.essentialsCol}>
              {nodeSpec.resourceGroup && (
                <div className={styles.essentialsItem}>
                  <span className={styles.essentialsLabel}>{t("detail.resourceGroup")}</span>
                  <span className={styles.essentialsValue}>{nodeSpec.resourceGroup}</span>
                </div>
              )}
              {nodeSpec.endpoint && (
                <div className={styles.essentialsItem}>
                  <span className={styles.essentialsLabel}>{t("detail.endpoint")}</span>
                  <span className={styles.essentialsValueMono}>{nodeSpec.endpoint}</span>
                </div>
              )}
              {nodeSpec.azureResourceId && (
                <div className={styles.essentialsItem}>
                  <span className={styles.essentialsLabel}>{t("detail.azureId")}</span>
                  <span className={styles.essentialsValueMono} title={nodeSpec.azureResourceId}>
                    {truncateId(nodeSpec.azureResourceId)}
                  </span>
                </div>
              )}
            </div>
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
                <div style={{ minWidth: 0 }}>
                  <div className={styles.essentialsValue}>{sr.label}</div>
                  <div className={styles.essentialsValueMono} style={{ fontSize: 11 }}>
                    {RESOURCE_KIND_DISPLAY[sr.kind] ?? sr.kind}
                  </div>
                  {sr.endpoint && (
                    <div className={styles.essentialsValueMono}>{sr.endpoint}</div>
                  )}
                  {sr.azureResourceId && (
                    <div
                      className={styles.essentialsValueMono}
                      title={sr.azureResourceId}
                      style={{ fontSize: 10 }}
                    >
                      {truncateId(sr.azureResourceId, 50)}
                    </div>
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

        {/* Alerts */}
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>
            {t("detail.alerts")} {alerts.length > 0 && `(${alerts.length})`}
          </div>
          {alerts.length === 0 ? (
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
                </div>
                <div className={styles.detailAlertTitle}>{alert.title}</div>
                <div className={styles.detailAlertSummary}>{alert.summary}</div>
              </div>
            ))
          )}
        </div>

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
