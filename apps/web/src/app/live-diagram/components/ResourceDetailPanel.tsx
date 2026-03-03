import type {
  DiagramNodeSpec,
  DiagramEdgeSpec,
  LiveNode,
  LiveEdge,
  LiveAlert,
  HealthStatus,
  SparklineData,
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

  if (!nodeSpec) return null;

  const health: HealthStatus = liveNode?.health ?? "unknown";
  const colors = nodeColor(health);
  const metrics = liveNode?.metrics ?? {};
  const sparklines = liveNode?.sparklines;

  const metricEntries = Object.entries(metrics).filter(
    ([, v]) => v != null,
  );

  // Get all sparklines with enough data
  const sparklineEntries: [string, SparklineData][] = sparklines
    ? Object.entries(sparklines).filter(([, s]) => s.values.length >= 2)
    : [];

  const tags = nodeSpec.tags;
  const tagEntries = tags ? Object.entries(tags) : [];

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
        {/* Basic Info */}
        <div className={styles.detailSection}>
          {nodeSpec.resourceKind && (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{t("detail.kind")}</span>
              <span className={styles.detailVal}>{nodeSpec.resourceKind}</span>
            </div>
          )}
          <div className={styles.detailRow}>
            <span className={styles.detailKey}>{t("detail.health")}</span>
            <span className={styles.detailVal} style={{ color: colors.ringStroke }}>
              {healthLabel[health]}
              {liveNode ? ` (${(liveNode.healthScore * 100).toFixed(0)}%)` : ""}
            </span>
          </div>
          {nodeSpec.location && (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{t("detail.location")}</span>
              <span className={styles.detailVal}>{nodeSpec.location}</span>
            </div>
          )}
          {nodeSpec.resourceGroup && (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{t("detail.resourceGroup")}</span>
              <span className={styles.detailVal}>{nodeSpec.resourceGroup}</span>
            </div>
          )}
          {nodeSpec.endpoint && (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{t("detail.endpoint")}</span>
              <span className={styles.detailValMono}>{nodeSpec.endpoint}</span>
            </div>
          )}
          {nodeSpec.azureResourceId && (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{t("detail.azureId")}</span>
              <span className={styles.detailValMono} title={nodeSpec.azureResourceId}>
                {truncateId(nodeSpec.azureResourceId)}
              </span>
            </div>
          )}
        </div>

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

        {/* Connections */}
        {connectedEdges.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>
              {t("detail.connections")} ({connectedEdges.length})
            </div>
            {connectedEdges.map((ce) => {
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
